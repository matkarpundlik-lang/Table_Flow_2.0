import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type express from 'express';
import { Router } from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  billingSettings,
  diningSessions,
  orders,
  payments,
  receiptTemplates,
  receipts,
  restaurantTables,
  restaurants,
  serviceRequests,
} from '../db/schema.ts';
import {
  type AuthedRequest,
  getClientIp,
  requireAuth,
  requirePermission,
  requireQrSession,
  requireTenant,
} from './middleware.ts';
import { broadcastToRestaurant } from './realtime.ts';
import {
  SlidingWindowLimiter,
  UPLOADS_LOGOS_DIR,
  generateRazorpayTestSignature,
  resolveSafeLogoPath,
  sanitizeLogoUrl,
  sanitizeText,
  validateReceiptMagicBytes,
  verifyRazorpayTestSignature,
} from './security.ts';
import { logAudit, logSecurityEvent, syncDiningSessionPaymentStatus } from './services.ts';
import {
  STARTER_TEMPLATE_PRESETS,
  buildUpiPaymentUri,
  computeDiningSessionBill,
  ensureRestaurantBillingSetup,
  issueReceiptForPayment,
  normalizeVisibility,
  sanitizeCustomMethods,
  sanitizeSocialHandles,
} from './billing-services.ts';

if (!fs.existsSync(UPLOADS_LOGOS_DIR)) {
  fs.mkdirSync(UPLOADS_LOGOS_DIR, { recursive: true });
}

const logoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOADS_LOGOS_DIR);
  },
  filename: (req, file, cb) => {
    const restId = (req as AuthedRequest).auth?.restaurantId || 0;
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '');
    const safeExt = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext) ? ext : '.png';
    cb(null, `logo_r${restId}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}${safeExt}`);
  },
});

const uploadLogo = multer({
  storage: logoStorage,
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
      return cb(new Error('Only PNG, JPEG, or WEBP logo images are allowed'));
    }
    cb(null, true);
  },
});

const customerPayLimiter = new SlidingWindowLimiter(20, 5 * 60 * 1000);

const canEditTemplates = (req: AuthedRequest): boolean => {
  if (!req.auth) return false;
  return (
    req.auth.isSuperAdmin ||
    req.auth.role === 'owner' ||
    req.auth.role === 'manager' ||
    Boolean(req.auth.permissions.manage_settings)
  );
};

const canManageRefunds = (req: AuthedRequest): boolean => {
  if (!req.auth) return false;
  if (req.auth.isSuperAdmin || req.auth.role === 'owner') return true;
  if (!req.auth.permissions.manage_billing) return false;
  return req.auth.role === 'manager' || Boolean(req.auth.permissions.cancel_orders);
};

