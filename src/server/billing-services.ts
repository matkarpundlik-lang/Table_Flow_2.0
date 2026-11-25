import crypto from 'crypto';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  type CustomPaymentMethod,
  type ReceiptLineItemSnapshot,
  type ReceiptSocialHandles,
  type ReceiptTemplateSnapshot,
  type ReceiptVisibilityConfig,
  billingSettings,
  diningSessions,
  orderItems,
  orders,
  payments,
  receiptTemplates,
  receipts,
  restaurantTables,
  restaurants,
} from '../db/schema.ts';
import { sanitizeLogoUrl, sanitizeText } from './security.ts';

export const DEFAULT_RECEIPT_VISIBILITY: ReceiptVisibilityConfig = {
  logo: true,
  gstin: true,
  customerName: true,
  customerPhone: false,
  tableNumber: true,
  orderId: true,
  paymentMethod: true,
  transactionId: true,
  taxBreakdown: true,
  discountBreakdown: true,
  serviceCharge: true,
  footerMessage: true,
  socialHandles: true,
};

export interface StarterTemplatePreset {
  templateKey: 'classic' | 'modern' | 'premium' | 'compact';
  name: string;
  accentColor: string;
  fontStyle: 'sans' | 'mono' | 'serif';
  fontSize: 'sm' | 'md' | 'lg';
  layoutMode: 'centered' | 'left' | 'compact';
  paperSize: '58mm' | '80mm' | 'A4';
  headerMessage: string;
  visibility: ReceiptVisibilityConfig;
}

export const STARTER_TEMPLATE_PRESETS: StarterTemplatePreset[] = [
  {
    templateKey: 'classic',
    name: 'Classic Restaurant',
    accentColor: '#0F172A',
    fontStyle: 'mono',
    fontSize: 'md',
    layoutMode: 'centered',
    paperSize: '80mm',
    headerMessage: 'TAX INVOICE',
    visibility: { ...DEFAULT_RECEIPT_VISIBILITY },
  },
  {
    templateKey: 'modern',
    name: 'Modern Minimal',
    accentColor: '#EA580C',
    fontStyle: 'sans',
    fontSize: 'md',
    layoutMode: 'left',
    paperSize: '80mm',
    headerMessage: 'Digital Dining Receipt',
    visibility: { ...DEFAULT_RECEIPT_VISIBILITY },
  },
  {
    templateKey: 'premium',
    name: 'Premium Brand',
    accentColor: '#1E293B',
    fontStyle: 'serif',
    fontSize: 'lg',
    layoutMode: 'centered',
    paperSize: 'A4',
    headerMessage: 'Official Tax Invoice & Guest Copy',
    visibility: { ...DEFAULT_RECEIPT_VISIBILITY, customerPhone: true },
  },
  {
    templateKey: 'compact',
    name: 'Compact Thermal',
    accentColor: '#0F172A',
    fontStyle: 'mono',
    fontSize: 'sm',
    layoutMode: 'compact',
    paperSize: '58mm',
    headerMessage: 'CASH/UPI BILL',
    visibility: {
      ...DEFAULT_RECEIPT_VISIBILITY,
      logo: false,
      customerPhone: false,
      socialHandles: false,
    },
  },
];

export function normalizeVisibility(raw?: Partial<ReceiptVisibilityConfig> | null): ReceiptVisibilityConfig {
  return {
    logo: raw?.logo !== undefined ? Boolean(raw.logo) : DEFAULT_RECEIPT_VISIBILITY.logo,
    gstin: raw?.gstin !== undefined ? Boolean(raw.gstin) : DEFAULT_RECEIPT_VISIBILITY.gstin,
    customerName:
      raw?.customerName !== undefined ? Boolean(raw.customerName) : DEFAULT_RECEIPT_VISIBILITY.customerName,
    customerPhone:
      raw?.customerPhone !== undefined ? Boolean(raw.customerPhone) : DEFAULT_RECEIPT_VISIBILITY.customerPhone,
    tableNumber:
      raw?.tableNumber !== undefined ? Boolean(raw.tableNumber) : DEFAULT_RECEIPT_VISIBILITY.tableNumber,
    orderId: raw?.orderId !== undefined ? Boolean(raw.orderId) : DEFAULT_RECEIPT_VISIBILITY.orderId,
    paymentMethod:
      raw?.paymentMethod !== undefined ? Boolean(raw.paymentMethod) : DEFAULT_RECEIPT_VISIBILITY.paymentMethod,
    transactionId:
      raw?.transactionId !== undefined ? Boolean(raw.transactionId) : DEFAULT_RECEIPT_VISIBILITY.transactionId,
    taxBreakdown:
      raw?.taxBreakdown !== undefined ? Boolean(raw.taxBreakdown) : DEFAULT_RECEIPT_VISIBILITY.taxBreakdown,
    discountBreakdown:
      raw?.discountBreakdown !== undefined
        ? Boolean(raw.discountBreakdown)
        : DEFAULT_RECEIPT_VISIBILITY.discountBreakdown,
    serviceCharge:
      raw?.serviceCharge !== undefined ? Boolean(raw.serviceCharge) : DEFAULT_RECEIPT_VISIBILITY.serviceCharge,
    footerMessage:
      raw?.footerMessage !== undefined ? Boolean(raw.footerMessage) : DEFAULT_RECEIPT_VISIBILITY.footerMessage,
    socialHandles:
      raw?.socialHandles !== undefined ? Boolean(raw.socialHandles) : DEFAULT_RECEIPT_VISIBILITY.socialHandles,
  };
}

