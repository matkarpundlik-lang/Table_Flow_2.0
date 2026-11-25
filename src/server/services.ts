import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  auditLogs,
  customers,
  diningSessionPinHistory,
  diningSessions,
  inventoryItems,
  menuItemRecipes,
  menuItems,
  orderItems,
  orders,
  payments,
  promotionalOffers,
  qrTokenHistory,
  restaurantTables,
  restaurants,
  securityEvents,
  stockMovements,
} from '../db/schema.ts';
import { broadcastToRestaurant } from './realtime.ts';
import {
  encryptDiningPin,
  generateDiningPin,
  generateDiningSessionUid,
  hashPin,
  hashTokenSha256,
  sanitizeText,
} from './security.ts';

export async function logAudit(params: {
  restaurantId?: number | null;
  actorName: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId?: string | number;
  details?: Record<string, unknown>;
}) {
  try {
    await db.insert(auditLogs).values({
      restaurantId: params.restaurantId ?? null,
      actorName: sanitizeText(params.actorName, 120),
      actorRole: sanitizeText(params.actorRole, 40),
      action: sanitizeText(params.action, 80),
      entityType: sanitizeText(params.entityType, 40),
      entityId: params.entityId !== undefined ? String(params.entityId) : '',
      details: params.details || {},
    });
  } catch (err) {
    console.error('Audit log error:', err);
  }
}

export async function logSecurityEvent(params: {
  restaurantId?: number | null;
  severity: 'low' | 'medium' | 'high' | 'critical';
  eventType: string;
  actorIdentifier?: string;
  ipAddress?: string;
  path?: string;
  method?: string;
  statusCode?: number;
  details?: Record<string, unknown>;
}) {
  try {
    await db.insert(securityEvents).values({
      restaurantId: params.restaurantId ?? null,
      severity: params.severity,
      eventType: sanitizeText(params.eventType, 80),
      actorIdentifier: sanitizeText(params.actorIdentifier || 'anonymous', 120),
      ipAddress: sanitizeText(params.ipAddress || '', 64),
      path: sanitizeText(params.path || '', 180),
      method: sanitizeText(params.method || '', 12),
      statusCode: params.statusCode ?? 200,
      details: params.details || {},
    });
  } catch (err) {
    console.error('Security event log error:', err);
  }
}

export async function recordQrTokenHistory(params: {
  restaurantId: number;
  tableId: number;
  rawToken: string;
  tokenVersion: number;
  action: 'created' | 'regenerated' | 'revoked' | 'expired' | 'migrated';
  actorName: string;
  reason?: string;
  expiresAt?: Date | null;
}) {
  try {
    await db.insert(qrTokenHistory).values({
      restaurantId: params.restaurantId,
      tableId: params.tableId,
      tokenHash: hashTokenSha256(params.rawToken),
      tokenVersion: params.tokenVersion,
      action: params.action,
      actorName: sanitizeText(params.actorName, 120),
      reason: sanitizeText(params.reason || '', 200),
      expiresAt: params.expiresAt ?? null,
    });
  } catch (err) {
    console.error('QR token history error:', err);
  }
}

export async function sendOtpViaProvider(params: {
  phone: string;
  code: string;
  purpose: string;
}): Promise<{ provider: 'twilio' | 'webhook' }> {
  const twilioSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const twilioToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const twilioFrom = process.env.TWILIO_FROM_NUMBER?.trim();

  if (twilioSid && twilioToken && twilioFrom) {
    const body = new URLSearchParams({
      To: params.phone,
      From: twilioFrom,
      Body: `Your DineFlow verification code is ${params.code}. It expires in 5 minutes. Never share this code.`,
    });

    const authHeader = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');
    const resp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(twilioSid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${authHeader}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      },
    );

    if (!resp.ok) {
      throw new Error('Upstream SMS OTP delivery failed');
    }
    return { provider: 'twilio' };
  }

  const webhookUrl = process.env.OTP_WEBHOOK_URL?.trim();
  if (webhookUrl) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(webhookUrl);
    } catch {
      throw new Error('Invalid OTP_WEBHOOK_URL server configuration');
    }

    if (process.env.NODE_ENV === 'production' && parsedUrl.protocol !== 'https:') {
      throw new Error('OTP_WEBHOOK_URL must use HTTPS in production');
    }

    const resp = await fetch(parsedUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-otp-webhook-secret': process.env.OTP_WEBHOOK_SECRET || '',
      },
      body: JSON.stringify({
        phone: params.phone,
        code: params.code,
        purpose: params.purpose,
        expiresInSeconds: 300,
      }),
    });

    if (!resp.ok) {
      throw new Error('Upstream OTP webhook delivery failed');
    }
    return { provider: 'webhook' };
  }

  const err = new Error(
    'SMS OTP provider is not configured on the server. Configure TWILIO_* or OTP_WEBHOOK_URL in server secrets.',
  ) as Error & { code?: string };
  err.code = 'OTP_PROVIDER_UNCONFIGURED';
  throw err;
}

