export interface PlatformPlan {
  id: number;
  name: string;
  code: string;
  monthlyPriceInr: number;
  maxTables: number;
  maxStaff: number;
  features: string[];
  isActive: boolean;
}

export interface Restaurant {
  id: number;
  name: string;
  slug: string;
  tagline: string;
  cuisineType: string;
  logoUrl?: string | null;
  address: string;
  city: string;
  state: string;
  phone: string;
  email: string;
  gstin: string;
  fssaiNo: string;
  openingHours: string;
  gstRate: number;
  serviceChargeRate: number;
  receiptHeader: string;
  receiptFooter: string;
  soundAlertsEnabled: boolean;
  qrOrderingEnabled: boolean;
  autoAcceptQrOrders: boolean;
  planId: number | null;
  subscriptionStatus: string;
  isActive: boolean;
  ownerUid: string;
  upiId?: string;
  upiPayeeName?: string;
  acceptedPaymentMethods?: string[];
}

export interface AuthContextData {
  authType: 'firebase' | 'staff';
  uid?: string;
  userId?: number;
  email?: string;
  displayName: string;
  isSuperAdmin: boolean;
  staffId?: number;
  role: 'owner' | 'manager' | 'waiter' | 'kitchen' | 'super_admin';
  restaurantId: number | null;
  permissions: Record<string, boolean>;
}

export interface MenuCategory {
  id: number;
  restaurantId: number;
  name: string;
  description: string;
  sortOrder: number;
  isActive: boolean;
}

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

export interface MenuItem {
  id: number;
  restaurantId: number;
  categoryId: number;
  name: string;
  description: string;
  price: number;
  isVeg: boolean;
  imageUrl: string;
  prepTimeMins: number;
  variants: MenuVariant[];
  addons: MenuAddon[];
  isCombo: boolean;
  comboDetails: string;
  isAvailable: boolean;
  isFeatured: boolean;
}

export interface PromotionalOffer {
  id: number;
  restaurantId: number;
  title: string;
  code: string;
  discountType: 'percent' | 'flat';
  discountValue: number;
  minOrderAmount: number;
  maxDiscount: number;
  isActive: boolean;
  usageCount: number;
}

export type TableStatus =
  | 'Available'
  | 'Occupied'
  | 'Ordering'
  | 'Preparing'
  | 'Served'
  | 'Billing'
  | 'Cleaning';

export interface RestaurantTable {
  id: number;
  restaurantId: number;
  tableNumber: string;
  section: string;
  capacity: number;
  status: TableStatus;
  assignedStaffId: number | null;
  qrToken: string;
  qrTokenVersion?: number;
  qrExpiresAt?: string | null;
  qrRevokedAt?: string | null;
}

export interface ServiceRequest {
  id: number;
  restaurantId: number;
  tableId: number;
  tableNumber?: string;
  requestType: 'waiter' | 'bill' | 'water' | 'closure';
  note: string;
  status: 'pending' | 'acknowledged' | 'resolved';
  handledBy: string;
  createdAt: string;
}

export interface OrderItem {
  id: number;
  orderId: number;
  menuItemId: number | null;
  itemName: string;
  unitPrice: number;
  quantity: number;
  selectedVariant: MenuVariant | null;
  selectedAddons: MenuAddon[];
  specialInstructions: string;
  status: 'Queued' | 'Preparing' | 'Ready' | 'Served';
  itemTotal: number;
}

export interface PaymentRecord {
  id: number;
  orderId: number;
  diningSessionId?: number | null;
  amount: number;
  method: 'cash' | 'upi' | 'card' | 'razorpay' | 'other';
  paymentMethodLabel?: string;
  status: 'pending' | 'processing' | 'verified' | 'failed' | 'refunded' | 'partial';
  initiatedBySource?: 'pos' | 'customer_qr' | string;
  upiUri?: string;
  customerUtrSubmitted?: string;
  transactionRef: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  collectedBy: string;
  verifiedBy?: string;
  verifiedAt?: string | null;
  refundedAmount?: number;
  refundReason?: string;
  refundedBy?: string;
  refundedAt?: string | null;
  notes: string;
  createdAt: string;
  orderNumber?: string;
  tableNumber?: string;
  customerName?: string;
}

export interface Order {
  id: number;
  restaurantId: number;
  orderNumber: string;
  tableId: number | null;
  tableNumber?: string | null;
  customerId: number | null;
  waiterId: number | null;
  customerName: string;
  customerPhone: string;
  orderType: 'dine_in' | 'takeaway' | 'parcel';
  source: 'pos' | 'qr';
  status:
    | 'New'
    | 'Accepted'
    | 'Preparing'
    | 'Ready'
    | 'Served'
    | 'Completed'
    | 'Paid'
    | 'Closed'
    | 'Cancelled';
  subtotal: number;
  discountAmount: number;
  promoCode: string;
  gstRateApplied: number;
  gstAmount: number;
  serviceChargeRateApplied: number;
  serviceChargeAmount: number;
  totalAmount: number;
  paidAmount: number;
  specialInstructions: string;
  cancelReason: string;
  cancelledBy: string;
  inventoryDeducted: boolean;
  createdAt: string;
  acceptedAt: string | null;
  preparingAt: string | null;
  readyAt: string | null;
  servedAt: string | null;
  paidAt: string | null;
  items: OrderItem[];
  payments?: PaymentRecord[];
}

