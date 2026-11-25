import type { Router } from 'express';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  customerQrSessions,
  diningSessionPinHistory,
  diningSessions,
  orderAuthTokens,
  orders,
  pinAttemptTrackers,
  restaurantTables,
  securityEvents,
  serviceRequests,
} from '../db/schema.ts';
import {
  type AuthedRequest,
  getClientIp,
  requireAuth,
  requireQrSession,
  requireTenant,
} from './middleware.ts';
import { broadcastToRestaurant } from './realtime.ts';
import {
  CUSTOMER_PIN_LOCKOUT_MS,
  CUSTOMER_PIN_MAX_ATTEMPTS,
  ORDER_AUTH_TOKEN_TTL_MS,
  SlidingWindowLimiter,
  decryptDiningPin,
  encryptDiningPin,
  generateDiningPin,
  generateOrderAuthJti,
  hashPin,
  hashTokenSha256,
  sanitizeText,
  signAppToken,
  verifyPin,
} from './security.ts';
import {
  getOrCreateActiveDiningSession,
  logAudit,
  logSecurityEvent,
} from './services.ts';

const qrPinIpLimiter = new SlidingWindowLimiter(20, 5 * 60 * 1000);

function computeClientKey(ipAddress: string): string {
  return hashTokenSha256(`pin_client:${ipAddress}`).slice(0, 32);
}

function canViewPinsForAuth(auth: NonNullable<AuthedRequest['auth']>): boolean {
  if (auth.isSuperAdmin || auth.role === 'owner') return true;
  if (auth.role === 'manager' && auth.permissions.view_table_pins) return true;
  return false;
}

function canRegeneratePinsForAuth(auth: NonNullable<AuthedRequest['auth']>): boolean {
  if (auth.isSuperAdmin || auth.role === 'owner') return true;
  if (auth.role === 'manager' && auth.permissions.regenerate_table_pins) return true;
  return false;
}

function canCloseSessionForAuth(auth: NonNullable<AuthedRequest['auth']>): boolean {
  if (auth.isSuperAdmin || auth.role === 'owner' || auth.role === 'manager') return true;
  return Boolean(auth.permissions.close_dining_session);
}

function canManageDiningSessionsForAuth(auth: NonNullable<AuthedRequest['auth']>): boolean {
  if (auth.isSuperAdmin || auth.role === 'owner' || auth.role === 'manager') return true;
  return Boolean(auth.permissions.manage_dining_sessions || auth.permissions.manage_tables);
}

async function issueOneTimeOrderAuthToken(params: {
  restaurantId: number;
  tableId: number;
  diningSessionId: number;
  customerQrSessionId: number;
  qrSessionUid: string;
}) {
  const jti = generateOrderAuthJti();
  const expiresAt = new Date(Date.now() + ORDER_AUTH_TOKEN_TTL_MS);

  await db.insert(orderAuthTokens).values({
    tokenJti: jti,
    restaurantId: params.restaurantId,
    tableId: params.tableId,
    diningSessionId: params.diningSessionId,
    customerQrSessionId: params.customerQrSessionId,
    expiresAt,
  });

  const signed = signAppToken({
    kind: 'order_auth',
    jti,
    qsid: params.qrSessionUid,
    dsid: params.diningSessionId,
    tableId: params.tableId,
    restaurantId: params.restaurantId,
    exp: expiresAt.getTime(),
  });

  return { orderAuthToken: signed, expiresAt: expiresAt.toISOString() };
}