export async function deductInventoryForOrder(
  restaurantId: number,
  orderId: number,
  actorName: string,
) {
  const lowStockAlerts: Array<{
    id: number;
    name: string;
    currentStock: number;
    reorderLevel: number;
    unit: string;
  }> = [];

  const result = await db.transaction(async (tx) => {
    const claimed = await tx
      .update(orders)
      .set({ inventoryDeducted: true, updatedAt: new Date() })
      .where(
        and(
          eq(orders.id, orderId),
          eq(orders.restaurantId, restaurantId),
          eq(orders.inventoryDeducted, false),
        ),
      )
      .returning({ id: orders.id });

    if (claimed.length === 0) {
      return { deducted: false, movementsCount: 0 };
    }

    const items = await tx
      .select()
      .from(orderItems)
      .where(and(eq(orderItems.orderId, orderId), eq(orderItems.restaurantId, restaurantId)));

    const menuIds = items
      .map((i) => i.menuItemId)
      .filter((id): id is number => typeof id === 'number');

    if (menuIds.length === 0) {
      return { deducted: true, movementsCount: 0 };
    }

    const recipes = await tx
      .select()
      .from(menuItemRecipes)
      .where(
        and(
          eq(menuItemRecipes.restaurantId, restaurantId),
          inArray(menuItemRecipes.menuItemId, menuIds),
        ),
      );

    if (recipes.length === 0) {
      return { deducted: true, movementsCount: 0 };
    }

    const usageMap = new Map<number, number>();
    for (const item of items) {
      if (!item.menuItemId) continue;
      for (const recipe of recipes) {
        if (recipe.menuItemId === item.menuItemId) {
          const prev = usageMap.get(recipe.inventoryItemId) || 0;
          usageMap.set(recipe.inventoryItemId, prev + recipe.quantityRequired * item.quantity);
        }
      }
    }

    let movementsCount = 0;
    for (const [inventoryItemId, qtyToDeduct] of usageMap.entries()) {
      if (qtyToDeduct <= 0) continue;

      const updated = await tx
        .update(inventoryItems)
        .set({
          currentStock: sql`GREATEST(0, ${inventoryItems.currentStock} - ${qtyToDeduct})`,
        })
        .where(
          and(
            eq(inventoryItems.id, inventoryItemId),
            eq(inventoryItems.restaurantId, restaurantId),
          ),
        )
        .returning();

      if (updated.length > 0) {
        const inv = updated[0];
        await tx.insert(stockMovements).values({
          restaurantId,
          inventoryItemId,
          movementType: 'deduction',
          quantityDelta: -qtyToDeduct,
          unitCost: inv.costPerUnit,
          referenceOrderId: orderId,
          notes: `Auto-deducted from recipe for order #${orderId}`,
          createdBy: actorName,
        });
        movementsCount++;

        if (inv.currentStock <= inv.reorderLevel) {
          lowStockAlerts.push({
            id: inv.id,
            name: inv.name,
            currentStock: inv.currentStock,
            reorderLevel: inv.reorderLevel,
            unit: inv.unit,
          });
        }
      }
    }

    return { deducted: true, movementsCount };
  });

  if (lowStockAlerts.length > 0) {
    broadcastToRestaurant(restaurantId, 'inventory:alert', { alerts: lowStockAlerts });
  }

  return result;
}