export interface Supplier {
  id: number;
  name: string;
  contactPerson: string;
  phone: string;
  email: string;
  category: string;
  address: string;
}

export interface InventoryItem {
  id: number;
  supplierId: number | null;
  name: string;
  sku: string;
  category: string;
  unit: string;
  currentStock: number;
  reorderLevel: number;
  costPerUnit: number;
  lastRestockedAt: string;
}

export interface RecipeMapping {
  id: number;
  menuItemId: number;
  inventoryItemId: number;
  quantityRequired: number;
}

export interface StockMovement {
  id: number;
  inventoryItemId: number;
  movementType: 'purchase' | 'deduction' | 'wastage' | 'adjustment';
  quantityDelta: number;
  unitCost: number;
  referenceOrderId: number | null;
  notes: string;
  createdBy: string;
  createdAt: string;
}

export interface Expense {
  id: number;
  category: string;
  title: string;
  amount: number;
  expenseDate: string;
  paymentMethod: string;
  vendorName: string;
  description: string;
  receiptUrl: string;
  recordedBy: string;
}

export interface Customer {
  id: number;
  name: string;
  phone: string;
  email: string;
  visitCount: number;
  totalSpent: number;
  lastVisitAt: string;
  feedbackRating: number | null;
  feedbackComment: string;
  notes: string;
}

export interface StaffMember {
  id: number;
  restaurantId: number;
  name: string;
  email: string | null;
  phone: string | null;
  role: 'owner' | 'manager' | 'waiter' | 'kitchen';
  permissions: Record<string, boolean>;
  isActive: boolean;
  lastActiveAt: string | null;
}