export function registerDiningSessionRoutes(router: Router) {
  // ---------------------------------------------------------------------------
  // CUSTOMER QR PIN VERIFICATION & ONE-TIME ORDER AUTHORIZATION
  // ---------------------------------------------------------------------------

  router.post('/qr/:qrToken/verify-pin', requireQrSession, async (req: AuthedRequest, res) => {
    const ipAddress = getClientIp(req);
    try {
      const { table, restaurant: rest, customerSession, diningSession } = req.qrSession!;

      const rl = qrPinIpLimiter.consume(`${ipAddress}:${rest.id}:${diningSession.id}`);
      if (!rl.allowed) {
        res.setHeader('Retry-After', String(rl.retryAfterSeconds));
        return res.status(429).json({
          error: 'Too many PIN verification attempts. Please wait before trying again.',
          lockRemainingSeconds: rl.retryAfterSeconds,
        });
      }

      const clientKey = computeClientKey(ipAddress);
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
      const sessionLocked =
        customerSession.pinLockedUntil && customerSession.pinLockedUntil.getTime() > now;
      const trackerLocked = tracker?.lockedUntil && tracker.lockedUntil.getTime() > now;

      if (sessionLocked || trackerLocked) {
        const lockUntilMs = Math.max(
          customerSession.pinLockedUntil?.getTime() || 0,
          tracker?.lockedUntil?.getTime() || 0,
        );
        const remainingSec = Math.max(1, Math.ceil((lockUntilMs - now) / 1000));
        await logSecurityEvent({
          restaurantId: rest.id,
          severity: 'high',
          eventType: 'PIN_LOCKOUT_ENFORCED',
          actorIdentifier: `Table ${table.tableNumber}`,
          ipAddress,
          path: req.originalUrl,
          method: req.method,
          statusCode: 429,
          details: {
            tableId: table.id,
            diningSessionId: diningSession.id,
            remainingSeconds: remainingSec,
          },
        });
        return res.status(429).json({
          error: `Too many incorrect PIN attempts. PIN verification is locked for ${Math.ceil(remainingSec / 60)} minute(s).`,
          lockedUntil: new Date(lockUntilMs).toISOString(),
          lockRemainingSeconds: remainingSec,
          failedAttempts: CUSTOMER_PIN_MAX_ATTEMPTS,
          maxAttempts: CUSTOMER_PIN_MAX_ATTEMPTS,
        });
      }

      const pin = String(req.body?.pin ?? '').trim();
      if (!/^\d{3}$/.test(pin)) {
        return res.status(400).json({
          error: 'Enter a valid 3-digit numeric security PIN.',
        });
      }

      const matchesCurrent = verifyPin(pin, diningSession.pinHash, diningSession.pinSalt);
      if (!matchesCurrent) {
        const matchesOld =
          Boolean(diningSession.previousPinHash && diningSession.previousPinSalt) &&
          verifyPin(pin, diningSession.previousPinHash!, diningSession.previousPinSalt!);

        // Reset expired lockouts before incrementing
        const baseSessionFails =
          customerSession.pinLockedUntil && customerSession.pinLockedUntil.getTime() <= now
            ? 0
            : customerSession.failedPinAttempts;
        const baseTrackerFails =
          tracker?.lockedUntil && tracker.lockedUntil.getTime() <= now
            ? 0
            : tracker?.failedAttempts || 0;

        const nextAttempts = Math.max(baseSessionFails, baseTrackerFails) + 1;
        const shouldLock = nextAttempts >= CUSTOMER_PIN_MAX_ATTEMPTS;
        const lockedUntil = shouldLock ? new Date(now + CUSTOMER_PIN_LOCKOUT_MS) : null;

        await db
          .update(customerQrSessions)
          .set({
            failedPinAttempts: nextAttempts,
            pinLockedUntil: lockedUntil,
          })
          .where(eq(customerQrSessions.id, customerSession.id));

        await db
          .insert(pinAttemptTrackers)
          .values({
            restaurantId: rest.id,
            diningSessionId: diningSession.id,
            clientKey,
            failedAttempts: nextAttempts,
            lockedUntil,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [pinAttemptTrackers.diningSessionId, pinAttemptTrackers.clientKey],
            set: {
              failedAttempts: nextAttempts,
              lockedUntil,
              updatedAt: new Date(),
            },
          });

        // NEVER log plaintext entered PIN
        await logSecurityEvent({
          restaurantId: rest.id,
          severity: shouldLock ? 'high' : 'medium',
          eventType: shouldLock
            ? 'PIN_LOCKOUT_TRIGGERED'
            : matchesOld
            ? 'EXPIRED_PIN_VERIFICATION_FAILED'
            : 'PIN_VERIFICATION_FAILED',
          actorIdentifier: `Table ${table.tableNumber}`,
          ipAddress,
          path: req.originalUrl,
          method: req.method,
          statusCode: shouldLock ? 429 : 401,
          details: {
            tableId: table.id,
            diningSessionId: diningSession.id,
            sessionUid: diningSession.sessionUid,
            failedAttempts: nextAttempts,
            maxAttempts: CUSTOMER_PIN_MAX_ATTEMPTS,
            lockedForSeconds: shouldLock ? Math.round(CUSTOMER_PIN_LOCKOUT_MS / 1000) : 0,
          },
        });

        broadcastToRestaurant(
          rest.id,
          'dining_session:updated',
          { tableId: table.id, diningSessionId: diningSession.id },
          table.id,
        );

        if (shouldLock && lockedUntil) {
          return res.status(429).json({
            error: 'Too many incorrect attempts. PIN verification is temporarily locked for 2 minutes.',
            lockedUntil: lockedUntil.toISOString(),
            lockRemainingSeconds: Math.round(CUSTOMER_PIN_LOCKOUT_MS / 1000),
            failedAttempts: nextAttempts,
            maxAttempts: CUSTOMER_PIN_MAX_ATTEMPTS,
          });
        }

        return res.status(401).json({
          error: matchesOld
            ? 'This security PIN is no longer valid. Please ask your waiter for a new code.'
            : 'Incorrect security PIN. Please ask your waiter for the latest code.',
          failedAttempts: nextAttempts,
          maxAttempts: CUSTOMER_PIN_MAX_ATTEMPTS,
          remainingAttempts: Math.max(0, CUSTOMER_PIN_MAX_ATTEMPTS - nextAttempts),
        });
      }

      // PIN matches! Reset failure counters and authorize session
      await db
        .update(customerQrSessions)
        .set({
          pinVerified: true,
          pinVerifiedVersion: diningSession.pinVersion,
          pinVerifiedAt: new Date(),
          failedPinAttempts: 0,
          pinLockedUntil: null,
        })
        .where(eq(customerQrSessions.id, customerSession.id));

      await db
        .update(pinAttemptTrackers)
        .set({ failedAttempts: 0, lockedUntil: null, updatedAt: new Date() })
        .where(
          and(
            eq(pinAttemptTrackers.diningSessionId, diningSession.id),
            eq(pinAttemptTrackers.clientKey, clientKey),
          ),
        );

      const authIssued = await issueOneTimeOrderAuthToken({
        restaurantId: rest.id,
        tableId: table.id,
        diningSessionId: diningSession.id,
        customerQrSessionId: customerSession.id,
        qrSessionUid: customerSession.qrSessionUid,
      });

      await logSecurityEvent({
        restaurantId: rest.id,
        severity: 'low',
        eventType: 'PIN_VERIFICATION_SUCCEEDED',
        actorIdentifier: `Table ${table.tableNumber}`,
        ipAddress,
        path: req.originalUrl,
        method: req.method,
        statusCode: 200,
        details: {
          tableId: table.id,
          diningSessionId: diningSession.id,
          sessionUid: diningSession.sessionUid,
          pinVersion: diningSession.pinVersion,
        },
      });

      res.json({
        verified: true,
        message: 'PIN verified. You can now place your order.',
        orderAuthToken: authIssued.orderAuthToken,
        orderAuthExpiresAt: authIssued.expiresAt,
        diningSessionUid: diningSession.sessionUid,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'PIN verification failed' });
    }
  });

  router.post('/qr/:qrToken/order-auth', requireQrSession, async (req: AuthedRequest, res) => {
    const ipAddress = getClientIp(req);
    try {
      const { table, restaurant: rest, customerSession, diningSession } = req.qrSession!;

      if (!customerSession.pinVerified) {
        return res.status(401).json({
          error: 'Please enter the 3-digit security PIN from your waiter before placing an order.',
          requiresPin: true,
        });
      }

      if (customerSession.pinVerifiedVersion !== diningSession.pinVersion) {
        await db
          .update(customerQrSessions)
          .set({ pinVerified: false, pinVerifiedVersion: null })
          .where(eq(customerQrSessions.id, customerSession.id));

        await logSecurityEvent({
          restaurantId: rest.id,
          severity: 'medium',
          eventType: 'EXPIRED_PIN_SESSION_CHALLENGED',
          actorIdentifier: `Table ${table.tableNumber}`,
          ipAddress,
          path: req.originalUrl,
          method: req.method,
          statusCode: 401,
          details: { tableId: table.id, diningSessionId: diningSession.id },
        });

        return res.status(401).json({
          error: 'This security PIN is no longer valid. Please ask your waiter for a new code.',
          requiresPin: true,
          pinInvalidated: true,
        });
      }

      const authIssued = await issueOneTimeOrderAuthToken({
        restaurantId: rest.id,
        tableId: table.id,
        diningSessionId: diningSession.id,
        customerQrSessionId: customerSession.id,
        qrSessionUid: customerSession.qrSessionUid,
      });

      res.json({
        orderAuthToken: authIssued.orderAuthToken,
        orderAuthExpiresAt: authIssued.expiresAt,
        diningSessionUid: diningSession.sessionUid,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to issue order authorization token' });
    }
  });

  // ---------------------------------------------------------------------------
  // OWNER, MANAGER & WAITER DINING SESSION & PIN MANAGEMENT
  // ---------------------------------------------------------------------------

  router.get('/dining-sessions', requireAuth, requireTenant, async (req: AuthedRequest, res) => {
    try {
      if (!canManageDiningSessionsForAuth(req.auth!)) {
        await logSecurityEvent({
          restaurantId: req.auth!.restaurantId,
          severity: 'medium',
          eventType: 'UNAUTHORIZED_DINING_SESSION_ACCESS',
          actorIdentifier: `${req.auth!.displayName} (${req.auth!.role})`,
          ipAddress: getClientIp(req),
          path: req.originalUrl,
          method: req.method,
          statusCode: 403,
        });
        return res.status(403).json({ error: 'Permission denied for dining session view' });
      }

      const restaurantId = req.auth!.restaurantId!;
      const canViewPins = canViewPinsForAuth(req.auth!);

      const tables = await db
        .select()
        .from(restaurantTables)
        .where(eq(restaurantTables.restaurantId, restaurantId))
        .orderBy(restaurantTables.id);

      const allSessions = await db
        .select()
        .from(diningSessions)
        .where(eq(diningSessions.restaurantId, restaurantId))
        .orderBy(desc(diningSessions.startedAt))
        .limit(80);

      const sessionIds = allSessions.map((s) => s.id);
      const sessionOrders =
        sessionIds.length > 0
          ? await db
              .select({
                id: orders.id,
                diningSessionId: orders.diningSessionId,
                orderNumber: orders.orderNumber,
                status: orders.status,
                totalAmount: orders.totalAmount,
                paidAmount: orders.paidAmount,
                createdAt: orders.createdAt,
              })
              .from(orders)
              .where(inArray(orders.diningSessionId, sessionIds))
          : [];

      const trackerRows =
        sessionIds.length > 0
          ? await db
              .select({
                diningSessionId: pinAttemptTrackers.diningSessionId,
                failedAttempts: pinAttemptTrackers.failedAttempts,
                lockedUntil: pinAttemptTrackers.lockedUntil,
              })
              .from(pinAttemptTrackers)
              .where(inArray(pinAttemptTrackers.diningSessionId, sessionIds))
          : [];

      const activeCustomerRows =
        sessionIds.length > 0
          ? await db
              .select({
                id: customerQrSessions.id,
                diningSessionId: customerQrSessions.diningSessionId,
                failedPinAttempts: customerQrSessions.failedPinAttempts,
                pinVerified: customerQrSessions.pinVerified,
                revokedAt: customerQrSessions.revokedAt,
                lastActivityAt: customerQrSessions.lastActivityAt,
              })
              .from(customerQrSessions)
              .where(inArray(customerQrSessions.diningSessionId, sessionIds))
          : [];

      const serializeSession = (s: typeof diningSessions.$inferSelect) => {
        const linkedOrders = sessionOrders.filter(
          (o) => o.diningSessionId === s.id && o.status !== 'Cancelled',
        );
        const totalBill = Number(
          linkedOrders.reduce((acc, o) => acc + Number(o.totalAmount || 0), 0).toFixed(2),
        );
        const paidTotal = Number(
          linkedOrders.reduce((acc, o) => acc + Number(o.paidAmount || 0), 0).toFixed(2),
        );
        const latestOrderStatus =
          linkedOrders.length > 0
            ? [...linkedOrders].sort(
                (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
              )[0].status
            : null;
        const failedPinAttempts = Math.max(
          0,
          ...trackerRows
            .filter((t) => t.diningSessionId === s.id)
            .map((t) => t.failedAttempts),
          ...activeCustomerRows
            .filter((c) => c.diningSessionId === s.id)
            .map((c) => c.failedPinAttempts),
        );
        const activeCustomerDevices = activeCustomerRows.filter(
          (c) => c.diningSessionId === s.id && !c.revokedAt,
        ).length;

        const base = {
          id: s.id,
          sessionUid: s.sessionUid,
          restaurantId: s.restaurantId,
          tableId: s.tableId,
          status: s.status,
          pinVersion: s.pinVersion,
          pinGeneratedAt: s.pinGeneratedAt,
          pinLastRegeneratedAt: s.pinLastRegeneratedAt,
          billRequested: s.billRequested,
          billRequestedAt: s.billRequestedAt,
          paymentStatus: s.paymentStatus,
          customerDeparted: s.customerDeparted,
          departureConfirmedBy: s.departureConfirmedBy,
          departureConfirmedAt: s.departureConfirmedAt,
          closedBy: s.closedBy,
          closedByRole: s.closedByRole,
          closeReason: s.closeReason,
          isOverrideClose: s.isOverrideClose,
          startedAt: s.startedAt,
          closedAt: s.closedAt,
          orderCount: linkedOrders.length,
          totalBill,
          paidTotal,
          latestOrderStatus,
          failedPinAttempts,
          activeCustomerDevices,
        };

        // STRICT BACKEND ROLE ISOLATION: Waiters NEVER receive activePin
        if (canViewPins && s.status === 'ACTIVE') {
          return {
            ...base,
            activePin: decryptDiningPin(s.pinEncrypted) || '---',
          };
        }
        return base;
      };

      const activeSessions = allSessions
        .filter((s) => s.status === 'ACTIVE')
        .map(serializeSession);
      const closedSessions = allSessions
        .filter((s) => s.status === 'CLOSED')
        .slice(0, 25)
        .map(serializeSession);

      const pinHistory = canViewPins
        ? await db
            .select()
            .from(diningSessionPinHistory)
            .where(eq(diningSessionPinHistory.restaurantId, restaurantId))
            .orderBy(desc(diningSessionPinHistory.createdAt))
            .limit(40)
        : [];

      const sessionSecurityLogs = canViewPins
        ? await db
            .select()
            .from(securityEvents)
            .where(eq(securityEvents.restaurantId, restaurantId))
            .orderBy(desc(securityEvents.createdAt))
            .limit(50)
        : [];

      res.json({
        canViewPins,
        canRegeneratePins: canRegeneratePinsForAuth(req.auth!),
        canCloseSessions: canCloseSessionForAuth(req.auth!),
        canOverrideClose:
          req.auth!.isSuperAdmin ||
          req.auth!.role === 'owner' ||
          Boolean(req.auth!.permissions.override_session_close),
        tables: tables.map((t) => ({
          id: t.id,
          tableNumber: t.tableNumber,
          section: t.section,
          capacity: t.capacity,
          status: t.status,
          assignedStaffId: t.assignedStaffId,
          activeSession: activeSessions.find((s) => s.tableId === t.id) || null,
        })),
        activeSessions,
        closedSessions,
        pinHistory,
        securityLogs: sessionSecurityLogs,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to load dining sessions' });
    }
  });

  // Strict Owner/Manager-only PIN endpoint — Waiters & Kitchen receive 403
  router.get('/dining-sessions/pins', requireAuth, requireTenant, async (req: AuthedRequest, res) => {
    if (!canViewPinsForAuth(req.auth!)) {
      await logSecurityEvent({
        restaurantId: req.auth!.restaurantId,
        severity: 'high',
        eventType: 'UNAUTHORIZED_PIN_ACCESS_ATTEMPT',
        actorIdentifier: `${req.auth!.displayName} (${req.auth!.role})`,
        ipAddress: getClientIp(req),
        path: req.originalUrl,
        method: req.method,
        statusCode: 403,
      });
      return res.status(403).json({
        error: 'Access denied: Waiter and kitchen accounts cannot view table security PINs',
      });
    }

    try {
      const restaurantId = req.auth!.restaurantId!;
      const active = await db
        .select()
        .from(diningSessions)
        .where(
          and(eq(diningSessions.restaurantId, restaurantId), eq(diningSessions.status, 'ACTIVE')),
        )
        .orderBy(diningSessions.tableId);

      res.json({
        pins: active.map((s) => ({
          diningSessionId: s.id,
          sessionUid: s.sessionUid,
          tableId: s.tableId,
          pinVersion: s.pinVersion,
          activePin: decryptDiningPin(s.pinEncrypted) || '---',
          pinGeneratedAt: s.pinGeneratedAt,
          pinLastRegeneratedAt: s.pinLastRegeneratedAt,
        })),
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to load active PINs' });
    }
  });

  router.post('/dining-sessions/start', requireAuth, requireTenant, async (req: AuthedRequest, res) => {
    try {
      if (!canManageDiningSessionsForAuth(req.auth!)) {
        return res.status(403).json({ error: 'Permission denied to start dining session' });
      }
      const restaurantId = req.auth!.restaurantId!;
      const tableId = Number(req.body?.tableId);
      if (!tableId) {
        return res.status(400).json({ error: 'Valid tableId is required' });
      }

      const [table] = await db
        .select()
        .from(restaurantTables)
        .where(and(eq(restaurantTables.id, tableId), eq(restaurantTables.restaurantId, restaurantId)))
        .limit(1);

      if (!table) return res.status(404).json({ error: 'Table not found' });

      const { session, created } = await getOrCreateActiveDiningSession({
        restaurantId,
        tableId: table.id,
        actorName: req.auth!.displayName,
        actorRole: req.auth!.role,
        ipAddress: getClientIp(req),
        reason: createdReason(req.body?.reason, req.auth!.displayName),
      });

      if (table.status === 'Available') {
        const [updatedTable] = await db
          .update(restaurantTables)
          .set({ status: 'Occupied' })
          .where(eq(restaurantTables.id, table.id))
          .returning();
        broadcastToRestaurant(restaurantId, 'table:updated', { table: updatedTable }, table.id);
      }

      const canViewPins = canViewPinsForAuth(req.auth!);
      res.status(created ? 201 : 200).json({
        created,
        session: {
          id: session.id,
          sessionUid: session.sessionUid,
          tableId: session.tableId,
          status: session.status,
          pinVersion: session.pinVersion,
          startedAt: session.startedAt,
          ...(canViewPins ? { activePin: decryptDiningPin(session.pinEncrypted) || '---' } : {}),
        },
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to start dining session' });
    }
  });

  router.post(
    '/dining-sessions/:id/regenerate-pin',
    requireAuth,
    requireTenant,
    async (req: AuthedRequest, res) => {
      const ipAddress = getClientIp(req);
      if (!canRegeneratePinsForAuth(req.auth!)) {
        await logSecurityEvent({
          restaurantId: req.auth!.restaurantId,
          severity: 'high',
          eventType: 'UNAUTHORIZED_PIN_REGENERATION_ATTEMPT',
          actorIdentifier: `${req.auth!.displayName} (${req.auth!.role})`,
          ipAddress,
          path: req.originalUrl,
          method: req.method,
          statusCode: 403,
        });
        return res.status(403).json({
          error: 'Only Restaurant Owners and Managers can regenerate table security PINs',
        });
      }

      try {
        const restaurantId = req.auth!.restaurantId!;
        const sessionId = Number(req.params.id);
        const reason = sanitizeText(req.body?.reason || 'Manual security regeneration', 200);

        const result = await db.transaction(async (tx) => {
          const lockRes = await tx.execute(
            sql`SELECT id, status FROM dining_sessions WHERE id = ${sessionId} AND restaurant_id = ${restaurantId} FOR UPDATE`,
          );
          if (!lockRes.rows.length) {
            return { errorStatus: 404, error: 'Dining session not found' };
          }

          const [current] = await tx
            .select()
            .from(diningSessions)
            .where(and(eq(diningSessions.id, sessionId), eq(diningSessions.restaurantId, restaurantId)))
            .limit(1);

          if (!current || current.status !== 'ACTIVE') {
            return { errorStatus: 409, error: 'Cannot regenerate PIN for a closed dining session' };
          }

          const nextPin = generateDiningPin();
          const { hash, salt } = hashPin(nextPin);
          const pinEncrypted = encryptDiningPin(nextPin);
          const nextVersion = current.pinVersion + 1;
          const now = new Date();

          const [updated] = await tx
            .update(diningSessions)
            .set({
              previousPinHash: current.pinHash,
              previousPinSalt: current.pinSalt,
              pinHash: hash,
              pinSalt: salt,
              pinEncrypted,
              pinVersion: nextVersion,
              pinLastRegeneratedAt: now,
              updatedAt: now,
            })
            .where(eq(diningSessions.id, current.id))
            .returning();

          // Invalidate prior PIN verification (clear pinVerifiedVersion so version check blocks and reports pinInvalidated)
          await tx
            .update(customerQrSessions)
            .set({ pinVerifiedVersion: null })
            .where(eq(customerQrSessions.diningSessionId, current.id));

          await tx
            .update(orderAuthTokens)
            .set({ revokedAt: now })
            .where(
              and(
                eq(orderAuthTokens.diningSessionId, current.id),
                isNull(orderAuthTokens.consumedAt),
                isNull(orderAuthTokens.revokedAt),
              ),
            );

          await tx
            .delete(pinAttemptTrackers)
            .where(eq(pinAttemptTrackers.diningSessionId, current.id));

          const pinDigest = hashTokenSha256(`${current.sessionUid}:${nextPin}:v${nextVersion}`).slice(
            0,
            16,
          );

          await tx.insert(diningSessionPinHistory).values({
            restaurantId,
            tableId: current.tableId,
            diningSessionId: current.id,
            pinVersion: nextVersion,
            pinDigest,
            action: 'regenerated',
            actorName: req.auth!.displayName,
            actorRole: req.auth!.role,
            reason,
          });

          await tx.insert(securityEvents).values({
            restaurantId,
            severity: 'medium',
            eventType: 'PIN_REGENERATED',
            actorIdentifier: `${req.auth!.displayName} (${req.auth!.role})`,
            ipAddress,
            path: req.originalUrl,
            method: req.method,
            statusCode: 200,
            details: {
              tableId: current.tableId,
              diningSessionId: current.id,
              sessionUid: current.sessionUid,
              pinVersion: nextVersion,
              reason,
            },
          });

          return { updated, activePin: nextPin };
        });

        if ('errorStatus' in result) {
          return res.status(result.errorStatus!).json({ error: result.error });
        }

        await logAudit({
          restaurantId,
          actorName: req.auth!.displayName,
          actorRole: req.auth!.role,
          action: 'DINING_PIN_REGENERATED',
          entityType: 'dining_session',
          entityId: sessionId,
          details: { pinVersion: result.updated.pinVersion, reason },
        });

        broadcastToRestaurant(
          restaurantId,
          'dining_session:updated',
          { tableId: result.updated.tableId, diningSessionId: result.updated.id },
          result.updated.tableId,
        );

        res.json({
          regenerated: true,
          diningSessionId: result.updated.id,
          pinVersion: result.updated.pinVersion,
          activePin: result.activePin,
          pinLastRegeneratedAt: result.updated.pinLastRegeneratedAt,
        });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to regenerate security PIN' });
      }
    },
  );

  router.post(
    '/dining-sessions/:id/request-bill',
    requireAuth,
    requireTenant,
    async (req: AuthedRequest, res) => {
      try {
        if (!canManageDiningSessionsForAuth(req.auth!)) {
          return res.status(403).json({ error: 'Permission denied' });
        }
        const restaurantId = req.auth!.restaurantId!;
        const sessionId = Number(req.params.id);

        const [updated] = await db
          .update(diningSessions)
          .set({
            billRequested: true,
            billRequestedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(diningSessions.id, sessionId),
              eq(diningSessions.restaurantId, restaurantId),
              eq(diningSessions.status, 'ACTIVE'),
            ),
          )
          .returning();

        if (!updated) {
          return res.status(404).json({ error: 'Active dining session not found' });
        }

        const [updatedTable] = await db
          .update(restaurantTables)
          .set({ status: 'Billing' })
          .where(eq(restaurantTables.id, updated.tableId))
          .returning();

        broadcastToRestaurant(restaurantId, 'table:updated', { table: updatedTable }, updated.tableId);
        broadcastToRestaurant(
          restaurantId,
          'dining_session:updated',
          { tableId: updated.tableId, diningSessionId: updated.id },
          updated.tableId,
        );

        res.json({ billRequested: true, diningSessionId: updated.id });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to mark bill requested' });
      }
    },
  );

  router.post(
    '/dining-sessions/:id/confirm-departure',
    requireAuth,
    requireTenant,
    async (req: AuthedRequest, res) => {
      try {
        if (!canManageDiningSessionsForAuth(req.auth!)) {
          return res.status(403).json({ error: 'Permission denied' });
        }
        const restaurantId = req.auth!.restaurantId!;
        const sessionId = Number(req.params.id);

        const [updated] = await db
          .update(diningSessions)
          .set({
            customerDeparted: true,
            departureConfirmedBy: req.auth!.displayName,
            departureConfirmedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(diningSessions.id, sessionId),
              eq(diningSessions.restaurantId, restaurantId),
              eq(diningSessions.status, 'ACTIVE'),
            ),
          )
          .returning();

        if (!updated) {
          return res.status(404).json({ error: 'Active dining session not found' });
        }

        await logSecurityEvent({
          restaurantId,
          severity: 'low',
          eventType: 'CUSTOMER_DEPARTURE_CONFIRMED',
          actorIdentifier: `${req.auth!.displayName} (${req.auth!.role})`,
          ipAddress: getClientIp(req),
          path: req.originalUrl,
          method: req.method,
          statusCode: 200,
          details: {
            tableId: updated.tableId,
            diningSessionId: updated.id,
            sessionUid: updated.sessionUid,
          },
        });

        broadcastToRestaurant(
          restaurantId,
          'dining_session:updated',
          { tableId: updated.tableId, diningSessionId: updated.id },
          updated.tableId,
        );

        res.json({ customerDeparted: true, diningSessionId: updated.id });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to confirm customer departure' });
      }
    },
  );

  router.post(
    '/dining-sessions/:id/request-closure',
    requireAuth,
    requireTenant,
    async (req: AuthedRequest, res) => {
      try {
        if (!canManageDiningSessionsForAuth(req.auth!)) {
          return res.status(403).json({ error: 'Permission denied' });
        }
        const restaurantId = req.auth!.restaurantId!;
        const sessionId = Number(req.params.id);

        const [session] = await db
          .select()
          .from(diningSessions)
          .where(
            and(
              eq(diningSessions.id, sessionId),
              eq(diningSessions.restaurantId, restaurantId),
              eq(diningSessions.status, 'ACTIVE'),
            ),
          )
          .limit(1);

        if (!session) {
          return res.status(404).json({ error: 'Active dining session not found' });
        }

        const [reqRow] = await db
          .insert(serviceRequests)
          .values({
            restaurantId,
            tableId: session.tableId,
            diningSessionId: session.id,
            requestType: 'closure',
            note: sanitizeText(
              req.body?.note ||
                `Closure requested by ${req.auth!.displayName} (Payment: ${session.paymentStatus}, Departed: ${session.customerDeparted ? 'Yes' : 'No'})`,
              200,
            ),
            status: 'pending',
          })
          .returning();

        await logSecurityEvent({
          restaurantId,
          severity: 'low',
          eventType: 'SESSION_CLOSURE_REQUESTED',
          actorIdentifier: `${req.auth!.displayName} (${req.auth!.role})`,
          ipAddress: getClientIp(req),
          path: req.originalUrl,
          method: req.method,
          statusCode: 201,
          details: { tableId: session.tableId, diningSessionId: session.id },
        });

        broadcastToRestaurant(restaurantId, 'service:requested', { request: reqRow });
        res.status(201).json({ requested: true, request: reqRow });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to request session closure' });
      }
    },
  );

  router.post('/dining-sessions/:id/close', requireAuth, requireTenant, async (req: AuthedRequest, res) => {
    const ipAddress = getClientIp(req);
    try {
      const restaurantId = req.auth!.restaurantId!;
      const sessionId = Number(req.params.id);
      const override = req.body?.override === true;
      const reason = sanitizeText(req.body?.reason || '', 200);

      if (override) {
        const hasOverridePerm =
          req.auth!.isSuperAdmin ||
          req.auth!.role === 'owner' ||
          Boolean(req.auth!.permissions.override_session_close);
        if (!hasOverridePerm) {
          await logSecurityEvent({
            restaurantId,
            severity: 'high',
            eventType: 'UNAUTHORIZED_OVERRIDE_CLOSE_ATTEMPT',
            actorIdentifier: `${req.auth!.displayName} (${req.auth!.role})`,
            ipAddress,
            path: req.originalUrl,
            method: req.method,
            statusCode: 403,
            details: { diningSessionId: sessionId },
          });
          return res.status(403).json({ error: 'Only Restaurant Owners can perform override closure' });
        }
        if (reason.length < 5) {
          return res.status(400).json({
            error: 'A detailed reason (at least 5 characters) is required for override session closure',
          });
        }
      } else if (!canCloseSessionForAuth(req.auth!)) {
        return res.status(403).json({
          error: 'Permission denied: close_dining_session required (you can Request Closure instead)',
        });
      }

      const result = await db.transaction(async (tx) => {
        const lockRes = await tx.execute(
          sql`SELECT id, status FROM dining_sessions WHERE id = ${sessionId} AND restaurant_id = ${restaurantId} FOR UPDATE`,
        );
        if (!lockRes.rows.length) {
          return { errorStatus: 404, error: 'Dining session not found' };
        }

        const [session] = await tx
          .select()
          .from(diningSessions)
          .where(and(eq(diningSessions.id, sessionId), eq(diningSessions.restaurantId, restaurantId)))
          .limit(1);

        if (!session) {
          return { errorStatus: 404, error: 'Dining session not found' };
        }

        if (session.status === 'CLOSED') {
          return { errorStatus: 409, error: 'Dining session is already closed' };
        }

        if (!override) {
          const linkedOrders = await tx
            .select()
            .from(orders)
            .where(eq(orders.diningSessionId, session.id));

          const activeOrders = linkedOrders.filter((o) => o.status !== 'Cancelled');
          const totalDue = activeOrders.reduce((s, o) => s + Number(o.totalAmount || 0), 0);
          const totalPaid = activeOrders.reduce((s, o) => s + Number(o.paidAmount || 0), 0);
          const unpaidExists =
            session.paymentStatus !== 'paid' ||
            activeOrders.length === 0 ||
            totalPaid < totalDue - 0.5;

          if (unpaidExists) {
            return {
              errorStatus: 400,
              error:
                activeOrders.length === 0
                  ? 'No paid orders in this session. Use Owner Override with reason to close an empty session.'
                  : 'Payment must be verified as completed before closing this dining session.',
            };
          }

          if (!session.customerDeparted) {
            return {
              errorStatus: 400,
              error: 'Confirm customer departure before officially closing the dining session.',
            };
          }
        }

        const now = new Date();
        const [closedSession] = await tx
          .update(diningSessions)
          .set({
            status: 'CLOSED',
            closedAt: now,
            closedBy: req.auth!.displayName,
            closedByRole: req.auth!.role,
            closeReason: reason || (override ? 'Owner override' : 'Paid and customer departed'),
            isOverrideClose: override,
            updatedAt: now,
          })
          .where(eq(diningSessions.id, session.id))
          .returning();

        // Invalidate previous PIN, all associated customer QR sessions, and unused order tokens
        await tx
          .update(customerQrSessions)
          .set({
            revokedAt: now,
            revokeReason: override ? 'session_closed_override' : 'session_closed',
            pinVerified: false,
            pinVerifiedVersion: null,
          })
          .where(
            and(
              eq(customerQrSessions.diningSessionId, session.id),
              isNull(customerQrSessions.revokedAt),
            ),
          );

        await tx
          .update(orderAuthTokens)
          .set({ revokedAt: now })
          .where(
            and(
              eq(orderAuthTokens.diningSessionId, session.id),
              isNull(orderAuthTokens.consumedAt),
              isNull(orderAuthTokens.revokedAt),
            ),
          );

        await tx.insert(diningSessionPinHistory).values({
          restaurantId,
          tableId: session.tableId,
          diningSessionId: session.id,
          pinVersion: session.pinVersion,
          pinDigest: hashTokenSha256(`${session.sessionUid}:invalidated:v${session.pinVersion}`).slice(
            0,
            16,
          ),
          action: 'invalidated',
          actorName: req.auth!.displayName,
          actorRole: req.auth!.role,
          reason: reason || (override ? 'Owner override close' : 'Session closed after payment & departure'),
        });

        await tx
          .update(serviceRequests)
          .set({ status: 'resolved', resolvedAt: now, handledBy: req.auth!.displayName })
          .where(
            and(
              eq(serviceRequests.diningSessionId, session.id),
              eq(serviceRequests.status, 'pending'),
            ),
          );

        const [updatedTable] = await tx
          .update(restaurantTables)
          .set({ status: 'Available' })
          .where(eq(restaurantTables.id, session.tableId))
          .returning();

        await tx.insert(securityEvents).values({
          restaurantId,
          severity: override ? 'high' : 'low',
          eventType: override ? 'DINING_SESSION_OVERRIDE_CLOSED' : 'DINING_SESSION_CLOSED',
          actorIdentifier: `${req.auth!.displayName} (${req.auth!.role})`,
          ipAddress,
          path: req.originalUrl,
          method: req.method,
          statusCode: 200,
          details: {
            tableId: session.tableId,
            diningSessionId: session.id,
            sessionUid: session.sessionUid,
            override,
            reason: closedSession.closeReason,
          },
        });

        return { closedSession, updatedTable };
      });

      if ('errorStatus' in result) {
        return res.status(result.errorStatus!).json({ error: result.error });
      }

      await logAudit({
        restaurantId,
        actorName: req.auth!.displayName,
        actorRole: req.auth!.role,
        action: override ? 'DINING_SESSION_OVERRIDE_CLOSED' : 'DINING_SESSION_CLOSED',
        entityType: 'dining_session',
        entityId: sessionId,
        details: {
          sessionUid: result.closedSession.sessionUid,
          reason: result.closedSession.closeReason,
        },
      });

      broadcastToRestaurant(
        restaurantId,
        'table:updated',
        { table: result.updatedTable },
        result.closedSession.tableId,
      );
      broadcastToRestaurant(
        restaurantId,
        'dining_session:updated',
        { tableId: result.closedSession.tableId, diningSessionId: sessionId, status: 'CLOSED' },
        result.closedSession.tableId,
      );

      res.json({
        closed: true,
        session: {
          id: result.closedSession.id,
          sessionUid: result.closedSession.sessionUid,
          tableId: result.closedSession.tableId,
          status: result.closedSession.status,
          closedAt: result.closedSession.closedAt,
          closedBy: result.closedSession.closedBy,
        },
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to close dining session' });
    }
  });
}

function createdReason(raw: unknown, actor: string): string {
  const txt = sanitizeText(raw || '', 200);
  return txt || `Session initiated by ${actor}`;
}