export function sanitizeCustomMethods(raw: unknown): CustomPaymentMethod[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: CustomPaymentMethod[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const label = sanitizeText(rec.label, 40);
    if (!label) continue;
    const rawCode = sanitizeText(rec.code || label, 28)
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '');
    const code = rawCode ? `custom_${rawCode.replace(/^custom_/, '')}` : '';
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push({
      code,
      label,
      enabled: rec.enabled !== false,
      instructions: sanitizeText(rec.instructions || '', 160),
    });
    if (out.length >= 8) break;
  }
  return out;
}

export function sanitizeSocialHandles(raw: unknown): ReceiptSocialHandles {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;
  return {
    instagram: sanitizeText(obj.instagram || '', 60),
    facebook: sanitizeText(obj.facebook || '', 60),
    website: sanitizeText(obj.website || '', 120),
  };
}

export function buildUpiPaymentUri(params: {
  upiId: string;
  payeeName: string;
  amount: number;
  transactionRef: string;
  note: string;
}): string {
  const cleanUpi = sanitizeText(params.upiId, 100).replace(/\s+/g, '');
  if (!cleanUpi || !cleanUpi.includes('@')) return '';
  const query = new URLSearchParams({
    pa: cleanUpi,
    pn: sanitizeText(params.payeeName || 'Restaurant', 60),
    am: Number(params.amount).toFixed(2),
    cu: 'INR',
    tr: sanitizeText(params.transactionRef, 35),
    tn: sanitizeText(params.note, 80),
  });
  return `upi://pay?${query.toString()}`;
}

