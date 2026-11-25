import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const platformPlans = pgTable('platform_plans', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  code: text('code').notNull().unique(),
  monthlyPriceInr: integer('monthly_price_inr').notNull(),
  maxTables: integer('max_tables').notNull(),
  maxStaff: integer('max_staff').notNull(),
  features: jsonb('features').$type<string[]>().notNull().default([]),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const platformSettings = pgTable('platform_settings', {
  id: serial('id').primaryKey(),
  platformName: text('platform_name').notNull().default('DineFlow'),
  supportEmail: text('support_email').notNull().default('support@dineflow.in'),
  defaultGstRate: doublePrecision('default_gst_rate').notNull().default(5),
  maintenanceMode: boolean('maintenance_mode').notNull().default(false),
  allowSelfRegistration: boolean('allow_self_registration').notNull().default(true),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').notNull().unique(),
  email: text('email').notNull(),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  isSuperAdmin: boolean('is_super_admin').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const restaurants = pgTable(
  'restaurants',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    tagline: text('tagline').default('Modern Hospitality'),
    cuisineType: text('cuisine_type').default('Multi-Cuisine'),
    logoUrl: text('logo_url'),
    address: text('address').notNull(),
    city: text('city').notNull(),
    state: text('state').notNull().default('Karnataka'),
    phone: text('phone').notNull(),
    email: text('email').notNull(),
    gstin: text('gstin').default(''),
    fssaiNo: text('fssai_no').default(''),
    openingHours: text('opening_hours').default('11:00 AM - 11:00 PM'),
    gstRate: doublePrecision('gst_rate').notNull().default(5),
    serviceChargeRate: doublePrecision('service_charge_rate').notNull().default(5),
    receiptHeader: text('receipt_header').default('Thank you for dining with us!'),
    receiptFooter: text('receipt_footer').default('Visit again · Powered by DineFlow'),
    soundAlertsEnabled: boolean('sound_alerts_enabled').notNull().default(true),
    qrOrderingEnabled: boolean('qr_ordering_enabled').notNull().default(true),
    autoAcceptQrOrders: boolean('auto_accept_qr_orders').notNull().default(false),
    upiId: text('upi_id').default(''),
    upiPayeeName: text('upi_payee_name').default(''),
    acceptedPaymentMethods: jsonb('accepted_payment_methods')
      .$type<string[]>()
      .notNull()
      .default(['upi', 'cash', 'card', 'razorpay']),
    planId: integer('plan_id').references(() => platformPlans.id),
    subscriptionStatus: text('subscription_status').notNull().default('active'),
    isActive: boolean('is_active').notNull().default(true),
    ownerUid: text('owner_uid').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [index('restaurants_owner_uid_idx').on(table.ownerUid)],
);

export const staffMembers = pgTable(
  'staff_members',
  {
    id: serial('id').primaryKey(),
    restaurantId: integer('restaurant_id')
      .references(() => restaurants.id, { onDelete: 'cascade' })
      .notNull(),
    userId: integer('user_id').references(() => users.id),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),
    role: text('role').notNull(), // 'owner' | 'manager' | 'waiter' | 'kitchen'
    pinHash: text('pin_hash').notNull(),
    pinSalt: text('pin_salt').notNull(),
    passwordHash: text('password_hash'),
    passwordSalt: text('password_salt'),
    tokenVersion: integer('token_version').notNull().default(1),
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until'),
    phoneVerified: boolean('phone_verified').notNull().default(false),
    permissions: jsonb('permissions').$type<Record<string, boolean>>().notNull().default({}),
    isActive: boolean('is_active').notNull().default(true),
    lastActiveAt: timestamp('last_active_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('staff_restaurant_idx').on(table.restaurantId)],
);

export const menuCategories = pgTable(
  'menu_categories',
  {
    id: serial('id').primaryKey(),
    restaurantId: integer('restaurant_id')
      .references(() => restaurants.id, { onDelete: 'cascade' })
      .notNull(),
    name: text('name').notNull(),
    description: text('description').default(''),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('menu_cat_restaurant_idx').on(table.restaurantId)],
);

export interface MenuVariant {
  id: string;
  name: string;
  priceDelta: number;
}

export interface MenuAddon {
  id: string;
  name: string;
  price: number;
}

export const menuItems = pgTable(
  'menu_items',
  {
    id: serial('id').primaryKey(),
    restaurantId: integer('restaurant_id')
      .references(() => restaurants.id, { onDelete: 'cascade' })
      .notNull(),
    categoryId: integer('category_id')
      .references(() => menuCategories.id, { onDelete: 'cascade' })
      .notNull(),
    name: text('name').notNull(),
    description: text('description').default(''),
    price: doublePrecision('price').notNull(),
    isVeg: boolean('is_veg').notNull().default(true),
    imageUrl: text('image_url').default(''),
    prepTimeMins: integer('prep_time_mins').notNull().default(15),
    variants: jsonb('variants').$type<MenuVariant[]>().notNull().default([]),
    addons: jsonb('addons').$type<MenuAddon[]>().notNull().default([]),
    isCombo: boolean('is_combo').notNull().default(false),
    comboDetails: text('combo_details').default(''),
    isAvailable: boolean('is_available').notNull().default(true),
    isFeatured: boolean('is_featured').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('menu_items_restaurant_idx').on(table.restaurantId),
    index('menu_items_category_idx').on(table.categoryId),
  ],
);

export const promotionalOffers = pgTable(
  'promotional_offers',
  {
    id: serial('id').primaryKey(),
    restaurantId: integer('restaurant_id')
      .references(() => restaurants.id, { onDelete: 'cascade' })
      .notNull(),
    title: text('title').notNull(),
    code: text('code').notNull(),
    discountType: text('discount_type').notNull().default('percent'), // 'percent' | 'flat'
    discountValue: doublePrecision('discount_value').notNull(),
    minOrderAmount: doublePrecision('min_order_amount').notNull().default(0),
    maxDiscount: doublePrecision('max_discount').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    usageCount: integer('usage_count').notNull().default(0),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('offers_restaurant_idx').on(table.restaurantId),
    uniqueIndex('offers_restaurant_code_uidx').on(table.restaurantId, table.code),
  ],
);

export const restaurantTables = pgTable(
  'restaurant_tables',
  {
    id: serial('id').primaryKey(),
    restaurantId: integer('restaurant_id')
      .references(() => restaurants.id, { onDelete: 'cascade' })
      .notNull(),
    tableNumber: text('table_number').notNull(),
    section: text('section').notNull().default('Main Dining'),
    capacity: integer('capacity').notNull().default(4),
    status: text('status').notNull().default('Available'), // Available | Occupied | Ordering | Preparing | Served | Billing | Cleaning
    assignedStaffId: integer('assigned_staff_id').references(() => staffMembers.id, {
      onDelete: 'set null',
    }),
    qrToken: text('qr_token').notNull().unique(),
    qrTokenVersion: integer('qr_token_version').notNull().default(1),
    qrExpiresAt: timestamp('qr_expires_at'),
    qrRevokedAt: timestamp('qr_revoked_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('tables_restaurant_idx').on(table.restaurantId),
    uniqueIndex('tables_restaurant_num_uidx').on(table.restaurantId, table.tableNumber),
  ],
);

export const customers = pgTable(
  'customers',
  {
    id: serial('id').primaryKey(),
    restaurantId: integer('restaurant_id')
      .references(() => restaurants.id, { onDelete: 'cascade' })
      .notNull(),
    name: text('name').notNull(),
    phone: text('phone').notNull(),
    email: text('email').default(''),
    visitCount: integer('visit_count').notNull().default(1),
    totalSpent: doublePrecision('total_spent').notNull().default(0),
    lastVisitAt: timestamp('last_visit_at').defaultNow(),
    feedbackRating: integer('feedback_rating'),
    feedbackComment: text('feedback_comment').default(''),
    notes: text('notes').default(''),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('customers_restaurant_idx').on(table.restaurantId)],
);

export const diningSessions = pgTable(
  'dining_sessions',
  {
    id: serial('id').primaryKey(),
    sessionUid: text('session_uid').notNull().unique(),
    restaurantId: integer('restaurant_id')
      .references(() => restaurants.id, { onDelete: 'cascade' })
      .notNull(),
    tableId: integer('table_id')
      .references(() => restaurantTables.id, { onDelete: 'cascade' })
      .notNull(),
    status: text('status').notNull().default('ACTIVE'), // ACTIVE | CLOSED
    pinHash: text('pin_hash').notNull(),
    pinSalt: text('pin_salt').notNull(),
    pinEncrypted: text('pin_encrypted').notNull(),
    previousPinHash: text('previous_pin_hash'),
    previousPinSalt: text('previous_pin_salt'),
    pinVersion: integer('pin_version').notNull().default(1),
    pinGeneratedAt: timestamp('pin_generated_at').defaultNow().notNull(),
    pinLastRegeneratedAt: timestamp('pin_last_regenerated_at'),
    billRequested: boolean('bill_requested').notNull().default(false),
    billRequestedAt: timestamp('bill_requested_at'),
    paymentStatus: text('payment_status').notNull().default('unpaid'), // unpaid | initiated | partial | paid | failed
    customerDeparted: boolean('customer_departed').notNull().default(false),
    departureConfirmedBy: text('departure_confirmed_by').default(''),
    departureConfirmedAt: timestamp('departure_confirmed_at'),
    closedBy: text('closed_by').default(''),
    closedByRole: text('closed_by_role').default(''),
    closeReason: text('close_reason').default(''),
    isOverrideClose: boolean('is_override_close').notNull().default(false),
    startedAt: timestamp('started_at').defaultNow().notNull(),
    closedAt: timestamp('closed_at'),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    index('dining_sessions_restaurant_idx').on(table.restaurantId),
    index('dining_sessions_table_status_idx').on(table.tableId, table.status),
  ],
);

export const diningSessionPinHistory = pgTable(
  'dining_session_pin_history',
  {
    id: serial('id').primaryKey(),
    restaurantId: integer('restaurant_id')
      .references(() => restaurants.id, { onDelete: 'cascade' })
      .notNull(),
    tableId: integer('table_id')
      .references(() => restaurantTables.id, { onDelete: 'cascade' })
      .notNull(),
    diningSessionId: integer('dining_session_id')
      .references(() => diningSessions.id, { onDelete: 'cascade' })
      .notNull(),
    pinVersion: integer('pin_version').notNull().default(1),
    pinDigest: text('pin_digest').notNull(),
    action: text('action').notNull(), // generated | regenerated | invalidated
    actorName: text('actor_name').notNull(),
    actorRole: text('actor_role').notNull().default('system'),
    reason: text('reason').default(''),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('pin_hist_restaurant_idx').on(table.restaurantId),
    index('pin_hist_session_idx').on(table.diningSessionId),
  ],
);

export const customerQrSessions = pgTable(
  'customer_qr_sessions',
  {
    id: serial('id').primaryKey(),
    qrSessionUid: text('qr_session_uid').notNull().unique(),
    restaurantId: integer('restaurant_id')
      .references(() => restaurants.id, { onDelete: 'cascade' })
      .notNull(),
    tableId: integer('table_id')
      .references(() => restaurantTables.id, { onDelete: 'cascade' })
      .notNull(),
    diningSessionId: integer('dining_session_id')
      .references(() => diningSessions.id, { onDelete: 'cascade' })
      .notNull(),
    qrTokenVersion: integer('qr_token_version').notNull().default(1),
    pinVerified: boolean('pin_verified').notNull().default(false),
    pinVerifiedVersion: integer('pin_verified_version'),
    pinVerifiedAt: timestamp('pin_verified_at'),
    failedPinAttempts: integer('failed_pin_attempts').notNull().default(0),
    pinLockedUntil: timestamp('pin_locked_until'),
    ipAddress: text('ip_address').default(''),
    lastActivityAt: timestamp('last_activity_at').defaultNow().notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    revokedAt: timestamp('revoked_at'),
    revokeReason: text('revoke_reason').default(''),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('cust_qr_sessions_dining_idx').on(table.diningSessionId),
    index('cust_qr_sessions_table_idx').on(table.tableId),
  ],
);

export const orderAuthTokens = pgTable(
  'order_auth_tokens',
  {
    id: serial('id').primaryKey(),
    tokenJti: text('token_jti').notNull().unique(),
    restaurantId: integer('restaurant_id')
      .references(() => restaurants.id, { onDelete: 'cascade' })
      .notNull(),
    tableId: integer('table_id')
      .references(() => restaurantTables.id, { onDelete: 'cascade' })
      .notNull(),
    diningSessionId: integer('dining_session_id')
      .references(() => diningSessions.id, { onDelete: 'cascade' })
      .notNull(),
    customerQrSessionId: integer('customer_qr_session_id')
      .references(() => customerQrSessions.id, { onDelete: 'cascade' })
      .notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    consumedAt: timestamp('consumed_at'),
    consumedByOrderId: integer('consumed_by_order_id'),
    revokedAt: timestamp('revoked_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('order_auth_dining_idx').on(table.diningSessionId),
    index('order_auth_qr_idx').on(table.customerQrSessionId),
  ],
);

export const pinAttemptTrackers = pgTable(
  'pin_attempt_trackers',
  {
    id: serial('id').primaryKey(),
    restaurantId: integer('restaurant_id')
      .references(() => restaurants.id, { onDelete: 'cascade' })
      .notNull(),
    diningSessionId: integer('dining_session_id')
      .references(() => diningSessions.id, { onDelete: 'cascade' })
      .notNull(),
    clientKey: text('client_key').notNull(),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until'),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('pin_attempt_session_client_uidx').on(table.diningSessionId, table.clientKey),
  ],
);

export const orders = pgTable(
  'orders',
  {
    id: serial('id').primaryKey(),
    restaurantId: integer('restaurant_id')
      .references(() => restaurants.id, { onDelete: 'cascade' })
      .notNull(),
    orderNumber: text('order_number').notNull(),
    tableId: integer('table_id').references(() => restaurantTables.id, { onDelete: 'set null' }),
    diningSessionId: integer('dining_session_id').references(() => diningSessions.id, {
      onDelete: 'set null',
    }),
    customerQrSessionId: integer('customer_qr_session_id').references(() => customerQrSessions.id, {
      onDelete: 'set null',
    }),
    customerId: integer('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    waiterId: integer('waiter_id').references(() => staffMembers.id, { onDelete: 'set null' }),
    customerName: text('customer_name').default('Walk-in Guest'),
    customerPhone: text('customer_phone').default(''),
    orderType: text('order_type').notNull().default('dine_in'), // dine_in | takeaway | parcel
    source: text('source').notNull().default('pos'), // pos | qr
    status: text('status').notNull().default('New'), // New | Accepted | Preparing | Ready | Served | Completed | Paid | Closed | Cancelled
    subtotal: doublePrecision('subtotal').notNull().default(0),
    discountAmount: doublePrecision('discount_amount').notNull().default(0),
    promoCode: text('promo_code').default(''),
    gstRateApplied: doublePrecision('gst_rate_applied').notNull().default(5),
    gstAmount: doublePrecision('gst_amount').notNull().default(0),
    serviceChargeRateApplied: doublePrecision('service_charge_rate_applied').notNull().default(0),
    serviceChargeAmount: doublePrecision('service_charge_amount').notNull().default(0),
    totalAmount: doublePrecision('total_amount').notNull().default(0),
    paidAmount: doublePrecision('paid_amount').notNull().default(0),
    specialInstructions: text('special_instructions').default(''),
    cancelReason: text('cancel_reason').default(''),
    cancelledBy: text('cancelled_by').default(''),
    inventoryDeducted: boolean('inventory_deducted').notNull().default(false),
    idempotencyKey: text('idempotency_key'),
    acceptedAt: timestamp('accepted_at'),
    preparingAt: timestamp('preparing_at'),
    readyAt: timestamp('ready_at'),
    servedAt: timestamp('served_at'),
    paidAt: timestamp('paid_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    index('orders_restaurant_idx').on(table.restaurantId),
    index('orders_status_idx').on(table.restaurantId, table.status),
    index('orders_table_idx').on(table.tableId),
    uniqueIndex('orders_rest_idemp_uidx').on(table.restaurantId, table.idempotencyKey),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: serial('id').primaryKey(),
    restaurantId: integer('restaurant_id')
      .references(() => restaurants.id, { onDelete: 'cascade' })
      .notNull(),
    orderId: integer('order_id')
      .references(() => orders.id, { onDelete: 'cascade' })
      .notNull(),
    menuItemId: integer('menu_item_id').references(() => menuItems.id, { onDelete: 'set null' }),
    itemName: text('item_name').notNull(),
    unitPrice: doublePrecision('unit_price').notNull(),
    quantity: integer('quantity').notNull().default(1),
    selectedVariant: jsonb('selected_variant').$type<{ id: string; name: string; priceDelta: number } | null>(),
    selectedAddons: jsonb('selected_addons').$type<Array<{ id: string; name: string; price: number }>>().notNull().default([]),
    specialInstructions: text('special_instructions').default(''),
    status: text('status').notNull().default('Queued'), // Queued | Preparing | Ready | Served
    itemTotal: doublePrecision('item_total').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('order_items_order_idx').on(table.orderId),
    index('order_items_restaurant_idx').on(table.restaurantId),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: serial('id').primaryKey(),
    restaurantId: integer('restaurant_id')
      .references(() => restaurants.id, { onDelete: 'cascade' })
      .notNull(),
    orderId: integer('order_id')
      .references(() => orders.id, { onDelete: 'cascade' })
      .notNull(),
    diningSessionId: integer('dining_session_id').references(() => diningSessions.id, {
      onDelete: 'set null',
    }),
    amount: doublePrecision('amount').notNull(),
    method: text('method').notNull(), // cash | upi | card | razorpay | other
    paymentMethodLabel: text('payment_method_label').default(''),
    status: text('status').notNull().default('verified'), // pending | processing | verified | failed | refunded | partial
    initiatedBySource: text('initiated_by_source').notNull().default('pos'), // pos | customer_qr
    upiUri: text('upi_uri').default(''),
    customerUtrSubmitted: text('customer_utr_submitted').default(''),
    transactionRef: text('transaction_ref').default(''),
    razorpayOrderId: text('razorpay_order_id').default(''),
    razorpayPaymentId: text('razorpay_payment_id').default(''),
    razorpaySignature: text('razorpay_signature').default(''),
    collectedBy: text('collected_by').default(''),
    verifiedBy: text('verified_by').default(''),
    verifiedAt: timestamp('verified_at'),
    refundedAmount: doublePrecision('refunded_amount').notNull().default(0),
    refundReason: text('refund_reason').default(''),
    refundedBy: text('refunded_by').default(''),
    refundedAt: timestamp('refunded_at'),
    idempotencyKey: text('idempotency_key'),
    notes: text('notes').default(''),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('payments_restaurant_idx').on(table.restaurantId),
    index('payments_order_idx').on(table.orderId),
    index('payments_dining_session_idx').on(table.diningSessionId),
    uniqueIndex('payments_rest_idemp_uidx').on(table.restaurantId, table.idempotencyKey),
  ],
);

export interface CustomPaymentMethod {
  code: string;
  label: string;
  enabled: boolean;
  instructions?: string;
}

export interface ReceiptVisibilityConfig {
  logo: boolean;
  gstin: boolean;
  customerName: boolean;
  customerPhone: boolean;
  tableNumber: boolean;
  orderId: boolean;
  paymentMethod: boolean;
  transactionId: boolean;
  taxBreakdown: boolean;
  discountBreakdown: boolean;
  serviceCharge: boolean;
  footerMessage: boolean;
  socialHandles: boolean;
}

export interface ReceiptSocialHandles {
  instagram?: string;
  facebook?: string;
  website?: string;
}

export interface ReceiptTemplateSnapshot {
  templateKey: 'classic' | 'modern' | 'premium' | 'compact' | string;
  name: string;
  accentColor: string;
  fontStyle: 'sans' | 'mono' | 'serif' | string;
  fontSize: 'sm' | 'md' | 'lg' | string;
  layoutMode: 'centered' | 'left' | 'compact' | string;
  paperSize: '58mm' | '80mm' | 'A4' | string;
  logoUrl: string;
  businessName: string;
  address: string;
  phone: string;
  email: string;
  gstin: string;
  headerMessage: string;
  footerMessage: string;
  thankYouMessage: string;
  socialHandles: ReceiptSocialHandles;
  visibility: ReceiptVisibilityConfig;
}

export interface ReceiptLineItemSnapshot {
  itemName: string;
  quantity: number;
  unitPrice: number;
  itemTotal: number;
  variantName?: string;
  addonsSummary?: string;
}

export const billingSettings = pgTable(
  'billing_settings',
  {
    id: serial('id').primaryKey(),
    restaurantId: integer('restaurant_id')
      .references(() => restaurants.id, { onDelete: 'cascade' })
      .notNull()
      .unique(),
    activeTemplateId: integer('active_template_id'),
    upiId: text('upi_id').default(''),
    upiPayeeName: text('upi_payee_name').default(''),
    customPaymentMethods: jsonb('custom_payment_methods')
      .$type<CustomPaymentMethod[]>()
      .notNull()
      .default([]),
    otherChargesLabel: text('other_charges_label').default('Other Charges'),
    otherChargesAmount: doublePrecision('other_charges_amount').notNull().default(0),
    thankYouMessage: text('thank_you_message').default('Thank you for dining with us! Visit again.'),
    socialHandles: jsonb('social_handles').$type<ReceiptSocialHandles>().notNull().default({}),
    updatedBy: text('updated_by').default(''),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [uniqueIndex('billing_settings_rest_uidx').on(table.restaurantId)],
);

export const receiptTemplates = pgTable(
  'receipt_templates',
  {
    id: serial('id').primaryKey(),
    restaurantId: integer('restaurant_id')
      .references(() => restaurants.id, { onDelete: 'cascade' })
      .notNull(),
    name: text('name').notNull(),
    templateKey: text('template_key').notNull().default('classic'), // classic | modern | premium | compact
    isDefault: boolean('is_default').notNull().default(false),
    logoUrl: text('logo_url').default(''),
    businessName: text('business_name').default(''),
    address: text('address').default(''),
    phone: text('phone').default(''),
    email: text('email').default(''),
    gstin: text('gstin').default(''),
    headerMessage: text('header_message').default(''),
    footerMessage: text('footer_message').default(''),
    thankYouMessage: text('thank_you_message').default('Thank you for dining with us!'),
    socialHandles: jsonb('social_handles').$type<ReceiptSocialHandles>().notNull().default({}),
    accentColor: text('accent_color').notNull().default('#EA580C'),
    fontStyle: text('font_style').notNull().default('mono'), // sans | mono | serif
    fontSize: text('font_size').notNull().default('md'), // sm | md | lg
    layoutMode: text('layout_mode').notNull().default('centered'), // centered | left | compact
    paperSize: text('paper_size').notNull().default('80mm'), // 58mm | 80mm | A4
    visibility: jsonb('visibility').$type<ReceiptVisibilityConfig>().notNull().default({
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
    }),
    createdBy: text('created_by').default('System'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [index('receipt_templates_rest_idx').on(table.restaurantId)],
);

export const receipts = pgTable(
  'receipts',
  {
    id: serial('id').primaryKey(),
    receiptNumber: text('receipt_number').notNull().unique(),
    restaurantId: integer('restaurant_id')
      .references(() => restaurants.id, { onDelete: 'cascade' })
      .notNull(),
    orderId: integer('order_id').references(() => orders.id, { onDelete: 'set null' }),
    diningSessionId: integer('dining_session_id').references(() => diningSessions.id, {
      onDelete: 'set null',
    }),
    paymentId: integer('payment_id').references(() => payments.id, { onDelete: 'set null' }),
    customerQrSessionId: integer('customer_qr_session_id').references(() => customerQrSessions.id, {
      onDelete: 'set null',
    }),
    tableId: integer('table_id'),
    tableNumber: text('table_number').default(''),
    orderNumber: text('order_number').default(''),
    customerName: text('customer_name').default('Walk-in Guest'),
    customerPhone: text('customer_phone').default(''),
    paymentMethod: text('payment_method').notNull().default('cash'),
    paymentStatus: text('payment_status').notNull().default('Paid'), // Pending | Processing | Paid | Failed | Refunded | Partially Paid
    transactionId: text('transaction_id').default(''),
    subtotal: doublePrecision('subtotal').notNull().default(0),
    discountAmount: doublePrecision('discount_amount').notNull().default(0),
    gstRateApplied: doublePrecision('gst_rate_applied').notNull().default(5),
    cgstAmount: doublePrecision('cgst_amount').notNull().default(0),
    sgstAmount: doublePrecision('sgst_amount').notNull().default(0),
    serviceChargeRateApplied: doublePrecision('service_charge_rate_applied').notNull().default(0),
    serviceChargeAmount: doublePrecision('service_charge_amount').notNull().default(0),
    otherChargesLabel: text('other_charges_label').default('Other Charges'),
    otherChargesAmount: doublePrecision('other_charges_amount').notNull().default(0),
    grandTotal: doublePrecision('grand_total').notNull().default(0),
    amountPaid: doublePrecision('amount_paid').notNull().default(0),
    balanceDue: doublePrecision('balance_due').notNull().default(0),
    refundedAmount: doublePrecision('refunded_amount').notNull().default(0),
    refundReason: text('refund_reason').default(''),
    refundedAt: timestamp('refunded_at'),
    itemsSnapshot: jsonb('items_snapshot').$type<ReceiptLineItemSnapshot[]>().notNull().default([]),
    restaurantSnapshot: jsonb('restaurant_snapshot')
      .$type<{
        name: string;
        logoUrl?: string;
        address: string;
        city: string;
        state: string;
        phone: string;
        email: string;
        gstin: string;
        fssaiNo?: string;
      }>()
      .notNull(),
    templateSnapshot: jsonb('template_snapshot').$type<ReceiptTemplateSnapshot>().notNull(),
    generatedBy: text('generated_by').default('System'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('receipts_rest_idx').on(table.restaurantId),
    index('receipts_order_idx').on(table.orderId),
    index('receipts_session_idx').on(table.diningSessionId),
    uniqueIndex('receipts_payment_uidx').on(table.paymentId),
  ],
);

export const serviceRequests = pgTable(
  'service_requests',
  {
    id: serial('id').primaryKey(),
    restaurantId: integer('restaurant_id')
      .references(() => restaurants.id, { onDelete: 'cascade' })
      .notNull(),
    tableId: integer('table_id')
      .references(() => restaurantTables.id, { onDelete: 'cascade' })
      .notNull(),
    diningSessionId: integer('dining_session_id').references(() => diningSessions.id, {
      onDelete: 'set null',
    }),
    requestType: text('request_type').notNull(), // waiter | bill | water
    note: text('note').default(''),
    status: text('status').notNull().default('pending'), // pending | acknowledged | resolved
    handledBy: text('handled_by').default(''),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    resolvedAt: timestamp('resolved_at'),
  },
  (table) => [index('service_req_restaurant_idx').on(table.restaurantId)],
);

export const suppliers = pgTable(
  'suppliers',
  {
    id: serial('id').primaryKey(),
    restaurantId: integer('restaurant_id')
      .references(() => restaurants.id, { onDelete: 'cascade' })
      .notNull(),
    name: text('name').notNull(),
    contactPerson: text('contact_person').default(''),
    phone: text('phone').default(''),
    email: text('email').default(''),
    category: text('category').default('Groceries & Staples'),
    address: text('address').default(''),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('suppliers_restaurant_idx').on(table.restaurantId)],
);

export const inventoryItems = pgTable(
  'inventory_items',
  {
    id: serial('id').primaryKey(),
    restaurantId: integer('restaurant_id')
      .references(() => restaurants.id, { onDelete: 'cascade' })
      .notNull(),
    supplierId: integer('supplier_id').references(() => suppliers.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    sku: text('sku').default(''),
    category: text('category').notNull().default('Ingredients'),
    unit: text('unit').notNull().default('kg'),
    currentStock: doublePrecision('current_stock').notNull().default(0),
    reorderLevel: doublePrecision('reorder_level').notNull().default(5),
    costPerUnit: doublePrecision('cost_per_unit').notNull().default(0),
    lastRestockedAt: timestamp('last_restocked_at').defaultNow(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('inventory_restaurant_idx').on(table.restaurantId)],
);

export const menuItemRecipes = pgTable(
  'menu_item_recipes',
  {
    id: serial('id').primaryKey(),
    restaurantId: integer('restaurant_id')
      .references(() => restaurants.id, { onDelete: 'cascade' })
      .notNull(),
    menuItemId: integer('menu_item_id')
      .references(() => menuItems.id, { onDelete: 'cascade' })
      .notNull(),
    inventoryItemId: integer('inventory_item_id')
      .references(() => inventoryItems.id, { onDelete: 'cascade' })
      .notNull(),
    quantityRequired: doublePrecision('quantity_required').notNull(),
  },
  (table) => [
    index('recipes_menu_item_idx').on(table.menuItemId),
    uniqueIndex('recipes_item_ing_uidx').on(table.menuItemId, table.inventoryItemId),
  ],
);

export const stockMovements = pgTable(
  'stock_movements',
  {
    id: serial('id').primaryKey(),
    restaurantId: integer('restaurant_id')
      .references(() => restaurants.id, { onDelete: 'cascade' })
      .notNull(),
    inventoryItemId: integer('inventory_item_id')
      .references(() => inventoryItems.id, { onDelete: 'cascade' })
      .notNull(),
    movementType: text('movement_type').notNull(), // purchase | deduction | wastage | adjustment
    quantityDelta: doublePrecision('quantity_delta').notNull(),
    unitCost: doublePrecision('unit_cost').notNull().default(0),
    referenceOrderId: integer('reference_order_id').references(() => orders.id, {
      onDelete: 'set null',
    }),
    notes: text('notes').default(''),
    createdBy: text('created_by').default('System'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('stock_mov_restaurant_idx').on(table.restaurantId),
    index('stock_mov_item_idx').on(table.inventoryItemId),
  ],
);

export const expenses = pgTable(
  'expenses',
  {
    id: serial('id').primaryKey(),
    restaurantId: integer('restaurant_id')
      .references(() => restaurants.id, { onDelete: 'cascade' })
      .notNull(),
    category: text('category').notNull(), // Raw Materials | Rent | Utilities | Salaries | Marketing | Maintenance | Other
    title: text('title').notNull(),
    amount: doublePrecision('amount').notNull(),
    expenseDate: text('expense_date').notNull(), // YYYY-MM-DD
    paymentMethod: text('payment_method').notNull().default('upi'), // cash | upi | card | bank_transfer
    vendorName: text('vendor_name').default(''),
    description: text('description').default(''),
    receiptUrl: text('receipt_url').default(''),
    recordedBy: text('recorded_by').default('Owner'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('expenses_restaurant_idx').on(table.restaurantId)],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: serial('id').primaryKey(),
    restaurantId: integer('restaurant_id').references(() => restaurants.id, { onDelete: 'cascade' }),
    actorName: text('actor_name').notNull(),
    actorRole: text('actor_role').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').default(''),
    details: jsonb('details').$type<Record<string, unknown>>().default({}),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('audit_restaurant_idx').on(table.restaurantId)],
);

export const qrTokenHistory = pgTable(
  'qr_token_history',
  {
    id: serial('id').primaryKey(),
    restaurantId: integer('restaurant_id')
      .references(() => restaurants.id, { onDelete: 'cascade' })
      .notNull(),
    tableId: integer('table_id')
      .references(() => restaurantTables.id, { onDelete: 'cascade' })
      .notNull(),
    tokenHash: text('token_hash').notNull(),
    tokenVersion: integer('token_version').notNull().default(1),
    action: text('action').notNull(), // created | regenerated | revoked | expired | migrated
    actorName: text('actor_name').notNull(),
    reason: text('reason').default(''),
    expiresAt: timestamp('expires_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('qr_history_restaurant_idx').on(table.restaurantId),
    index('qr_history_table_idx').on(table.tableId),
  ],
);

export const userSessions = pgTable(
  'user_sessions',
  {
    id: serial('id').primaryKey(),
    sessionId: text('session_id').notNull().unique(),
    authType: text('auth_type').notNull(), // staff | firebase
    staffId: integer('staff_id').references(() => staffMembers.id, { onDelete: 'cascade' }),
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
    restaurantId: integer('restaurant_id').references(() => restaurants.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    actorName: text('actor_name').notNull(),
    tokenVersion: integer('token_version').notNull().default(1),
    ipAddress: text('ip_address').default(''),
    userAgent: text('user_agent').default(''),
    expiresAt: timestamp('expires_at').notNull(),
    revokedAt: timestamp('revoked_at'),
    lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('sessions_restaurant_idx').on(table.restaurantId),
    index('sessions_staff_idx').on(table.staffId),
  ],
);

export const otpChallenges = pgTable(
  'otp_challenges',
  {
    id: serial('id').primaryKey(),
    purpose: text('purpose').notNull(), // guest_verify | staff_reset
    phone: text('phone').notNull(),
    restaurantId: integer('restaurant_id').references(() => restaurants.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    codeSalt: text('code_salt').notNull(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    expiresAt: timestamp('expires_at').notNull(),
    consumedAt: timestamp('consumed_at'),
    lastSentAt: timestamp('last_sent_at').defaultNow().notNull(),
    ipAddress: text('ip_address').default(''),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('otp_phone_purpose_idx').on(table.phone, table.purpose),
    index('otp_created_idx').on(table.createdAt),
  ],
);

export const securityEvents = pgTable(
  'security_events',
  {
    id: serial('id').primaryKey(),
    restaurantId: integer('restaurant_id').references(() => restaurants.id, { onDelete: 'cascade' }),
    severity: text('severity').notNull().default('medium'), // low | medium | high | critical
    eventType: text('event_type').notNull(),
    actorIdentifier: text('actor_identifier').default('anonymous'),
    ipAddress: text('ip_address').default(''),
    path: text('path').default(''),
    method: text('method').default(''),
    statusCode: integer('status_code').default(200),
    details: jsonb('details').$type<Record<string, unknown>>().default({}),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('sec_events_restaurant_idx').on(table.restaurantId),
    index('sec_events_type_idx').on(table.eventType),
    index('sec_events_created_idx').on(table.createdAt),
  ],
);
