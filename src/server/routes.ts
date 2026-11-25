import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import express, { Router } from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  auditLogs,
  customerQrSessions,
  customers,
  diningSessions,
  expenses,
  inventoryItems,
  menuCategories,
  menuItemRecipes,
  menuItems,
  orderAuthTokens,
  orderItems,
  orders,
  payments,
  pinAttemptTrackers,
  platformPlans,
  platformSettings,
  promotionalOffers,
  restaurantTables,
  restaurants,
  securityEvents,
  serviceRequests,
  staffMembers,
  stockMovements,
  suppliers,
  userSessions,
} from '../db/schema.ts';
import {
  type AuthedRequest,
  DEFAULT_ROLE_PERMISSIONS,
  csrfOriginGuard,
  getClientIp,
  requireAuth,
  requirePermission,
  requireQrSession,
  requireSuperAdmin,
  requireTenant,
} from './middleware.ts';
import { broadcastToRestaurant, registerSseClient, removeSseClient } from './realtime.ts';
import {
  CUSTOMER_PIN_MAX_ATTEMPTS,
  QR_INACTIVITY_TTL_MS,
  QR_SESSION_TTL_MS,
  QR_TOKEN_TTL_DAYS,
  STAFF_LOCKOUT_MS,
  STAFF_MAX_FAILED_ATTEMPTS,
  STAFF_SESSION_TTL_MS,
  SlidingWindowLimiter,
  UPLOADS_RECEIPTS_DIR,
  generateQrSessionUid,
  generateRazorpayTestSignature,
  generateSecureQrToken,
  hashPin,
  hashTokenSha256,
  parseCookies,
  resolveSafeReceiptPath,
  sanitizeText,
  signAppToken,
  validateReceiptMagicBytes,
  verifyAppToken,
  verifyPin,
  verifyRazorpayTestSignature,
} from './security.ts';
import { ensureSeedData } from './seed.ts';
import { registerSecurityRoutes } from './security-routes.ts';
import { registerDiningSessionRoutes } from './dining-session-routes.ts';
import { registerBillingRoutes } from './billing-routes.ts';
import { issueReceiptForPayment } from './billing-services.ts';
import {
  buildAuthoritativeOrderItems,
  computeOrderTotals,
  deductInventoryForOrder,
  getOrCreateActiveDiningSession,
  logAudit,
  logSecurityEvent,
  recordQrTokenHistory,
  syncDiningSessionPaymentStatus,
  upsertCustomerFromOrder,
} from './services.ts';

if (!fs.existsSync(UPLOADS_RECEIPTS_DIR)) {
  fs.mkdirSync(UPLOADS_RECEIPTS_DIR, { recursive: true });
}

const receiptStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOADS_RECEIPTS_DIR);
  },
  filename: (req, file, cb) => {
    const restId = (req as AuthedRequest).auth?.restaurantId || 0;
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '');
    const safeExt = ['.png', '.jpg', '.jpeg', '.webp', '.pdf'].includes(ext) ? ext : '.bin';
    cb(null, `rcpt_r${restId}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}${safeExt}`);
  },
});

const uploadReceipt = multer({
  storage: receiptStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp', '.pdf'].includes(ext)) {
      return cb(new Error('Only PNG, JPEG, WEBP, and PDF receipt files are allowed'));
    }
    cb(null, true);
  },
});

const staffLoginLimiter = new SlidingWindowLimiter(15, 5 * 60 * 1000);
const qrDiscoveryLimiter = new SlidingWindowLimiter(45, 5 * 60 * 1000);
const qrOrderLimiter = new SlidingWindowLimiter(15, 5 * 60 * 1000);
const staffTerminalLocks = new Map<string, { fails: number; lockedUntil: number }>();

const ALLOWED_ORDER_TRANSITIONS: Record<string, string[]> = {
  New: ['Accepted', 'Preparing', 'Ready', 'Cancelled'],
  Accepted: ['Preparing', 'Ready', 'Cancelled'],
  Preparing: ['Ready', 'Cancelled'],
  Ready: ['Served', 'Completed', 'Cancelled'],
  Served: ['Completed', 'Cancelled'],
  Completed: ['Cancelled'],
  Paid: ['Closed'],
  Closed: [],
  Cancelled: [],
};

const requireAnyPermission = (keys: string[]) => {
  return async (req: AuthedRequest, res: express.Response, next: express.NextFunction) => {
    if (!req.auth) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (req.auth.isSuperAdmin || req.auth.role === 'owner') {
      return next();
    }
    if (keys.some((k) => req.auth!.permissions[k])) {
      return next();
    }
    await logSecurityEvent({
      restaurantId: req.auth.restaurantId,
      severity: 'medium',
      eventType: 'PERMISSION_DENIED',
      actorIdentifier: `${req.auth.displayName} (${req.auth.role})`,
      ipAddress: getClientIp(req),
      path: req.originalUrl,
      method: req.method,
      statusCode: 403,
      details: { requiredAny: keys, actorRole: req.auth.role },
    });
    return res.status(403).json({ error: `Permission denied: requires ${keys.join(' or ')}` });
  };
};