export function registerBillingRoutes(router: Router) {
  // ---------------------------------------------------------------------------
  // BRAND LOGO UPLOAD & SERVING (VALIDATED MAGIC BYTES, NO PATH TRAVERSAL)
  // ---------------------------------------------------------------------------

  router.post(
    '/uploads/logo',
    requireAuth,
    requireTenant,
    async (req: AuthedRequest, res, next) => {
      if (!canEditTemplates(req)) {
        return res.status(403).json({ error: 'Only owners or authorized managers can upload brand logos' });
      }
      next();
    },
    uploadLogo.single('logo'),
    async (req: AuthedRequest, res) => {
      if (!req.file) {
        return res.status(400).json({ error: 'No logo image uploaded' });
      }
      const check = validateReceiptMagicBytes(req.file.path);
      if (!check.valid || !['image/png', 'image/jpeg', 'image/webp'].includes(check.detectedType)) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {
          // ignore cleanup
        }
        await logSecurityEvent({
          restaurantId: req.auth!.restaurantId,
          severity: 'high',
          eventType: 'MALICIOUS_LOGO_UPLOAD_REJECTED',
          actorIdentifier: `${req.auth!.displayName} (${req.auth!.role})`,
          ipAddress: getClientIp(req),
          path: req.originalUrl,
          method: req.method,
          statusCode: 400,
          details: { detectedType: check.detectedType },
        });
        return res.status(400).json({ error: 'Logo must be a valid PNG, JPEG, or WEBP image' });
      }
      res.status(201).json({ logoUrl: `/api/uploads/logos/${req.file.filename}` });
    },
  );

  router.get('/uploads/logos/:filename', (req, res) => {
    const safePath = resolveSafeLogoPath(String(req.params.filename || ''));
    if (!safePath || !fs.existsSync(safePath)) {
      return res.status(404).json({ error: 'Logo not found' });
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(safePath);
  });

  // ---------------------------------------------------------------------------
  // CUSTOMER QR BILLING, PAYMENT INITIATION, PROOF SUBMISSION & RECEIPTS
  // ---------------------------------------------------------------------------

  router.get('/qr/:qrToken/bill', requireQrSession, async (req: AuthedRequest, res) => {
    try {
      const { restaurant, diningSession } = req.qrSession!;
      const bill = await computeDiningSessionBill(restaurant.id, diningSession.id);

      // Enrich pending UPI payment with QR image so page reloads preserve active QR
      let pendingUpiQrDataUrl = '';
      if (bill.pendingPayment && bill.pendingPayment.method === 'upi' && bill.pendingPayment.upiUri) {
        pendingUpiQrDataUrl = await QRCode.toDataURL(bill.pendingPayment.upiUri, {
          width: 260,
          margin: 2,
          color: { dark: '#0F172A', light: '#FFFFFF' },
        });
      }

      res.json({
        ...bill,
        pendingUpiQrDataUrl,
      });
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ error: err.message || 'Failed to compute table bill' });
    }
  });

  router.post('/qr/:qrToken/payments/initiate', requireQrSession, async (req: AuthedRequest, res) => {
    const ipAddress = getClientIp(req);
    try {
      const { table, restaurant, diningSession, qrToken } = req.qrSession!;

      const rl = customerPayLimiter.consume(`${ipAddress}:${qrToken}`);
      if (!rl.allowed) {
        res.setHeader('Retry-After', String(rl.retryAfterSeconds));
        return res.status(429).json({ error: 'Too many payment requests. Please wait a moment.' });
      }

      const rawMethod = sanitizeText(req.body?.method || 'upi', 40).toLowerCase();
      const rawIdempKey = sanitizeText(
        req.headers['x-idempotency-key'] || req.body?.idempotencyKey || '',
        120,
      );
      if (!rawIdempKey || rawIdempKey.length < 8) {
        return res.status(400).json({ error: 'Valid idempotencyKey is required to prevent duplicate payments' });
      }

      const bill = await computeDiningSessionBill(restaurant.id, diningSession.id);

      if (bill.activeOrderIds.length === 0) {
        return res.status(400).json({ error: 'No active orders found for this table yet' });
      }

      if (bill.summary.balanceDue <= 0.01) {
        return res.status(409).json({
          error: 'This bill is already fully settled',
          receipt: bill.receipts[0] || null,
        });
      }

      const requestedAmount = req.body?.amount !== undefined ? Number(req.body.amount) : bill.summary.balanceDue;
      if (Number.isNaN(requestedAmount) || requestedAmount <= 0) {
        return res.status(400).json({ error: 'Payment amount must be positive' });
      }
      // Server-authoritative cap: customer cannot pay more than remaining balance due
      const payableAmount = Number(Math.min(bill.summary.balanceDue, requestedAmount).toFixed(2));
      if (payableAmount <= 0) {
        return res.status(409).json({ error: 'No remaining balance to pay' });
      }

      const isStandardMethod = ['upi', 'cash', 'card', 'razorpay'].includes(rawMethod);
      const customMethod = bill.customMethods.find((m) => m.code === rawMethod);
      if (!isStandardMethod && !customMethod) {
        return res.status(400).json({ error: 'Selected payment method is not enabled by this restaurant' });
      }
      if (isStandardMethod && !bill.acceptedMethods.includes(rawMethod)) {
        return res.status(400).json({ error: `${rawMethod.toUpperCase()} payment is not enabled by this restaurant` });
      }

      if (rawMethod === 'upi' && (!bill.restaurant.upiId || !bill.restaurant.upiId.includes('@'))) {
        return res.status(400).json({
          error: 'Restaurant UPI ID is not configured yet. Please pay via Cash/Card or ask staff.',
        });
      }

      const primaryOrderId = bill.activeOrderIds[bill.activeOrderIds.length - 1];
      const paymentMethodLabel = customMethod
        ? customMethod.label
        : rawMethod === 'upi'
        ? 'UPI QR'
        : rawMethod === 'card'
        ? 'Card at Table'
        : rawMethod === 'cash'
        ? 'Cash'
        : 'Online Gateway';

      const methodValue = customMethod ? 'other' : rawMethod;
      const refCode = `DF-${diningSession.id}-${Date.now().toString().slice(-6)}`;
      const upiUri =
        rawMethod === 'upi'
          ? buildUpiPaymentUri({
              upiId: bill.restaurant.upiId,
              payeeName: bill.restaurant.upiPayeeName || restaurant.name,
              amount: payableAmount,
              transactionRef: refCode,
              note: `${restaurant.name} Table ${table.tableNumber}`,
            })
          : '';
      const razorpayOrderId =
        rawMethod === 'razorpay' ? `order_rzp_test_${crypto.randomBytes(6).toString('hex')}` : '';

      const txResult = await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT id FROM dining_sessions WHERE id = ${diningSession.id} FOR UPDATE`,
        );

        const [existingByIdemp] = await tx
          .select()
          .from(payments)
          .where(and(eq(payments.restaurantId, restaurant.id), eq(payments.idempotencyKey, rawIdempKey)))
          .limit(1);

        if (existingByIdemp) {
          return { payment: existingByIdemp, reused: true };
        }

        // Prevent duplicate pending/processing requests from double clicks
        const [activePending] = await tx
          .select()
          .from(payments)
          .where(
            and(
              eq(payments.restaurantId, restaurant.id),
              eq(payments.diningSessionId, diningSession.id),
              inArray(payments.status, ['pending', 'processing']),
            ),
          )
          .orderBy(desc(payments.createdAt))
          .limit(1);

        if (
          activePending &&
          activePending.method === methodValue &&
          Math.abs(activePending.amount - payableAmount) < 0.5
        ) {
          return { payment: activePending, reused: true };
        }

        // Mark older unconfirmed pending requests superseded as failed before creating a new method
        if (activePending) {
          await tx
            .update(payments)
            .set({
              status: 'failed',
              notes: `Replaced by new ${paymentMethodLabel} payment attempt`,
            })
            .where(
              and(
                eq(payments.id, activePending.id),
                eq(payments.status, 'pending'),
              ),
            );
        }

        const [created] = await tx
          .insert(payments)
          .values({
            restaurantId: restaurant.id,
            orderId: primaryOrderId,
            diningSessionId: diningSession.id,
            amount: payableAmount,
            method: methodValue,
            paymentMethodLabel,
            status: 'pending', // NEVER auto-paid on customer initiation!
            initiatedBySource: 'customer_qr',
            upiUri,
            razorpayOrderId,
            transactionRef: refCode,
            idempotencyKey: rawIdempKey,
            notes: `Customer QR initiated ${paymentMethodLabel} for Table ${table.tableNumber}`,
          })
          .returning();

        await tx
          .update(diningSessions)
          .set({
            billRequested: true,
            billRequestedAt: diningSession.billRequestedAt || new Date(),
            updatedAt: new Date(),
          })
          .where(eq(diningSessions.id, diningSession.id));

        await tx
          .update(restaurantTables)
          .set({ status: 'Billing' })
          .where(eq(restaurantTables.id, table.id));

        return { payment: created, reused: false };
      });

      const createdPayment = txResult.payment;

      if (!txResult.reused && ['cash', 'card', 'other'].includes(methodValue)) {
        await db.insert(serviceRequests).values({
          restaurantId: restaurant.id,
          tableId: table.id,
          diningSessionId: diningSession.id,
          requestType: 'bill',
          note: `Customer selected ${paymentMethodLabel} for ₹${payableAmount.toFixed(2)} — collect & confirm`,
          status: 'pending',
        });
      }

      await syncDiningSessionPaymentStatus(diningSession.id);

      await logSecurityEvent({
        restaurantId: restaurant.id,
        severity: 'low',
        eventType: 'CUSTOMER_PAYMENT_INITIATED',
        actorIdentifier: `Table ${table.tableNumber}`,
        ipAddress,
        path: req.originalUrl,
        method: req.method,
        statusCode: 201,
        details: {
          paymentId: createdPayment.id,
          diningSessionId: diningSession.id,
          method: paymentMethodLabel,
          amount: payableAmount,
        },
      });

      broadcastToRestaurant(
        restaurant.id,
        'payment:updated',
        {
          payment: createdPayment,
          tableId: table.id,
          tableNumber: table.tableNumber,
          diningSessionId: diningSession.id,
        },
        table.id,
      );

      let qrDataUrl = '';
      if (createdPayment.upiUri) {
        qrDataUrl = await QRCode.toDataURL(createdPayment.upiUri, {
          width: 260,
          margin: 2,
          color: { dark: '#0F172A', light: '#FFFFFF' },
        });
      }

      res.status(201).json({
        payment: createdPayment,
        upiUri: createdPayment.upiUri || '',
        upiQrDataUrl: qrDataUrl,
        upiId: bill.restaurant.upiId,
        razorpayOrderId: createdPayment.razorpayOrderId || '',
        amountPaise: Math.round(createdPayment.amount * 100),
      });
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ error: err.message || 'Failed to initiate payment' });
    }
  });

  router.post(
    '/qr/:qrToken/payments/:paymentId/submit-proof',
    requireQrSession,
    async (req: AuthedRequest, res) => {
      const ipAddress = getClientIp(req);
      try {
        const { table, restaurant, diningSession } = req.qrSession!;
        const paymentId = Number(req.params.paymentId);
        const utrRef = sanitizeText(req.body?.utr || req.body?.transactionRef || '', 64);

        if (!utrRef || utrRef.length < 4) {
          return res.status(400).json({
            error: 'Please enter a valid 4+ character UPI Transaction / UTR Reference ID',
          });
        }

        const [existing] = await db
          .select()
          .from(payments)
          .where(
            and(
              eq(payments.id, paymentId),
              eq(payments.restaurantId, restaurant.id),
              eq(payments.diningSessionId, diningSession.id),
            ),
          )
          .limit(1);

        if (!existing) {
          return res.status(404).json({ error: 'Payment session not found for this table' });
        }

        if (existing.status === 'verified') {
          return res.status(409).json({ error: 'Payment is already verified' });
        }

        if (!['pending', 'processing'].includes(existing.status)) {
          return res.status(409).json({ error: 'This payment attempt is no longer active' });
        }

        // Moves to 'processing' — NEVER auto-marks Paid without staff or gateway verification!
        const [updated] = await db
          .update(payments)
          .set({
            status: 'processing',
            customerUtrSubmitted: utrRef,
            transactionRef: utrRef,
            notes: `Customer submitted UPI ref ${utrRef} — awaiting staff/gateway verification`,
          })
          .where(eq(payments.id, existing.id))
          .returning();

        await db.insert(serviceRequests).values({
          restaurantId: restaurant.id,
          tableId: table.id,
          diningSessionId: diningSession.id,
          requestType: 'bill',
          note: `Verify UPI payment ₹${existing.amount.toFixed(2)} (UTR: ${utrRef})`,
          status: 'pending',
        });

        await logSecurityEvent({
          restaurantId: restaurant.id,
          severity: 'low',
          eventType: 'CUSTOMER_UPI_PROOF_SUBMITTED',
          actorIdentifier: `Table ${table.tableNumber}`,
          ipAddress,
          path: req.originalUrl,
          method: req.method,
          statusCode: 200,
          details: { paymentId: existing.id, diningSessionId: diningSession.id, utrRef },
        });

        broadcastToRestaurant(
          restaurant.id,
          'payment:updated',
          {
            payment: updated,
            tableId: table.id,
            tableNumber: table.tableNumber,
            diningSessionId: diningSession.id,
          },
          table.id,
        );

        res.json({
          payment: updated,
          message: 'Payment reference submitted for verification. Staff will confirm once received.',
        });
      } catch (err: any) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Failed to submit payment proof' });
      }
    },
  );

  router.post(
    '/qr/:qrToken/payments/:paymentId/razorpay-verify',
    requireQrSession,
    async (req: AuthedRequest, res) => {
      const ipAddress = getClientIp(req);
      try {
        const { table, restaurant, diningSession } = req.qrSession!;
        const paymentId = Number(req.params.paymentId);
        const razorpayOrderId = String(req.body?.razorpayOrderId || '').trim();
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
              eq(payments.restaurantId, restaurant.id),
              eq(payments.diningSessionId, diningSession.id),
              eq(payments.razorpayOrderId, razorpayOrderId),
            ),
          )
          .limit(1);

        if (!pending || !['pending', 'processing'].includes(pending.status)) {
          return res.status(404).json({ error: 'Pending online payment not found or already processed' });
        }

        if (outcome === 'fail') {
          const [failed] = await db
            .update(payments)
            .set({ status: 'failed', notes: 'Online gateway payment declined' })
            .where(eq(payments.id, pending.id))
            .returning();

          await syncDiningSessionPaymentStatus(diningSession.id);
          broadcastToRestaurant(restaurant.id, 'payment:updated', { payment: failed, tableId: table.id }, table.id);
          return res.status(402).json({ error: 'Payment declined', payment: failed });
        }

        const rzpPaymentId = String(
          req.body?.razorpayPaymentId || `pay_test_${crypto.randomBytes(5).toString('hex')}`,
        );
        const signature = simulateAuthorize
          ? generateRazorpayTestSignature(razorpayOrderId, rzpPaymentId)
          : String(req.body?.razorpaySignature || '');

        if (!verifyRazorpayTestSignature(razorpayOrderId, rzpPaymentId, signature)) {
          await logSecurityEvent({
            restaurantId: restaurant.id,
            severity: 'high',
            eventType: 'CUSTOMER_RAZORPAY_SIGNATURE_INVALID',
            actorIdentifier: `Table ${table.tableNumber}`,
            ipAddress,
            path: req.originalUrl,
            method: req.method,
            statusCode: 400,
            details: { paymentId, razorpayOrderId },
          });
          return res.status(400).json({ error: 'Payment signature verification failed' });
        }

        const verifiedPayment = await settleSessionPaymentAndOrders({
          restaurantId: restaurant.id,
          paymentId: pending.id,
          actorName: 'Razorpay Gateway',
          transactionRef: rzpPaymentId,
          razorpayPaymentId: rzpPaymentId,
          razorpaySignature: signature,
          notes: 'Verified via Razorpay cryptographic signature',
        });

        const receipt = await issueReceiptForPayment({
          restaurantId: restaurant.id,
          paymentId: verifiedPayment.id,
          actorName: 'Razorpay Gateway',
          includeFullSessionOrders: true,
        });

        await syncDiningSessionPaymentStatus(diningSession.id);

        await logSecurityEvent({
          restaurantId: restaurant.id,
          severity: 'low',
          eventType: 'CUSTOMER_RAZORPAY_VERIFIED',
          actorIdentifier: `Table ${table.tableNumber}`,
          ipAddress,
          path: req.originalUrl,
          method: req.method,
          statusCode: 200,
          details: { paymentId: verifiedPayment.id, receiptNumber: receipt.receiptNumber },
        });

        broadcastToRestaurant(
          restaurant.id,
          'receipt:created',
          { receipt, tableId: table.id, diningSessionId: diningSession.id },
          table.id,
        );
        broadcastToRestaurant(
          restaurant.id,
          'payment:updated',
          { payment: verifiedPayment, receipt, tableId: table.id, diningSessionId: diningSession.id },
          table.id,
        );

        res.json({ payment: verifiedPayment, receipt });
      } catch (err: any) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Failed to verify payment' });
      }
    },
  );

  router.get('/qr/:qrToken/receipts', requireQrSession, async (req: AuthedRequest, res) => {
    try {
      const { restaurant, diningSession } = req.qrSession!;
      const rows = await db
        .select()
        .from(receipts)
        .where(
          and(
            eq(receipts.restaurantId, restaurant.id),
            eq(receipts.diningSessionId, diningSession.id),
          ),
        )
        .orderBy(desc(receipts.createdAt));

      res.json({ receipts: rows });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to load receipts' });
    }
  });

  router.get('/qr/:qrToken/receipts/:receiptId', requireQrSession, async (req: AuthedRequest, res) => {
    try {
      const { restaurant, diningSession, table } = req.qrSession!;
      const receiptId = Number(req.params.receiptId);
      const [row] = await db
        .select()
        .from(receipts)
        .where(and(eq(receipts.id, receiptId), eq(receipts.restaurantId, restaurant.id)))
        .limit(1);

      if (!row || row.diningSessionId !== diningSession.id) {
        await logSecurityEvent({
          restaurantId: restaurant.id,
          severity: 'high',
          eventType: 'CROSS_SESSION_RECEIPT_ACCESS_BLOCKED',
          actorIdentifier: `Table ${table.tableNumber}`,
          ipAddress: getClientIp(req),
          path: req.originalUrl,
          method: req.method,
          statusCode: 403,
          details: { requestedReceiptId: receiptId, activeSessionId: diningSession.id },
        });
        return res.status(404).json({ error: 'Receipt not found for your active dining session' });
      }

      res.json({ receipt: row });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to load receipt' });
    }
  });

  // ---------------------------------------------------------------------------
  // BILLING SETTINGS & CUSTOM RECEIPT TEMPLATES (OWNER & MANAGER ONLY)
  // ---------------------------------------------------------------------------

  router.get('/billing/settings', requireAuth, requireTenant, async (req: AuthedRequest, res) => {
    try {
      if (!canEditTemplates(req)) {
        await logSecurityEvent({
          restaurantId: req.auth!.restaurantId,
          severity: 'medium',
          eventType: 'BILLING_SETTINGS_ACCESS_DENIED',
          actorIdentifier: `${req.auth!.displayName} (${req.auth!.role})`,
          ipAddress: getClientIp(req),
          path: req.originalUrl,
          method: req.method,
          statusCode: 403,
        });
        return res.status(403).json({
          error: 'Only owners or authorized managers can access billing template settings',
        });
      }

      const restaurantId = req.auth!.restaurantId!;
      const setup = await ensureRestaurantBillingSetup(restaurantId);
      res.json(setup);
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ error: err.message || 'Failed to load billing settings' });
    }
  });

  router.patch('/billing/settings', requireAuth, requireTenant, async (req: AuthedRequest, res) => {
    try {
      if (!canEditTemplates(req)) {
        return res.status(403).json({
          error: 'Only owners or authorized managers can update billing settings',
        });
      }

      const restaurantId = req.auth!.restaurantId!;
      const { settings: current } = await ensureRestaurantBillingSetup(restaurantId);

      const upiId =
        req.body?.upiId !== undefined ? sanitizeText(req.body.upiId, 100).replace(/\s+/g, '') : current.upiId;
      const upiPayeeName =
        req.body?.upiPayeeName !== undefined
          ? sanitizeText(req.body.upiPayeeName, 80)
          : current.upiPayeeName;
      const otherChargesLabel =
        req.body?.otherChargesLabel !== undefined
          ? sanitizeText(req.body.otherChargesLabel, 50)
          : current.otherChargesLabel;
      const otherChargesAmount =
        req.body?.otherChargesAmount !== undefined
          ? Math.max(0, Number(req.body.otherChargesAmount) || 0)
          : current.otherChargesAmount;
      const thankYouMessage =
        req.body?.thankYouMessage !== undefined
          ? sanitizeText(req.body.thankYouMessage, 240)
          : current.thankYouMessage;
      const customPaymentMethods =
        req.body?.customPaymentMethods !== undefined
          ? sanitizeCustomMethods(req.body.customPaymentMethods)
          : current.customPaymentMethods;
      const socialHandles =
        req.body?.socialHandles !== undefined
          ? sanitizeSocialHandles(req.body.socialHandles)
          : current.socialHandles;

      const [updatedSettings] = await db
        .update(billingSettings)
        .set({
          upiId,
          upiPayeeName,
          otherChargesLabel,
          otherChargesAmount,
          thankYouMessage,
          customPaymentMethods,
          socialHandles,
          updatedBy: req.auth!.displayName,
          updatedAt: new Date(),
        })
        .where(eq(billingSettings.id, current.id))
        .returning();

      const acceptedPaymentMethods = Array.isArray(req.body?.acceptedPaymentMethods)
        ? req.body.acceptedPaymentMethods.filter((m: unknown) =>
            ['upi', 'cash', 'card', 'razorpay'].includes(String(m)),
          )
        : undefined;

      const restUpdates: Record<string, unknown> = {
        upiId,
        upiPayeeName,
        updatedAt: new Date(),
      };
      if (acceptedPaymentMethods && acceptedPaymentMethods.length > 0) {
        restUpdates.acceptedPaymentMethods = acceptedPaymentMethods;
      }
      if (req.body?.logoUrl !== undefined) {
        restUpdates.logoUrl = sanitizeLogoUrl(req.body.logoUrl);
      }

      const [updatedRestaurant] = await db
        .update(restaurants)
        .set(restUpdates)
        .where(eq(restaurants.id, restaurantId))
        .returning();

      await logAudit({
        restaurantId,
        actorName: req.auth!.displayName,
        actorRole: req.auth!.role,
        action: 'BILLING_SETTINGS_UPDATED',
        entityType: 'billing_settings',
        entityId: updatedSettings.id,
        details: { upiId, acceptedPaymentMethods },
      });

      res.json({ settings: updatedSettings, restaurant: updatedRestaurant });
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ error: err.message || 'Failed to update billing settings' });
    }
  });

  router.patch('/billing/templates/:id', requireAuth, requireTenant, async (req: AuthedRequest, res) => {
    try {
      if (!canEditTemplates(req)) {
        return res.status(403).json({
          error: 'Only owners or authorized managers can customise receipt templates',
        });
      }

      const restaurantId = req.auth!.restaurantId!;
      const templateId = Number(req.params.id);

      const [existing] = await db
        .select()
        .from(receiptTemplates)
        .where(and(eq(receiptTemplates.id, templateId), eq(receiptTemplates.restaurantId, restaurantId)))
        .limit(1);

      if (!existing) {
        return res.status(404).json({ error: 'Receipt template not found' });
      }

      const accent = String(req.body?.accentColor || existing.accentColor).trim();
      const safeAccent = /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : existing.accentColor;
      const fontStyle = ['sans', 'mono', 'serif'].includes(req.body?.fontStyle)
        ? req.body.fontStyle
        : existing.fontStyle;
      const fontSize = ['sm', 'md', 'lg'].includes(req.body?.fontSize)
        ? req.body.fontSize
        : existing.fontSize;
      const layoutMode = ['centered', 'left', 'compact'].includes(req.body?.layoutMode)
        ? req.body.layoutMode
        : existing.layoutMode;
      const paperSize = ['58mm', '80mm', 'A4'].includes(req.body?.paperSize)
        ? req.body.paperSize
        : existing.paperSize;
      const templateKey = ['classic', 'modern', 'premium', 'compact'].includes(req.body?.templateKey)
        ? req.body.templateKey
        : existing.templateKey;

      const logoUrl =
        req.body?.logoUrl !== undefined ? sanitizeLogoUrl(req.body.logoUrl) : existing.logoUrl;

      const [updated] = await db
        .update(receiptTemplates)
        .set({
          name: req.body?.name ? sanitizeText(req.body.name, 60) : existing.name,
          templateKey,
          logoUrl,
          businessName:
            req.body?.businessName !== undefined
              ? sanitizeText(req.body.businessName, 100)
              : existing.businessName,
          address:
            req.body?.address !== undefined
              ? sanitizeText(req.body.address, 220)
              : existing.address,
          phone:
            req.body?.phone !== undefined ? sanitizeText(req.body.phone, 32) : existing.phone,
          email:
            req.body?.email !== undefined ? sanitizeText(req.body.email, 120) : existing.email,
          gstin:
            req.body?.gstin !== undefined ? sanitizeText(req.body.gstin, 32) : existing.gstin,
          headerMessage:
            req.body?.headerMessage !== undefined
              ? sanitizeText(req.body.headerMessage, 180)
              : existing.headerMessage,
          footerMessage:
            req.body?.footerMessage !== undefined
              ? sanitizeText(req.body.footerMessage, 220)
              : existing.footerMessage,
          thankYouMessage:
            req.body?.thankYouMessage !== undefined
              ? sanitizeText(req.body.thankYouMessage, 220)
              : existing.thankYouMessage,
          socialHandles:
            req.body?.socialHandles !== undefined
              ? sanitizeSocialHandles(req.body.socialHandles)
              : existing.socialHandles,
          accentColor: safeAccent,
          fontStyle,
          fontSize,
          layoutMode,
          paperSize,
          visibility:
            req.body?.visibility !== undefined
              ? normalizeVisibility(req.body.visibility)
              : existing.visibility,
          updatedAt: new Date(),
        })
        .where(eq(receiptTemplates.id, existing.id))
        .returning();

      await logAudit({
        restaurantId,
        actorName: req.auth!.displayName,
        actorRole: req.auth!.role,
        action: 'RECEIPT_TEMPLATE_UPDATED',
        entityType: 'receipt_template',
        entityId: updated.id,
        details: { name: updated.name, templateKey: updated.templateKey, paperSize: updated.paperSize },
      });

      res.json({ template: updated });
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ error: err.message || 'Failed to update receipt template' });
    }
  });

  router.post(
    '/billing/templates/:id/set-default',
    requireAuth,
    requireTenant,
    async (req: AuthedRequest, res) => {
      try {
        if (!canEditTemplates(req)) {
          return res.status(403).json({
            error: 'Only owners or authorized managers can set the default receipt template',
          });
        }

        const restaurantId = req.auth!.restaurantId!;
        const templateId = Number(req.params.id);

        const [target] = await db
          .select()
          .from(receiptTemplates)
          .where(and(eq(receiptTemplates.id, templateId), eq(receiptTemplates.restaurantId, restaurantId)))
          .limit(1);

        if (!target) {
          return res.status(404).json({ error: 'Template not found' });
        }

        await db.transaction(async (tx) => {
          await tx
            .update(receiptTemplates)
            .set({ isDefault: false })
            .where(eq(receiptTemplates.restaurantId, restaurantId));

          await tx
            .update(receiptTemplates)
            .set({ isDefault: true, updatedAt: new Date() })
            .where(eq(receiptTemplates.id, templateId));

          await tx
            .update(billingSettings)
            .set({ activeTemplateId: templateId, updatedBy: req.auth!.displayName, updatedAt: new Date() })
            .where(eq(billingSettings.restaurantId, restaurantId));
        });

        const templates = await db
          .select()
          .from(receiptTemplates)
          .where(eq(receiptTemplates.restaurantId, restaurantId))
          .orderBy(receiptTemplates.id);

        await logAudit({
          restaurantId,
          actorName: req.auth!.displayName,
          actorRole: req.auth!.role,
          action: 'DEFAULT_RECEIPT_TEMPLATE_SET',
          entityType: 'receipt_template',
          entityId: templateId,
          details: { templateName: target.name },
        });

        res.json({ templates, defaultTemplate: templates.find((t) => t.id === templateId) });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to set default template' });
      }
    },
  );

  router.post(
    '/billing/templates/:id/reset',
    requireAuth,
    requireTenant,
    async (req: AuthedRequest, res) => {
      try {
        if (!canEditTemplates(req)) {
          return res.status(403).json({
            error: 'Only owners or authorized managers can reset receipt templates',
          });
        }

        const restaurantId = req.auth!.restaurantId!;
        const templateId = Number(req.params.id);

        const [existing] = await db
          .select()
          .from(receiptTemplates)
          .where(and(eq(receiptTemplates.id, templateId), eq(receiptTemplates.restaurantId, restaurantId)))
          .limit(1);

        if (!existing) return res.status(404).json({ error: 'Template not found' });

        const [rest] = await db
          .select()
          .from(restaurants)
          .where(eq(restaurants.id, restaurantId))
          .limit(1);

        const preset =
          STARTER_TEMPLATE_PRESETS.find((p) => p.templateKey === existing.templateKey) ||
          STARTER_TEMPLATE_PRESETS[0];

        const [resetTemplate] = await db
          .update(receiptTemplates)
          .set({
            name: preset.name,
            logoUrl: sanitizeLogoUrl(rest?.logoUrl || ''),
            businessName: rest?.name || '',
            address: rest ? [rest.address, rest.city, rest.state].filter(Boolean).join(', ') : '',
            phone: rest?.phone || '',
            email: rest?.email || '',
            gstin: rest?.gstin || '',
            headerMessage: rest?.receiptHeader || preset.headerMessage,
            footerMessage: rest?.receiptFooter || 'Thank you for dining with us!',
            thankYouMessage: 'Thank you for dining with us! Visit again.',
            socialHandles: {},
            accentColor: preset.accentColor,
            fontStyle: preset.fontStyle,
            fontSize: preset.fontSize,
            layoutMode: preset.layoutMode,
            paperSize: preset.paperSize,
            visibility: preset.visibility,
            updatedAt: new Date(),
          })
          .where(eq(receiptTemplates.id, existing.id))
          .returning();

        res.json({ template: resetTemplate });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to reset receipt template' });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // BILLING HISTORY, STAFF PAYMENT CONFIRMATION / REJECTION & REFUNDS
  // ---------------------------------------------------------------------------

  router.get(
    '/billing/history',
    requireAuth,
    requireTenant,
    async (req: AuthedRequest, res) => {
      try {
        if (
          !req.auth!.isSuperAdmin &&
          req.auth!.role !== 'owner' &&
          !req.auth!.permissions.manage_billing &&
          !req.auth!.permissions.view_reports
        ) {
          return res.status(403).json({ error: 'Billing access permission required' });
        }

        const restaurantId = req.auth!.restaurantId!;
        const search = sanitizeText(req.query.search || '', 80).toLowerCase();
        const methodFilter = sanitizeText(req.query.method || '', 40).toLowerCase();
        const statusFilter = sanitizeText(req.query.status || '', 40);
        const dateFrom = sanitizeText(req.query.dateFrom || '', 20);
        const dateTo = sanitizeText(req.query.dateTo || '', 20);

        const allReceipts = await db
          .select()
          .from(receipts)
          .where(eq(receipts.restaurantId, restaurantId))
          .orderBy(desc(receipts.createdAt))
          .limit(200);

        const filteredReceipts = allReceipts.filter((r) => {
          if (search) {
            const hay = `${r.receiptNumber} ${r.orderNumber} ${r.customerName} ${r.tableNumber} ${r.transactionId}`.toLowerCase();
            if (!hay.includes(search)) return false;
          }
          if (methodFilter && methodFilter !== 'all') {
            if (!r.paymentMethod.toLowerCase().includes(methodFilter)) return false;
          }
          if (statusFilter && statusFilter !== 'all') {
            if (r.paymentStatus !== statusFilter) return false;
          }
          if (dateFrom) {
            const createdYmd = new Date(r.createdAt).toISOString().slice(0, 10);
            if (createdYmd < dateFrom) return false;
          }
          if (dateTo) {
            const createdYmd = new Date(r.createdAt).toISOString().slice(0, 10);
            if (createdYmd > dateTo) return false;
          }
          return true;
        });

        const pendingPayments = await db
          .select()
          .from(payments)
          .where(
            and(
              eq(payments.restaurantId, restaurantId),
              inArray(payments.status, ['pending', 'processing']),
            ),
          )
          .orderBy(desc(payments.createdAt))
          .limit(50);

        const orderIds = [...new Set(pendingPayments.map((p) => p.orderId))];
        const relatedOrders =
          orderIds.length > 0
            ? await db
                .select({
                  id: orders.id,
                  orderNumber: orders.orderNumber,
                  tableId: orders.tableId,
                  customerName: orders.customerName,
                })
                .from(orders)
                .where(inArray(orders.id, orderIds))
            : [];

        const tables = await db
          .select({ id: restaurantTables.id, tableNumber: restaurantTables.tableNumber })
          .from(restaurantTables)
          .where(eq(restaurantTables.restaurantId, restaurantId));
        const tableMap = new Map(tables.map((t) => [t.id, t.tableNumber]));
        const orderMap = new Map(relatedOrders.map((o) => [o.id, o]));

        const enrichedPending = pendingPayments.map((p) => {
          const ord = orderMap.get(p.orderId);
          return {
            ...p,
            orderNumber: ord?.orderNumber || `#${p.orderId}`,
            tableNumber: ord?.tableId ? tableMap.get(ord.tableId) || '' : '',
            customerName: ord?.customerName || 'Guest',
          };
        });

        res.json({ receipts: filteredReceipts, pendingPayments: enrichedPending });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load billing history' });
      }
    },
  );

  router.get('/billing/receipts/:id', requireAuth, requireTenant, async (req: AuthedRequest, res) => {
    try {
      const restaurantId = req.auth!.restaurantId!;
      const receiptId = Number(req.params.id);
      const [row] = await db
        .select()
        .from(receipts)
        .where(and(eq(receipts.id, receiptId), eq(receipts.restaurantId, restaurantId)))
        .limit(1);

      if (!row) return res.status(404).json({ error: 'Receipt not found' });
      res.json({ receipt: row });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to load receipt' });
    }
  });

  router.post(
    '/payments/:id/confirm',
    requireAuth,
    requireTenant,
    requirePermission('manage_billing'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const paymentId = Number(req.params.id);
        const overrideRef = sanitizeText(req.body?.transactionRef || '', 64);

        const verified = await settleSessionPaymentAndOrders({
          restaurantId,
          paymentId,
          actorName: req.auth!.displayName,
          transactionRef: overrideRef || undefined,
          notes: sanitizeText(req.body?.notes || `Confirmed by ${req.auth!.displayName}`, 200),
        });

        const receipt = await issueReceiptForPayment({
          restaurantId,
          paymentId: verified.id,
          actorName: req.auth!.displayName,
          includeFullSessionOrders: verified.initiatedBySource === 'customer_qr',
        });

        if (verified.diningSessionId) {
          await syncDiningSessionPaymentStatus(verified.diningSessionId);
        }

        await logSecurityEvent({
          restaurantId,
          severity: 'low',
          eventType: 'STAFF_CONFIRMED_PAYMENT',
          actorIdentifier: `${req.auth!.displayName} (${req.auth!.role})`,
          ipAddress: getClientIp(req),
          path: req.originalUrl,
          method: req.method,
          statusCode: 200,
          details: {
            paymentId: verified.id,
            receiptNumber: receipt.receiptNumber,
            amount: verified.amount,
            method: verified.paymentMethodLabel || verified.method,
          },
        });

        await logAudit({
          restaurantId,
          actorName: req.auth!.displayName,
          actorRole: req.auth!.role,
          action: 'PAYMENT_CONFIRMED',
          entityType: 'payment',
          entityId: verified.id,
          details: { receiptNumber: receipt.receiptNumber, amount: verified.amount },
        });

        const [ord] = await db.select().from(orders).where(eq(orders.id, verified.orderId)).limit(1);
        broadcastToRestaurant(
          restaurantId,
          'receipt:created',
          { receipt, tableId: ord?.tableId || undefined, diningSessionId: verified.diningSessionId },
          ord?.tableId || undefined,
        );
        broadcastToRestaurant(
          restaurantId,
          'payment:updated',
          {
            payment: verified,
            receipt,
            tableId: ord?.tableId || undefined,
            diningSessionId: verified.diningSessionId,
          },
          ord?.tableId || undefined,
        );
        if (ord) {
          broadcastToRestaurant(restaurantId, 'order:updated', { order: ord, payment: verified }, ord.tableId || undefined);
        }

        res.json({ payment: verified, receipt });
      } catch (err: any) {
        const status = err?.statusCode || 400;
        res.status(status).json({ error: err.message || 'Failed to confirm payment' });
      }
    },
  );

  router.post(
    '/payments/:id/reject',
    requireAuth,
    requireTenant,
    requirePermission('manage_billing'),
    async (req: AuthedRequest, res) => {
      try {
        const restaurantId = req.auth!.restaurantId!;
        const paymentId = Number(req.params.id);
        const reason = sanitizeText(req.body?.reason || 'Payment could not be verified by staff', 200);

        const [existing] = await db
          .select()
          .from(payments)
          .where(and(eq(payments.id, paymentId), eq(payments.restaurantId, restaurantId)))
          .limit(1);

        if (!existing) return res.status(404).json({ error: 'Payment not found' });
        if (!['pending', 'processing'].includes(existing.status)) {
          return res.status(409).json({ error: 'Only pending or processing payments can be rejected' });
        }

        const [updated] = await db
          .update(payments)
          .set({
            status: 'failed',
            notes: reason,
            verifiedBy: req.auth!.displayName,
            verifiedAt: new Date(),
          })
          .where(eq(payments.id, existing.id))
          .returning();

        if (existing.diningSessionId) {
          await syncDiningSessionPaymentStatus(existing.diningSessionId);
        }

        await logSecurityEvent({
          restaurantId,
          severity: 'medium',
          eventType: 'STAFF_REJECTED_PAYMENT',
          actorIdentifier: `${req.auth!.displayName} (${req.auth!.role})`,
          ipAddress: getClientIp(req),
          path: req.originalUrl,
          method: req.method,
          statusCode: 200,
          details: { paymentId: existing.id, reason },
        });

        const [ord] = await db.select().from(orders).where(eq(orders.id, existing.orderId)).limit(1);
        broadcastToRestaurant(
          restaurantId,
          'payment:updated',
          {
            payment: updated,
            tableId: ord?.tableId || undefined,
            diningSessionId: existing.diningSessionId,
          },
          ord?.tableId || undefined,
        );

        res.json({ payment: updated });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to reject payment' });
      }
    },
  );

  router.post('/payments/:id/refund', requireAuth, requireTenant, async (req: AuthedRequest, res) => {
    try {
      if (!canManageRefunds(req)) {
        await logSecurityEvent({
          restaurantId: req.auth!.restaurantId,
          severity: 'high',
          eventType: 'UNAUTHORIZED_REFUND_ATTEMPT',
          actorIdentifier: `${req.auth!.displayName} (${req.auth!.role})`,
          ipAddress: getClientIp(req),
          path: req.originalUrl,
          method: req.method,
          statusCode: 403,
        });
        return res.status(403).json({ error: 'Only owners or authorized managers can issue refunds' });
      }

      const restaurantId = req.auth!.restaurantId!;
      const paymentId = Number(req.params.id);
      const refundReason = sanitizeText(req.body?.reason || 'Refund issued by management', 200);

      const result = await db.transaction(async (tx) => {
        const lock = await tx.execute(
          sql`SELECT * FROM payments WHERE id = ${paymentId} AND restaurant_id = ${restaurantId} FOR UPDATE`,
        );
        if (lock.rows.length === 0) {
          throw Object.assign(new Error('Payment record not found'), { statusCode: 404 });
        }

        const [payment] = await tx
          .select()
          .from(payments)
          .where(and(eq(payments.id, paymentId), eq(payments.restaurantId, restaurantId)))
          .limit(1);

        if (!payment || !['verified', 'partial'].includes(payment.status)) {
          throw Object.assign(new Error('Only verified payments can be refunded'), { statusCode: 409 });
        }

        const remainingRefundable = Number((payment.amount - (payment.refundedAmount || 0)).toFixed(2));
        const reqRefund =
          req.body?.amount !== undefined ? Number(req.body.amount) : remainingRefundable;

        if (Number.isNaN(reqRefund) || reqRefund <= 0 || reqRefund > remainingRefundable + 0.01) {
          throw Object.assign(
            new Error(`Refund amount must be between ₹1 and ₹${remainingRefundable.toFixed(2)}`),
            { statusCode: 400 },
          );
        }

        const actualRefund = Number(Math.min(remainingRefundable, reqRefund).toFixed(2));
        const newRefundedTotal = Number(((payment.refundedAmount || 0) + actualRefund).toFixed(2));
        const fullyRefunded = newRefundedTotal >= payment.amount - 0.5;
        const now = new Date();

        const [updatedPayment] = await tx
          .update(payments)
          .set({
            status: fullyRefunded ? 'refunded' : 'verified',
            refundedAmount: newRefundedTotal,
            refundReason,
            refundedBy: req.auth!.displayName,
            refundedAt: now,
          })
          .where(eq(payments.id, payment.id))
          .returning();

        // Deduct refunded amount from order(s)
        const [ord] = await tx.select().from(orders).where(eq(orders.id, payment.orderId)).limit(1);
        if (ord) {
          const reducedPaid = Math.max(0, Number((ord.paidAmount - actualRefund).toFixed(2)));
          await tx
            .update(orders)
            .set({
              paidAmount: reducedPaid,
              status: reducedPaid < ord.totalAmount - 0.5 && ord.status === 'Paid' ? 'Served' : ord.status,
              updatedAt: now,
            })
            .where(eq(orders.id, ord.id));
        }

        const [updatedReceipt] = await tx
          .update(receipts)
          .set({
            paymentStatus: fullyRefunded ? 'Refunded' : 'Partially Paid',
            refundedAmount: newRefundedTotal,
            refundReason,
            refundedAt: now,
          })
          .where(and(eq(receipts.paymentId, payment.id), eq(receipts.restaurantId, restaurantId)))
          .returning();

        return { updatedPayment, updatedReceipt, actualRefund, ord };
      });

      if (result.updatedPayment.diningSessionId) {
        await syncDiningSessionPaymentStatus(result.updatedPayment.diningSessionId);
      }

      await logSecurityEvent({
        restaurantId,
        severity: 'medium',
        eventType: 'PAYMENT_REFUNDED',
        actorIdentifier: `${req.auth!.displayName} (${req.auth!.role})`,
        ipAddress: getClientIp(req),
        path: req.originalUrl,
        method: req.method,
        statusCode: 200,
        details: {
          paymentId,
          refundedAmount: result.actualRefund,
          reason: refundReason,
        },
      });

      await logAudit({
        restaurantId,
        actorName: req.auth!.displayName,
        actorRole: req.auth!.role,
        action: 'PAYMENT_REFUNDED',
        entityType: 'payment',
        entityId: paymentId,
        details: { refundedAmount: result.actualRefund, reason: refundReason },
      });

      broadcastToRestaurant(restaurantId, 'payment:updated', {
        payment: result.updatedPayment,
        receipt: result.updatedReceipt || null,
      });

      res.json({ payment: result.updatedPayment, receipt: result.updatedReceipt || null });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      res.status(status).json({ error: err.message || 'Failed to issue refund' });
    }
  });
}