export interface RequestedOrderItemInput {
  menuItemId: number;
  quantity: number;
  selectedVariantId?: string;
  selectedAddonIds?: string[];
  specialInstructions?: string;
}

export async function buildAuthoritativeOrderItems(
  restaurantId: number,
  requestedItems: RequestedOrderItemInput[],
) {
  if (!Array.isArray(requestedItems) || requestedItems.length === 0) {
    throw new Error('Order must include at least one item');
  }
  if (requestedItems.length > 50) {
    throw new Error('Order cannot exceed 50 line items');
  }

  const parsedMenuIds: number[] = [];
  for (const reqItem of requestedItems) {
    const menuItemId = Number(reqItem?.menuItemId);
    const qty = Number(reqItem?.quantity);
    if (!Number.isInteger(menuItemId) || menuItemId <= 0) {
      throw new Error('Invalid menu item identifier');
    }
    if (!Number.isInteger(qty) || qty <= 0 || qty > 50) {
      throw new Error('Item quantity must be a whole number between 1 and 50');
    }
    parsedMenuIds.push(menuItemId);
  }

  const uniqueMenuIds = [...new Set(parsedMenuIds)];
  const dbMenuItems = await db
    .select()
    .from(menuItems)
    .where(and(eq(menuItems.restaurantId, restaurantId), inArray(menuItems.id, uniqueMenuIds)));

  const menuMap = new Map(dbMenuItems.map((m) => [m.id, m]));

  let subtotal = 0;
  const normalizedItems: Array<{
    menuItemId: number;
    itemName: string;
    unitPrice: number;
    quantity: number;
    selectedVariant: { id: string; name: string; priceDelta: number } | null;
    selectedAddons: Array<{ id: string; name: string; price: number }>;
    specialInstructions: string;
    itemTotal: number;
  }> = [];

  for (const reqItem of requestedItems) {
    const qty = Number(reqItem.quantity);
    const menuItemId = Number(reqItem.menuItemId);
    const menuItem = menuMap.get(menuItemId);
    if (!menuItem) {
      throw new Error(`Menu item #${menuItemId} does not belong to this restaurant`);
    }
    if (!menuItem.isAvailable) {
      throw new Error(`${menuItem.name} is currently out of stock`);
    }

    let unitPrice = menuItem.price;
    let selectedVariant: { id: string; name: string; priceDelta: number } | null = null;
    if (reqItem.selectedVariantId && Array.isArray(menuItem.variants)) {
      const found = menuItem.variants.find((v) => v.id === reqItem.selectedVariantId);
      if (found) {
        selectedVariant = found;
        unitPrice += Math.max(0, Number(found.priceDelta) || 0);
      }
    }

    const selectedAddons: Array<{ id: string; name: string; price: number }> = [];
    if (Array.isArray(reqItem.selectedAddonIds) && Array.isArray(menuItem.addons)) {
      const seenAddonIds = new Set<string>();
      for (const addonId of reqItem.selectedAddonIds) {
        if (seenAddonIds.has(addonId)) continue;
        const foundAddon = menuItem.addons.find((a) => a.id === addonId);
        if (foundAddon) {
          seenAddonIds.add(addonId);
          selectedAddons.push(foundAddon);
          unitPrice += Math.max(0, Number(foundAddon.price) || 0);
        }
      }
    }

    const itemTotal = Number((unitPrice * qty).toFixed(2));
    subtotal += itemTotal;

    normalizedItems.push({
      menuItemId: menuItem.id,
      itemName: menuItem.name,
      unitPrice: Number(unitPrice.toFixed(2)),
      quantity: qty,
      selectedVariant,
      selectedAddons,
      specialInstructions: sanitizeText(reqItem.specialInstructions, 240),
      itemTotal,
    });
  }

  return { subtotal: Number(subtotal.toFixed(2)), normalizedItems };
}