export interface AuditLog {
  id: number;
  actorName: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface DashboardSummary {
  kpis: {
    todaysRevenue: number;
    rangeRevenue: number;
    totalOrders: number;
    averageOrderValue: number;
    activeTables: number;
    totalTables: number;
    pendingOrders: number;
    completedOrders: number;
    monthlyExpenses: number;
    estimatedProfit: number;
  };
  lowStockAlerts: InventoryItem[];
  bestSellingProducts: Array<{ name: string; qty: number; revenue: number }>;
  dailySeries: Array<{ date: string; label: string; revenue: number; expenses: number; orders: number }>;
  paymentMethods: Array<{ method: string; amount: number }>;
  recentTransactions: Array<PaymentRecord & { orderNumber: string; customerName: string }>;
}

export interface SecurityEventItem {
  id: number;
  restaurantId: number | null;
  severity: 'low' | 'medium' | 'high' | 'critical' | string;
  eventType: string;
  actorIdentifier: string;
  ipAddress: string;
  path: string;
  method: string;
  statusCode: number;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface UserSessionItem {
  id: number;
  sessionId: string;
  authType: string;
  staffId: number | null;
  role: string;
  actorName: string;
  ipAddress: string;
  expiresAt: string;
  revokedAt: string | null;
  lastSeenAt: string;
  createdAt: string;
}

export interface QrTokenHistoryItem {
  id: number;
  restaurantId: number;
  tableId: number;
  tokenDigest: string;
  tokenVersion: number;
  action: string;
  actorName: string;
  reason: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface StaffLockStatus {
  id: number;
  name: string;
  role: string;
  failedLoginAttempts: number;
  lockedUntil: string | null;
}

export interface SecurityOverviewPayload {
  events: SecurityEventItem[];
  sessions: UserSessionItem[];
  qrHistory: QrTokenHistoryItem[];
  staffLockStatus: StaffLockStatus[];
}

export interface CustomerQrPinState {
  verified: boolean;
  requiresPin: boolean;
  pinInvalidated: boolean;
  failedAttempts: number;
  maxAttempts: number;
  lockedUntil: string | null;
  lockRemainingSeconds: number;
}

export interface CustomerDiningSessionInfo {
  id: number;
  sessionUid: string;
  status: 'ACTIVE' | 'CLOSED';
  startedAt: string;
  billRequested: boolean;
  paymentStatus: 'unpaid' | 'initiated' | 'partial' | 'paid' | 'failed' | string;
}

export interface DiningSessionItem {
  id: number;
  sessionUid: string;
  restaurantId: number;
  tableId: number;
  status: 'ACTIVE' | 'CLOSED';
  pinVersion: number;
  pinGeneratedAt: string;
  pinLastRegeneratedAt: string | null;
  activePin?: string;
  billRequested: boolean;
  billRequestedAt: string | null;
  paymentStatus: 'unpaid' | 'initiated' | 'partial' | 'paid' | 'failed' | string;
  customerDeparted: boolean;
  departureConfirmedBy: string | null;
  departureConfirmedAt: string | null;
  closedBy: string | null;
  closedByRole: string | null;
  closeReason: string | null;
  isOverrideClose: boolean;
  startedAt: string;
  closedAt: string | null;
  orderCount: number;
  totalBill: number;
  paidTotal: number;
  latestOrderStatus: string | null;
  failedPinAttempts: number;
  activeCustomerDevices: number;
}

export interface DiningSessionPinHistoryItem {
  id: number;
  restaurantId: number;
  tableId: number;
  diningSessionId: number;
  pinVersion: number;
  pinDigest: string;
  action: string;
  actorName: string;
  actorRole: string;
  reason: string;
  createdAt: string;
}

export interface DiningSessionsOverviewPayload {
  canViewPins: boolean;
  canRegeneratePins: boolean;
  canCloseSessions: boolean;
  canOverrideClose: boolean;
  tables: Array<{
    id: number;
    tableNumber: string;
    section: string;
    capacity: number;
    status: TableStatus;
    assignedStaffId: number | null;
    activeSession: DiningSessionItem | null;
  }>;
  activeSessions: DiningSessionItem[];
  closedSessions: DiningSessionItem[];
  pinHistory: DiningSessionPinHistoryItem[];
  securityLogs: SecurityEventItem[];
}

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

export interface BillingSettingsRecord {
  id: number;
  restaurantId: number;
  activeTemplateId: number | null;
  upiId: string;
  upiPayeeName: string;
  customPaymentMethods: CustomPaymentMethod[];
  otherChargesLabel: string;
  otherChargesAmount: number;
  thankYouMessage: string;
  socialHandles: ReceiptSocialHandles;
  updatedBy: string;
  updatedAt: string;
}

export interface ReceiptTemplateRecord extends ReceiptTemplateSnapshot {
  id: number;
  restaurantId: number;
  isDefault: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReceiptRecord {
  id: number;
  receiptNumber: string;
  restaurantId: number;
  orderId: number | null;
  diningSessionId: number | null;
  paymentId: number | null;
  tableId: number | null;
  tableNumber: string;
  orderNumber: string;
  customerName: string;
  customerPhone: string;
  paymentMethod: string;
  paymentStatus: 'Pending' | 'Processing' | 'Paid' | 'Failed' | 'Refunded' | 'Partially Paid' | string;
  transactionId: string;
  subtotal: number;
  discountAmount: number;
  gstRateApplied: number;
  cgstAmount: number;
  sgstAmount: number;
  serviceChargeRateApplied: number;
  serviceChargeAmount: number;
  otherChargesLabel: string;
  otherChargesAmount: number;
  grandTotal: number;
  amountPaid: number;
  balanceDue: number;
  refundedAmount: number;
  refundReason: string;
  refundedAt: string | null;
  itemsSnapshot: ReceiptLineItemSnapshot[];
  restaurantSnapshot: {
    name: string;
    logoUrl?: string;
    address: string;
    city: string;
    state: string;
    phone: string;
    email: string;
    gstin: string;
    fssaiNo?: string;
  };
  templateSnapshot: ReceiptTemplateSnapshot;
  generatedBy: string;
  createdAt: string;
}

export interface CustomerBillPayload {
  restaurant: {
    id: number;
    name: string;
    logoUrl: string;
    address: string;
    phone: string;
    gstin: string;
    upiId: string;
    upiPayeeName: string;
    gstRate: number;
    serviceChargeRate: number;
  };
  table: { id: number; tableNumber: string; section: string } | null;
  diningSession: {
    id: number;
    sessionUid: string;
    status: string;
    billRequested: boolean;
    paymentStatus: string;
  };
  orderNumbers: string[];
  activeOrderIds: number[];
  items: ReceiptLineItemSnapshot[];
  summary: {
    subtotal: number;
    discountAmount: number;
    gstRateApplied: number;
    gstAmount: number;
    cgstAmount: number;
    sgstAmount: number;
    serviceChargeRateApplied: number;
    serviceChargeAmount: number;
    otherChargesLabel: string;
    otherChargesAmount: number;
    grandTotal: number;
    amountPaid: number;
    balanceDue: number;
  };
  acceptedMethods: string[];
  customMethods: CustomPaymentMethod[];
  payments: PaymentRecord[];
  pendingPayment: PaymentRecord | null;
  pendingUpiQrDataUrl: string;
  receipts: ReceiptRecord[];
}



