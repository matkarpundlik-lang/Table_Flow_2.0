import type { NextFunction, Request, Response } from 'express';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { adminAuth } from '../lib/firebase-admin.ts';
import { db } from '../db/index.ts';
import {
  customerQrSessions,
  diningSessions,
  restaurantTables,
  restaurants,
  staffMembers,
  userSessions,
  users,
} from '../db/schema.ts';
import { QR_INACTIVITY_TTL_MS, hashTokenSha256, verifyAppToken } from './security.ts';
import { logSecurityEvent } from './services.ts';

export type StaffRole = 'owner' | 'manager' | 'waiter' | 'kitchen' | 'super_admin';

export const DEFAULT_ROLE_PERMISSIONS: Record<string, Record<string, boolean>> = {
  owner: {
    manage_orders: true,
    cancel_orders: true,
    manage_menu: true,
    manage_tables: true,
    manage_billing: true,
    manage_inventory: true,
    manage_expenses: true,
    manage_staff: true,
    manage_settings: true,
    view_reports: true,
    kitchen_display: true,
    view_table_pins: true,
    regenerate_table_pins: true,
    manage_dining_sessions: true,
    close_dining_session: true,
    override_session_close: true,
  },
  manager: {
    manage_orders: true,
    cancel_orders: true,
    manage_menu: true,
    manage_tables: true,
    manage_billing: true,
    manage_inventory: true,
    manage_expenses: true,
    manage_staff: false,
    manage_settings: false,
    view_reports: true,
    kitchen_display: true,
    view_table_pins: true,
    regenerate_table_pins: true,
    manage_dining_sessions: true,
    close_dining_session: true,
    override_session_close: false,
  },
  waiter: {
    manage_orders: true,
    cancel_orders: false,
    manage_menu: false,
    manage_tables: true,
    manage_billing: true,
    manage_inventory: false,
    manage_expenses: false,
    manage_staff: false,
    manage_settings: false,
    view_reports: false,
    kitchen_display: false,
    view_table_pins: false,
    regenerate_table_pins: false,
    manage_dining_sessions: true,
    close_dining_session: true,
    override_session_close: false,
  },
  kitchen: {
    manage_orders: false,
    cancel_orders: false,
    manage_menu: false,
    manage_tables: false,
    manage_billing: false,
    manage_inventory: false,
    manage_expenses: false,
    manage_staff: false,
    manage_settings: false,
    view_reports: false,
    kitchen_display: true,
    view_table_pins: false,
    regenerate_table_pins: false,
    manage_dining_sessions: false,
    close_dining_session: false,
    override_session_close: false,
  },
};

export interface AuthContext {
  authType: 'firebase' | 'staff';
  sessionId?: string;
  uid?: string;
  userId?: number;
  email?: string;
  displayName: string;
  isSuperAdmin: boolean;
  staffId?: number;
  role: StaffRole;
  restaurantId: number | null;
  permissions: Record<string, boolean>;
}

export interface AuthedRequest extends Request {
  auth?: AuthContext;
  qrSession?: {
    table: typeof restaurantTables.$inferSelect;
    restaurant: typeof restaurants.$inferSelect;
    customerSession: typeof customerQrSessions.$inferSelect;
    diningSession: typeof diningSessions.$inferSelect;
    qrToken: string;
  };
}

const SUPER_ADMIN_EMAIL = 'matkarpundlik@gmail.com';

export function getClientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

export async function getOrCreateFirebaseUser(
  uid: string,
  email: string,
  displayName?: string,
  avatarUrl?: string,
) {
  const isSuper = email.toLowerCase() === SUPER_ADMIN_EMAIL;
  const result = await db
    .insert(users)
    .values({
      uid,
      email,
      displayName: displayName || email.split('@')[0],
      avatarUrl: avatarUrl || '',
      isSuperAdmin: isSuper,
    })
    .onConflictDoUpdate({
      target: users.uid,
      set: {
        email,
        displayName: displayName || email.split('@')[0],
        avatarUrl: avatarUrl || '',
      },
    })
    .returning();
  return result[0];
}