export function generateReceiptNumber(paymentId: number): string {
  const now = new Date();
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
    now.getDate(),
  ).padStart(2, '0')}`;
  const seq = String(paymentId).padStart(4, '0');
  const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `INV-${ymd}-${seq}-${suffix}`;
}

export async function ensureRestaurantBillingSetup(restaurantId: number) {
  const [rest] = await db
    .select()
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId))
    .limit(1);

  if (!rest) {
    throw new Error('Restaurant not found');
  }

  let [settings] = await db
    .select()
    .from(billingSettings)
    .where(eq(billingSettings.restaurantId, restaurantId))
    .limit(1);

  const defaultSlugUpi = rest.slug
    ? `${rest.slug.replace(/[^a-z0-9]/gi, '').slice(0, 20)}@okaxis`
    : `outlet${rest.id}@okaxis`;
  const effectiveUpiId = (settings?.upiId || rest.upiId || defaultSlugUpi).trim();
  const effectivePayee = (settings?.upiPayeeName || rest.upiPayeeName || rest.name).trim();

  if (!rest.upiId) {
    await db
      .update(restaurants)
      .set({
        upiId: effectiveUpiId,
        upiPayeeName: effectivePayee,
        acceptedPaymentMethods:
          Array.isArray(rest.acceptedPaymentMethods) && rest.acceptedPaymentMethods.length > 0
            ? rest.acceptedPaymentMethods
            : ['upi', 'cash', 'card', 'razorpay'],
      })
      .where(eq(restaurants.id, restaurantId));
    rest.upiId = effectiveUpiId;
    rest.upiPayeeName = effectivePayee;
  }

  let templates = await db
    .select()
    .from(receiptTemplates)
    .where(eq(receiptTemplates.restaurantId, restaurantId))
    .orderBy(receiptTemplates.id);

  if (templates.length === 0) {
    const addressJoined = [rest.address, rest.city, rest.state].filter(Boolean).join(', ');
    templates = await db
      .insert(receiptTemplates)
      .values(
        STARTER_TEMPLATE_PRESETS.map((preset, idx) => ({
          restaurantId,
          name: preset.name,
          templateKey: preset.templateKey,
          isDefault: idx === 0,
          logoUrl: sanitizeLogoUrl(rest.logoUrl),
          businessName: rest.name,
          address: addressJoined,
          phone: rest.phone || '',
          email: rest.email || '',
          gstin: rest.gstin || '',
          headerMessage: rest.receiptHeader || preset.headerMessage,
          footerMessage: rest.receiptFooter || 'Thank you for dining with us!',
          thankYouMessage: 'Thank you for dining with us! Visit again.',
          socialHandles: settings?.socialHandles || {},
          accentColor: preset.accentColor,
          fontStyle: preset.fontStyle,
          fontSize: preset.fontSize,
          layoutMode: preset.layoutMode,
          paperSize: preset.paperSize,
          visibility: preset.visibility,
          createdBy: 'System',
        })),
      )
      .returning();
  }

  const defaultTemplate = templates.find((t) => t.isDefault) || templates[0];

  if (!settings) {
    const [created] = await db
      .insert(billingSettings)
      .values({
        restaurantId,
        activeTemplateId: defaultTemplate?.id || null,
        upiId: effectiveUpiId,
        upiPayeeName: effectivePayee,
        customPaymentMethods: [],
        otherChargesLabel: 'Other Charges',
        otherChargesAmount: 0,
        thankYouMessage: 'Thank you for dining with us! Visit again.',
        socialHandles: {},
        updatedBy: 'System',
      })
      .onConflictDoNothing()
      .returning();

    if (created) {
      settings = created;
    } else {
      const [refetched] = await db
        .select()
        .from(billingSettings)
        .where(eq(billingSettings.restaurantId, restaurantId))
        .limit(1);
      settings = refetched;
    }
  } else if (!settings.activeTemplateId && defaultTemplate) {
    const [updated] = await db
      .update(billingSettings)
      .set({ activeTemplateId: defaultTemplate.id, updatedAt: new Date() })
      .where(eq(billingSettings.id, settings.id))
      .returning();
    settings = updated;
  }

  return { restaurant: rest, settings, templates, defaultTemplate };
}

export function buildTemplateSnapshot(
  template: typeof receiptTemplates.$inferSelect,
  rest: typeof restaurants.$inferSelect,
  settings: typeof billingSettings.$inferSelect,
): ReceiptTemplateSnapshot {
  return {
    templateKey: template.templateKey || 'classic',
    name: template.name,
    accentColor: /^#[0-9a-fA-F]{6}$/.test(template.accentColor || '') ? template.accentColor : '#0F172A',
    fontStyle: template.fontStyle || 'mono',
    fontSize: template.fontSize || 'md',
    layoutMode: template.layoutMode || 'centered',
    paperSize: template.paperSize || '80mm',
    logoUrl: sanitizeLogoUrl(template.logoUrl || rest.logoUrl || ''),
    businessName: template.businessName || rest.name,
    address: template.address || [rest.address, rest.city, rest.state].filter(Boolean).join(', '),
    phone: template.phone || rest.phone || '',
    email: template.email || rest.email || '',
    gstin: template.gstin || rest.gstin || '',
    headerMessage: template.headerMessage || rest.receiptHeader || '',
    footerMessage: template.footerMessage || rest.receiptFooter || '',
    thankYouMessage:
      template.thankYouMessage || settings.thankYouMessage || 'Thank you for dining with us! Visit again.',
    socialHandles: template.socialHandles || settings.socialHandles || {},
    visibility: normalizeVisibility(template.visibility),
  };
}

export async function computeDiningSessionBill(restaurantId: number, diningSessionId: number) {
  const { restaurant: rest, settings } = await ensureRestaurantBillingSetup(restaurantId);

  const [session] = await db
    .select()
    .from(diningSessions)
    .where(and(eq(diningSessions.id, diningSessionId), eq(diningSessions.restaurantId, restaurantId)))
    .limit(1);

  if (!session) {
    throw new Error('Dining session not found');
  }

  const [table] = await db
    .select()
    .from(restaurantTables)
    .where(eq(restaurantTables.id, session.tableId))
    .limit(1);

  const sessionOrders = await db
    .select()
    .from(orders)
    .where(and(eq(orders.restaurantId, restaurantId), eq(orders.diningSessionId, diningSessionId)))
    .orderBy(orders.createdAt);

  const activeOrders = sessionOrders.filter((o) => o.status !== 'Cancelled');
  const orderIds = activeOrders.map((o) => o.id);

  const allItems =
    orderIds.length > 0
      ? await db
          .select()
          .from(orderItems)
          .where(and(eq(orderItems.restaurantId, restaurantId), inArray(orderItems.orderId, orderIds)))
      : [];

  const sessionPayments = await db
    .select()
    .from(payments)
    .where(
      orderIds.length > 0
        ? and(eq(payments.restaurantId, restaurantId), eq(payments.diningSessionId, diningSessionId))
        : and(eq(payments.restaurantId, restaurantId), eq(payments.diningSessionId, diningSessionId)),
    )
    .orderBy(desc(payments.createdAt));

  const itemizedBill: ReceiptLineItemSnapshot[] = allItems.map((it) => ({
    itemName: it.itemName,
    quantity: it.quantity,
    unitPrice: Number(it.unitPrice.toFixed(2)),
    itemTotal: Number(it.itemTotal.toFixed(2)),
    variantName: it.selectedVariant?.name || undefined,
    addonsSummary:
      Array.isArray(it.selectedAddons) && it.selectedAddons.length > 0
        ? it.selectedAddons.map((a) => a.name).join(', ')
        : undefined,
  }));

  const subtotal = Number(activeOrders.reduce((s, o) => s + Number(o.subtotal || 0), 0).toFixed(2));
  const discountAmount = Number(
    activeOrders.reduce((s, o) => s + Number(o.discountAmount || 0), 0).toFixed(2),
  );
  const gstAmount = Number(activeOrders.reduce((s, o) => s + Number(o.gstAmount || 0), 0).toFixed(2));
  const cgstAmount = Number((gstAmount / 2).toFixed(2));
  const sgstAmount = Number((gstAmount - cgstAmount).toFixed(2));
  const serviceChargeAmount = Number(
    activeOrders.reduce((s, o) => s + Number(o.serviceChargeAmount || 0), 0).toFixed(2),
  );

  const otherChargesLabel = settings.otherChargesLabel || 'Other Charges';
  const otherChargesAmount =
    activeOrders.length > 0 ? Number(Math.max(0, settings.otherChargesAmount || 0).toFixed(2)) : 0;

  const ordersGrandTotal = Number(
    activeOrders.reduce((s, o) => s + Number(o.totalAmount || 0), 0).toFixed(2),
  );
  const grandTotal = Number((ordersGrandTotal + otherChargesAmount).toFixed(2));

  const verifiedNetFromPayments = Number(
    sessionPayments
      .filter((p) => p.status === 'verified' || p.status === 'partial')
      .reduce((s, p) => s + Math.max(0, Number(p.amount || 0) - Number(p.refundedAmount || 0)), 0)
      .toFixed(2),
  );
  const paidFromOrders = Number(
    activeOrders.reduce((s, o) => s + Number(o.paidAmount || 0), 0).toFixed(2),
  );
  const amountPaid = Math.max(verifiedNetFromPayments, paidFromOrders);
  const balanceDue = Math.max(0, Number((grandTotal - amountPaid).toFixed(2)));

  const sessionReceipts = await db
    .select()
    .from(receipts)
    .where(and(eq(receipts.restaurantId, restaurantId), eq(receipts.diningSessionId, diningSessionId)))
    .orderBy(desc(receipts.createdAt));

  const acceptedMethods =
    Array.isArray(rest.acceptedPaymentMethods) && rest.acceptedPaymentMethods.length > 0
      ? rest.acceptedPaymentMethods
      : ['upi', 'cash', 'card', 'razorpay'];

  const customMethods = (settings.customPaymentMethods || []).filter((m) => m.enabled);

  return {
    restaurant: {
      id: rest.id,
      name: rest.name,
      logoUrl: sanitizeLogoUrl(rest.logoUrl),
      address: [rest.address, rest.city, rest.state].filter(Boolean).join(', '),
      phone: rest.phone || '',
      gstin: rest.gstin || '',
      upiId: settings.upiId || rest.upiId || '',
      upiPayeeName: settings.upiPayeeName || rest.upiPayeeName || rest.name,
      gstRate: rest.gstRate,
      serviceChargeRate: rest.serviceChargeRate,
    },
    table: table ? { id: table.id, tableNumber: table.tableNumber, section: table.section } : null,
    diningSession: {
      id: session.id,
      sessionUid: session.sessionUid,
      status: session.status,
      billRequested: session.billRequested,
      paymentStatus: session.paymentStatus,
    },
    orderNumbers: activeOrders.map((o) => o.orderNumber),
    activeOrderIds: orderIds,
    items: itemizedBill,
    summary: {
      subtotal,
      discountAmount,
      gstRateApplied: rest.gstRate,
      gstAmount,
      cgstAmount,
      sgstAmount,
      serviceChargeRateApplied: rest.serviceChargeRate,
      serviceChargeAmount,
      otherChargesLabel,
      otherChargesAmount,
      grandTotal,
      amountPaid,
      balanceDue,
    },
    acceptedMethods,
    customMethods,
    payments: sessionPayments,
    pendingPayment:
      sessionPayments.find((p) => p.status === 'pending' || p.status === 'processing') || null,
    receipts: sessionReceipts,
  };
}

export async function issueReceiptForPayment(params: {
  restaurantId: number;
  paymentId: number;
  actorName: string;
  includeFullSessionOrders?: boolean;
}) {
  const [existing] = await db
    .select()
    .from(receipts)
    .where(and(eq(receipts.paymentId, params.paymentId), eq(receipts.restaurantId, params.restaurantId)))
    .limit(1);

  if (existing) {
    return existing;
  }

  const [payment] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.id, params.paymentId), eq(payments.restaurantId, params.restaurantId)))
    .limit(1);

  if (!payment) {
    throw new Error('Payment not found for receipt generation');
  }

  const { restaurant: rest, settings, defaultTemplate } = await ensureRestaurantBillingSetup(
    params.restaurantId,
  );

  const [primaryOrder] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, payment.orderId), eq(orders.restaurantId, params.restaurantId)))
    .limit(1);

  if (!primaryOrder) {
    throw new Error('Order not found for receipt generation');
  }

  const useSessionScope =
    Boolean(params.includeFullSessionOrders || payment.initiatedBySource === 'customer_qr') &&
    Boolean(primaryOrder.diningSessionId);

  const coveredOrders = useSessionScope
    ? await db
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.restaurantId, params.restaurantId),
            eq(orders.diningSessionId, primaryOrder.diningSessionId!),
            ne(orders.status, 'Cancelled'),
          ),
        )
        .orderBy(orders.createdAt)
    : [primaryOrder];

  const orderList = coveredOrders.length > 0 ? coveredOrders : [primaryOrder];
  const orderIds = orderList.map((o) => o.id);

  const dbItems = await db
    .select()
    .from(orderItems)
    .where(and(eq(orderItems.restaurantId, params.restaurantId), inArray(orderItems.orderId, orderIds)));

  const itemsSnapshot: ReceiptLineItemSnapshot[] = dbItems.map((it) => ({
    itemName: it.itemName,
    quantity: it.quantity,
    unitPrice: Number(it.unitPrice.toFixed(2)),
    itemTotal: Number(it.itemTotal.toFixed(2)),
    variantName: it.selectedVariant?.name || undefined,
    addonsSummary:
      Array.isArray(it.selectedAddons) && it.selectedAddons.length > 0
        ? it.selectedAddons.map((a) => a.name).join(', ')
        : undefined,
  }));

  const tableId = primaryOrder.tableId || null;
  const [tableRow] = tableId
    ? await db
        .select()
        .from(restaurantTables)
        .where(eq(restaurantTables.id, tableId))
        .limit(1)
    : [];

  const subtotal = Number(orderList.reduce((s, o) => s + Number(o.subtotal || 0), 0).toFixed(2));
  const discountAmount = Number(
    orderList.reduce((s, o) => s + Number(o.discountAmount || 0), 0).toFixed(2),
  );
  const gstAmount = Number(orderList.reduce((s, o) => s + Number(o.gstAmount || 0), 0).toFixed(2));
  const cgstAmount = Number((gstAmount / 2).toFixed(2));
  const sgstAmount = Number((gstAmount - cgstAmount).toFixed(2));
  const serviceChargeAmount = Number(
    orderList.reduce((s, o) => s + Number(o.serviceChargeAmount || 0), 0).toFixed(2),
  );
  const otherChargesLabel = settings.otherChargesLabel || 'Other Charges';
  const otherChargesAmount = Number(Math.max(0, settings.otherChargesAmount || 0).toFixed(2));
  const ordersTotal = Number(orderList.reduce((s, o) => s + Number(o.totalAmount || 0), 0).toFixed(2));
  const grandTotal = Number((ordersTotal + otherChargesAmount).toFixed(2));

  let totalPaid = Number(
    orderList.reduce((s, o) => s + Number(o.paidAmount || 0), 0).toFixed(2),
  );
  if (useSessionScope && primaryOrder.diningSessionId) {
    const sessVerifiedPays = await db
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.restaurantId, params.restaurantId),
          eq(payments.diningSessionId, primaryOrder.diningSessionId),
        ),
      );
    const verifiedNet = Number(
      sessVerifiedPays
        .filter((p) => p.status === 'verified' || p.status === 'partial')
        .reduce((s, p) => s + Math.max(0, Number(p.amount || 0) - Number(p.refundedAmount || 0)), 0)
        .toFixed(2),
    );
    totalPaid = Math.max(totalPaid, verifiedNet);
  } else {
    totalPaid = Math.max(totalPaid, payment.amount);
  }

  const balanceDue = Math.max(0, Number((grandTotal - totalPaid).toFixed(2)));
  const paymentStatus =
    payment.status === 'refunded'
      ? 'Refunded'
      : balanceDue > 0.5
      ? 'Partially Paid'
      : 'Paid';

  const templateSnapshot = buildTemplateSnapshot(defaultTemplate, rest, settings);
  const restaurantSnapshot = {
    name: templateSnapshot.businessName || rest.name,
    logoUrl: templateSnapshot.logoUrl || sanitizeLogoUrl(rest.logoUrl),
    address: templateSnapshot.address || rest.address || '',
    city: rest.city || '',
    state: rest.state || '',
    phone: templateSnapshot.phone || rest.phone || '',
    email: templateSnapshot.email || rest.email || '',
    gstin: templateSnapshot.gstin || rest.gstin || '',
    fssaiNo: rest.fssaiNo || '',
  };

  const methodLabel =
    payment.paymentMethodLabel ||
    (payment.method === 'upi'
      ? 'UPI'
      : payment.method === 'card'
      ? 'Card'
      : payment.method === 'razorpay'
      ? 'Online Gateway'
      : payment.method === 'cash'
      ? 'Cash'
      : payment.method);

  const txRef =
    payment.transactionRef ||
    payment.razorpayPaymentId ||
    payment.customerUtrSubmitted ||
    `TXN-${payment.id}`;

  const orderNumbersJoined =
    orderList.length === 1 ? primaryOrder.orderNumber : orderList.map((o) => o.orderNumber).join(', ');

  const [created] = await db
    .insert(receipts)
    .values({
      receiptNumber: generateReceiptNumber(payment.id),
      restaurantId: params.restaurantId,
      orderId: primaryOrder.id,
      diningSessionId: primaryOrder.diningSessionId || null,
      paymentId: payment.id,
      customerQrSessionId: primaryOrder.customerQrSessionId || null,
      tableId,
      tableNumber: tableRow?.tableNumber || (primaryOrder.orderType === 'takeaway' ? 'Takeaway' : ''),
      orderNumber: orderNumbersJoined,
      customerName: primaryOrder.customerName || 'Walk-in Guest',
      customerPhone: primaryOrder.customerPhone || '',
      paymentMethod: methodLabel,
      paymentStatus,
      transactionId: txRef,
      subtotal,
      discountAmount,
      gstRateApplied: primaryOrder.gstRateApplied ?? rest.gstRate,
      cgstAmount,
      sgstAmount,
      serviceChargeRateApplied: primaryOrder.serviceChargeRateApplied ?? rest.serviceChargeRate,
      serviceChargeAmount,
      otherChargesLabel,
      otherChargesAmount,
      grandTotal,
      amountPaid: totalPaid,
      balanceDue,
      refundedAmount: payment.refundedAmount || 0,
      refundReason: payment.refundReason || '',
      refundedAt: payment.refundedAt || null,
      itemsSnapshot,
      restaurantSnapshot,
      templateSnapshot,
      generatedBy: sanitizeText(params.actorName || 'System', 100),
    })
    .onConflictDoNothing()
    .returning();

  if (created) {
    return created;
  }

  const [raceExisting] = await db
    .select()
    .from(receipts)
    .where(and(eq(receipts.paymentId, payment.id), eq(receipts.restaurantId, params.restaurantId)))
    .limit(1);

  return raceExisting;
}