export async function computeOrderTotals(params: {
  restaurantId: number;
  subtotal: number;
  promoCode?: string;
  manualDiscountAmount?: number;
  allowManualDiscount?: boolean;
}) {
  const [rest] = await db
    .select()
    .from(restaurants)
    .where(eq(restaurants.id, params.restaurantId))
    .limit(1);

  if (!rest) {
    throw new Error('Restaurant not found');
  }

  const rawManual = Number(params.manualDiscountAmount || 0);
  if (Number.isNaN(rawManual) || rawManual < 0) {
    throw new Error('Discount amount cannot be negative');
  }

  let discountAmount = params.allowManualDiscount ? rawManual : 0;
  let appliedPromo = '';

  if (params.promoCode && params.promoCode.trim()) {
    const codeUpper = sanitizeText(params.promoCode, 32).toUpperCase();
    const [offer] = await db
      .select()
      .from(promotionalOffers)
      .where(
        and(
          eq(promotionalOffers.restaurantId, params.restaurantId),
          eq(promotionalOffers.code, codeUpper),
          eq(promotionalOffers.isActive, true),
        ),
      )
      .limit(1);

    if (offer && params.subtotal >= offer.minOrderAmount) {
      let promoDiscount =
        offer.discountType === 'percent'
          ? (params.subtotal * offer.discountValue) / 100
          : offer.discountValue;

      if (offer.maxDiscount > 0) {
        promoDiscount = Math.min(promoDiscount, offer.maxDiscount);
      }
      discountAmount = Number(Math.min(params.subtotal, promoDiscount).toFixed(2));
      appliedPromo = offer.code;
    }
  }

  discountAmount = Math.min(params.subtotal, discountAmount);
  const taxableAmount = Math.max(0, params.subtotal - discountAmount);
  const gstAmount = Number(((taxableAmount * rest.gstRate) / 100).toFixed(2));
  const serviceChargeAmount = Number(((taxableAmount * rest.serviceChargeRate) / 100).toFixed(2));
  const totalAmount = Number((taxableAmount + gstAmount + serviceChargeAmount).toFixed(2));

  return {
    subtotal: params.subtotal,
    discountAmount,
    promoCode: appliedPromo,
    gstRateApplied: rest.gstRate,
    gstAmount,
    serviceChargeRateApplied: rest.serviceChargeRate,
    serviceChargeAmount,
    totalAmount,
  };
}