export const csrfOriginGuard = async (req: Request, res: Response, next: NextFunction) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return next();
  }
  // Skip Origin check for server-to-server webhook endpoints
  if (req.path === '/webhooks/razorpay') {
    return next();
  }

  const origin = req.headers.origin;
  if (!origin) {
    return next();
  }

  try {
    const originHost = new URL(origin).host.toLowerCase();
    const expectedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();

    const isLocalLoopback = (h: string) =>
      h.startsWith('localhost:') || h.startsWith('127.0.0.1:') || h === 'localhost' || h === '127.0.0.1';

    if (expectedHost && originHost !== expectedHost && !(isLocalLoopback(originHost) && isLocalLoopback(expectedHost))) {
      await logSecurityEvent({
        severity: 'high',
        eventType: 'CSRF_ORIGIN_MISMATCH',
        ipAddress: getClientIp(req),
        path: req.originalUrl,
        method: req.method,
        statusCode: 403,
        details: { originHost, expectedHost },
      });
      return res.status(403).json({ error: 'Cross-origin request rejected' });
    }
  } catch {
    return res.status(403).json({ error: 'Invalid request origin' });
  }

  return next();
};

export const requireAuth = async (req: AuthedRequest, res: Response, next: NextFunction) => {
  const ipAddress = getClientIp(req);
  try {
    const authHeader = req.headers.authorization;
    // Allow ?token= ONLY on SSE stream routes where browser EventSource cannot attach headers
    const isSseRoute = req.path === '/realtime/stream';
    const queryToken = isSseRoute && typeof req.query.token === 'string' ? req.query.token : undefined;
    const rawToken =
      authHeader && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : queryToken;

    if (!rawToken) {
      await logSecurityEvent({
        severity: 'low',
        eventType: 'AUTH_MISSING_TOKEN',
        ipAddress,
        path: req.originalUrl,
        method: req.method,
        statusCode: 401,
      });
      return res.status(401).json({ error: 'Authentication required' });
    }

    // 1. Staff PIN Session Token (verified via HMAC + active DB user_sessions + tokenVersion)
    if (rawToken.startsWith('df_staff.')) {
      const payload = verifyAppToken(rawToken);
      if (!payload || payload.kind !== 'staff' || !payload.jti) {
        await logSecurityEvent({
          severity: 'medium',
          eventType: 'AUTH_INVALID_STAFF_TOKEN',
          ipAddress,
          path: req.originalUrl,
          method: req.method,
          statusCode: 401,
        });
        return res.status(401).json({ error: 'Invalid or expired staff session' });
      }

      const [sessionRow] = await db
        .select()
        .from(userSessions)
        .where(
          and(
            eq(userSessions.sessionId, payload.jti),
            isNull(userSessions.revokedAt),
            gt(userSessions.expiresAt, new Date()),
          ),
        )
        .limit(1);

      if (!sessionRow) {
        await logSecurityEvent({
          restaurantId: payload.restaurantId,
          severity: 'medium',
          eventType: 'REVOKED_OR_EXPIRED_SESSION_USED',
          actorIdentifier: payload.name,
          ipAddress,
          path: req.originalUrl,
          method: req.method,
          statusCode: 401,
        });
        return res.status(401).json({ error: 'Session has been logged out or expired' });
      }

      const [staff] = await db
        .select()
        .from(staffMembers)
        .where(and(eq(staffMembers.id, payload.staffId), eq(staffMembers.isActive, true)))
        .limit(1);

      if (!staff || staff.restaurantId !== payload.restaurantId || staff.tokenVersion !== payload.tv) {
        await logSecurityEvent({
          restaurantId: payload.restaurantId,
          severity: 'medium',
          eventType: 'STAFF_TOKEN_VERSION_REVOKED',
          actorIdentifier: payload.name,
          ipAddress,
          path: req.originalUrl,
          method: req.method,
          statusCode: 401,
        });
        return res.status(401).json({ error: 'Staff session revoked or account inactive' });
      }

      const requestedRestaurantId = req.headers['x-restaurant-id']
        ? Number(req.headers['x-restaurant-id'])
        : staff.restaurantId;

      if (requestedRestaurantId !== staff.restaurantId) {
        await logSecurityEvent({
          restaurantId: staff.restaurantId,
          severity: 'high',
          eventType: 'CROSS_TENANT_ACCESS_ATTEMPT',
          actorIdentifier: `${staff.name} (${staff.role})`,
          ipAddress,
          path: req.originalUrl,
          method: req.method,
          statusCode: 403,
          details: { targetRestaurantId: requestedRestaurantId, ownRestaurantId: staff.restaurantId },
        });
        return res.status(403).json({ error: 'Cross-restaurant access denied' });
      }

      const [rest] = await db
        .select({ isActive: restaurants.isActive })
        .from(restaurants)
        .where(eq(restaurants.id, staff.restaurantId))
        .limit(1);

      if (!rest || !rest.isActive) {
        return res.status(403).json({ error: 'Restaurant account is currently suspended' });
      }

      // Refresh lastSeenAt quietly
      db.update(userSessions)
        .set({ lastSeenAt: new Date() })
        .where(eq(userSessions.id, sessionRow.id))
        .catch(() => {});

      const rolePerms = DEFAULT_ROLE_PERMISSIONS[staff.role] || {};
      const mergedPerms = { ...rolePerms, ...(staff.permissions || {}) };
      if (staff.role === 'waiter' || staff.role === 'kitchen') {
        mergedPerms.view_table_pins = false;
        mergedPerms.regenerate_table_pins = false;
        mergedPerms.override_session_close = false;
      }
      req.auth = {
        authType: 'staff',
        sessionId: sessionRow.sessionId,
        displayName: staff.name,
        email: staff.email || undefined,
        isSuperAdmin: false,
        staffId: staff.id,
        role: staff.role as StaffRole,
        restaurantId: staff.restaurantId,
        permissions: mergedPerms,
      };
      return next();
    }

    // 2. Firebase Google Sign-In Token
    const decoded = await adminAuth.verifyIdToken(rawToken);
    const email = decoded.email || '';
    const dbUser = await getOrCreateFirebaseUser(
      decoded.uid,
      email,
      decoded.name,
      decoded.picture,
    );

    const isSuperAdmin = dbUser.isSuperAdmin || email.toLowerCase() === SUPER_ADMIN_EMAIL;
    const requestedHeader = req.headers['x-restaurant-id'] || (isSseRoute ? req.query.restaurantId : undefined);
    const requestedRestaurantId = requestedHeader ? Number(requestedHeader) : null;

    let activeRestaurantId: number | null = null;
    let role: StaffRole = isSuperAdmin ? 'super_admin' : 'owner';
    let permissions: Record<string, boolean> = DEFAULT_ROLE_PERMISSIONS.owner;
    let staffId: number | undefined;

    if (requestedRestaurantId && !Number.isNaN(requestedRestaurantId)) {
      const [rest] = await db
        .select()
        .from(restaurants)
        .where(eq(restaurants.id, requestedRestaurantId))
        .limit(1);

      if (!rest) {
        return res.status(404).json({ error: 'Restaurant not found' });
      }

      if (rest.ownerUid === decoded.uid || isSuperAdmin) {
        activeRestaurantId = rest.id;
        role = rest.ownerUid === decoded.uid ? 'owner' : 'super_admin';
        permissions = DEFAULT_ROLE_PERMISSIONS.owner;
      } else {
        const [member] = await db
          .select()
          .from(staffMembers)
          .where(
            and(
              eq(staffMembers.restaurantId, rest.id),
              eq(staffMembers.userId, dbUser.id),
              eq(staffMembers.isActive, true),
            ),
          )
          .limit(1);

        if (!member) {
          await logSecurityEvent({
            restaurantId: rest.id,
            severity: 'high',
            eventType: 'CROSS_TENANT_ACCESS_ATTEMPT',
            actorIdentifier: email || decoded.uid,
            ipAddress,
            path: req.originalUrl,
            method: req.method,
            statusCode: 403,
            details: { targetRestaurantId: rest.id },
          });
          return res.status(403).json({ error: 'Cross-restaurant access denied' });
        }
        activeRestaurantId = rest.id;
        staffId = member.id;
        role = member.role as StaffRole;
        permissions = { ...(DEFAULT_ROLE_PERMISSIONS[member.role] || {}), ...(member.permissions || {}) };
        if (member.role === 'waiter' || member.role === 'kitchen') {
          permissions.view_table_pins = false;
          permissions.regenerate_table_pins = false;
          permissions.override_session_close = false;
        }
      }
    }

    req.auth = {
      authType: 'firebase',
      uid: decoded.uid,
      userId: dbUser.id,
      email,
      displayName: dbUser.displayName || email,
      isSuperAdmin,
      staffId,
      role,
      restaurantId: activeRestaurantId,
      permissions,
    };

    return next();
  } catch (err) {
    await logSecurityEvent({
      severity: 'medium',
      eventType: 'AUTH_VERIFICATION_FAILED',
      ipAddress,
      path: req.originalUrl,
      method: req.method,
      statusCode: 401,
    });
    return res.status(401).json({ error: 'Unauthorized: Invalid credentials' });
  }
};