export function createApiRouter(): Router {
  const router = Router();

  // Origin/Host CSRF protection for browser-originating mutations
  router.use(csrfOriginGuard);

  // Ensure database seed & CSPRNG QR token upgrade are initialized
  router.use(async (_req, _res, next) => {
    try {
      await ensureSeedData();
      next();
    } catch (err) {
      next(err);
    }
  });

  registerSecurityRoutes(router);
  registerDiningSessionRoutes(router);
  registerBillingRoutes(router);

  // ---------------------------------------------------------------------------
  // PUBLIC DISCOVERY & AUTHENTICATION
  // ---------------------------------------------------------------------------

  router.get('/public/restaurants', async (_req, res) => {
    try {
      const activeRests = await db
        .select({
          id: restaurants.id,
          name: restaurants.name,
          slug: restaurants.slug,
          tagline: restaurants.tagline,
          cuisineType: restaurants.cuisineType,
          city: restaurants.city,
          qrOrderingEnabled: restaurants.qrOrderingEnabled,
        })
        .from(restaurants)
        .where(eq(restaurants.isActive, true))
        .orderBy(restaurants.id);

      // Never expose raw qrTokens publicly to unauthenticated callers
      const allTables = await db
        .select({
          id: restaurantTables.id,
          restaurantId: restaurantTables.restaurantId,
          tableNumber: restaurantTables.tableNumber,
          section: restaurantTables.section,
        })
        .from(restaurantTables)
        .orderBy(restaurantTables.id);

      const plans = await db.select().from(platformPlans).where(eq(platformPlans.isActive, true));

      const result = activeRests.map((r) => ({
        ...r,
        sampleTables: allTables.filter((t) => t.restaurantId === r.id).slice(0, 3),
      }));

      res.json({ restaurants: result, plans });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to load restaurants' });
    }
  });

  router.post('/auth/staff-login', async (req, res) => {
    const ipAddress = getClientIp(req);
    try {
      const restaurantId = Number(req.body?.restaurantId);
      const pin = String(req.body?.pin || '').trim();
      if (!restaurantId || !pin) {
        return res.status(400).json({ error: 'Restaurant and PIN are required' });
      }

      const lockKey = `${ipAddress}:${restaurantId}`;
      const lockState = staffTerminalLocks.get(lockKey);
      if (lockState && lockState.lockedUntil > Date.now()) {
        const retrySecs = Math.ceil((lockState.lockedUntil - Date.now()) / 1000);
        await logSecurityEvent({
          restaurantId,
          severity: 'high',
          eventType: 'BRUTE_FORCE_LOCKED_ATTEMPT',
          actorIdentifier: `PIN terminal (${ipAddress})`,
          ipAddress,
          path: req.originalUrl,
          method: req.method,
          statusCode: 423,
          details: { retryAfterSeconds: retrySecs },
        });
        res.setHeader('Retry-After', String(retrySecs));
        return res.status(423).json({
          error: `Account/terminal temporarily locked due to repeated failed attempts. Try again in ${Math.ceil(retrySecs / 60)} minute(s).`,
        });
      }

      const rl = staffLoginLimiter.consume(lockKey);
      if (!rl.allowed) {
        await logSecurityEvent({
          restaurantId,
          severity: 'high',
          eventType: 'LOGIN_RATE_LIMIT_EXCEEDED',
          ipAddress,
          path: req.originalUrl,
          method: req.method,
          statusCode: 429,
        });
        res.setHeader('Retry-After', String(rl.retryAfterSeconds));
        return res.status(429).json({
          error: `Too many login attempts. Retry in ${rl.retryAfterSeconds}s.`,
        });
      }

      const [rest] = await db
        .select()
        .from(restaurants)
        .where(and(eq(restaurants.id, restaurantId), eq(restaurants.isActive, true)))
        .limit(1);

      if (!rest) {
        return res.status(404).json({ error: 'Restaurant not found or suspended' });
      }

      const members = await db
        .select()
        .from(staffMembers)
        .where(and(eq(staffMembers.restaurantId, restaurantId), eq(staffMembers.isActive, true)));

      const matched = members.find((m) => verifyPin(pin, m.pinHash, m.pinSalt));
      if (!matched) {
        const nextFails = (lockState?.fails || 0) + 1;
        const shouldLock = nextFails >= STAFF_MAX_FAILED_ATTEMPTS;
        const lockedUntil = shouldLock ? Date.now() + STAFF_LOCKOUT_MS : 0;
        staffTerminalLocks.set(lockKey, { fails: nextFails, lockedUntil });

        await logSecurityEvent({
          restaurantId,
          severity: shouldLock ? 'high' : 'medium',
          eventType: shouldLock ? 'STAFF_LOGIN_LOCKOUT_TRIGGERED' : 'STAFF_LOGIN_FAILED',
          actorIdentifier: `PIN attempt #${nextFails}`,
          ipAddress,
          path: req.originalUrl,
          method: req.method,
          statusCode: shouldLock ? 423 : 401,
          details: { failedAttempts: nextFails },
        });

        if (shouldLock) {
          return res.status(423).json({
            error: 'Too many failed PIN attempts. Login locked for 15 minutes.',
          });
        }
        return res.status(401).json({
          error: `Invalid staff PIN for this outlet (${STAFF_MAX_FAILED_ATTEMPTS - nextFails} attempts remaining)`,
        });
      }

      if (matched.lockedUntil && matched.lockedUntil.getTime() > Date.now()) {
        return res.status(423).json({
          error: 'Staff account is locked. Ask your Restaurant Owner to unlock it.',
        });
      }

      staffTerminalLocks.delete(lockKey);

      await db
        .update(staffMembers)
        .set({ lastActiveAt: new Date(), failedLoginAttempts: 0, lockedUntil: null })
        .where(eq(staffMembers.id, matched.id));

      const sessionId = crypto.randomBytes(24).toString('base64url');
      const expiresAt = new Date(Date.now() + STAFF_SESSION_TTL_MS);
      const tokenVersion = matched.tokenVersion || 1;

      await db.insert(userSessions).values({
        sessionId,
        authType: 'staff',
        staffId: matched.id,
        restaurantId: rest.id,
        role: matched.role,
        actorName: matched.name,
        tokenVersion,
        ipAddress,
        userAgent: sanitizeText(req.headers['user-agent'], 180),
        expiresAt,
      });

      const token = signAppToken({
        kind: 'staff',
        jti: sessionId,
        staffId: matched.id,
        restaurantId: rest.id,
        role: matched.role,
        name: matched.name,
        tv: tokenVersion,
        exp: expiresAt.getTime(),
      });

      await logAudit({
        restaurantId: rest.id,
        actorName: matched.name,
        actorRole: matched.role,
        action: 'STAFF_PIN_LOGIN',
        entityType: 'staff',
        entityId: matched.id,
      });

      await logSecurityEvent({
        restaurantId: rest.id,
        severity: 'low',
        eventType: 'STAFF_LOGIN_SUCCESS',
        actorIdentifier: `${matched.name} (${matched.role})`,
        ipAddress,
        path: req.originalUrl,
        method: req.method,
        statusCode: 200,
      });

      res.json({
        token,
        staff: {
          id: matched.id,
          name: matched.name,
          role: matched.role,
          restaurantId: rest.id,
          permissions: {
            ...(DEFAULT_ROLE_PERMISSIONS[matched.role] || {}),
            ...(matched.permissions || {}),
          },
        },
        restaurant: rest,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to authenticate staff PIN' });
    }
  });

  router.get('/auth/me', requireAuth, async (req: AuthedRequest, res) => {
    try {
      const authCtx = req.auth!;
      let accessibleRestaurants: Array<typeof restaurants.$inferSelect> = [];

      if (authCtx.authType === 'staff' && authCtx.restaurantId) {
        accessibleRestaurants = await db
          .select()
          .from(restaurants)
          .where(eq(restaurants.id, authCtx.restaurantId));
      } else if (authCtx.isSuperAdmin) {
        accessibleRestaurants = await db.select().from(restaurants).orderBy(restaurants.id);
      } else if (authCtx.uid) {
        const owned = await db
          .select()
          .from(restaurants)
          .where(eq(restaurants.ownerUid, authCtx.uid))
          .orderBy(restaurants.id);

        const memberships = authCtx.userId
          ? await db
              .select({ restaurantId: staffMembers.restaurantId })
              .from(staffMembers)
              .where(and(eq(staffMembers.userId, authCtx.userId), eq(staffMembers.isActive, true)))
          : [];
        const memberRestIds = memberships.map((m) => m.restaurantId);
        const memberRests =
          memberRestIds.length > 0
            ? await db.select().from(restaurants).where(inArray(restaurants.id, memberRestIds))
            : [];

        const combined = new Map<number, typeof owned[number]>();
        for (const r of [...owned, ...memberRests]) combined.set(r.id, r);
        accessibleRestaurants = Array.from(combined.values());
      }

      res.json({
        auth: authCtx,
        restaurants: accessibleRestaurants,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to load user session' });
    }
  });

  router.post('/restaurants/register', requireAuth, async (req: AuthedRequest, res) => {
    try {
      const authCtx = req.auth!;
      if (authCtx.authType !== 'firebase' || !authCtx.uid) {
        return res.status(403).json({ error: 'Google Sign-In required to register a restaurant' });
      }

      const name = String(req.body?.name || '').trim();
      const address = String(req.body?.address || '').trim();
      const city = String(req.body?.city || '').trim();
      const state = String(req.body?.state || 'Karnataka').trim();
      const phone = String(req.body?.phone || '').trim();
      const email = String(req.body?.email || authCtx.email || '').trim();
      const cuisineType = String(req.body?.cuisineType || 'Multi-Cuisine').trim();
      const gstin = String(req.body?.gstin || '').trim();
      const ownerPin = String(req.body?.managerPin || '1234').trim();

      if (!name || !address || !city || !phone) {
        return res.status(400).json({ error: 'Name, address, city, and phone are required' });
      }

      const baseSlug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
      const slug = `${baseSlug}-${crypto.randomBytes(2).toString('hex')}`;

      const [defaultPlan] = await db.select().from(platformPlans).limit(1);

      const [created] = await db
        .insert(restaurants)
        .values({
          name,
          slug,
          cuisineType,
          address,
          city,
          state,
          phone,
          email,
          gstin,
          planId: defaultPlan?.id || null,
          ownerUid: authCtx.uid,
          receiptHeader: `${name} · ${city}`,
        })
        .returning();

      // Create default owner/manager staff record, categories, and 4 starter tables
      const { hash, salt } = hashPin(ownerPin);
      await db.insert(staffMembers).values({
        restaurantId: created.id,
        userId: authCtx.userId,
        name: authCtx.displayName,
        email: authCtx.email,
        phone,
        role: 'owner',
        pinHash: hash,
        pinSalt: salt,
        permissions: DEFAULT_ROLE_PERMISSIONS.owner,
      });

      await db.insert(menuCategories).values([
        { restaurantId: created.id, name: 'Starters', sortOrder: 1 },
        { restaurantId: created.id, name: 'Mains', sortOrder: 2 },
        { restaurantId: created.id, name: 'Beverages', sortOrder: 3 },
      ]);

      const defaultQrExpiry = new Date(Date.now() + QR_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
      const starterTables = await db
        .insert(restaurantTables)
        .values([
          { restaurantId: created.id, tableNumber: 'T-01', section: 'Main Dining', capacity: 4, qrToken: generateSecureQrToken(), qrExpiresAt: defaultQrExpiry },
          { restaurantId: created.id, tableNumber: 'T-02', section: 'Main Dining', capacity: 4, qrToken: generateSecureQrToken(), qrExpiresAt: defaultQrExpiry },
          { restaurantId: created.id, tableNumber: 'T-03', section: 'Main Dining', capacity: 2, qrToken: generateSecureQrToken(), qrExpiresAt: defaultQrExpiry },
          { restaurantId: created.id, tableNumber: 'T-04', section: 'Patio', capacity: 6, qrToken: generateSecureQrToken(), qrExpiresAt: defaultQrExpiry },
        ])
        .returning();

      for (const tbl of starterTables) {
        await recordQrTokenHistory({
          restaurantId: created.id,
          tableId: tbl.id,
          rawToken: tbl.qrToken,
          tokenVersion: tbl.qrTokenVersion,
          action: 'created',
          actorName: authCtx.displayName,
          reason: 'Initial restaurant workspace provisioning',
          expiresAt: tbl.qrExpiresAt,
        });
      }

      await logAudit({
        restaurantId: created.id,
        actorName: authCtx.displayName,
        actorRole: 'owner',
        action: 'RESTAURANT_REGISTERED',
        entityType: 'restaurant',
        entityId: created.id,
      });

      res.status(201).json({ restaurant: created });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to register restaurant' });
    }
  });

  // ---------------------------------------------------------------------------
  // CUSTOMER QR ORDERING (NO ACCOUNT REQUIRED, VALIDATED QR SESSION)
  // ---------------------------------------------------------------------------

  router.get('/qr/:qrToken', async (req, res) => {
    const ipAddress = getClientIp(req);
    try {
      const rl = qrDiscoveryLimiter.consume(ipAddress);
      if (!rl.allowed) {
        res.setHeader('Retry-After', String(rl.retryAfterSeconds));
        return res.status(429).json({ error: 'Too many QR scan requests. Please wait a moment.' });
      }

      const qrToken = String(req.params.qrToken || '').trim();
      const [table] = await db
        .select()
        .from(restaurantTables)
        .where(eq(restaurantTables.qrToken, qrToken))
        .limit(1);

      if (!table || table.qrRevokedAt || (table.qrExpiresAt && table.qrExpiresAt.getTime() <= Date.now())) {
        await logSecurityEvent({
          restaurantId: table?.restaurantId ?? null,
          severity: table?.qrRevokedAt ? 'high' : 'medium',
          eventType: table?.qrRevokedAt
            ? 'REVOKED_QR_SCAN_REJECTED'
            : table?.qrExpiresAt
            ? 'EXPIRED_QR_SCAN_REJECTED'
            : 'SUSPICIOUS_QR_ACCESS',
          ipAddress,
          path: req.originalUrl,
          method: req.method,
          statusCode: 401,
          details: { tokenDigest: hashTokenSha256(qrToken).slice(0, 16) },
        });
        return res.status(401).json({ error: 'Invalid, revoked, or expired table QR code' });
      }

      const [rest] = await db
        .select()
        .from(restaurants)
        .where(eq(restaurants.id, table.restaurantId))
        .limit(1);

      if (!rest || !rest.isActive || !rest.qrOrderingEnabled) {
        return res.status(403).json({ error: 'QR ordering is currently unavailable for this outlet' });
      }

      const { session: diningSession } = await getOrCreateActiveDiningSession({
        restaurantId: rest.id,
        tableId: table.id,
        actorName: `Table ${table.tableNumber} QR Scan`,
        actorRole: 'customer_qr',
        ipAddress,
        reason: 'Customer QR scan initiated dining session',
      });

      if (table.status === 'Available') {
        await db
          .update(restaurantTables)
          .set({ status: 'Occupied' })
          .where(eq(restaurantTables.id, table.id));
        table.status = 'Occupied';
        broadcastToRestaurant(rest.id, 'table:updated', { table });
      }

      // Attempt to resume an existing valid customer QR session strictly bound to this ACTIVE dining session
      const incomingHeader = String(req.headers['x-qr-session'] || '').trim();
      const verifiedHeader = incomingHeader ? verifyAppToken(incomingHeader) : null;
      const cookies = parseCookies(req.headers.cookie);
      const cookieSid = cookies[`df_qr_sid_${table.id}`];

      let candidateUid: string | null = null;
      if (
        verifiedHeader &&
        verifiedHeader.kind === 'qr' &&
        verifiedHeader.qrToken === table.qrToken &&
        verifiedHeader.tableId === table.id &&
        verifiedHeader.restaurantId === rest.id &&
        verifiedHeader.dsid === diningSession.id &&
        verifiedHeader.tv === (table.qrTokenVersion || 1)
      ) {
        candidateUid = verifiedHeader.qsid;
      } else if (cookieSid) {
        candidateUid = cookieSid;
      }

      let customerSession: typeof customerQrSessions.$inferSelect | null = null;
      if (candidateUid) {
        const [existingQrSess] = await db
          .select()
          .from(customerQrSessions)
          .where(
            and(
              eq(customerQrSessions.qrSessionUid, candidateUid),
              eq(customerQrSessions.restaurantId, rest.id),
              eq(customerQrSessions.tableId, table.id),
              eq(customerQrSessions.diningSessionId, diningSession.id),
              isNull(customerQrSessions.revokedAt),
            ),
          )
          .limit(1);

        if (
          existingQrSess &&
          existingQrSess.expiresAt.getTime() > Date.now() &&
          Date.now() - existingQrSess.lastActivityAt.getTime() <= QR_INACTIVITY_TTL_MS
        ) {
          const [touched] = await db
            .update(customerQrSessions)
            .set({ lastActivityAt: new Date() })
            .where(eq(customerQrSessions.id, existingQrSess.id))
            .returning();
          customerSession = touched || existingQrSess;
        } else if (existingQrSess && !existingQrSess.revokedAt) {
          await db
            .update(customerQrSessions)
            .set({ revokedAt: new Date(), revokeReason: 'expired_or_idle' })
            .where(eq(customerQrSessions.id, existingQrSess.id));
        }
      }

      if (!customerSession) {
        const newUid = generateQrSessionUid();
        const expiresAt = new Date(Date.now() + QR_SESSION_TTL_MS);
        const [createdQrSess] = await db
          .insert(customerQrSessions)
          .values({
            qrSessionUid: newUid,
            restaurantId: rest.id,
            tableId: table.id,
            diningSessionId: diningSession.id,
            qrTokenVersion: table.qrTokenVersion || 1,
            pinVerified: false,
            failedPinAttempts: 0,
            lastActivityAt: new Date(),
            expiresAt,
            ipAddress,
          })
          .returning();
        customerSession = createdQrSess;

        await logSecurityEvent({
          restaurantId: rest.id,
          severity: 'low',
          eventType: 'QR_SESSION_CREATED',
          actorIdentifier: `Table ${table.tableNumber}`,
          ipAddress,
          path: req.originalUrl,
          method: req.method,
          statusCode: 200,
          details: {
            tableId: table.id,
            diningSessionId: diningSession.id,
            sessionUid: diningSession.sessionUid,
          },
        });
      }

      const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
      const maxAgeSec = Math.floor(QR_SESSION_TTL_MS / 1000);
      const cookieParts = [
        `df_qr_sid_${table.id}=${encodeURIComponent(customerSession.qrSessionUid)}`,
        'Path=/',
        `Max-Age=${maxAgeSec}`,
        'HttpOnly',
        ...(isHttps ? ['SameSite=None', 'Secure', 'Partitioned'] : ['SameSite=Lax']),
      ];
      res.setHeader('Set-Cookie', cookieParts.join('; '));

      const sessionToken = signAppToken({
        kind: 'qr',
        qsid: customerSession.qrSessionUid,
        dsid: diningSession.id,
        tableId: table.id,
        restaurantId: rest.id,
        qrToken: table.qrToken,
        tv: table.qrTokenVersion || 1,
        exp: customerSession.expiresAt.getTime(),
      });

      const clientKey = hashTokenSha256(`pin_client:${ipAddress}`).slice(0, 32);
      const [tracker] = await db
        .select()
        .from(pinAttemptTrackers)
        .where(
          and(
            eq(pinAttemptTrackers.diningSessionId, diningSession.id),
            eq(pinAttemptTrackers.clientKey, clientKey),
          ),
        )
        .limit(1);

      const now = Date.now();
      const lockUntilMs = Math.max(
        customerSession.pinLockedUntil?.getTime() || 0,
        tracker?.lockedUntil?.getTime() || 0,
      );
      const isLocked = lockUntilMs > now;
      const effectiveFails = isLocked
        ? CUSTOMER_PIN_MAX_ATTEMPTS
        : Math.max(
            customerSession.pinLockedUntil && customerSession.pinLockedUntil.getTime() <= now
              ? 0
              : customerSession.failedPinAttempts,
            tracker?.lockedUntil && tracker.lockedUntil.getTime() <= now
              ? 0
              : tracker?.failedAttempts || 0,
          );

      const pinVerifiedValid =
        Boolean(customerSession.pinVerified) &&
        customerSession.pinVerifiedVersion === diningSession.pinVersion;

      const categories = await db
        .select()
        .from(menuCategories)
        .where(and(eq(menuCategories.restaurantId, rest.id), eq(menuCategories.isActive, true)))
        .orderBy(menuCategories.sortOrder);

      const items = await db
        .select()
        .from(menuItems)
        .where(eq(menuItems.restaurantId, rest.id))
        .orderBy(menuItems.id);

      const offers = await db
        .select()
        .from(promotionalOffers)
        .where(and(eq(promotionalOffers.restaurantId, rest.id), eq(promotionalOffers.isActive, true)));

      // Strictly scope orders to the CURRENT ACTIVE dining session — never leak prior customer orders
      const activeOrders = await db
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.restaurantId, rest.id),
            eq(orders.tableId, table.id),
            eq(orders.diningSessionId, diningSession.id),
          ),
        )
        .orderBy(desc(orders.createdAt))
        .limit(15);

      const orderIds = activeOrders.map((o) => o.id);
      const itemsForOrders =
        orderIds.length > 0
          ? await db.select().from(orderItems).where(inArray(orderItems.orderId, orderIds))
          : [];

      const enrichedOrders = activeOrders
        .filter((o) => !['Closed', 'Cancelled'].includes(o.status))
        .map((o) => ({
          id: o.id,
          restaurantId: o.restaurantId,
          orderNumber: o.orderNumber,
          tableId: o.tableId,
          diningSessionId: o.diningSessionId,
          customerName: o.customerName,
          orderType: o.orderType,
          source: o.source,
          status: o.status,
          subtotal: o.subtotal,
          discountAmount: o.discountAmount,
          promoCode: o.promoCode,
          gstRateApplied: o.gstRateApplied,
          gstAmount: o.gstAmount,
          serviceChargeRateApplied: o.serviceChargeRateApplied,
          serviceChargeAmount: o.serviceChargeAmount,
          totalAmount: o.totalAmount,
          paidAmount: o.paidAmount,
          specialInstructions: o.specialInstructions,
          createdAt: o.createdAt,
          items: itemsForOrders.filter((i) => i.orderId === o.id),
        }));

      res.json({
        sessionToken,
        diningSession: {
          id: diningSession.id,
          sessionUid: diningSession.sessionUid,
          status: diningSession.status,
          startedAt: diningSession.startedAt,
          billRequested: diningSession.billRequested,
          paymentStatus: diningSession.paymentStatus,
        },
        pinState: {
          verified: pinVerifiedValid,
          requiresPin: !pinVerifiedValid,
          pinInvalidated: Boolean(customerSession.pinVerified && !pinVerifiedValid),
          failedAttempts: effectiveFails,
          maxAttempts: CUSTOMER_PIN_MAX_ATTEMPTS,
          lockedUntil: isLocked ? new Date(lockUntilMs).toISOString() : null,
          lockRemainingSeconds: isLocked ? Math.max(1, Math.ceil((lockUntilMs - now) / 1000)) : 0,
        },
        restaurant: {
          id: rest.id,
          name: rest.name,
          tagline: rest.tagline,
          cuisineType: rest.cuisineType,
          city: rest.city,
          gstRate: rest.gstRate,
          serviceChargeRate: rest.serviceChargeRate,
          openingHours: rest.openingHours,
        },
        table: {
          id: table.id,
          restaurantId: table.restaurantId,
          tableNumber: table.tableNumber,
          section: table.section,
          capacity: table.capacity,
          status: table.status,
        },
        categories,
        items,
        offers,
        activeOrders: enrichedOrders,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to load table menu' });
    }
  });

  router.get('/qr/:qrToken/stream', requireQrSession, async (req: AuthedRequest, res) => {
    try {
      const { table } = req.qrSession!;

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const clientId = `qr_${table.id}_${crypto.randomBytes(4).toString('hex')}`;
      registerSseClient(clientId, table.restaurantId, res, table.id);

      const heartbeat = setInterval(() => {
        res.write(': heartbeat\n\n');
      }, 25000);

      req.on('close', () => {
        clearInterval(heartbeat);
        removeSseClient(clientId);
      });
    } catch (err) {
      console.error(err);
      res.status(500).end();
    }
  });

  router.post('/qr/:qrToken/orders', requireQrSession, async (req: AuthedRequest, res) => {
    const ipAddress = getClientIp(req);
    try {
      const { table, restaurant: rest, qrToken, customerSession, diningSession } = req.qrSession!;

      const rl = qrOrderLimiter.consume(`${ipAddress}:${qrToken}`);
      if (!rl.allowed) {
        await logSecurityEvent({
          restaurantId: rest.id,
          severity: 'medium',
          eventType: 'QR_ORDER_RATE_LIMITED',
          ipAddress,
          path: req.originalUrl,
          method: req.method,
          statusCode: 429,
        });
        res.setHeader('Retry-After', String(rl.retryAfterSeconds));
        return res.status(429).json({ error: 'Too many order submissions. Please wait.' });
      }

      // Enforce 3-digit PIN verification & active PIN version check
      if (!customerSession.pinVerified || customerSession.pinVerifiedVersion !== diningSession.pinVersion) {
        const wasInvalidated = Boolean(
          customerSession.pinVerified && customerSession.pinVerifiedVersion !== diningSession.pinVersion,
        );
        if (wasInvalidated) {
          await db
            .update(customerQrSessions)
            .set({ pinVerified: false, pinVerifiedVersion: null })
            .where(eq(customerQrSessions.id, customerSession.id));
        }

        await logSecurityEvent({
          restaurantId: rest.id,
          severity: 'high',
          eventType: wasInvalidated ? 'EXPIRED_PIN_ORDER_BLOCKED' : 'ORDER_WITHOUT_PIN_BLOCKED',
          actorIdentifier: `Table ${table.tableNumber}`,
          ipAddress,
          path: req.originalUrl,
          method: req.method,
          statusCode: wasInvalidated ? 401 : 403,
          details: { tableId: table.id, diningSessionId: diningSession.id },
        });
        return res.status(wasInvalidated ? 401 : 403).json({
          error: wasInvalidated
            ? 'This security PIN is no longer valid. Please ask your waiter for a new code.'
            : 'Please enter the 3-digit security PIN from your waiter before placing an order.',
          requiresPin: true,
          pinInvalidated: wasInvalidated,
        });
      }

      // Enforce single-use order authorization token
      const rawOrderAuthToken = String(
        req.headers['x-order-auth-token'] || req.body?.orderAuthToken || '',
      ).trim();
      const verifiedOrderAuth = rawOrderAuthToken ? verifyAppToken(rawOrderAuthToken) : null;

      if (
        !verifiedOrderAuth ||
        verifiedOrderAuth.kind !== 'order_auth' ||
        verifiedOrderAuth.qsid !== customerSession.qrSessionUid ||
        verifiedOrderAuth.dsid !== diningSession.id ||
        verifiedOrderAuth.tableId !== table.id ||
        verifiedOrderAuth.restaurantId !== rest.id
      ) {
        await logSecurityEvent({
          restaurantId: rest.id,
          severity: 'high',
          eventType: 'INVALID_ORDER_AUTH_TOKEN_BLOCKED',
          actorIdentifier: `Table ${table.tableNumber}`,
          ipAddress,
          path: req.originalUrl,
          method: req.method,
          statusCode: 401,
          details: { tableId: table.id, diningSessionId: diningSession.id },
        });
        return res.status(401).json({
          error: 'Valid single-use order authorization token required',
        });
      }

      const rawIdempKey = sanitizeText(
        req.headers['x-idempotency-key'] || req.body?.idempotencyKey || '',
        128,
      );
      if (!rawIdempKey || rawIdempKey.length < 8) {
        return res.status(400).json({ error: 'Valid idempotencyKey is required to prevent duplicate orders' });
      }

      const { subtotal, normalizedItems } = await buildAuthoritativeOrderItems(
        rest.id,
        req.body?.items || [],
      );

      // QR guests cannot apply arbitrary manualDiscountAmount — only verified active promoCode
      const totals = await computeOrderTotals({
        restaurantId: rest.id,
        subtotal,
        promoCode: req.body?.promoCode,
        allowManualDiscount: false,
      });

      const customerName =
        sanitizeText(req.body?.customerName || `Table ${table.tableNumber} Guest`, 80) ||
        `Table ${table.tableNumber} Guest`;
      const customerPhone = sanitizeText(req.body?.customerPhone || '', 24);
      const customer = await upsertCustomerFromOrder({
        restaurantId: rest.id,
        name: customerName,
        phone: customerPhone,
      });

      const initialStatus = rest.autoAcceptQrOrders ? 'Accepted' : 'New';
      const orderNumber = `QR-${Date.now().toString().slice(-5)}`;

      const txResult = await db.transaction(async (tx) => {
        const sessLock = await tx.execute(
          sql`SELECT id, status FROM dining_sessions WHERE id = ${diningSession.id} FOR UPDATE`,
        );
        const lockedStatus = (sessLock.rows[0] as { status?: string } | undefined)?.status;
        if (lockedStatus !== 'ACTIVE') {
          return {
            errorStatus: 401,
            error: 'Your ordering session has expired. Please scan the table QR code again.',
          };
        }

        const [existingOrder] = await tx
          .select({ id: orders.id, orderNumber: orders.orderNumber })
          .from(orders)
          .where(and(eq(orders.restaurantId, rest.id), eq(orders.idempotencyKey, rawIdempKey)))
          .limit(1);

        if (existingOrder) {
          return {
            errorStatus: 409,
            error: 'Duplicate order submission blocked',
            existingOrderId: existingOrder.id,
            orderNumber: existingOrder.orderNumber,
            eventType: 'DUPLICATE_ORDER_BLOCKED',
          };
        }

        // Atomic one-time token consumption inside transaction
        const consumedTokens = await tx
          .update(orderAuthTokens)
          .set({ consumedAt: new Date() })
          .where(
            and(
              eq(orderAuthTokens.tokenJti, verifiedOrderAuth.jti),
              eq(orderAuthTokens.restaurantId, rest.id),
              eq(orderAuthTokens.tableId, table.id),
              eq(orderAuthTokens.diningSessionId, diningSession.id),
              eq(orderAuthTokens.customerQrSessionId, customerSession.id),
              isNull(orderAuthTokens.consumedAt),
              isNull(orderAuthTokens.revokedAt),
              sql`${orderAuthTokens.expiresAt} > NOW()`,
            ),
          )
          .returning({ id: orderAuthTokens.id });

        if (consumedTokens.length === 0) {
          return {
            errorStatus: 409,
            error: 'Order authorization token has already been used or expired. Please try again.',
            eventType: 'REUSED_OR_EXPIRED_ORDER_AUTH_TOKEN',
          };
        }

        const [createdOrder] = await tx
          .insert(orders)
          .values({
            restaurantId: rest.id,
            orderNumber,
            tableId: table.id,
            diningSessionId: diningSession.id,
            customerQrSessionId: customerSession.id,
            customerId: customer?.id || null,
            waiterId: table.assignedStaffId,
            customerName,
            customerPhone,
            orderType: 'dine_in',
            source: 'qr',
            status: initialStatus,
            idempotencyKey: rawIdempKey,
            ...totals,
            specialInstructions: sanitizeText(req.body?.specialInstructions || '', 300),
            acceptedAt: initialStatus === 'Accepted' ? new Date() : null,
          })
          .returning();

        const insertedItems = await tx
          .insert(orderItems)
          .values(
            normalizedItems.map((ni) => ({
              restaurantId: rest.id,
              orderId: createdOrder.id,
              ...ni,
              status: 'Queued',
            })),
          )
          .returning();

        await tx
          .update(orderAuthTokens)
          .set({ consumedByOrderId: createdOrder.id })
          .where(eq(orderAuthTokens.id, consumedTokens[0].id));

        return { createdOrder, insertedItems };
      });

      if ('errorStatus' in txResult) {
        if (txResult.eventType) {
          await logSecurityEvent({
            restaurantId: rest.id,
            severity: 'medium',
            eventType: txResult.eventType,
            actorIdentifier: `Table ${table.tableNumber}`,
            ipAddress,
            path: req.originalUrl,
            method: req.method,
            statusCode: txResult.errorStatus!,
            details: {
              tableId: table.id,
              diningSessionId: diningSession.id,
              existingOrderId: txResult.existingOrderId,
            },
          });
        }
        return res.status(txResult.errorStatus!).json({
          error: txResult.error,
          orderId: txResult.existingOrderId,
          orderNumber: txResult.orderNumber,
        });
      }

      const { createdOrder, insertedItems } = txResult;

      if (initialStatus === 'Accepted') {
        await deductInventoryForOrder(rest.id, createdOrder.id, 'Auto-Accept QR');
      }

      const nextTableStatus = initialStatus === 'Accepted' ? 'Preparing' : 'Ordering';
      const [updatedTable] = await db
        .update(restaurantTables)
        .set({ status: nextTableStatus })
        .where(eq(restaurantTables.id, table.id))
        .returning();

      const fullOrder = { ...createdOrder, tableNumber: table.tableNumber, items: insertedItems };
      broadcastToRestaurant(rest.id, 'order:created', { order: fullOrder }, table.id);
      broadcastToRestaurant(rest.id, 'table:updated', { table: updatedTable }, table.id);
      broadcastToRestaurant(
        rest.id,
        'dining_session:updated',
        { tableId: table.id, diningSessionId: diningSession.id },
        table.id,
      );

      res.status(201).json({ order: fullOrder });
    } catch (err: any) {
      if (err?.code === '23505') {
        return res.status(409).json({ error: 'Duplicate order submission blocked' });
      }
      console.error(err);
      res.status(400).json({ error: err.message || 'Failed to submit QR order' });
    }
  });

  router.post('/qr/:qrToken/service-request', requireQrSession, async (req: AuthedRequest, res) => {
    try {
      const { table, diningSession } = req.qrSession!;

      const requestType = ['waiter', 'bill', 'water'].includes(req.body?.requestType)
        ? req.body.requestType
        : 'waiter';

      const [created] = await db
        .insert(serviceRequests)
        .values({
          restaurantId: table.restaurantId,
          tableId: table.id,
          diningSessionId: diningSession.id,
          requestType,
          note: sanitizeText(req.body?.note || '', 200),
          status: 'pending',
        })
        .returning();

      if (requestType === 'bill') {
        await db
          .update(diningSessions)
          .set({ billRequested: true, billRequestedAt: new Date(), updatedAt: new Date() })
          .where(eq(diningSessions.id, diningSession.id));

        const [updatedTable] = await db
          .update(restaurantTables)
          .set({ status: 'Billing' })
          .where(eq(restaurantTables.id, table.id))
          .returning();
        broadcastToRestaurant(table.restaurantId, 'table:updated', { table: updatedTable }, table.id);
        broadcastToRestaurant(
          table.restaurantId,
          'dining_session:updated',
          { tableId: table.id, diningSessionId: diningSession.id, billRequested: true },
          table.id,
        );
      }

      broadcastToRestaurant(table.restaurantId, 'service:requested', {
        request: { ...created, tableNumber: table.tableNumber },
      });

      res.status(201).json({ request: created });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to submit service request' });
    }
  });

  router.post('/qr/:qrToken/feedback', requireQrSession, async (req: AuthedRequest, res) => {
    try {
      const { table } = req.qrSession!;

      const name = sanitizeText(req.body?.name || 'Dine-In Guest', 80) || 'Dine-In Guest';
      const phone = sanitizeText(req.body?.phone || `QR-${table.tableNumber}`, 24);
      const rating = Math.min(5, Math.max(1, Math.round(Number(req.body?.rating) || 5)));
      const comment = sanitizeText(req.body?.comment || '', 400);

      const [created] = await db
        .insert(customers)
        .values({
          restaurantId: table.restaurantId,
          name,
          phone,
          visitCount: 1,
          totalSpent: 0,
          feedbackRating: rating,
          feedbackComment: comment,
        })
        .returning();

      res.status(201).json({ customer: created });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to save feedback' });
    }
  });

  // ---------------------------------------------------------------------------
  // REALTIME SSE FOR RESTAURANT STAFF & OWNERS
  // ---------------------------------------------------------------------------

  router.get('/realtime/stream', requireAuth, requireTenant, (req: AuthedRequest, res) => {
    const restaurantId = req.auth!.restaurantId!;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const clientId = `staff_${restaurantId}_${crypto.randomBytes(5).toString('hex')}`;
    registerSseClient(clientId, restaurantId, res);

    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      removeSseClient(clientId);
    });
  });

  // ---------------------------------------------------------------------------
  // DASHBOARD & ANALYTICS + CSV EXPORTS
  // ---------------------------------------------------------------------------

  router.get('/dashboard/summary', requireAuth, requireTenant, async (req: AuthedRequest, res) => {
    try {
      const restaurantId = req.auth!.restaurantId!;
      const range = String(req.query.range || '7d');

      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      let rangeStart = new Date(now);
      if (range === 'today') {
        rangeStart = startOfToday;
      } else if (range === '30d') {
        rangeStart.setDate(rangeStart.getDate() - 30);
      } else if (range === 'all') {
        rangeStart = new Date(2020, 0, 1);
      } else {
        rangeStart.setDate(rangeStart.getDate() - 7);
      }

      const allOrders = await db
        .select()
        .from(orders)
        .where(eq(orders.restaurantId, restaurantId))
        .orderBy(desc(orders.createdAt));

      const allOrderItems = await db
        .select()
        .from(orderItems)
        .where(eq(orderItems.restaurantId, restaurantId));

      const allPayments = await db
        .select()
        .from(payments)
        .where(and(eq(payments.restaurantId, restaurantId), eq(payments.status, 'verified')))
        .orderBy(desc(payments.createdAt));

      const allExpenses = await db
        .select()
        .from(expenses)
        .where(eq(expenses.restaurantId, restaurantId));

      const allTables = await db
        .select()
        .from(restaurantTables)
        .where(eq(restaurantTables.restaurantId, restaurantId));

      const allInventory = await db
        .select()
        .from(inventoryItems)
        .where(eq(inventoryItems.restaurantId, restaurantId));

      const nonCancelled = allOrders.filter((o) => o.status !== 'Cancelled');
      const todayOrders = nonCancelled.filter((o) => new Date(o.createdAt) >= startOfToday);
      const rangeOrders = nonCancelled.filter((o) => new Date(o.createdAt) >= rangeStart);

      const todaysRevenue = todayOrders.reduce((s, o) => s + (o.paidAmount > 0 ? o.paidAmount : o.totalAmount), 0);
      const rangeRevenue = rangeOrders.reduce((s, o) => s + (o.paidAmount > 0 ? o.paidAmount : o.totalAmount), 0);
      const totalOrdersCount = rangeOrders.length;
      const averageOrderValue = totalOrdersCount > 0 ? rangeRevenue / totalOrdersCount : 0;

      const activeTablesCount = allTables.filter((t) => t.status !== 'Available').length;
      const pendingOrdersCount = allOrders.filter((o) =>
        ['New', 'Accepted', 'Preparing', 'Ready', 'Served'].includes(o.status),
      ).length;
      const completedOrdersCount = allOrders.filter((o) =>
        ['Completed', 'Paid', 'Closed'].includes(o.status),
      ).length;

      const monthlyExpenses = allExpenses
        .filter((e) => new Date(e.expenseDate) >= startOfMonth)
        .reduce((s, e) => s + e.amount, 0);

      const rangeExpenses = allExpenses
        .filter((e) => new Date(e.expenseDate) >= rangeStart)
        .reduce((s, e) => s + e.amount, 0);

      const estimatedProfit = rangeRevenue - rangeExpenses;

      const lowStockAlerts = allInventory.filter((i) => i.currentStock <= i.reorderLevel);

      // Best-selling products from real order_items in range
      const rangeOrderIds = new Set(rangeOrders.map((o) => o.id));
      const productMap = new Map<string, { name: string; qty: number; revenue: number }>();
      for (const oi of allOrderItems) {
        if (!rangeOrderIds.has(oi.orderId)) continue;
        const curr = productMap.get(oi.itemName) || { name: oi.itemName, qty: 0, revenue: 0 };
        curr.qty += oi.quantity;
        curr.revenue += oi.itemTotal;
        productMap.set(oi.itemName, curr);
      }
      const bestSellingProducts = Array.from(productMap.values())
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 6);

      // Daily chart series (last 7 days or 14 days)
      const daysCount = range === '30d' ? 14 : 7;
      const dailySeries: Array<{ date: string; label: string; revenue: number; expenses: number; orders: number }> = [];
      for (let i = daysCount - 1; i >= 0; i--) {
        const dt = new Date(now);
        dt.setDate(dt.getDate() - i);
        const key = dt.toISOString().slice(0, 10);
        const label = dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
        const dayOrders = nonCancelled.filter(
          (o) => new Date(o.createdAt).toISOString().slice(0, 10) === key,
        );
        const dayRev = dayOrders.reduce((s, o) => s + o.totalAmount, 0);
        const dayExp = allExpenses
          .filter((e) => e.expenseDate === key)
          .reduce((s, e) => s + e.amount, 0);
        dailySeries.push({
          date: key,
          label,
          revenue: Number(dayRev.toFixed(2)),
          expenses: Number(dayExp.toFixed(2)),
          orders: dayOrders.length,
        });
      }

      // Payment method mix
      const payMixMap = new Map<string, number>();
      for (const p of allPayments) {
        if (new Date(p.createdAt) < rangeStart) continue;
        payMixMap.set(p.method, (payMixMap.get(p.method) || 0) + p.amount);
      }
      const paymentMethods = Array.from(payMixMap.entries()).map(([method, amount]) => ({
        method,
        amount: Number(amount.toFixed(2)),
      }));

      // Recent transactions
      const recentTransactions = allPayments.slice(0, 8).map((p) => {
        const ord = allOrders.find((o) => o.id === p.orderId);
        return {
          ...p,
          orderNumber: ord?.orderNumber || `#${p.orderId}`,
          customerName: ord?.customerName || 'Guest',
        };
      });

      res.json({
        kpis: {
          todaysRevenue: Number(todaysRevenue.toFixed(2)),
          rangeRevenue: Number(rangeRevenue.toFixed(2)),
          totalOrders: totalOrdersCount,
          averageOrderValue: Number(averageOrderValue.toFixed(2)),
          activeTables: activeTablesCount,
          totalTables: allTables.length,
          pendingOrders: pendingOrdersCount,
          completedOrders: completedOrdersCount,
          monthlyExpenses: Number(monthlyExpenses.toFixed(2)),
          estimatedProfit: Number(estimatedProfit.toFixed(2)),
        },
        lowStockAlerts,
        bestSellingProducts,
        dailySeries,
        paymentMethods,
        recentTransactions,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to load dashboard metrics' });
    }
  });

  router.get(
    '/reports/export',
    requireAuth,
    requireTenant,
    requirePermission('view_reports'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const type = String(req.query.type || 'sales');
        const escapeCsv = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

        let csv = '';
        if (type === 'expenses') {
          const rows = await db
            .select()
            .from(expenses)
            .where(eq(expenses.restaurantId, restaurantId))
            .orderBy(desc(expenses.expenseDate));
          csv = ['Date,Category,Title,Vendor,Payment Method,Amount INR,Recorded By']
            .concat(
              rows.map((r) =>
                [r.expenseDate, r.category, r.title, r.vendorName, r.paymentMethod, r.amount, r.recordedBy]
                  .map(escapeCsv)
                  .join(','),
              ),
            )
            .join('\n');
        } else if (type === 'inventory') {
          const rows = await db
            .select()
            .from(inventoryItems)
            .where(eq(inventoryItems.restaurantId, restaurantId));
          csv = ['SKU,Name,Category,Unit,Current Stock,Reorder Level,Cost Per Unit INR']
            .concat(
              rows.map((r) =>
                [r.sku, r.name, r.category, r.unit, r.currentStock, r.reorderLevel, r.costPerUnit]
                  .map(escapeCsv)
                  .join(','),
              ),
            )
            .join('\n');
        } else {
          const rows = await db
            .select()
            .from(orders)
            .where(eq(orders.restaurantId, restaurantId))
            .orderBy(desc(orders.createdAt));
          csv = [
            'Order Number,Date,Type,Source,Status,Customer,Subtotal,Discount,GST,Service Charge,Total INR,Paid INR',
          ]
            .concat(
              rows.map((r) =>
                [
                  r.orderNumber,
                  new Date(r.createdAt).toISOString(),
                  r.orderType,
                  r.source,
                  r.status,
                  r.customerName,
                  r.subtotal,
                  r.discountAmount,
                  r.gstAmount,
                  r.serviceChargeAmount,
                  r.totalAmount,
                  r.paidAmount,
                ]
                  .map(escapeCsv)
                  .join(','),
              ),
            )
            .join('\n');
        }

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="dineflow-${type}-report.csv"`);
        res.send(csv);
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to export CSV report' });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // ORDERS & KITCHEN DISPLAY SYSTEM (KDS)
  // ---------------------------------------------------------------------------

  router.get('/orders', requireAuth, requireTenant, async (req: AuthedRequest, res) => {
    try {
      const restaurantId = req.auth!.restaurantId!;
      const allOrders = await db
        .select()
        .from(orders)
        .where(eq(orders.restaurantId, restaurantId))
        .orderBy(desc(orders.createdAt))
        .limit(120);

      const allItems = await db
        .select()
        .from(orderItems)
        .where(eq(orderItems.restaurantId, restaurantId));

      const allTables = await db
        .select()
        .from(restaurantTables)
        .where(eq(restaurantTables.restaurantId, restaurantId));

      const allPayments = await db
        .select()
        .from(payments)
        .where(eq(payments.restaurantId, restaurantId));

      const tableMap = new Map(allTables.map((t) => [t.id, t]));

      const enriched = allOrders.map((o) => ({
        ...o,
        tableNumber: o.tableId ? tableMap.get(o.tableId)?.tableNumber || null : null,
        items: allItems.filter((i) => i.orderId === o.id),
        payments: allPayments.filter((p) => p.orderId === o.id),
      }));

      res.json({ orders: enriched });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to fetch orders' });
    }
  });

  router.post(
    '/orders',
    requireAuth,
    requireTenant,
    requirePermission('manage_orders'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const rawIdempKey = sanitizeText(
          req.headers['x-idempotency-key'] || req.body?.idempotencyKey || '',
          128,
        );
        if (rawIdempKey) {
          const [existingOrder] = await db
            .select({ id: orders.id, orderNumber: orders.orderNumber })
            .from(orders)
            .where(and(eq(orders.restaurantId, restaurantId), eq(orders.idempotencyKey, rawIdempKey)))
            .limit(1);

          if (existingOrder) {
            await logSecurityEvent({
              restaurantId,
              severity: 'medium',
              eventType: 'DUPLICATE_ORDER_BLOCKED',
              actorIdentifier: `${req.auth!.displayName} (${req.auth!.role})`,
              ipAddress: getClientIp(req),
              path: req.originalUrl,
              method: req.method,
              statusCode: 409,
              details: { existingOrderId: existingOrder.id },
            });
            return res.status(409).json({
              error: 'Duplicate order submission blocked',
              orderId: existingOrder.id,
            });
          }
        }

        const orderType = ['dine_in', 'takeaway', 'parcel'].includes(req.body?.orderType)
          ? req.body.orderType
          : 'dine_in';

        const tableId = orderType === 'dine_in' && req.body?.tableId ? Number(req.body.tableId) : null;
        let tableNumber: string | null = null;
        let activeDiningSessionId: number | null = null;
        if (tableId) {
          const [tbl] = await db
            .select()
            .from(restaurantTables)
            .where(and(eq(restaurantTables.id, tableId), eq(restaurantTables.restaurantId, restaurantId)))
            .limit(1);
          if (!tbl) {
            return res.status(404).json({ error: 'Selected table not found in this restaurant' });
          }
          tableNumber = tbl.tableNumber;
          const { session } = await getOrCreateActiveDiningSession({
            restaurantId,
            tableId,
            actorName: req.auth!.displayName,
            actorRole: req.auth!.role,
            ipAddress: getClientIp(req),
            reason: 'POS dine-in order attached to dining session',
          });
          activeDiningSessionId = session.id;
        }

        const { subtotal, normalizedItems } = await buildAuthoritativeOrderItems(
          restaurantId,
          req.body?.items || [],
        );

        const canApplyManualDiscount =
          req.auth!.isSuperAdmin ||
          req.auth!.role === 'owner' ||
          req.auth!.role === 'manager' ||
          Boolean(req.auth!.permissions.manage_billing);

        const totals = await computeOrderTotals({
          restaurantId,
          subtotal,
          promoCode: req.body?.promoCode,
          manualDiscountAmount: req.body?.manualDiscountAmount,
          allowManualDiscount: canApplyManualDiscount,
        });

        const customerName = sanitizeText(req.body?.customerName || 'Walk-in Guest', 80) || 'Walk-in Guest';
        const customerPhone = sanitizeText(req.body?.customerPhone || '', 24);
        const customer = await upsertCustomerFromOrder({
          restaurantId,
          name: customerName,
          phone: customerPhone,
        });

        const acceptImmediately = req.body?.acceptImmediately !== false;
        const initialStatus = acceptImmediately ? 'Accepted' : 'New';
        const prefix = orderType === 'dine_in' ? 'DF' : orderType === 'takeaway' ? 'TK' : 'PR';
        const orderNumber = `${prefix}-${Date.now().toString().slice(-5)}`;

        const [createdOrder] = await db
          .insert(orders)
          .values({
            restaurantId,
            orderNumber,
            tableId,
            diningSessionId: activeDiningSessionId,
            customerId: customer?.id || null,
            waiterId: req.auth!.staffId || null,
            customerName,
            customerPhone,
            orderType,
            source: 'pos',
            status: initialStatus,
            idempotencyKey: rawIdempKey || null,
            ...totals,
            specialInstructions: sanitizeText(req.body?.specialInstructions || '', 300),
            acceptedAt: acceptImmediately ? new Date() : null,
          })
          .returning();

        const insertedItems = await db
          .insert(orderItems)
          .values(
            normalizedItems.map((ni) => ({
              restaurantId,
              orderId: createdOrder.id,
              ...ni,
              status: 'Queued',
            })),
          )
          .returning();

        if (acceptImmediately) {
          await deductInventoryForOrder(restaurantId, createdOrder.id, req.auth!.displayName);
        }

        if (tableId) {
          const [updatedTable] = await db
            .update(restaurantTables)
            .set({ status: acceptImmediately ? 'Preparing' : 'Ordering' })
            .where(eq(restaurantTables.id, tableId))
            .returning();
          broadcastToRestaurant(restaurantId, 'table:updated', { table: updatedTable });
          if (activeDiningSessionId) {
            broadcastToRestaurant(restaurantId, 'dining_session:updated', {
              tableId,
              diningSessionId: activeDiningSessionId,
            });
          }
        }

        await logAudit({
          restaurantId,
          actorName: req.auth!.displayName,
          actorRole: req.auth!.role,
          action: 'ORDER_CREATED',
          entityType: 'order',
          entityId: createdOrder.id,
          details: { orderNumber, totalAmount: totals.totalAmount, diningSessionId: activeDiningSessionId },
        });

        const fullOrder = { ...createdOrder, tableNumber, items: insertedItems, payments: [] };
        broadcastToRestaurant(restaurantId, 'order:created', { order: fullOrder });

        res.status(201).json({ order: fullOrder });
      } catch (err: any) {
        if (err?.code === '23505') {
          return res.status(409).json({ error: 'Duplicate order submission blocked' });
        }
        console.error(err);
        res.status(400).json({ error: err.message || 'Failed to create order' });
      }
    },
  );

  router.patch(
    '/orders/:id/status',
    requireAuth,
    requireTenant,
    requireAnyPermission(['manage_orders', 'kitchen_display']),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const orderId = Number(req.params.id);
        const nextStatus = String(req.body?.status || '').trim();
        const validStatuses = Object.keys(ALLOWED_ORDER_TRANSITIONS);
        if (!validStatuses.includes(nextStatus)) {
          return res.status(400).json({ error: 'Invalid order status' });
        }

        // Kitchen-only staff may only progress kitchen workflow states
        const hasFloorOrderPerm =
          req.auth!.isSuperAdmin || req.auth!.role === 'owner' || Boolean(req.auth!.permissions.manage_orders);
        if (!hasFloorOrderPerm && !['Accepted', 'Preparing', 'Ready', 'Served'].includes(nextStatus)) {
          await logSecurityEvent({
            restaurantId,
            severity: 'medium',
            eventType: 'PERMISSION_DENIED',
            actorIdentifier: `${req.auth!.displayName} (${req.auth!.role})`,
            ipAddress: getClientIp(req),
            path: req.originalUrl,
            method: req.method,
            statusCode: 403,
            details: { attemptedStatus: nextStatus },
          });
          return res.status(403).json({ error: 'Permission denied for this status transition' });
        }

        if (
          nextStatus === 'Cancelled' &&
          !req.auth!.permissions.cancel_orders &&
          req.auth!.role !== 'owner' &&
          !req.auth!.isSuperAdmin
        ) {
          await logSecurityEvent({
            restaurantId,
            severity: 'medium',
            eventType: 'CANCEL_ORDER_PERMISSION_DENIED',
            actorIdentifier: `${req.auth!.displayName} (${req.auth!.role})`,
            ipAddress: getClientIp(req),
            path: req.originalUrl,
            method: req.method,
            statusCode: 403,
          });
          return res.status(403).json({ error: 'Permission denied: cancel_orders required' });
        }

        // Prevent marking an order Paid without verified payment settlement
        if (nextStatus === 'Paid') {
          await logSecurityEvent({
            restaurantId,
            severity: 'high',
            eventType: 'UNVERIFIED_PAYMENT_STATUS_BLOCKED',
            actorIdentifier: `${req.auth!.displayName} (${req.auth!.role})`,
            ipAddress: getClientIp(req),
            path: req.originalUrl,
            method: req.method,
            statusCode: 403,
            details: { orderId },
          });
          return res.status(403).json({
            error: 'Orders cannot be marked Paid directly; verify payment via billing or Razorpay endpoints',
          });
        }

        const [existing] = await db
          .select()
          .from(orders)
          .where(and(eq(orders.id, orderId), eq(orders.restaurantId, restaurantId)))
          .limit(1);

        if (!existing) {
          return res.status(404).json({ error: 'Order not found' });
        }

        // Idempotent no-op if two KDS/POS clients bump to the same active workflow state concurrently
        if (existing.status === nextStatus && ['Accepted', 'Preparing', 'Ready', 'Served'].includes(nextStatus)) {
          const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
          return res.json({ order: { ...existing, items } });
        }

        const allowedNext = ALLOWED_ORDER_TRANSITIONS[existing.status] || [];
        if (!allowedNext.includes(nextStatus)) {
          await logSecurityEvent({
            restaurantId,
            severity: 'medium',
            eventType: 'INVALID_ORDER_STATE_TRANSITION',
            actorIdentifier: `${req.auth!.displayName} (${req.auth!.role})`,
            ipAddress: getClientIp(req),
            path: req.originalUrl,
            method: req.method,
            statusCode: 409,
            details: { orderId, from: existing.status, to: nextStatus },
          });
          return res.status(409).json({
            error: `Invalid order transition from ${existing.status} to ${nextStatus}`,
          });
        }

        if (nextStatus === 'Closed' && existing.paidAmount < existing.totalAmount - 0.5) {
          return res.status(400).json({ error: 'Cannot close an order with an unpaid balance' });
        }

        const now = new Date();
        const updateFields: Record<string, unknown> = {
          status: nextStatus,
          updatedAt: now,
        };
        if (['Accepted', 'Preparing', 'Ready', 'Served'].includes(nextStatus) && !existing.acceptedAt) {
          updateFields.acceptedAt = now;
        }
        if (['Preparing', 'Ready', 'Served'].includes(nextStatus) && !existing.preparingAt) {
          updateFields.preparingAt = now;
        }
        if (['Ready', 'Served'].includes(nextStatus) && !existing.readyAt) {
          updateFields.readyAt = now;
        }
        if (nextStatus === 'Served' && !existing.servedAt) {
          updateFields.servedAt = now;
        }
        if (nextStatus === 'Cancelled') {
          updateFields.cancelReason = sanitizeText(req.body?.reason || 'Cancelled by staff', 200);
          updateFields.cancelledBy = req.auth!.displayName;
        }

        const [updated] = await db
          .update(orders)
          .set(updateFields)
          .where(and(eq(orders.id, orderId), eq(orders.restaurantId, restaurantId)))
          .returning();

        if (['Accepted', 'Preparing', 'Ready', 'Served'].includes(nextStatus)) {
          await deductInventoryForOrder(restaurantId, orderId, req.auth!.displayName);
        }

        if (nextStatus === 'Ready') {
          await db
            .update(orderItems)
            .set({ status: 'Ready' })
            .where(and(eq(orderItems.orderId, orderId), eq(orderItems.restaurantId, restaurantId)));
        } else if (nextStatus === 'Served') {
          await db
            .update(orderItems)
            .set({ status: 'Served' })
            .where(and(eq(orderItems.orderId, orderId), eq(orderItems.restaurantId, restaurantId)));
        }

        if (existing.tableId) {
          const tableStatusMap: Record<string, string> = {
            Accepted: 'Preparing',
            Preparing: 'Preparing',
            Ready: 'Served',
            Served: 'Served',
            Closed: 'Available',
            Cancelled: 'Available',
          };
          const mappedTableStatus = tableStatusMap[nextStatus];
          if (mappedTableStatus) {
            const [updatedTable] = await db
              .update(restaurantTables)
              .set({ status: mappedTableStatus })
              .where(eq(restaurantTables.id, existing.tableId))
              .returning();
            broadcastToRestaurant(restaurantId, 'table:updated', { table: updatedTable }, existing.tableId);
          }
        }

        await logAudit({
          restaurantId,
          actorName: req.auth!.displayName,
          actorRole: req.auth!.role,
          action: `ORDER_STATUS_${nextStatus.toUpperCase()}`,
          entityType: 'order',
          entityId: orderId,
        });

        const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
        broadcastToRestaurant(
          restaurantId,
          'order:updated',
          { order: { ...updated, items } },
          existing.tableId || undefined,
        );

        res.json({ order: { ...updated, items } });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update order status' });
      }
    },
  );

  router.patch(
    '/orders/:id/items/:itemId/status',
    requireAuth,
    requireTenant,
    requirePermission('kitchen_display'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const orderId = Number(req.params.id);
        const itemId = Number(req.params.itemId);
        const status = String(req.body?.status || '').trim();
        if (!['Queued', 'Preparing', 'Ready', 'Served'].includes(status)) {
          return res.status(400).json({ error: 'Invalid item status' });
        }

        const [updatedItem] = await db
          .update(orderItems)
          .set({ status })
          .where(
            and(
              eq(orderItems.id, itemId),
              eq(orderItems.orderId, orderId),
              eq(orderItems.restaurantId, restaurantId),
            ),
          )
          .returning();

        if (!updatedItem) {
          return res.status(404).json({ error: 'Order item not found' });
        }

        const allOrderItems = await db
          .select()
          .from(orderItems)
          .where(and(eq(orderItems.orderId, orderId), eq(orderItems.restaurantId, restaurantId)));

        const allReady = allOrderItems.every((i) => i.status === 'Ready' || i.status === 'Served');
        const anyPreparing = allOrderItems.some((i) => i.status === 'Preparing' || i.status === 'Ready');

        const [ord] = await db
          .select()
          .from(orders)
          .where(eq(orders.id, orderId))
          .limit(1);

        let currentOrdStatus = ord?.status;
        if (ord && ['New', 'Accepted', 'Preparing'].includes(ord.status)) {
          const nextOrdStatus = allReady ? 'Ready' : anyPreparing ? 'Preparing' : ord.status;
          if (nextOrdStatus !== ord.status) {
            const now = new Date();
            await db
              .update(orders)
              .set({
                status: nextOrdStatus,
                acceptedAt: ord.acceptedAt || now,
                preparingAt: nextOrdStatus === 'Preparing' || nextOrdStatus === 'Ready' ? (ord.preparingAt || now) : ord.preparingAt,
                readyAt: nextOrdStatus === 'Ready' && !ord.readyAt ? now : ord.readyAt,
                updatedAt: now,
              })
              .where(eq(orders.id, orderId));
            await deductInventoryForOrder(restaurantId, orderId, req.auth!.displayName);
            currentOrdStatus = nextOrdStatus;
          }
        }

        broadcastToRestaurant(
          restaurantId,
          'order:updated',
          { orderId, item: updatedItem, orderStatus: currentOrdStatus },
          ord?.tableId || undefined,
        );
        res.json({ item: updatedItem, orderStatus: currentOrdStatus });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update item status' });
      }
    },
  );

  router.post(
    '/orders/:id/transfer-table',
    requireAuth,
    requireTenant,
    requirePermission('manage_tables'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const orderId = Number(req.params.id);
        const targetTableId = Number(req.body?.targetTableId);

        const [order] = await db
          .select()
          .from(orders)
          .where(and(eq(orders.id, orderId), eq(orders.restaurantId, restaurantId)))
          .limit(1);

        const [targetTable] = await db
          .select()
          .from(restaurantTables)
          .where(and(eq(restaurantTables.id, targetTableId), eq(restaurantTables.restaurantId, restaurantId)))
          .limit(1);

        if (!order || !targetTable) {
          return res.status(404).json({ error: 'Order or target table not found' });
        }

        const oldTableId = order.tableId;
        await db.transaction(async (tx) => {
          await tx
            .update(orders)
            .set({ tableId: targetTable.id, updatedAt: new Date() })
            .where(eq(orders.id, orderId));

          if (oldTableId) {
            await tx
              .update(restaurantTables)
              .set({ status: 'Available' })
              .where(eq(restaurantTables.id, oldTableId));
          }

          await tx
            .update(restaurantTables)
            .set({ status: 'Occupied' })
            .where(eq(restaurantTables.id, targetTable.id));
        });

        await logAudit({
          restaurantId,
          actorName: req.auth!.displayName,
          actorRole: req.auth!.role,
          action: 'TABLE_TRANSFERRED',
          entityType: 'order',
          entityId: orderId,
          details: { oldTableId, targetTableId },
        });

        broadcastToRestaurant(restaurantId, 'table:updated', { transferred: true });
        broadcastToRestaurant(restaurantId, 'order:updated', { orderId, targetTableId });

        res.json({ success: true });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to transfer table' });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // BILLING, PAYMENTS & RAZORPAY TEST MODE VERIFICATION
  // ---------------------------------------------------------------------------

  router.get(
    '/payments',
    requireAuth,
    requireTenant,
    requireAnyPermission(['manage_billing', 'view_reports']),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const rows = await db
          .select()
          .from(payments)
          .where(eq(payments.restaurantId, restaurantId))
          .orderBy(desc(payments.createdAt))
          .limit(100);
        res.json({ payments: rows });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load payment records' });
      }
    },
  );

  router.post(
    '/orders/:id/payments',
    requireAuth,
    requireTenant,
    requirePermission('manage_billing'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const orderId = Number(req.params.id);
        const method = String(req.body?.method || 'cash');
        if (!['cash', 'upi', 'card', 'other'].includes(method)) {
          return res.status(400).json({ error: 'Use Razorpay endpoint for online gateway payments' });
        }

        const amount = Number(req.body?.amount);
        if (!amount || amount <= 0) {
          return res.status(400).json({ error: 'Payment amount must be positive' });
        }

        const rawIdempKey = sanitizeText(
          req.headers['x-idempotency-key'] || req.body?.idempotencyKey || '',
          120,
        );
        if (rawIdempKey) {
          const [dupPay] = await db
            .select()
            .from(payments)
            .where(and(eq(payments.restaurantId, restaurantId), eq(payments.idempotencyKey, rawIdempKey)))
            .limit(1);
          if (dupPay) {
            const [existingOrd] = await db
              .select()
              .from(orders)
              .where(eq(orders.id, dupPay.orderId))
              .limit(1);
            const receipt = await issueReceiptForPayment({
              restaurantId,
              paymentId: dupPay.id,
              actorName: req.auth!.displayName,
            });
            return res.status(200).json({ payment: dupPay, order: existingOrd, receipt });
          }
        }

        const [ord] = await db
          .select()
          .from(orders)
          .where(and(eq(orders.id, orderId), eq(orders.restaurantId, restaurantId)))
          .limit(1);

        if (!ord) {
          return res.status(404).json({ error: 'Order not found' });
        }

        const paymentMethodLabel = sanitizeText(
          req.body?.paymentMethodLabel ||
            (method === 'upi' ? 'UPI' : method === 'card' ? 'Card' : method === 'cash' ? 'Cash' : 'Other'),
          50,
        );

        const [payment] = await db
          .insert(payments)
          .values({
            restaurantId,
            orderId,
            diningSessionId: ord.diningSessionId || null,
            amount,
            method,
            paymentMethodLabel,
            status: 'verified',
            initiatedBySource: 'pos',
            transactionRef: String(req.body?.transactionRef || `${method.toUpperCase()}-${Date.now().toString().slice(-6)}`),
            collectedBy: req.auth!.displayName,
            verifiedBy: req.auth!.displayName,
            verifiedAt: new Date(),
            idempotencyKey: rawIdempKey || null,
            notes: String(req.body?.notes || ''),
          })
          .returning();

        const newPaid = Number((ord.paidAmount + amount).toFixed(2));
        const isSettled = newPaid >= ord.totalAmount - 0.5;

        const [updatedOrder] = await db
          .update(orders)
          .set({
            paidAmount: newPaid,
            status: isSettled ? 'Paid' : ord.status,
            paidAt: isSettled ? new Date() : ord.paidAt,
            updatedAt: new Date(),
          })
          .where(eq(orders.id, orderId))
          .returning();

        const receipt = await issueReceiptForPayment({
          restaurantId,
          paymentId: payment.id,
          actorName: req.auth!.displayName,
        });

        if (isSettled && ord.customerId) {
          await db
            .update(customers)
            .set({
              totalSpent: sql`${customers.totalSpent} + ${ord.totalAmount}`,
              lastVisitAt: new Date(),
            })
            .where(eq(customers.id, ord.customerId));
        }

        if (ord.diningSessionId) {
          await syncDiningSessionPaymentStatus(ord.diningSessionId);
          await logSecurityEvent({
            restaurantId,
            severity: 'low',
            eventType: 'PAYMENT_VERIFIED',
            actorIdentifier: `${req.auth!.displayName} (${req.auth!.role})`,
            ipAddress: getClientIp(req),
            path: req.originalUrl,
            method: req.method,
            statusCode: 201,
            details: { orderId, diningSessionId: ord.diningSessionId, method, amount, isSettled },
          });
        }

        // Keep dining session active and table occupied (Billing) until waiter confirms departure & closes session
        if (isSettled && ord.tableId) {
          const [updatedTable] = await db
            .update(restaurantTables)
            .set({ status: ord.diningSessionId ? 'Billing' : 'Cleaning' })
            .where(eq(restaurantTables.id, ord.tableId))
            .returning();
          broadcastToRestaurant(restaurantId, 'table:updated', { table: updatedTable }, ord.tableId);
        }

        await logAudit({
          restaurantId,
          actorName: req.auth!.displayName,
          actorRole: req.auth!.role,
          action: 'PAYMENT_RECORDED',
          entityType: 'payment',
          entityId: payment.id,
          details: { orderId, method, amount, isSettled, receiptNumber: receipt.receiptNumber },
        });

        broadcastToRestaurant(
          restaurantId,
          'receipt:created',
          { receipt, tableId: ord.tableId || undefined, diningSessionId: ord.diningSessionId },
          ord.tableId || undefined,
        );
        broadcastToRestaurant(
          restaurantId,
          'order:updated',
          { order: updatedOrder, payment, receipt },
          ord.tableId || undefined,
        );

        res.status(201).json({ payment, order: updatedOrder, receipt });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to record payment' });
      }
    },
  );

  router.post(
    '/orders/:id/razorpay/create-order',
    requireAuth,
    requireTenant,
    requirePermission('manage_billing'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const orderId = Number(req.params.id);
        const [ord] = await db
          .select()
          .from(orders)
          .where(and(eq(orders.id, orderId), eq(orders.restaurantId, restaurantId)))
          .limit(1);

        if (!ord) return res.status(404).json({ error: 'Order not found' });

        const balance = Math.max(0, Number((ord.totalAmount - ord.paidAmount).toFixed(2)));
        const amountToPay = Number(req.body?.amount) > 0 ? Math.min(balance, Number(req.body.amount)) : balance;
        if (amountToPay <= 0) {
          return res.status(400).json({ error: 'Order is already fully paid' });
        }

        const razorpayOrderId = `order_rzp_test_${crypto.randomBytes(6).toString('hex')}`;

        // Strictly created in 'pending' status — never marked verified until callback verification
        const [pendingPayment] = await db
          .insert(payments)
          .values({
            restaurantId,
            orderId,
            diningSessionId: ord.diningSessionId || null,
            amount: amountToPay,
            method: 'razorpay',
            status: 'pending',
            razorpayOrderId,
            collectedBy: req.auth!.displayName,
            notes: 'Awaiting Razorpay test-mode verification',
          })
          .returning();

        if (ord.diningSessionId) {
          await syncDiningSessionPaymentStatus(ord.diningSessionId);
          await logSecurityEvent({
            restaurantId,
            severity: 'low',
            eventType: 'PAYMENT_INITIATED',
            actorIdentifier: `${req.auth!.displayName} (${req.auth!.role})`,
            ipAddress: getClientIp(req),
            path: req.originalUrl,
            method: req.method,
            statusCode: 201,
            details: { orderId, diningSessionId: ord.diningSessionId, razorpayOrderId, amount: amountToPay },
          });
        }

        res.status(201).json({
          paymentId: pendingPayment.id,
          razorpayOrderId,
          amountInr: amountToPay,
          amountPaise: Math.round(amountToPay * 100),
          currency: 'INR',
          mode: 'test',
        });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to initiate Razorpay test order' });
      }
    },
  );

  router.post(
    '/orders/:id/razorpay/verify',
    requireAuth,
    requireTenant,
    requirePermission('manage_billing'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const orderId = Number(req.params.id);
        const paymentId = Number(req.body?.paymentId);
        const razorpayOrderId = String(req.body?.razorpayOrderId || '');
        const simulateAuthorize = req.body?.authorizeTestPayment === true;
        const outcome = req.body?.outcome === 'fail' ? 'fail' : 'success';

        if (process.env.NODE_ENV === 'production' && simulateAuthorize) {
          return res.status(400).json({
            error: 'Test authorization shortcut is disabled in production; provide verified Razorpay signature',
          });
        }

        const [pending] = await db
          .select()
          .from(payments)
          .where(
            and(
              eq(payments.id, paymentId),
              eq(payments.orderId, orderId),
              eq(payments.restaurantId, restaurantId),
              eq(payments.razorpayOrderId, razorpayOrderId),
              eq(payments.status, 'pending'),
            ),
          )
          .limit(1);

        if (!pending) {
          return res.status(404).json({ error: 'Pending Razorpay transaction not found or already processed' });
        }

        const [ord] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);

        if (outcome === 'fail') {
          const [failed] = await db
            .update(payments)
            .set({ status: 'failed', notes: 'Test payment declined by customer' })
            .where(eq(payments.id, pending.id))
            .returning();

          if (ord?.diningSessionId) {
            await syncDiningSessionPaymentStatus(ord.diningSessionId);
            await logSecurityEvent({
              restaurantId,
              severity: 'medium',
              eventType: 'PAYMENT_FAILED',
              actorIdentifier: `${req.auth!.displayName} (${req.auth!.role})`,
              ipAddress: getClientIp(req),
              path: req.originalUrl,
              method: req.method,
              statusCode: 402,
              details: { orderId, diningSessionId: ord.diningSessionId, razorpayOrderId },
            });
          }
          return res.status(402).json({ error: 'Payment declined in Razorpay Test Mode', payment: failed });
        }

        // Generate or verify HMAC signature
        const rzpPaymentId = String(req.body?.razorpayPaymentId || `pay_test_${crypto.randomBytes(5).toString('hex')}`);
        const signature = simulateAuthorize
          ? generateRazorpayTestSignature(razorpayOrderId, rzpPaymentId)
          : String(req.body?.razorpaySignature || '');

        if (!verifyRazorpayTestSignature(razorpayOrderId, rzpPaymentId, signature)) {
          await logSecurityEvent({
            restaurantId,
            severity: 'high',
            eventType: 'RAZORPAY_SIGNATURE_INVALID',
            actorIdentifier: `${req.auth!.displayName} (${req.auth!.role})`,
            ipAddress: getClientIp(req),
            path: req.originalUrl,
            method: req.method,
            statusCode: 400,
            details: { orderId, razorpayOrderId },
          });
          return res.status(400).json({ error: 'Razorpay signature verification failed' });
        }

        const [verifiedPayment] = await db
          .update(payments)
          .set({
            status: 'verified',
            razorpayPaymentId: rzpPaymentId,
            razorpaySignature: signature,
            transactionRef: rzpPaymentId,
            verifiedBy: req.auth!.displayName,
            verifiedAt: new Date(),
            notes: 'Verified via Razorpay Test Mode HMAC',
          })
          .where(eq(payments.id, pending.id))
          .returning();

        const newPaid = Number(((ord?.paidAmount || 0) + pending.amount).toFixed(2));
        const isSettled = ord ? newPaid >= ord.totalAmount - 0.5 : true;

        const [updatedOrder] = await db
          .update(orders)
          .set({
            paidAmount: newPaid,
            status: isSettled ? 'Paid' : ord?.status || 'Served',
            paidAt: isSettled ? new Date() : ord?.paidAt || null,
            updatedAt: new Date(),
          })
          .where(eq(orders.id, orderId))
          .returning();

        const receipt = await issueReceiptForPayment({
          restaurantId,
          paymentId: verifiedPayment.id,
          actorName: req.auth!.displayName,
        });

        if (ord?.diningSessionId) {
          await syncDiningSessionPaymentStatus(ord.diningSessionId);
          await logSecurityEvent({
            restaurantId,
            severity: 'low',
            eventType: 'PAYMENT_VERIFIED',
            actorIdentifier: `${req.auth!.displayName} (${req.auth!.role})`,
            ipAddress: getClientIp(req),
            path: req.originalUrl,
            method: req.method,
            statusCode: 200,
            details: {
              orderId,
              diningSessionId: ord.diningSessionId,
              razorpayOrderId,
              isSettled,
              receiptNumber: receipt.receiptNumber,
            },
          });
        }

        if (isSettled && ord?.tableId) {
          const [updatedTable] = await db
            .update(restaurantTables)
            .set({ status: ord.diningSessionId ? 'Billing' : 'Cleaning' })
            .where(eq(restaurantTables.id, ord.tableId))
            .returning();
          broadcastToRestaurant(restaurantId, 'table:updated', { table: updatedTable }, ord.tableId);
        }

        broadcastToRestaurant(
          restaurantId,
          'receipt:created',
          { receipt, tableId: ord?.tableId || undefined, diningSessionId: ord?.diningSessionId },
          ord?.tableId || undefined,
        );
        broadcastToRestaurant(restaurantId, 'order:updated', {
          order: updatedOrder,
          payment: verifiedPayment,
          receipt,
        });
        res.json({ payment: verifiedPayment, order: updatedOrder, receipt });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to verify Razorpay payment' });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // TABLES, QR CODES & SERVICE REQUESTS
  // ---------------------------------------------------------------------------

  router.get('/tables', requireAuth, requireTenant, async (req: AuthedRequest, res) => {
    try {
      const restaurantId = req.auth!.restaurantId!;
      const tables = await db
        .select()
        .from(restaurantTables)
        .where(eq(restaurantTables.restaurantId, restaurantId))
        .orderBy(restaurantTables.id);

      const reqs = await db
        .select()
        .from(serviceRequests)
        .where(and(eq(serviceRequests.restaurantId, restaurantId), eq(serviceRequests.status, 'pending')))
        .orderBy(desc(serviceRequests.createdAt));

      res.json({ tables, serviceRequests: reqs });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to load tables' });
    }
  });

  router.post(
    '/tables',
    requireAuth,
    requireTenant,
    requirePermission('manage_tables'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const tableNumber = String(req.body?.tableNumber || '').trim();
        const section = String(req.body?.section || 'Main Dining').trim();
        const capacity = Math.max(1, Number(req.body?.capacity) || 4);
        const assignedStaffId = req.body?.assignedStaffId ? Number(req.body.assignedStaffId) : null;

        if (!tableNumber) {
          return res.status(400).json({ error: 'Table number is required' });
        }

        const qrToken = generateSecureQrToken();
        const expiresAt = new Date(Date.now() + QR_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

        const [created] = await db
          .insert(restaurantTables)
          .values({
            restaurantId,
            tableNumber,
            section,
            capacity,
            assignedStaffId,
            status: 'Available',
            qrToken,
            qrTokenVersion: 1,
            qrExpiresAt: expiresAt,
          })
          .returning();

        await recordQrTokenHistory({
          restaurantId,
          tableId: created.id,
          rawToken: qrToken,
          tokenVersion: 1,
          action: 'created',
          actorName: req.auth!.displayName,
          reason: 'Table created',
          expiresAt,
        });

        broadcastToRestaurant(restaurantId, 'table:updated', { table: created });
        res.status(201).json({ table: created });
      } catch (err) {
        console.error(err);
        res.status(400).json({ error: 'Table number already exists or invalid payload' });
      }
    },
  );

  router.patch(
    '/tables/:id',
    requireAuth,
    requireTenant,
    requirePermission('manage_tables'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const id = Number(req.params.id);
        const [existing] = await db
          .select()
          .from(restaurantTables)
          .where(and(eq(restaurantTables.id, id), eq(restaurantTables.restaurantId, restaurantId)))
          .limit(1);

        if (!existing) return res.status(404).json({ error: 'Table not found' });

        const updates: Record<string, unknown> = {};
        if (req.body?.tableNumber) updates.tableNumber = sanitizeText(req.body.tableNumber, 24);
        if (req.body?.section) updates.section = sanitizeText(req.body.section, 60);
        if (req.body?.capacity) updates.capacity = Math.max(1, Math.min(30, Number(req.body.capacity)));
        if (req.body?.status) updates.status = sanitizeText(req.body.status, 24);
        if (req.body?.assignedStaffId !== undefined) {
          updates.assignedStaffId = req.body.assignedStaffId ? Number(req.body.assignedStaffId) : null;
        }
        let regeneratedToken: string | null = null;
        let nextVersion = existing.qrTokenVersion || 1;
        let nextExpiresAt = existing.qrExpiresAt;
        if (req.body?.regenerateQr === true) {
          regeneratedToken = generateSecureQrToken();
          nextVersion += 1;
          nextExpiresAt = new Date(Date.now() + QR_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
          updates.qrToken = regeneratedToken;
          updates.qrTokenVersion = nextVersion;
          updates.qrExpiresAt = nextExpiresAt;
          updates.qrRevokedAt = null;
        }

        const [updated] = await db
          .update(restaurantTables)
          .set(updates)
          .where(and(eq(restaurantTables.id, id), eq(restaurantTables.restaurantId, restaurantId)))
          .returning();

        if (regeneratedToken) {
          await recordQrTokenHistory({
            restaurantId,
            tableId: id,
            rawToken: regeneratedToken,
            tokenVersion: nextVersion,
            action: 'regenerated',
            actorName: req.auth!.displayName,
            reason: 'Regenerated via table settings',
            expiresAt: nextExpiresAt,
          });
        }

        broadcastToRestaurant(restaurantId, 'table:updated', { table: updated });
        res.json({ table: updated });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update table' });
      }
    },
  );

  router.delete(
    '/tables/:id',
    requireAuth,
    requireTenant,
    requirePermission('manage_tables'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const id = Number(req.params.id);
        await db
          .delete(restaurantTables)
          .where(and(eq(restaurantTables.id, id), eq(restaurantTables.restaurantId, restaurantId)));
        res.json({ deleted: true });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete table' });
      }
    },
  );

  router.get(
    '/tables/:id/qr',
    requireAuth,
    requireTenant,
    requirePermission('manage_tables'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const id = Number(req.params.id);
        const [table] = await db
          .select()
          .from(restaurantTables)
          .where(and(eq(restaurantTables.id, id), eq(restaurantTables.restaurantId, restaurantId)))
          .limit(1);

        if (!table) return res.status(404).json({ error: 'Table not found' });
        if (table.qrRevokedAt) {
          return res.status(409).json({ error: 'Table QR is currently revoked. Regenerate a new QR code first.' });
        }
        const baseUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
        const qrUrl = `${baseUrl}/?qr=${encodeURIComponent(table.qrToken)}`;
        const dataUrl = await QRCode.toDataURL(qrUrl, {
          width: 320,
          margin: 2,
          color: { dark: '#0F172A', light: '#FFFFFF' },
        });

        res.json({
          qrUrl,
          dataUrl,
          qrToken: table.qrToken,
          tableNumber: table.tableNumber,
          qrExpiresAt: table.qrExpiresAt,
          qrRevokedAt: table.qrRevokedAt,
        });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to generate QR code' });
      }
    },
  );

  router.patch('/service-requests/:id', requireAuth, requireTenant, async (req: AuthedRequest, res) => {
    try {
      const restaurantId = req.auth!.restaurantId!;
      const id = Number(req.params.id);
      const status = req.body?.status === 'acknowledged' ? 'acknowledged' : 'resolved';

      const [updated] = await db
        .update(serviceRequests)
        .set({
          status,
          handledBy: req.auth!.displayName,
          resolvedAt: status === 'resolved' ? new Date() : null,
        })
        .where(and(eq(serviceRequests.id, id), eq(serviceRequests.restaurantId, restaurantId)))
        .returning();

      if (!updated) return res.status(404).json({ error: 'Service request not found' });
      broadcastToRestaurant(restaurantId, 'service:updated', { request: updated });
      res.json({ request: updated });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to update service request' });
    }
  });

  // ---------------------------------------------------------------------------
  // MENU & PROMOTIONAL OFFERS
  // ---------------------------------------------------------------------------

  router.get('/menu', requireAuth, requireTenant, async (req: AuthedRequest, res) => {
    try {
      const restaurantId = req.auth!.restaurantId!;
      const categories = await db
        .select()
        .from(menuCategories)
        .where(eq(menuCategories.restaurantId, restaurantId))
        .orderBy(menuCategories.sortOrder, menuCategories.id);

      const items = await db
        .select()
        .from(menuItems)
        .where(eq(menuItems.restaurantId, restaurantId))
        .orderBy(menuItems.id);

      const offers = await db
        .select()
        .from(promotionalOffers)
        .where(eq(promotionalOffers.restaurantId, restaurantId))
        .orderBy(promotionalOffers.id);

      res.json({ categories, items, offers });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to load menu' });
    }
  });

  router.post(
    '/menu/categories',
    requireAuth,
    requireTenant,
    requirePermission('manage_menu'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const name = String(req.body?.name || '').trim();
        if (!name) return res.status(400).json({ error: 'Category name is required' });

        const [created] = await db
          .insert(menuCategories)
          .values({
            restaurantId,
            name,
            description: String(req.body?.description || ''),
            sortOrder: Number(req.body?.sortOrder) || 10,
          })
          .returning();

        broadcastToRestaurant(restaurantId, 'menu:updated', { category: created });
        res.status(201).json({ category: created });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create category' });
      }
    },
  );

  router.delete(
    '/menu/categories/:id',
    requireAuth,
    requireTenant,
    requirePermission('manage_menu'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        await db
          .delete(menuCategories)
          .where(and(eq(menuCategories.id, Number(req.params.id)), eq(menuCategories.restaurantId, restaurantId)));
        broadcastToRestaurant(restaurantId, 'menu:updated', {});
        res.json({ deleted: true });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete category' });
      }
    },
  );

  router.post(
    '/menu/items',
    requireAuth,
    requireTenant,
    requirePermission('manage_menu'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const categoryId = Number(req.body?.categoryId);
        const name = String(req.body?.name || '').trim();
        const price = Number(req.body?.price);

        if (!categoryId || !name || Number.isNaN(price) || price < 0) {
          return res.status(400).json({ error: 'Valid category, name, and price required' });
        }

        const [created] = await db
          .insert(menuItems)
          .values({
            restaurantId,
            categoryId,
            name,
            description: String(req.body?.description || ''),
            price,
            isVeg: req.body?.isVeg !== false,
            imageUrl: String(req.body?.imageUrl || ''),
            prepTimeMins: Math.max(1, Number(req.body?.prepTimeMins) || 15),
            variants: Array.isArray(req.body?.variants) ? req.body.variants : [],
            addons: Array.isArray(req.body?.addons) ? req.body.addons : [],
            isCombo: req.body?.isCombo === true,
            comboDetails: String(req.body?.comboDetails || ''),
            isAvailable: req.body?.isAvailable !== false,
            isFeatured: req.body?.isFeatured === true,
          })
          .returning();

        broadcastToRestaurant(restaurantId, 'menu:updated', { item: created });
        res.status(201).json({ item: created });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create menu item' });
      }
    },
  );

  router.patch(
    '/menu/items/:id',
    requireAuth,
    requireTenant,
    requirePermission('manage_menu'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const id = Number(req.params.id);
        const updates: Record<string, unknown> = {};
        if (req.body?.name !== undefined) updates.name = String(req.body.name).trim();
        if (req.body?.description !== undefined) updates.description = String(req.body.description);
        if (req.body?.price !== undefined) updates.price = Number(req.body.price);
        if (req.body?.categoryId !== undefined) updates.categoryId = Number(req.body.categoryId);
        if (req.body?.isVeg !== undefined) updates.isVeg = Boolean(req.body.isVeg);
        if (req.body?.isAvailable !== undefined) updates.isAvailable = Boolean(req.body.isAvailable);
        if (req.body?.isFeatured !== undefined) updates.isFeatured = Boolean(req.body.isFeatured);
        if (req.body?.imageUrl !== undefined) updates.imageUrl = String(req.body.imageUrl);
        if (req.body?.variants !== undefined) updates.variants = req.body.variants;
        if (req.body?.addons !== undefined) updates.addons = req.body.addons;

        const [updated] = await db
          .update(menuItems)
          .set(updates)
          .where(and(eq(menuItems.id, id), eq(menuItems.restaurantId, restaurantId)))
          .returning();

        if (!updated) return res.status(404).json({ error: 'Menu item not found' });
        broadcastToRestaurant(restaurantId, 'menu:updated', { item: updated });
        res.json({ item: updated });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update menu item' });
      }
    },
  );

  router.delete(
    '/menu/items/:id',
    requireAuth,
    requireTenant,
    requirePermission('manage_menu'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        await db
          .delete(menuItems)
          .where(and(eq(menuItems.id, Number(req.params.id)), eq(menuItems.restaurantId, restaurantId)));
        broadcastToRestaurant(restaurantId, 'menu:updated', {});
        res.json({ deleted: true });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete menu item' });
      }
    },
  );

  router.post(
    '/menu/offers',
    requireAuth,
    requireTenant,
    requirePermission('manage_menu'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const title = String(req.body?.title || '').trim();
        const code = String(req.body?.code || '').trim().toUpperCase();
        const discountType = req.body?.discountType === 'flat' ? 'flat' : 'percent';
        const discountValue = Number(req.body?.discountValue);
        if (!title || !code || Number.isNaN(discountValue) || discountValue <= 0) {
          return res.status(400).json({ error: 'Valid offer title, code, and discount required' });
        }

        const [created] = await db
          .insert(promotionalOffers)
          .values({
            restaurantId,
            title,
            code,
            discountType,
            discountValue,
            minOrderAmount: Math.max(0, Number(req.body?.minOrderAmount) || 0),
            maxDiscount: Math.max(0, Number(req.body?.maxDiscount) || 0),
            isActive: true,
          })
          .returning();

        broadcastToRestaurant(restaurantId, 'menu:updated', {});
        res.status(201).json({ offer: created });
      } catch (err) {
        console.error(err);
        res.status(400).json({ error: 'Offer code already exists or invalid data' });
      }
    },
  );

  router.patch(
    '/menu/offers/:id',
    requireAuth,
    requireTenant,
    requirePermission('manage_menu'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const [updated] = await db
          .update(promotionalOffers)
          .set({ isActive: Boolean(req.body?.isActive) })
          .where(and(eq(promotionalOffers.id, Number(req.params.id)), eq(promotionalOffers.restaurantId, restaurantId)))
          .returning();
        res.json({ offer: updated });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to toggle offer' });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // INVENTORY, SUPPLIERS & RECIPES
  // ---------------------------------------------------------------------------

  router.get(
    '/inventory',
    requireAuth,
    requireTenant,
    requireAnyPermission(['manage_inventory', 'manage_orders', 'kitchen_display', 'view_reports']),
    async (req: AuthedRequest, res) => {
    try {
      const restaurantId = req.auth!.restaurantId!;
      const items = await db
        .select()
        .from(inventoryItems)
        .where(eq(inventoryItems.restaurantId, restaurantId))
        .orderBy(inventoryItems.name);

      const supps = await db
        .select()
        .from(suppliers)
        .where(eq(suppliers.restaurantId, restaurantId))
        .orderBy(suppliers.name);

      const recipes = await db
        .select()
        .from(menuItemRecipes)
        .where(eq(menuItemRecipes.restaurantId, restaurantId));

      const movements = await db
        .select()
        .from(stockMovements)
        .where(eq(stockMovements.restaurantId, restaurantId))
        .orderBy(desc(stockMovements.createdAt))
        .limit(80);

      res.json({ items, suppliers: supps, recipes, movements });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to load inventory' });
    }
  });

  router.post(
    '/inventory/suppliers',
    requireAuth,
    requireTenant,
    requirePermission('manage_inventory'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const name = String(req.body?.name || '').trim();
        if (!name) return res.status(400).json({ error: 'Supplier name required' });

        const [created] = await db
          .insert(suppliers)
          .values({
            restaurantId,
            name,
            contactPerson: String(req.body?.contactPerson || ''),
            phone: String(req.body?.phone || ''),
            email: String(req.body?.email || ''),
            category: String(req.body?.category || 'Groceries & Staples'),
            address: String(req.body?.address || ''),
          })
          .returning();

        res.status(201).json({ supplier: created });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to add supplier' });
      }
    },
  );

  router.post(
    '/inventory/items',
    requireAuth,
    requireTenant,
    requirePermission('manage_inventory'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const name = String(req.body?.name || '').trim();
        if (!name) return res.status(400).json({ error: 'Ingredient name required' });

        const initialStock = Math.max(0, Number(req.body?.currentStock) || 0);
        const costPerUnit = Math.max(0, Number(req.body?.costPerUnit) || 0);

        const [created] = await db
          .insert(inventoryItems)
          .values({
            restaurantId,
            supplierId: req.body?.supplierId ? Number(req.body.supplierId) : null,
            name,
            sku: String(req.body?.sku || `SKU-${Date.now().toString().slice(-4)}`),
            category: String(req.body?.category || 'Ingredients'),
            unit: String(req.body?.unit || 'kg'),
            currentStock: initialStock,
            reorderLevel: Math.max(0, Number(req.body?.reorderLevel) || 5),
            costPerUnit,
          })
          .returning();

        if (initialStock > 0) {
          await db.insert(stockMovements).values({
            restaurantId,
            inventoryItemId: created.id,
            movementType: 'purchase',
            quantityDelta: initialStock,
            unitCost: costPerUnit,
            notes: 'Initial opening stock',
            createdBy: req.auth!.displayName,
          });
        }

        res.status(201).json({ item: created });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create inventory item' });
      }
    },
  );

  router.post(
    '/inventory/adjust',
    requireAuth,
    requireTenant,
    requirePermission('manage_inventory'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const inventoryItemId = Number(req.body?.inventoryItemId);
        const movementType = ['purchase', 'wastage', 'adjustment'].includes(req.body?.movementType)
          ? req.body.movementType
          : 'adjustment';
        const rawQty = Number(req.body?.quantity);
        if (!inventoryItemId || !rawQty || Number.isNaN(rawQty)) {
          return res.status(400).json({ error: 'Valid item and quantity required' });
        }

        const delta = movementType === 'wastage' ? -Math.abs(rawQty) : movementType === 'purchase' ? Math.abs(rawQty) : rawQty;

        const [updated] = await db
          .update(inventoryItems)
          .set({
            currentStock: sql`GREATEST(0, ${inventoryItems.currentStock} + ${delta})`,
            lastRestockedAt: movementType === 'purchase' ? new Date() : undefined,
          })
          .where(and(eq(inventoryItems.id, inventoryItemId), eq(inventoryItems.restaurantId, restaurantId)))
          .returning();

        if (!updated) return res.status(404).json({ error: 'Inventory item not found' });

        const [movement] = await db
          .insert(stockMovements)
          .values({
            restaurantId,
            inventoryItemId,
            movementType,
            quantityDelta: delta,
            unitCost: Number(req.body?.unitCost) || updated.costPerUnit,
            notes: String(req.body?.notes || ''),
            createdBy: req.auth!.displayName,
          })
          .returning();

        res.json({ item: updated, movement });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to adjust stock' });
      }
    },
  );

  router.put(
    '/inventory/recipes/:menuItemId',
    requireAuth,
    requireTenant,
    requirePermission('manage_inventory'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const menuItemId = Number(req.params.menuItemId);
        const ingredients = Array.isArray(req.body?.ingredients) ? req.body.ingredients : [];

        await db.transaction(async (tx) => {
          await tx
            .delete(menuItemRecipes)
            .where(and(eq(menuItemRecipes.restaurantId, restaurantId), eq(menuItemRecipes.menuItemId, menuItemId)));

          if (ingredients.length > 0) {
            await tx.insert(menuItemRecipes).values(
              ingredients.map((ing: { inventoryItemId: number; quantityRequired: number }) => ({
                restaurantId,
                menuItemId,
                inventoryItemId: Number(ing.inventoryItemId),
                quantityRequired: Math.max(0.001, Number(ing.quantityRequired)),
              })),
            );
          }
        });

        const updatedRecipes = await db
          .select()
          .from(menuItemRecipes)
          .where(and(eq(menuItemRecipes.restaurantId, restaurantId), eq(menuItemRecipes.menuItemId, menuItemId)));

        res.json({ recipes: updatedRecipes });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to save recipe mapping' });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // EXPENSES & RECEIPT UPLOADS
  // ---------------------------------------------------------------------------

  router.post(
    '/uploads/receipt',
    requireAuth,
    requireTenant,
    requirePermission('manage_expenses'),
    uploadReceipt.single('receipt'),
    async (req: AuthedRequest, res) => {
      if (!req.file) {
        return res.status(400).json({ error: 'No receipt file uploaded' });
      }
      const check = validateReceiptMagicBytes(req.file.path);
      if (!check.valid) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {
          // ignore cleanup failure
        }
        await logSecurityEvent({
          restaurantId: req.auth!.restaurantId,
          severity: 'high',
          eventType: 'MALICIOUS_UPLOAD_REJECTED',
          actorIdentifier: `${req.auth!.displayName} (${req.auth!.role})`,
          ipAddress: getClientIp(req),
          path: req.originalUrl,
          method: req.method,
          statusCode: 400,
          details: { detectedType: check.detectedType },
        });
        return res.status(400).json({ error: 'Uploaded file content does not match allowed image/PDF formats' });
      }
      res.status(201).json({ receiptUrl: `/api/uploads/receipts/${req.file.filename}` });
    },
  );

  router.get(
    '/uploads/receipts/:filename',
    requireAuth,
    requireTenant,
    requireAnyPermission(['manage_expenses', 'view_reports']),
    async (req: AuthedRequest, res) => {
      const restaurantId = req.auth!.restaurantId!;
      const rawFilename = String(req.params.filename || '');
      const safePath = resolveSafeReceiptPath(rawFilename);
      if (!safePath || !fs.existsSync(safePath)) {
        return res.status(404).json({ error: 'Receipt not found' });
      }

      const baseName = path.basename(safePath);
      const isOwnedByPrefix = baseName.startsWith(`rcpt_r${restaurantId}_`);
      const [expenseMatch] = await db
        .select({ id: expenses.id })
        .from(expenses)
        .where(
          and(
            eq(expenses.restaurantId, restaurantId),
            eq(expenses.receiptUrl, `/api/uploads/receipts/${baseName}`),
          ),
        )
        .limit(1);

      if (!isOwnedByPrefix && !expenseMatch) {
        await logSecurityEvent({
          restaurantId,
          severity: 'high',
          eventType: 'CROSS_TENANT_RECEIPT_ACCESS_BLOCKED',
          actorIdentifier: `${req.auth!.displayName} (${req.auth!.role})`,
          ipAddress: getClientIp(req),
          path: req.originalUrl,
          method: req.method,
          statusCode: 403,
        });
        return res.status(403).json({ error: 'Access denied to this receipt file' });
      }

      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.sendFile(safePath);
    },
  );

  router.get(
    '/expenses',
    requireAuth,
    requireTenant,
    requireAnyPermission(['manage_expenses', 'view_reports']),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const rows = await db
          .select()
          .from(expenses)
          .where(eq(expenses.restaurantId, restaurantId))
          .orderBy(desc(expenses.expenseDate), desc(expenses.id));
        res.json({ expenses: rows });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load expenses' });
      }
    },
  );

  router.post(
    '/expenses',
    requireAuth,
    requireTenant,
    requirePermission('manage_expenses'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const title = String(req.body?.title || '').trim();
        const category = String(req.body?.category || 'Other').trim();
        const amount = Number(req.body?.amount);
        const expenseDate = String(req.body?.expenseDate || new Date().toISOString().slice(0, 10));
        if (!title || !amount || amount <= 0) {
          return res.status(400).json({ error: 'Valid title and positive amount required' });
        }

        const [created] = await db
          .insert(expenses)
          .values({
            restaurantId,
            category,
            title,
            amount,
            expenseDate,
            paymentMethod: String(req.body?.paymentMethod || 'upi'),
            vendorName: String(req.body?.vendorName || ''),
            description: String(req.body?.description || ''),
            receiptUrl: String(req.body?.receiptUrl || ''),
            recordedBy: req.auth!.displayName,
          })
          .returning();

        res.status(201).json({ expense: created });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to save expense' });
      }
    },
  );

  router.delete(
    '/expenses/:id',
    requireAuth,
    requireTenant,
    requirePermission('manage_expenses'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        await db
          .delete(expenses)
          .where(and(eq(expenses.id, Number(req.params.id)), eq(expenses.restaurantId, restaurantId)));
        res.json({ deleted: true });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete expense' });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // CUSTOMERS, STAFF & SETTINGS
  // ---------------------------------------------------------------------------

  router.get(
    '/customers',
    requireAuth,
    requireTenant,
    requireAnyPermission(['manage_orders', 'view_reports']),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const rows = await db
          .select()
          .from(customers)
          .where(eq(customers.restaurantId, restaurantId))
          .orderBy(desc(customers.totalSpent));
        res.json({ customers: rows });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load customers' });
      }
    },
  );

  router.post(
    '/customers',
    requireAuth,
    requireTenant,
    requireAnyPermission(['manage_orders', 'view_reports']),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const name = sanitizeText(req.body?.name || '', 80);
        const phone = sanitizeText(req.body?.phone || '', 24);
        if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });

        const [created] = await db
          .insert(customers)
          .values({
            restaurantId,
            name,
            phone,
            email: sanitizeText(req.body?.email || '', 120),
            notes: sanitizeText(req.body?.notes || '', 250),
          })
          .returning();
        res.status(201).json({ customer: created });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create customer' });
      }
    },
  );

  router.get(
    '/staff',
    requireAuth,
    requireTenant,
    requireAnyPermission(['manage_staff', 'manage_tables']),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const canViewFullStaff =
          req.auth!.isSuperAdmin ||
          req.auth!.role === 'owner' ||
          Boolean(req.auth!.permissions.manage_staff);

        const members = await db
          .select({
            id: staffMembers.id,
            restaurantId: staffMembers.restaurantId,
            name: staffMembers.name,
            email: staffMembers.email,
            phone: staffMembers.phone,
            role: staffMembers.role,
            permissions: staffMembers.permissions,
            isActive: staffMembers.isActive,
            lastActiveAt: staffMembers.lastActiveAt,
            createdAt: staffMembers.createdAt,
          })
          .from(staffMembers)
          .where(eq(staffMembers.restaurantId, restaurantId))
          .orderBy(staffMembers.id);

        if (!canViewFullStaff) {
          return res.json({
            staff: members.map((m) => ({
              id: m.id,
              restaurantId: m.restaurantId,
              name: m.name,
              role: m.role,
              isActive: m.isActive,
            })),
            auditLogs: [],
          });
        }

        const logs = await db
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.restaurantId, restaurantId))
          .orderBy(desc(auditLogs.createdAt))
          .limit(40);

        res.json({ staff: members, auditLogs: logs });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load staff' });
      }
    },
  );

  router.post(
    '/staff',
    requireAuth,
    requireTenant,
    requirePermission('manage_staff'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const name = sanitizeText(req.body?.name || '', 80);
        const role = ['owner', 'manager', 'waiter', 'kitchen'].includes(req.body?.role)
          ? req.body.role
          : 'waiter';
        const pin = String(req.body?.pin || '').trim();
        if (!name || !/^\d{4,6}$/.test(pin)) {
          return res.status(400).json({ error: 'Staff name and 4-6 digit numeric PIN required' });
        }

        const { hash, salt } = hashPin(pin);
        const [created] = await db
          .insert(staffMembers)
          .values({
            restaurantId,
            name,
            email: sanitizeText(req.body?.email || '', 120),
            phone: sanitizeText(req.body?.phone || '', 24),
            role,
            pinHash: hash,
            pinSalt: salt,
            permissions: req.body?.permissions || DEFAULT_ROLE_PERMISSIONS[role] || {},
          })
          .returning({
            id: staffMembers.id,
            restaurantId: staffMembers.restaurantId,
            name: staffMembers.name,
            email: staffMembers.email,
            phone: staffMembers.phone,
            role: staffMembers.role,
            permissions: staffMembers.permissions,
            isActive: staffMembers.isActive,
            createdAt: staffMembers.createdAt,
          });

        await logAudit({
          restaurantId,
          actorName: req.auth!.displayName,
          actorRole: req.auth!.role,
          action: 'STAFF_CREATED',
          entityType: 'staff',
          entityId: created.id,
          details: { name, role },
        });

        res.status(201).json({ staff: created });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to add staff member' });
      }
    },
  );

  router.patch(
    '/staff/:id',
    requireAuth,
    requireTenant,
    requirePermission('manage_staff'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const id = Number(req.params.id);
        const updates: Record<string, unknown> = {};
        let revokeSessions = false;

        if (req.body?.isActive !== undefined) {
          updates.isActive = Boolean(req.body.isActive);
          if (!updates.isActive) revokeSessions = true;
        }
        if (req.body?.role && ['owner', 'manager', 'waiter', 'kitchen'].includes(req.body.role)) {
          updates.role = String(req.body.role);
          revokeSessions = true;
        }
        if (req.body?.permissions) {
          updates.permissions = req.body.permissions;
          revokeSessions = true;
        }
        if (req.body?.pin) {
          const newPin = String(req.body.pin).trim();
          if (!/^\d{4,6}$/.test(newPin)) {
            return res.status(400).json({ error: 'PIN must be 4-6 digits' });
          }
          const { hash, salt } = hashPin(newPin);
          updates.pinHash = hash;
          updates.pinSalt = salt;
          revokeSessions = true;
        }

        if (revokeSessions) {
          updates.tokenVersion = sql`${staffMembers.tokenVersion} + 1`;
        }

        const [updated] = await db
          .update(staffMembers)
          .set(updates)
          .where(and(eq(staffMembers.id, id), eq(staffMembers.restaurantId, restaurantId)))
          .returning({
            id: staffMembers.id,
            restaurantId: staffMembers.restaurantId,
            name: staffMembers.name,
            email: staffMembers.email,
            phone: staffMembers.phone,
            role: staffMembers.role,
            permissions: staffMembers.permissions,
            isActive: staffMembers.isActive,
          });

        if (!updated) return res.status(404).json({ error: 'Staff member not found' });

        if (revokeSessions) {
          await db
            .update(userSessions)
            .set({ revokedAt: new Date() })
            .where(and(eq(userSessions.staffId, id), isNull(userSessions.revokedAt)));
          await logSecurityEvent({
            restaurantId,
            severity: 'medium',
            eventType: 'STAFF_ACCESS_MODIFIED_SESSIONS_REVOKED',
            actorIdentifier: `${req.auth!.displayName} (${req.auth!.role})`,
            ipAddress: getClientIp(req),
            path: req.originalUrl,
            method: req.method,
            statusCode: 200,
            details: { targetStaffId: id, targetName: updated.name },
          });
        }

        res.json({ staff: updated });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update staff member' });
      }
    },
  );

  router.get('/settings', requireAuth, requireTenant, async (req: AuthedRequest, res) => {
    try {
      const [rest] = await db
        .select()
        .from(restaurants)
        .where(eq(restaurants.id, req.auth!.restaurantId!))
        .limit(1);
      res.json({ restaurant: rest });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to load settings' });
    }
  });

  router.patch(
    '/settings',
    requireAuth,
    requireTenant,
    requirePermission('manage_settings'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const allowedKeys = [
          'name',
          'tagline',
          'cuisineType',
          'logoUrl',
          'address',
          'city',
          'state',
          'phone',
          'email',
          'gstin',
          'fssaiNo',
          'openingHours',
          'gstRate',
          'serviceChargeRate',
          'receiptHeader',
          'receiptFooter',
          'soundAlertsEnabled',
          'qrOrderingEnabled',
          'autoAcceptQrOrders',
        ] as const;

        const updates: Record<string, unknown> = { updatedAt: new Date() };
        for (const key of allowedKeys) {
          if (req.body?.[key] !== undefined) {
            updates[key] = req.body[key];
          }
        }

        const [updated] = await db
          .update(restaurants)
          .set(updates)
          .where(eq(restaurants.id, restaurantId))
          .returning();

        await logAudit({
          restaurantId,
          actorName: req.auth!.displayName,
          actorRole: req.auth!.role,
          action: 'SETTINGS_UPDATED',
          entityType: 'restaurant',
          entityId: restaurantId,
        });

        res.json({ restaurant: updated });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update restaurant settings' });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // PLATFORM SUPER ADMIN PANEL
  // ---------------------------------------------------------------------------

  router.get(
    '/super-admin/overview',
    requireAuth,
    requireSuperAdmin,
    async (_req: AuthedRequest, res) => {
      try {
        const allRests = await db.select().from(restaurants).orderBy(restaurants.id);
        const plans = await db.select().from(platformPlans).orderBy(platformPlans.monthlyPriceInr);
        const [settings] = await db.select().from(platformSettings).limit(1);
        const allOrders = await db.select().from(orders);

        const enrichedRests = allRests.map((r) => {
          const restOrders = allOrders.filter((o) => o.restaurantId === r.id && o.status !== 'Cancelled');
          const gmv = restOrders.reduce((s, o) => s + o.totalAmount, 0);
          return {
            ...r,
            ordersCount: restOrders.length,
            gmv: Number(gmv.toFixed(2)),
          };
        });

        res.json({
          restaurants: enrichedRests,
          plans,
          settings,
          totals: {
            totalRestaurants: allRests.length,
            activeRestaurants: allRests.filter((r) => r.isActive).length,
            totalOrders: allOrders.length,
            totalGmv: Number(
              allOrders
                .filter((o) => o.status !== 'Cancelled')
                .reduce((s, o) => s + o.totalAmount, 0)
                .toFixed(2),
            ),
          },
        });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load Super Admin overview' });
      }
    },
  );

  router.patch(
    '/super-admin/restaurants/:id',
    requireAuth,
    requireSuperAdmin,
    async (req: AuthedRequest, res) => {
      try {
        const id = Number(req.params.id);
        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (req.body?.isActive !== undefined) updates.isActive = Boolean(req.body.isActive);
        if (req.body?.planId !== undefined) updates.planId = Number(req.body.planId);
        if (req.body?.subscriptionStatus) updates.subscriptionStatus = String(req.body.subscriptionStatus);

        const [updated] = await db
          .update(restaurants)
          .set(updates)
          .where(eq(restaurants.id, id))
          .returning();

        res.json({ restaurant: updated });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update restaurant subscription' });
      }
    },
  );

  router.patch(
    '/super-admin/settings',
    requireAuth,
    requireSuperAdmin,
    async (req: AuthedRequest, res) => {
      try {
        const [current] = await db.select().from(platformSettings).limit(1);
        if (!current) return res.status(404).json({ error: 'Platform settings missing' });

        const [updated] = await db
          .update(platformSettings)
          .set({
            platformName: req.body?.platformName ?? current.platformName,
            supportEmail: req.body?.supportEmail ?? current.supportEmail,
            defaultGstRate: req.body?.defaultGstRate ?? current.defaultGstRate,
            maintenanceMode: req.body?.maintenanceMode ?? current.maintenanceMode,
            allowSelfRegistration: req.body?.allowSelfRegistration ?? current.allowSelfRegistration,
            updatedAt: new Date(),
          })
          .where(eq(platformSettings.id, current.id))
          .returning();

        res.json({ settings: updated });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update platform settings' });
      }
    },
  );

  return router;
}
