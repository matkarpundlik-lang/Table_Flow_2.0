import crypto from 'crypto';
import { Router } from 'express';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  customerQrSessions,
  orderAuthTokens,
  orders,
  otpChallenges,
  payments,
  qrTokenHistory,
  restaurantTables,
  securityEvents,
  staffMembers,
  userSessions,
} from '../db/schema.ts';
import {
  type AuthedRequest,
  getClientIp,
  requireAuth,
  requirePermission,
  requireTenant,
} from './middleware.ts';
import {
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
  QR_TOKEN_TTL_DAYS,
  SlidingWindowLimiter,
  generateOtpCode,
  generateSecureQrToken,
  hashPin,
  hashTokenSha256,
  normalizePhone,
  sanitizeText,
  signAppToken,
  verifyAppToken,
  verifyPin,
  verifyRazorpayWebhookSignature,
} from './security.ts';
import {
  logAudit,
  logSecurityEvent,
  recordQrTokenHistory,
  sendOtpViaProvider,
  syncDiningSessionPaymentStatus,
} from './services.ts';
import { issueReceiptForPayment } from './billing-services.ts';
import { broadcastToRestaurant } from './realtime.ts';

const otpRequestIpLimiter = new SlidingWindowLimiter(10, 10 * 60 * 1000);
const otpVerifyIpLimiter = new SlidingWindowLimiter(15, 10 * 60 * 1000);