export const requireTenant = (req: AuthedRequest, res: Response, next: NextFunction) => {
  if (!req.auth || !req.auth.restaurantId) {
    return res.status(400).json({ error: 'No active restaurant selected or authorized' });
  }
  return next();
};

export const requirePermission = (permissionKey: string) => {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.auth) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (req.auth.isSuperAdmin || req.auth.role === 'owner') {
      return next();
    }
    if (!req.auth.permissions[permissionKey]) {
      await logSecurityEvent({
        restaurantId: req.auth.restaurantId,
        severity: 'medium',
        eventType: 'PERMISSION_DENIED',
        actorIdentifier: `${req.auth.displayName} (${req.auth.role})`,
        ipAddress: getClientIp(req),
        path: req.originalUrl,
        method: req.method,
        statusCode: 403,
        details: { requiredPermission: permissionKey, actorRole: req.auth.role },
      });
      return res.status(403).json({ error: `Permission denied: ${permissionKey} required` });
    }
    return next();
  };
};

export const requireSuperAdmin = async (req: AuthedRequest, res: Response, next: NextFunction) => {
  if (!req.auth || !req.auth.isSuperAdmin) {
    await logSecurityEvent({
      restaurantId: req.auth?.restaurantId ?? null,
      severity: 'high',
      eventType: 'SUPER_ADMIN_ACCESS_DENIED',
      actorIdentifier: req.auth ? `${req.auth.displayName} (${req.auth.role})` : 'anonymous',
      ipAddress: getClientIp(req),
      path: req.originalUrl,
      method: req.method,
      statusCode: 403,
    });
    return res.status(403).json({ error: 'Platform Super Admin privileges required' });
  }
  return next();
};