export async function upsertCustomerFromOrder(params: {
  restaurantId: number;
  name?: string;
  phone?: string;
  amountDelta?: number;
}) {
  const cleanPhone = sanitizeText(params.phone || '', 24);
  const cleanName = sanitizeText(params.name || '', 80);
  if (!cleanPhone || cleanPhone.length < 6) return null;

  const [existing] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.restaurantId, params.restaurantId), eq(customers.phone, cleanPhone)))
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(customers)
      .set({
        name: cleanName || existing.name,
        visitCount: existing.visitCount + (params.amountDelta ? 0 : 1),
        totalSpent: existing.totalSpent + (params.amountDelta || 0),
        lastVisitAt: new Date(),
      })
      .where(eq(customers.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(customers)
    .values({
      restaurantId: params.restaurantId,
      name: cleanName || 'Guest',
      phone: cleanPhone,
      visitCount: 1,
      totalSpent: params.amountDelta || 0,
      lastVisitAt: new Date(),
    })
    .returning();
  return created;
}

export async function getOrCreateActiveDiningSession(params: {
  restaurantId: number;
  tableId: number;
  actorName: string;
  actorRole: string;
  ipAddress?: string;
  reason?: string;
}) {
  const result = await db.transaction(async (tx) => {
    // Row-lock table row to serialize concurrent first-scans for the same table
    await tx.execute(sql`SELECT id FROM restaurant_tables WHERE id = ${params.tableId} FOR UPDATE`);

    const [existing] = await tx
      .select()
      .from(diningSessions)
      .where(
        and(
          eq(diningSessions.restaurantId, params.restaurantId),
          eq(diningSessions.tableId, params.tableId),
          eq(diningSessions.status, 'ACTIVE'),
        ),
      )
      .limit(1);

    if (existing) {
      return { session: existing, created: false };
    }

    const pin = generateDiningPin();
    const { hash, salt } = hashPin(pin);
    const pinEncrypted = encryptDiningPin(pin);
    const sessionUid = generateDiningSessionUid();
    const now = new Date();

    const [created] = await tx
      .insert(diningSessions)
      .values({
        sessionUid,
        restaurantId: params.restaurantId,
        tableId: params.tableId,
        status: 'ACTIVE',
        pinHash: hash,
        pinSalt: salt,
        pinEncrypted,
        pinVersion: 1,
        pinGeneratedAt: now,
        paymentStatus: 'unpaid',
        startedAt: now,
        updatedAt: now,
      })
      .returning();

    const pinDigest = hashTokenSha256(`${created.sessionUid}:${pin}:v1`).slice(0, 16);

    await tx.insert(diningSessionPinHistory).values({
      restaurantId: params.restaurantId,
      tableId: params.tableId,
      diningSessionId: created.id,
      pinVersion: 1,
      pinDigest,
      action: 'generated',
      actorName: sanitizeText(params.actorName, 120),
      actorRole: sanitizeText(params.actorRole, 40),
      reason: sanitizeText(params.reason || 'New dining session started', 200),
    });

    await tx.insert(securityEvents).values({
      restaurantId: params.restaurantId,
      severity: 'low',
      eventType: 'DINING_SESSION_CREATED',
      actorIdentifier: sanitizeText(params.actorName, 120),
      ipAddress: sanitizeText(params.ipAddress || '', 64),
      statusCode: 201,
      details: {
        tableId: params.tableId,
        diningSessionId: created.id,
        sessionUid: created.sessionUid,
      },
    });

    await tx.insert(securityEvents).values({
      restaurantId: params.restaurantId,
      severity: 'low',
      eventType: 'PIN_GENERATED',
      actorIdentifier: sanitizeText(params.actorName, 120),
      ipAddress: sanitizeText(params.ipAddress || '', 64),
      statusCode: 201,
      details: {
        tableId: params.tableId,
        diningSessionId: created.id,
        sessionUid: created.sessionUid,
        pinVersion: 1,
        pinDigest,
      },
    });

    return { session: created, created: true };
  });

  if (result.created) {
    broadcastToRestaurant(
      params.restaurantId,
      'dining_session:updated',
      { tableId: params.tableId, diningSessionId: result.session.id, status: 'ACTIVE' },
      params.tableId,
    );
  }

  return result;
}

export async function syncDiningSessionPaymentStatus(diningSessionId: number | null | undefined) {
  if (!diningSessionId) return null;

  const sessionOrders = await db
    .select()
    .from(orders)
    .where(eq(orders.diningSessionId, diningSessionId));

  const activeOrders = sessionOrders.filter((o) => o.status !== 'Cancelled');
  const totalDue = activeOrders.reduce((s, o) => s + Number(o.totalAmount || 0), 0);
  const totalPaid = activeOrders.reduce((s, o) => s + Number(o.paidAmount || 0), 0);

  let nextPaymentStatus = 'unpaid';
  if (activeOrders.length > 0 && totalPaid >= totalDue - 0.5 && totalDue > 0) {
    nextPaymentStatus = 'paid';
  } else if (totalPaid > 0) {
    nextPaymentStatus = 'partial';
  } else {
    const orderIds = activeOrders.map((o) => o.id);
    if (orderIds.length > 0) {
      const orderPays = await db
        .select()
        .from(payments)
        .where(inArray(payments.orderId, orderIds));
      if (orderPays.some((p) => p.status === 'pending' || p.status === 'processing')) {
        nextPaymentStatus = 'initiated';
      } else if (orderPays.some((p) => p.status === 'failed')) {
        nextPaymentStatus = 'failed';
      }
    }
  }

  const [updated] = await db
    .update(diningSessions)
    .set({ paymentStatus: nextPaymentStatus, updatedAt: new Date() })
    .where(eq(diningSessions.id, diningSessionId))
    .returning();

  if (updated) {
    broadcastToRestaurant(
      updated.restaurantId,
      'dining_session:updated',
      { tableId: updated.tableId, diningSessionId: updated.id, paymentStatus: nextPaymentStatus },
      updated.tableId,
    );
  }

  return updated;
}