export function registerSecurityRoutes(router: Router) {
  // ---------------------------------------------------------------------------
  // AUTH LOGOUT, SESSION REVOCATION & ACCOUNT RECOVERY
  // ---------------------------------------------------------------------------

  router.post('/auth/logout', requireAuth, async (req: AuthedRequest, res) => {
    try {
      const authCtx = req.auth!;
      if (authCtx.sessionId) {
        await db
          .update(userSessions)
          .set({ revokedAt: new Date() })
          .where(eq(userSessions.sessionId, authCtx.sessionId));
      }

      await logSecurityEvent({
        restaurantId: authCtx.restaurantId,
        severity: 'low',
        eventType: 'USER_LOGOUT',
        actorIdentifier: `${authCtx.displayName} (${authCtx.role})`,
        ipAddress: getClientIp(req),
        path: req.originalUrl,
        method: req.method,
        statusCode: 200,
      });

      res.json({ loggedOut: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Logout failed' });
    }
  });

  router.post('/auth/logout-all', requireAuth, async (req: AuthedRequest, res) => {
    try {
      const authCtx = req.auth!;
      if (authCtx.authType === 'staff' && authCtx.staffId) {
        await db
          .update(staffMembers)
          .set({ tokenVersion: sql`${staffMembers.tokenVersion} + 1` })
          .where(eq(staffMembers.id, authCtx.staffId));

        await db
          .update(userSessions)
          .set({ revokedAt: new Date() })
          .where(and(eq(userSessions.staffId, authCtx.staffId), isNull(userSessions.revokedAt)));
      } else if (authCtx.sessionId) {
        await db
          .update(userSessions)
          .set({ revokedAt: new Date() })
          .where(eq(userSessions.sessionId, authCtx.sessionId));
      }

      await logSecurityEvent({
        restaurantId: authCtx.restaurantId,
        severity: 'medium',
        eventType: 'SESSION_LOGOUT_ALL',
        actorIdentifier: `${authCtx.displayName} (${authCtx.role})`,
        ipAddress: getClientIp(req),
        path: req.originalUrl,
        method: req.method,
        statusCode: 200,
      });

      res.json({ revokedAll: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to revoke all sessions' });
    }
  });

  // ---------------------------------------------------------------------------
  // OTP VERIFICATION (HASHED, EXPIRING, SINGLE-USE, COOLDOWN, MAX ATTEMPTS)
  // ---------------------------------------------------------------------------

  router.post('/auth/otp/request', async (req, res) => {
    const ipAddress = getClientIp(req);
    try {
      const rl = otpRequestIpLimiter.consume(ipAddress);
      if (!rl.allowed) {
        await logSecurityEvent({
          severity: 'medium',
          eventType: 'OTP_REQUEST_RATE_LIMITED',
          ipAddress,
          path: req.originalUrl,
          method: req.method,
          statusCode: 429,
        });
        res.setHeader('Retry-After', String(rl.retryAfterSeconds));
        return res.status(429).json({
          error: `Too many OTP requests. Retry in ${rl.retryAfterSeconds}s.`,
        });
      }

      const phone = normalizePhone(req.body?.phone);
      const purpose = req.body?.purpose === 'staff_reset' ? 'staff_reset' : 'guest_verify';
      const restaurantId = req.body?.restaurantId ? Number(req.body.restaurantId) : null;

      if (!phone) {
        return res.status(400).json({ error: 'Valid phone number (8-15 digits) is required' });
      }

      const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000);
      const recentChallenges = await db
        .select()
        .from(otpChallenges)
        .where(
          and(
            eq(otpChallenges.phone, phone),
            eq(otpChallenges.purpose, purpose),
            gt(otpChallenges.createdAt, tenMinsAgo),
          ),
        )
        .orderBy(desc(otpChallenges.createdAt));

      if (recentChallenges.length > 0) {
        const latest = recentChallenges[0];
        const elapsedMs = Date.now() - new Date(latest.lastSentAt).getTime();
        if (elapsedMs < OTP_RESEND_COOLDOWN_MS) {
          const retryAfter = Math.ceil((OTP_RESEND_COOLDOWN_MS - elapsedMs) / 1000);
          await logSecurityEvent({
            restaurantId,
            severity: 'low',
            eventType: 'OTP_RESEND_COOLDOWN_BLOCKED',
            actorIdentifier: phone,
            ipAddress,
            path: req.originalUrl,
            method: req.method,
            statusCode: 429,
          });
          res.setHeader('Retry-After', String(retryAfter));
          return res.status(429).json({
            error: `Please wait ${retryAfter} seconds before requesting another OTP`,
          });
        }
      }

      if (recentChallenges.length >= 3) {
        await logSecurityEvent({
          restaurantId,
          severity: 'medium',
          eventType: 'OTP_PHONE_QUOTA_EXCEEDED',
          actorIdentifier: phone,
          ipAddress,
          path: req.originalUrl,
          method: req.method,
          statusCode: 429,
        });
        return res.status(429).json({
          error: 'Maximum OTP requests reached for this number. Try again later.',
        });
      }

      const code = generateOtpCode();
      const { hash, salt } = hashPin(code);
      const expiresAt = new Date(Date.now() + OTP_TTL_MS);

      // Invalidate previous unconsumed challenges for same phone/purpose
      await db
        .update(otpChallenges)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(otpChallenges.phone, phone),
            eq(otpChallenges.purpose, purpose),
            isNull(otpChallenges.consumedAt),
          ),
        );

      const [challenge] = await db
        .insert(otpChallenges)
        .values({
          purpose,
          phone,
          restaurantId,
          codeHash: hash,
          codeSalt: salt,
          attempts: 0,
          maxAttempts: OTP_MAX_ATTEMPTS,
          expiresAt,
          lastSentAt: new Date(),
          ipAddress,
        })
        .returning();

      try {
        await sendOtpViaProvider({ phone, code, purpose });
      } catch (deliveryErr: any) {
        // Never leave an undelivered active OTP or simulate success
        await db.delete(otpChallenges).where(eq(otpChallenges.id, challenge.id));
        await logSecurityEvent({
          restaurantId,
          severity: 'medium',
          eventType: 'OTP_DELIVERY_UNAVAILABLE',
          actorIdentifier: phone,
          ipAddress,
          path: req.originalUrl,
          method: req.method,
          statusCode: 503,
        });
        return res.status(503).json({
          error:
            deliveryErr?.code === 'OTP_PROVIDER_UNCONFIGURED'
              ? deliveryErr.message
              : 'Failed to dispatch OTP via SMS gateway',
        });
      }

      await logSecurityEvent({
        restaurantId,
        severity: 'low',
        eventType: 'OTP_REQUESTED',
        actorIdentifier: phone,
        ipAddress,
        path: req.originalUrl,
        method: req.method,
        statusCode: 200,
        details: { purpose },
      });

      res.json({
        sent: true,
        challengeId: challenge.id,
        expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
        cooldownSeconds: Math.floor(OTP_RESEND_COOLDOWN_MS / 1000),
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to process OTP request' });
    }
  });

  router.post('/auth/otp/verify', async (req, res) => {
    const ipAddress = getClientIp(req);
    try {
      const rl = otpVerifyIpLimiter.consume(ipAddress);
      if (!rl.allowed) {
        res.setHeader('Retry-After', String(rl.retryAfterSeconds));
        return res.status(429).json({
          error: `Too many verification attempts. Retry in ${rl.retryAfterSeconds}s.`,
        });
      }

      const phone = normalizePhone(req.body?.phone);
      const code = String(req.body?.code || '').trim();
      const purpose = req.body?.purpose === 'staff_reset' ? 'staff_reset' : 'guest_verify';

      if (!phone || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ error: 'Valid phone number and 6-digit OTP are required' });
      }

      const [challenge] = await db
        .select()
        .from(otpChallenges)
        .where(and(eq(otpChallenges.phone, phone), eq(otpChallenges.purpose, purpose)))
        .orderBy(desc(otpChallenges.createdAt))
        .limit(1);

      if (!challenge) {
        return res.status(400).json({ error: 'No OTP challenge found for this phone number' });
      }

      if (challenge.consumedAt) {
        await logSecurityEvent({
          restaurantId: challenge.restaurantId,
          severity: 'medium',
          eventType: 'OTP_REUSE_BLOCKED',
          actorIdentifier: phone,
          ipAddress,
          path: req.originalUrl,
          method: req.method,
          statusCode: 400,
        });
        return res.status(400).json({ error: 'This OTP has already been used' });
      }

      if (challenge.expiresAt.getTime() <= Date.now()) {
        await logSecurityEvent({
          restaurantId: challenge.restaurantId,
          severity: 'low',
          eventType: 'OTP_EXPIRED',
          actorIdentifier: phone,
          ipAddress,
          path: req.originalUrl,
          method: req.method,
          statusCode: 400,
        });
        return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
      }

      if (challenge.attempts >= challenge.maxAttempts) {
        await logSecurityEvent({
          restaurantId: challenge.restaurantId,
          severity: 'high',
          eventType: 'OTP_MAX_ATTEMPTS_EXCEEDED',
          actorIdentifier: phone,
          ipAddress,
          path: req.originalUrl,
          method: req.method,
          statusCode: 429,
        });
        return res.status(429).json({
          error: 'Maximum OTP verification attempts exceeded. Request a new code.',
        });
      }

      const isMatch = verifyPin(code, challenge.codeHash, challenge.codeSalt);
      if (!isMatch) {
        const nextAttempts = challenge.attempts + 1;
        await db
          .update(otpChallenges)
          .set({
            attempts: nextAttempts,
            consumedAt: nextAttempts >= challenge.maxAttempts ? new Date() : null,
          })
          .where(eq(otpChallenges.id, challenge.id));

        await logSecurityEvent({
          restaurantId: challenge.restaurantId,
          severity: nextAttempts >= challenge.maxAttempts ? 'high' : 'medium',
          eventType: 'OTP_VERIFICATION_FAILED',
          actorIdentifier: phone,
          ipAddress,
          path: req.originalUrl,
          method: req.method,
          statusCode: 401,
          details: { attempts: nextAttempts, maxAttempts: challenge.maxAttempts },
        });

        const remaining = Math.max(0, challenge.maxAttempts - nextAttempts);
        return res.status(remaining === 0 ? 429 : 401).json({
          error:
            remaining === 0
              ? 'Maximum OTP verification attempts exceeded. Request a new code.'
              : `Invalid OTP. ${remaining} attempt(s) remaining.`,
        });
      }

      // Atomic single-use consumption guard
      const consumed = await db
        .update(otpChallenges)
        .set({ consumedAt: new Date() })
        .where(and(eq(otpChallenges.id, challenge.id), isNull(otpChallenges.consumedAt)))
        .returning({ id: otpChallenges.id });

      if (consumed.length === 0) {
        return res.status(400).json({ error: 'This OTP has already been used' });
      }

      const verificationToken = signAppToken({
        kind: 'otp_proof',
        phone,
        purpose,
        restaurantId: challenge.restaurantId,
        exp: Date.now() + 15 * 60 * 1000,
      });

      await logSecurityEvent({
        restaurantId: challenge.restaurantId,
        severity: 'low',
        eventType: 'OTP_VERIFIED',
        actorIdentifier: phone,
        ipAddress,
        path: req.originalUrl,
        method: req.method,
        statusCode: 200,
      });

      res.json({ verified: true, verificationToken });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'OTP verification failed' });
    }
  });

  // Reset staff PIN/password using a valid OTP verification proof token
  router.post('/auth/staff-reset-pin', async (req, res) => {
    const ipAddress = getClientIp(req);
    try {
      const verificationToken = String(req.body?.verificationToken || '').trim();
      const newPin = String(req.body?.newPin || '').trim();
      const restaurantId = Number(req.body?.restaurantId);

      const proof = verifyAppToken(verificationToken);
      if (!proof || proof.kind !== 'otp_proof' || proof.purpose !== 'staff_reset') {
        return res.status(401).json({ error: 'Valid OTP verification proof required' });
      }

      if (!restaurantId || !/^\d{4,6}$/.test(newPin)) {
        return res.status(400).json({ error: 'Restaurant ID and 4-6 digit new PIN required' });
      }

      const staffList = await db
        .select()
        .from(staffMembers)
        .where(and(eq(staffMembers.restaurantId, restaurantId), eq(staffMembers.isActive, true)));

      const matched = staffList.find((s) => normalizePhone(s.phone) === proof.phone);
      if (!matched) {
        return res.status(404).json({ error: 'No active staff account linked to verified phone' });
      }

      const { hash, salt } = hashPin(newPin);
      await db
        .update(staffMembers)
        .set({
          pinHash: hash,
          pinSalt: salt,
          tokenVersion: sql`${staffMembers.tokenVersion} + 1`,
          failedLoginAttempts: 0,
          lockedUntil: null,
        })
        .where(eq(staffMembers.id, matched.id));

      await db
        .update(userSessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(userSessions.staffId, matched.id), isNull(userSessions.revokedAt)));

      await logSecurityEvent({
        restaurantId,
        severity: 'medium',
        eventType: 'STAFF_PIN_RESET_VIA_OTP',
        actorIdentifier: matched.name,
        ipAddress,
        path: req.originalUrl,
        method: req.method,
        statusCode: 200,
      });

      res.json({ reset: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to reset PIN' });
    }
  });

  // ---------------------------------------------------------------------------
  // QR TOKEN REVOCATION & REGENERATION (ADMIN / MANAGER WITH manage_tables)
  // ---------------------------------------------------------------------------

  router.post(
    '/tables/:id/qr/regenerate',
    requireAuth,
    requireTenant,
    requirePermission('manage_tables'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const tableId = Number(req.params.id);
        const reason = sanitizeText(req.body?.reason || 'Regenerated by administrator', 180);

        const [existing] = await db
          .select()
          .from(restaurantTables)
          .where(and(eq(restaurantTables.id, tableId), eq(restaurantTables.restaurantId, restaurantId)))
          .limit(1);

        if (!existing) {
          return res.status(404).json({ error: 'Table not found' });
        }

        const newToken = generateSecureQrToken();
        const nextVersion = (existing.qrTokenVersion || 1) + 1;
        const expiresAt = new Date(Date.now() + QR_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

        const [updated] = await db
          .update(restaurantTables)
          .set({
            qrToken: newToken,
            qrTokenVersion: nextVersion,
            qrExpiresAt: expiresAt,
            qrRevokedAt: null,
          })
          .where(and(eq(restaurantTables.id, tableId), eq(restaurantTables.restaurantId, restaurantId)))
          .returning();

        await db
          .update(customerQrSessions)
          .set({ revokedAt: new Date(), revokeReason: 'qr_regenerated' })
          .where(and(eq(customerQrSessions.tableId, tableId), isNull(customerQrSessions.revokedAt)));

        await db
          .update(orderAuthTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(orderAuthTokens.tableId, tableId), isNull(orderAuthTokens.consumedAt), isNull(orderAuthTokens.revokedAt)));

        await recordQrTokenHistory({
          restaurantId,
          tableId,
          rawToken: newToken,
          tokenVersion: nextVersion,
          action: 'regenerated',
          actorName: req.auth!.displayName,
          reason,
          expiresAt,
        });

        await logSecurityEvent({
          restaurantId,
          severity: 'medium',
          eventType: 'QR_TOKEN_REGENERATED',
          actorIdentifier: `${req.auth!.displayName} (${req.auth!.role})`,
          ipAddress: getClientIp(req),
          path: req.originalUrl,
          method: req.method,
          statusCode: 200,
          details: { tableId, tableNumber: existing.tableNumber, tokenVersion: nextVersion },
        });

        await logAudit({
          restaurantId,
          actorName: req.auth!.displayName,
          actorRole: req.auth!.role,
          action: 'QR_TOKEN_REGENERATED',
          entityType: 'table',
          entityId: tableId,
          details: { tableNumber: existing.tableNumber, tokenVersion: nextVersion },
        });

        res.json({ table: updated });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to regenerate QR token' });
      }
    },
  );

  router.post(
    '/tables/:id/qr/revoke',
    requireAuth,
    requireTenant,
    requirePermission('manage_tables'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const tableId = Number(req.params.id);
        const reason = sanitizeText(req.body?.reason || 'Revoked by administrator', 180);

        const [existing] = await db
          .select()
          .from(restaurantTables)
          .where(and(eq(restaurantTables.id, tableId), eq(restaurantTables.restaurantId, restaurantId)))
          .limit(1);

        if (!existing) {
          return res.status(404).json({ error: 'Table not found' });
        }

        const nextVersion = (existing.qrTokenVersion || 1) + 1;
        const [updated] = await db
          .update(restaurantTables)
          .set({
            qrRevokedAt: new Date(),
            qrTokenVersion: nextVersion,
          })
          .where(and(eq(restaurantTables.id, tableId), eq(restaurantTables.restaurantId, restaurantId)))
          .returning();

        await db
          .update(customerQrSessions)
          .set({ revokedAt: new Date(), revokeReason: 'qr_revoked' })
          .where(and(eq(customerQrSessions.tableId, tableId), isNull(customerQrSessions.revokedAt)));

        await db
          .update(orderAuthTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(orderAuthTokens.tableId, tableId), isNull(orderAuthTokens.consumedAt), isNull(orderAuthTokens.revokedAt)));

        await recordQrTokenHistory({
          restaurantId,
          tableId,
          rawToken: existing.qrToken,
          tokenVersion: nextVersion,
          action: 'revoked',
          actorName: req.auth!.displayName,
          reason,
          expiresAt: existing.qrExpiresAt,
        });

        await logSecurityEvent({
          restaurantId,
          severity: 'high',
          eventType: 'QR_TOKEN_REVOKED',
          actorIdentifier: `${req.auth!.displayName} (${req.auth!.role})`,
          ipAddress: getClientIp(req),
          path: req.originalUrl,
          method: req.method,
          statusCode: 200,
          details: { tableId, tableNumber: existing.tableNumber, reason },
        });

        await logAudit({
          restaurantId,
          actorName: req.auth!.displayName,
          actorRole: req.auth!.role,
          action: 'QR_TOKEN_REVOKED',
          entityType: 'table',
          entityId: tableId,
          details: { tableNumber: existing.tableNumber, reason },
        });

        res.json({ table: updated });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to revoke QR token' });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // SECURITY MONITORING, AUDIT & ACTIVE SESSION CONTROLS (OWNER / SUPER ADMIN)
  // ---------------------------------------------------------------------------

  router.get(
    '/security/overview',
    requireAuth,
    requireTenant,
    requirePermission('manage_staff'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;

        const events = await db
          .select()
          .from(securityEvents)
          .where(eq(securityEvents.restaurantId, restaurantId))
          .orderBy(desc(securityEvents.createdAt))
          .limit(80);

        const globalAuthEvents = req.auth!.isSuperAdmin
          ? await db
              .select()
              .from(securityEvents)
              .where(isNull(securityEvents.restaurantId))
              .orderBy(desc(securityEvents.createdAt))
              .limit(30)
          : [];

        const sessions = await db
          .select({
            id: userSessions.id,
            sessionId: userSessions.sessionId,
            authType: userSessions.authType,
            staffId: userSessions.staffId,
            role: userSessions.role,
            actorName: userSessions.actorName,
            ipAddress: userSessions.ipAddress,
            expiresAt: userSessions.expiresAt,
            revokedAt: userSessions.revokedAt,
            lastSeenAt: userSessions.lastSeenAt,
            createdAt: userSessions.createdAt,
          })
          .from(userSessions)
          .where(eq(userSessions.restaurantId, restaurantId))
          .orderBy(desc(userSessions.createdAt))
          .limit(40);

        const qrHistoryRows = await db
          .select({
            id: qrTokenHistory.id,
            restaurantId: qrTokenHistory.restaurantId,
            tableId: qrTokenHistory.tableId,
            tokenHash: qrTokenHistory.tokenHash,
            tokenVersion: qrTokenHistory.tokenVersion,
            action: qrTokenHistory.action,
            actorName: qrTokenHistory.actorName,
            reason: qrTokenHistory.reason,
            expiresAt: qrTokenHistory.expiresAt,
            createdAt: qrTokenHistory.createdAt,
          })
          .from(qrTokenHistory)
          .where(eq(qrTokenHistory.restaurantId, restaurantId))
          .orderBy(desc(qrTokenHistory.createdAt))
          .limit(50);

        const qrHistory = qrHistoryRows.map(({ tokenHash, ...rest }) => ({
          ...rest,
          reason: rest.reason || '',
          tokenDigest: tokenHash ? tokenHash.slice(0, 16) : '',
        }));

        const lockedStaff = await db
          .select({
            id: staffMembers.id,
            name: staffMembers.name,
            role: staffMembers.role,
            failedLoginAttempts: staffMembers.failedLoginAttempts,
            lockedUntil: staffMembers.lockedUntil,
          })
          .from(staffMembers)
          .where(eq(staffMembers.restaurantId, restaurantId));

        res.json({
          events: [...events, ...globalAuthEvents].sort(
            (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
          ),
          sessions,
          qrHistory,
          staffLockStatus: lockedStaff,
        });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load security overview' });
      }
    },
  );

  router.post(
    '/security/sessions/:sessionId/revoke',
    requireAuth,
    requireTenant,
    requirePermission('manage_staff'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const sessionId = String(req.params.sessionId || '').trim();

        const [revoked] = await db
          .update(userSessions)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(userSessions.sessionId, sessionId),
              eq(userSessions.restaurantId, restaurantId),
              isNull(userSessions.revokedAt),
            ),
          )
          .returning();

        if (!revoked) {
          return res.status(404).json({ error: 'Active session not found' });
        }

        await logSecurityEvent({
          restaurantId,
          severity: 'medium',
          eventType: 'ADMIN_SESSION_REVOKED',
          actorIdentifier: `${req.auth!.displayName} (${req.auth!.role})`,
          ipAddress: getClientIp(req),
          path: req.originalUrl,
          method: req.method,
          statusCode: 200,
          details: { revokedActor: revoked.actorName, revokedSessionId: sessionId.slice(0, 10) },
        });

        res.json({ revoked: true });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to revoke session' });
      }
    },
  );

  router.post(
    '/staff/:id/unlock',
    requireAuth,
    requireTenant,
    requirePermission('manage_staff'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const staffId = Number(req.params.id);

        const [updated] = await db
          .update(staffMembers)
          .set({ failedLoginAttempts: 0, lockedUntil: null })
          .where(and(eq(staffMembers.id, staffId), eq(staffMembers.restaurantId, restaurantId)))
          .returning({ id: staffMembers.id, name: staffMembers.name });

        if (!updated) {
          return res.status(404).json({ error: 'Staff member not found' });
        }

        await logSecurityEvent({
          restaurantId,
          severity: 'medium',
          eventType: 'STAFF_ACCOUNT_UNLOCKED',
          actorIdentifier: `${req.auth!.displayName} (${req.auth!.role})`,
          ipAddress: getClientIp(req),
          path: req.originalUrl,
          method: req.method,
          statusCode: 200,
          details: { unlockedStaffId: staffId, unlockedStaffName: updated.name },
        });

        res.json({ unlocked: true, staff: updated });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to unlock staff member' });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // RAZORPAY WEBHOOK SIGNATURE VERIFICATION
  // ---------------------------------------------------------------------------

  router.post('/webhooks/razorpay', async (req, res) => {
    const signature = String(req.headers['x-razorpay-signature'] || '').trim();
    const rawBody = JSON.stringify(req.body || {});
    if (!verifyRazorpayWebhookSignature(rawBody, signature)) {
      await logSecurityEvent({
        severity: 'high',
        eventType: 'RAZORPAY_WEBHOOK_INVALID_SIGNATURE',
        ipAddress: getClientIp(req),
        path: req.originalUrl,
        method: req.method,
        statusCode: 400,
      });
      return res.status(400).json({ error: 'Invalid webhook signature' });
    }

    try {
      const eventName = String(req.body?.event || '');
      const payEntity = req.body?.payload?.payment?.entity;
      const rzpOrderId = payEntity?.order_id ? String(payEntity.order_id) : '';
      const rzpPaymentId = payEntity?.id ? String(payEntity.id) : '';

      if (rzpOrderId) {
        const [pending] = await db
          .select()
          .from(payments)
          .where(eq(payments.razorpayOrderId, rzpOrderId))
          .limit(1);

        if (pending && (pending.status === 'pending' || pending.status === 'processing')) {
          if (eventName === 'payment.captured') {
            await db
              .update(payments)
              .set({
                status: 'verified',
                razorpayPaymentId: rzpPaymentId || pending.razorpayPaymentId,
                transactionRef: rzpPaymentId || pending.transactionRef,
                verifiedBy: 'Razorpay Webhook',
                verifiedAt: new Date(),
                notes: 'Verified via Razorpay webhook',
              })
              .where(eq(payments.id, pending.id));

            const [ord] = await db.select().from(orders).where(eq(orders.id, pending.orderId)).limit(1);
            if (ord) {
              const newPaid = Number((ord.paidAmount + pending.amount).toFixed(2));
              const isSettled = newPaid >= ord.totalAmount - 0.5;
              await db
                .update(orders)
                .set({
                  paidAmount: newPaid,
                  status: isSettled ? 'Paid' : ord.status,
                  paidAt: isSettled ? new Date() : ord.paidAt,
                  updatedAt: new Date(),
                })
                .where(eq(orders.id, ord.id));

              const receipt = await issueReceiptForPayment({
                restaurantId: ord.restaurantId,
                paymentId: pending.id,
                actorName: 'Razorpay Webhook',
                includeFullSessionOrders: pending.initiatedBySource === 'customer_qr',
              });

              await syncDiningSessionPaymentStatus(ord.diningSessionId);
              await logSecurityEvent({
                restaurantId: ord.restaurantId,
                severity: 'low',
                eventType: 'PAYMENT_WEBHOOK_VERIFIED',
                ipAddress: getClientIp(req),
                path: req.originalUrl,
                method: req.method,
                statusCode: 200,
                details: {
                  orderId: ord.id,
                  diningSessionId: ord.diningSessionId,
                  receiptNumber: receipt.receiptNumber,
                },
              });

              broadcastToRestaurant(
                ord.restaurantId,
                'receipt:created',
                { receipt, tableId: ord.tableId || undefined, diningSessionId: ord.diningSessionId },
                ord.tableId || undefined,
              );
              broadcastToRestaurant(
                ord.restaurantId,
                'payment:updated',
                { payment: { ...pending, status: 'verified' }, receipt, diningSessionId: ord.diningSessionId },
                ord.tableId || undefined,
              );
            }
          } else if (eventName === 'payment.failed') {
            await db
              .update(payments)
              .set({
                status: 'failed',
                razorpayPaymentId: rzpPaymentId || pending.razorpayPaymentId,
                notes: 'Payment failed via Razorpay webhook',
              })
              .where(eq(payments.id, pending.id));

            const [ord] = await db.select().from(orders).where(eq(orders.id, pending.orderId)).limit(1);
            if (ord) {
              await syncDiningSessionPaymentStatus(ord.diningSessionId);
              await logSecurityEvent({
                restaurantId: ord.restaurantId,
                severity: 'medium',
                eventType: 'PAYMENT_WEBHOOK_FAILED',
                ipAddress: getClientIp(req),
                path: req.originalUrl,
                method: req.method,
                statusCode: 200,
                details: { orderId: ord.id, diningSessionId: ord.diningSessionId },
              });
            }
          }
        }
      }
    } catch (err) {
      console.error('Razorpay webhook processing error:', err);
    }

    res.json({ received: true });
  });
}