export const requireQrSession = async (req: AuthedRequest, res: Response, next: NextFunction) => {
  const ipAddress = getClientIp(req);
  const qrToken = String(req.params.qrToken || '').trim();
  const tokenDigest = hashTokenSha256(qrToken).slice(0, 16);

  try {
    const isStream = req.path.endsWith('/stream');
    const sessionHeader = String(
      req.headers['x-qr-session'] || (isStream && typeof req.query.session === 'string' ? req.query.session : '') || '',
    ).trim();

    if (!sessionHeader) {
      await logSecurityEvent({
        severity: 'medium',
        eventType: 'QR_SESSION_MISSING',
        ipAddress,
        path: req.originalUrl,
        method: req.method,
        statusCode: 401,
        details: { tokenDigest },
      });
      return res.status(401).json({ error: 'Valid QR table session required' });
    }

    const verified = verifyAppToken(sessionHeader);
    if (
      !verified ||
      verified.kind !== 'qr' ||
      verified.qrToken !== qrToken ||
      !verified.qsid ||
      !verified.dsid
    ) {
      await logSecurityEvent({
        severity: 'high',
        eventType: 'QR_SESSION_MISMATCH_OR_INVALID',
        ipAddress,
        path: req.originalUrl,
        method: req.method,
        statusCode: 401,
        details: { tokenDigest },
      });
      return res.status(401).json({
        error: 'Your ordering session has expired. Please scan the table QR code again.',
      });
    }

    const [table] = await db
      .select()
      .from(restaurantTables)
      .where(eq(restaurantTables.qrToken, qrToken))
      .limit(1);

    if (!table || table.id !== verified.tableId || table.restaurantId !== verified.restaurantId) {
      await logSecurityEvent({
        severity: 'high',
        eventType: 'SUSPICIOUS_QR_ACCESS',
        ipAddress,
        path: req.originalUrl,
        method: req.method,
        statusCode: 401,
        details: { reason: 'table_mismatch_or_not_found', tokenDigest },
      });
      return res.status(401).json({ error: 'Invalid or expired table QR code' });
    }

    if (table.qrRevokedAt) {
      await logSecurityEvent({
        restaurantId: table.restaurantId,
        severity: 'high',
        eventType: 'REVOKED_QR_ACCESS_BLOCKED',
        ipAddress,
        path: req.originalUrl,
        method: req.method,
        statusCode: 401,
        details: { tableId: table.id, tokenVersion: table.qrTokenVersion },
      });
      return res.status(401).json({ error: 'This table QR code has been revoked by the restaurant' });
    }

    if (table.qrExpiresAt && table.qrExpiresAt.getTime() <= Date.now()) {
      await logSecurityEvent({
        restaurantId: table.restaurantId,
        severity: 'medium',
        eventType: 'EXPIRED_QR_ACCESS_BLOCKED',
        ipAddress,
        path: req.originalUrl,
        method: req.method,
        statusCode: 401,
        details: { tableId: table.id },
      });
      return res.status(401).json({ error: 'This table QR code has expired. Ask staff for a refreshed code.' });
    }

    if (table.qrTokenVersion !== verified.tv) {
      await logSecurityEvent({
        restaurantId: table.restaurantId,
        severity: 'high',
        eventType: 'STALE_QR_SESSION_BLOCKED',
        ipAddress,
        path: req.originalUrl,
        method: req.method,
        statusCode: 401,
        details: { tableId: table.id, sessionTv: verified.tv, currentTv: table.qrTokenVersion },
      });
      return res.status(401).json({ error: 'QR code was regenerated. Please scan the new table QR.' });
    }

    // Verify server-side customer QR session binding, 30-min inactivity, and active dining session
    const [customerSession] = await db
      .select()
      .from(customerQrSessions)
      .where(eq(customerQrSessions.qrSessionUid, verified.qsid))
      .limit(1);

    if (
      !customerSession ||
      customerSession.tableId !== table.id ||
      customerSession.restaurantId !== table.restaurantId ||
      customerSession.diningSessionId !== verified.dsid
    ) {
      await logSecurityEvent({
        restaurantId: table.restaurantId,
        severity: 'high',
        eventType: 'QR_SESSION_BINDING_INVALID',
        ipAddress,
        path: req.originalUrl,
        method: req.method,
        statusCode: 401,
        details: { tableId: table.id },
      });
      return res.status(401).json({
        error: 'Your ordering session has expired. Please scan the table QR code again.',
      });
    }

    if (customerSession.revokedAt || customerSession.expiresAt.getTime() <= Date.now()) {
      await logSecurityEvent({
        restaurantId: table.restaurantId,
        severity: 'high',
        eventType: 'REVOKED_CUSTOMER_QR_SESSION_BLOCKED',
        ipAddress,
        path: req.originalUrl,
        method: req.method,
        statusCode: 401,
        details: {
          tableId: table.id,
          diningSessionId: customerSession.diningSessionId,
          reason: customerSession.revokeReason || 'expired',
        },
      });
      return res.status(401).json({
        error: 'Your ordering session has expired. Please scan the table QR code again.',
      });
    }

    if (Date.now() - customerSession.lastActivityAt.getTime() > QR_INACTIVITY_TTL_MS) {
      await db
        .update(customerQrSessions)
        .set({ revokedAt: new Date(), revokeReason: 'inactivity_timeout' })
        .where(eq(customerQrSessions.id, customerSession.id));

      await logSecurityEvent({
        restaurantId: table.restaurantId,
        severity: 'medium',
        eventType: 'QR_SESSION_INACTIVITY_EXPIRED',
        ipAddress,
        path: req.originalUrl,
        method: req.method,
        statusCode: 401,
        details: { tableId: table.id, diningSessionId: customerSession.diningSessionId },
      });
      return res.status(401).json({
        error: 'Your ordering session has expired. Please scan the table QR code again.',
      });
    }

    const [diningSession] = await db
      .select()
      .from(diningSessions)
      .where(
        and(
          eq(diningSessions.id, customerSession.diningSessionId),
          eq(diningSessions.tableId, table.id),
          eq(diningSessions.restaurantId, table.restaurantId),
        ),
      )
      .limit(1);

    if (!diningSession || diningSession.status !== 'ACTIVE') {
      await db
        .update(customerQrSessions)
        .set({ revokedAt: new Date(), revokeReason: 'dining_session_closed' })
        .where(and(eq(customerQrSessions.id, customerSession.id), isNull(customerQrSessions.revokedAt)));

      await logSecurityEvent({
        restaurantId: table.restaurantId,
        severity: 'high',
        eventType: 'CLOSED_DINING_SESSION_ACCESS_BLOCKED',
        ipAddress,
        path: req.originalUrl,
        method: req.method,
        statusCode: 401,
        details: { tableId: table.id, diningSessionId: customerSession.diningSessionId },
      });
      return res.status(401).json({
        error: 'Your ordering session has expired. Please scan the table QR code again.',
      });
    }

    // Prevent customers from tampering with tableId, restaurantId, or diningSessionId in payload
    if (req.body && typeof req.body === 'object') {
      if (req.body.tableId !== undefined && Number(req.body.tableId) !== table.id) {
        await logSecurityEvent({
          restaurantId: table.restaurantId,
          severity: 'high',
          eventType: 'QR_TABLE_TAMPER_ATTEMPT',
          ipAddress,
          path: req.originalUrl,
          method: req.method,
          statusCode: 403,
          details: { sessionTableId: table.id, attemptedTableId: req.body.tableId },
        });
        return res.status(403).json({ error: 'Table tampering detected and blocked' });
      }
      if (req.body.restaurantId !== undefined && Number(req.body.restaurantId) !== table.restaurantId) {
        await logSecurityEvent({
          restaurantId: table.restaurantId,
          severity: 'high',
          eventType: 'QR_TENANT_TAMPER_ATTEMPT',
          ipAddress,
          path: req.originalUrl,
          method: req.method,
          statusCode: 403,
          details: { sessionRestaurantId: table.restaurantId, attemptedRestaurantId: req.body.restaurantId },
        });
        return res.status(403).json({ error: 'Cross-restaurant tampering detected and blocked' });
      }
      if (
        req.body.diningSessionId !== undefined &&
        Number(req.body.diningSessionId) !== diningSession.id &&
        String(req.body.diningSessionId) !== diningSession.sessionUid
      ) {
        await logSecurityEvent({
          restaurantId: table.restaurantId,
          severity: 'high',
          eventType: 'QR_SESSION_TAMPER_ATTEMPT',
          ipAddress,
          path: req.originalUrl,
          method: req.method,
          statusCode: 403,
          details: { sessionId: diningSession.id, attemptedSessionId: req.body.diningSessionId },
        });
        return res.status(403).json({ error: 'Dining session tampering detected and blocked' });
      }
    }

    const [rest] = await db
      .select()
      .from(restaurants)
      .where(and(eq(restaurants.id, table.restaurantId), eq(restaurants.isActive, true)))
      .limit(1);

    if (!rest || !rest.qrOrderingEnabled) {
      return res.status(403).json({ error: 'QR ordering is currently unavailable for this outlet' });
    }

    if (!isStream) {
      db.update(customerQrSessions)
        .set({ lastActivityAt: new Date() })
        .where(eq(customerQrSessions.id, customerSession.id))
        .catch(() => {});
    }

    req.qrSession = { table, restaurant: rest, customerSession, diningSession, qrToken };
    return next();
  } catch (err) {
    console.error('QR session middleware error:', err);
    return res.status(401).json({ error: 'QR session verification failed' });
  }
};