async function settleSessionPaymentAndOrders(params: {
  restaurantId: number;
  paymentId: number;
  actorName: string;
  transactionRef?: string;
  razorpayPaymentId?: string;
  razorpaySignature?: string;
  notes?: string;
}) {
  const verified = await db.transaction(async (tx) => {
    const lock = await tx.execute(
      sql`SELECT * FROM payments WHERE id = ${params.paymentId} AND restaurant_id = ${params.restaurantId} FOR UPDATE`,
    );
    if (lock.rows.length === 0) {
      throw Object.assign(new Error('Payment record not found'), { statusCode: 404 });
    }

    const [payment] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.id, params.paymentId), eq(payments.restaurantId, params.restaurantId)))
      .limit(1);

    if (!payment || !['pending', 'processing'].includes(payment.status)) {
      throw Object.assign(new Error('Payment is already processed or inactive'), { statusCode: 409 });
    }

    const now = new Date();
    const [updatedPayment] = await tx
      .update(payments)
      .set({
        status: 'verified',
        transactionRef: params.transactionRef || payment.transactionRef || `TXN-${payment.id}`,
        razorpayPaymentId: params.razorpayPaymentId || payment.razorpayPaymentId,
        razorpaySignature: params.razorpaySignature || payment.razorpaySignature,
        collectedBy: params.actorName,
        verifiedBy: params.actorName,
        verifiedAt: now,
        notes: params.notes || payment.notes,
      })
      .where(eq(payments.id, payment.id))
      .returning();

    const targetOrders =
      payment.diningSessionId && payment.initiatedBySource === 'customer_qr'
        ? await tx
            .select()
            .from(orders)
            .where(
              and(
                eq(orders.restaurantId, params.restaurantId),
                eq(orders.diningSessionId, payment.diningSessionId),
                ne(orders.status, 'Cancelled'),
              ),
            )
            .orderBy(orders.createdAt)
        : await tx
            .select()
            .from(orders)
            .where(and(eq(orders.id, payment.orderId), eq(orders.restaurantId, params.restaurantId)));

    let remainingToAllocate = payment.amount;
    for (let i = 0; i < targetOrders.length; i++) {
      const ord = targetOrders[i];
      if (remainingToAllocate <= 0) break;
      const dueOnOrder = Math.max(0, Number((ord.totalAmount - ord.paidAmount).toFixed(2)));
      const applyAmount =
        i === targetOrders.length - 1
          ? remainingToAllocate
          : Math.min(dueOnOrder, remainingToAllocate);
      if (applyAmount <= 0 && i < targetOrders.length - 1) continue;

      const newPaid = Number((ord.paidAmount + applyAmount).toFixed(2));
      const isSettled = newPaid >= ord.totalAmount - 0.5;
      remainingToAllocate = Math.max(0, Number((remainingToAllocate - applyAmount).toFixed(2)));

      await tx
        .update(orders)
        .set({
          paidAmount: newPaid,
          status: isSettled ? 'Paid' : ord.status,
          paidAt: isSettled ? now : ord.paidAt,
          updatedAt: now,
        })
        .where(eq(orders.id, ord.id));

      if (isSettled && ord.tableId) {
        // Keep dining session ACTIVE & PIN unchanged; table remains in Billing until waiter confirms departure
        await tx
          .update(restaurantTables)
          .set({ status: ord.diningSessionId ? 'Billing' : 'Cleaning' })
          .where(eq(restaurantTables.id, ord.tableId));
      }
    }

    return updatedPayment;
  });

  return verified;
}
