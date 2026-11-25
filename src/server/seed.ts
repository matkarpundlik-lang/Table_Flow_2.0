import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  auditLogs,
  customers,
  expenses,
  inventoryItems,
  menuCategories,
  menuItemRecipes,
  menuItems,
  orderItems,
  orders,
  payments,
  platformPlans,
  platformSettings,
  promotionalOffers,
  qrTokenHistory,
  restaurantTables,
  restaurants,
  serviceRequests,
  staffMembers,
  stockMovements,
  suppliers,
} from '../db/schema.ts';
import {
  QR_TOKEN_TTL_DAYS,
  generateSecureQrToken,
  hashPin,
  hashTokenSha256,
  isCryptographicQrToken,
} from './security.ts';
import { DEFAULT_ROLE_PERMISSIONS } from './middleware.ts';

let seedPromise: Promise<void> | null = null;

export async function ensureSeedData(): Promise<void> {
  if (!seedPromise) {
    seedPromise = (async () => {
      await runSeed();
      await ensureSecureQrTokens();
    })().catch((err) => {
      seedPromise = null;
      throw err;
    });
  }
  return seedPromise;
}

async function ensureSecureQrTokens() {
  const allTables = await db.select().from(restaurantTables);
  const defaultExpiry = new Date(Date.now() + QR_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  for (const tbl of allTables) {
    const needsTokenUpgrade = !isCryptographicQrToken(tbl.qrToken);
    const needsExpiry = !tbl.qrExpiresAt;
    if (!needsTokenUpgrade && !needsExpiry) continue;

    const newToken = needsTokenUpgrade ? generateSecureQrToken() : tbl.qrToken;
    const nextVersion = needsTokenUpgrade ? (tbl.qrTokenVersion || 1) + 1 : tbl.qrTokenVersion || 1;
    const nextExpiry = tbl.qrExpiresAt || defaultExpiry;

    await db
      .update(restaurantTables)
      .set({
        qrToken: newToken,
        qrTokenVersion: nextVersion,
        qrExpiresAt: nextExpiry,
      })
      .where(eq(restaurantTables.id, tbl.id));

    if (needsTokenUpgrade) {
      await db.insert(qrTokenHistory).values({
        restaurantId: tbl.restaurantId,
        tableId: tbl.id,
        tokenHash: hashTokenSha256(newToken),
        tokenVersion: nextVersion,
        action: 'migrated',
        actorName: 'Security Upgrade',
        reason: 'Upgraded legacy predictable table token to cryptographically random QR token',
        expiresAt: nextExpiry,
      });
    }
  }
}

async function runSeed() {
  const existingPlans = await db.select({ id: platformPlans.id }).from(platformPlans).limit(1);
  if (existingPlans.length > 0) {
    return;
  }

  // 1. Platform Plans & Settings
  const insertedPlans = await db
    .insert(platformPlans)
    .values([
      {
        name: 'Starter Outlet',
        code: 'STARTER',
        monthlyPriceInr: 1499,
        maxTables: 15,
        maxStaff: 10,
        features: ['POS & Takeaway', 'Table QR Ordering', 'GST Billing', 'Basic Reports'],
      },
      {
        name: 'Growth Kitchen',
        code: 'GROWTH',
        monthlyPriceInr: 2999,
        maxTables: 45,
        maxStaff: 30,
        features: ['Everything in Starter', 'Live Kitchen Display (KDS)', 'Recipe Inventory', 'Expense & P&L Analytics'],
      },
      {
        name: 'Enterprise Group',
        code: 'ENTERPRISE',
        monthlyPriceInr: 5999,
        maxTables: 150,
        maxStaff: 120,
        features: ['Multi-Outlet Sync', 'Custom Role Permissions', 'Priority Support', 'API & Razorpay Webhooks'],
      },
    ])
    .returning();

  const growthPlan = insertedPlans[1];
  const starterPlan = insertedPlans[0];

  await db.insert(platformSettings).values({
    platformName: 'DineFlow',
    supportEmail: 'support@dineflow.in',
    defaultGstRate: 5,
    maintenanceMode: false,
    allowSelfRegistration: true,
  });

  // 2. Restaurant A: Spice Route Kitchen (Bengaluru)
  const [spiceRoute] = await db
    .insert(restaurants)
    .values({
      name: 'Spice Route Kitchen',
      slug: 'spice-route-kitchen',
      tagline: 'Modern North & Coastal Indian Dining',
      cuisineType: 'Indian Contemporary',
      address: '100 Feet Road, HAL 2nd Stage, Indiranagar',
      city: 'Bengaluru',
      state: 'Karnataka',
      phone: '+91 80 4123 8910',
      email: 'hello@spiceroutekitchen.in',
      gstin: '29AABCS1429B1Z5',
      fssaiNo: '11223331000452',
      openingHours: '11:30 AM - 11:30 PM',
      gstRate: 5,
      serviceChargeRate: 5,
      receiptHeader: 'Spice Route Kitchen · Indiranagar',
      receiptFooter: 'Thank you for dining with us! GSTIN: 29AABCS1429B1Z5',
      soundAlertsEnabled: true,
      qrOrderingEnabled: true,
      autoAcceptQrOrders: false,
      planId: growthPlan.id,
      subscriptionStatus: 'active',
      isActive: true,
      ownerUid: 'seed-owner-spice',
    })
    .returning();

  // Restaurant A Staff (PINs: 1111 Manager, 2222 Waiter, 3333 Kitchen)
  const pin1111 = hashPin('1111');
  const pin2222 = hashPin('2222');
  const pin3333 = hashPin('3333');
  const spiceStaff = await db
    .insert(staffMembers)
    .values([
      {
        restaurantId: spiceRoute.id,
        name: 'Ananya Sharma',
        email: 'ananya@spiceroutekitchen.in',
        phone: '+91 98450 11223',
        role: 'manager',
        pinHash: pin1111.hash,
        pinSalt: pin1111.salt,
        permissions: DEFAULT_ROLE_PERMISSIONS.manager,
        lastActiveAt: new Date(),
      },
      {
        restaurantId: spiceRoute.id,
        name: 'Rohan Verma',
        email: 'rohan@spiceroutekitchen.in',
        phone: '+91 98450 22334',
        role: 'waiter',
        pinHash: pin2222.hash,
        pinSalt: pin2222.salt,
        permissions: DEFAULT_ROLE_PERMISSIONS.waiter,
        lastActiveAt: new Date(),
      },
      {
        restaurantId: spiceRoute.id,
        name: 'Chef Vikram Rao',
        email: 'vikram@spiceroutekitchen.in',
        phone: '+91 98450 33445',
        role: 'kitchen',
        pinHash: pin3333.hash,
        pinSalt: pin3333.salt,
        permissions: DEFAULT_ROLE_PERMISSIONS.kitchen,
        lastActiveAt: new Date(),
      },
    ])
    .returning();

  const spiceWaiter = spiceStaff[1];

  // Restaurant A Categories & Menu
  const spiceCats = await db
    .insert(menuCategories)
    .values([
      { restaurantId: spiceRoute.id, name: 'Tandoor & Starters', description: 'Charcoal-grilled kebabs & small plates', sortOrder: 1 },
      { restaurantId: spiceRoute.id, name: 'Signature Curries', description: 'Slow-simmered gravies & coastal specials', sortOrder: 2 },
      { restaurantId: spiceRoute.id, name: 'South Classics & Breads', description: 'Artisan dosas, naans & biryanis', sortOrder: 3 },
      { restaurantId: spiceRoute.id, name: 'Drinks & Combos', description: 'Coolers & value meals', sortOrder: 4 },
    ])
    .returning();

  const spiceItems = await db
    .insert(menuItems)
    .values([
      {
        restaurantId: spiceRoute.id,
        categoryId: spiceCats[1].id,
        name: 'Old Delhi Butter Chicken',
        description: 'Tandoor-roasted chicken tikka simmered in velvety tomato-fenugreek makhani gravy.',
        price: 445,
        isVeg: false,
        imageUrl: '/src/assets/images/dish_butter_chicken_1795292950397.jpg',
        prepTimeMins: 18,
        variants: [
          { id: 'v_regular', name: 'Regular Portion', priceDelta: 0 },
          { id: 'v_family', name: 'Family Bowl', priceDelta: 220 },
        ],
        addons: [
          { id: 'a_naan', name: 'Garlic Butter Naan', price: 85 },
          { id: 'a_butter', name: 'Extra White Butter', price: 45 },
        ],
        isFeatured: true,
      },
      {
        restaurantId: spiceRoute.id,
        categoryId: spiceCats[0].id,
        name: 'Smoky Tandoori Paneer Tikka',
        description: 'Cottage cheese cubes marinated in hung curd, Kashmiri chili & ajwain, roasted over charcoal.',
        price: 365,
        isVeg: true,
        imageUrl: '/src/assets/images/dish_paneer_tikka_1795292950363.jpg',
        prepTimeMins: 14,
        variants: [
          { id: 'v_classic', name: 'Classic Malai', priceDelta: 0 },
          { id: 'v_achari', name: 'Achari Spice', priceDelta: 25 },
        ],
        addons: [
          { id: 'a_chutney', name: 'Extra Mint Chutney', price: 30 },
          { id: 'a_laccha', name: 'Masala Laccha Onion', price: 35 },
        ],
        isFeatured: true,
      },
      {
        restaurantId: spiceRoute.id,
        categoryId: spiceCats[2].id,
        name: 'Coastal Ghee Masala Dosa',
        description: 'Crisp fermented rice crepe brushed with pure cow ghee, spiced potato mash & three chutneys.',
        price: 225,
        isVeg: true,
        imageUrl: '/src/assets/images/dish_masala_dosa_1795292950456.jpg',
        prepTimeMins: 10,
        variants: [
          { id: 'v_classic', name: 'Classic Crisp', priceDelta: 0 },
          { id: 'v_podi', name: 'Mysore Podi Roast', priceDelta: 40 },
        ],
        addons: [
          { id: 'a_sambar', name: 'Extra Drumstick Sambar', price: 40 },
          { id: 'a_coffee', name: 'Mini Filter Coffee', price: 75 },
        ],
        isFeatured: true,
      },
      {
        restaurantId: spiceRoute.id,
        categoryId: spiceCats[1].id,
        name: '24-Hour Dal Makhani',
        description: 'Black urad lentils slow-cooked overnight with tomato puree, cream, and charred butter.',
        price: 345,
        isVeg: true,
        imageUrl: '',
        prepTimeMins: 12,
        variants: [{ id: 'v_std', name: 'Standard Bowl', priceDelta: 0 }],
        addons: [{ id: 'a_jeera', name: 'Jeera Rice Side', price: 110 }],
      },
      {
        restaurantId: spiceRoute.id,
        categoryId: spiceCats[2].id,
        name: 'Blistered Garlic Butter Naan',
        description: 'Hand-stretched sourdough leavened flatbread baked in clay tandoor with roasted garlic.',
        price: 85,
        isVeg: true,
        imageUrl: '',
        prepTimeMins: 6,
        variants: [],
        addons: [{ id: 'a_cheese', name: 'Cheddar Stuffing', price: 55 }],
      },
      {
        restaurantId: spiceRoute.id,
        categoryId: spiceCats[3].id,
        name: 'Indiranagar Family Feast Combo',
        description: 'Butter Chicken + Paneer Tikka + 2 Garlic Naans + 2 Masala Chaas coolers.',
        price: 1149,
        isVeg: false,
        imageUrl: '/src/assets/images/dish_butter_chicken_1795292950397.jpg',
        prepTimeMins: 22,
        variants: [],
        addons: [],
        isCombo: true,
        comboDetails: 'Serves 3-4 guests · Save ₹215 vs individual items',
      },
      {
        restaurantId: spiceRoute.id,
        categoryId: spiceCats[3].id,
        name: 'Smoked Jeera Masala Chaas',
        description: 'Chilled churned buttermilk tempered with roasted cumin, curry leaves, and black salt.',
        price: 95,
        isVeg: true,
        imageUrl: '',
        prepTimeMins: 4,
        variants: [],
        addons: [],
      },
    ])
    .returning();

  // Offers for Restaurant A
  await db.insert(promotionalOffers).values([
    {
      restaurantId: spiceRoute.id,
      title: '10% Off Dine-In Feast',
      code: 'SPICE10',
      discountType: 'percent',
      discountValue: 10,
      minOrderAmount: 500,
      maxDiscount: 250,
      usageCount: 14,
    },
    {
      restaurantId: spiceRoute.id,
      title: '₹100 Flat Welcome Discount',
      code: 'WELCOME100',
      discountType: 'flat',
      discountValue: 100,
      minOrderAmount: 799,
      maxDiscount: 100,
      usageCount: 6,
    },
  ]);

  // Tables for Restaurant A
  const defaultQrExpiry = new Date(Date.now() + QR_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  const spiceTables = await db
    .insert(restaurantTables)
    .values([
      { restaurantId: spiceRoute.id, tableNumber: 'T-01', section: 'Main Dining', capacity: 4, status: 'Preparing', assignedStaffId: spiceWaiter.id, qrToken: generateSecureQrToken(), qrExpiresAt: defaultQrExpiry },
      { restaurantId: spiceRoute.id, tableNumber: 'T-02', section: 'Main Dining', capacity: 2, status: 'Available', assignedStaffId: spiceWaiter.id, qrToken: generateSecureQrToken(), qrExpiresAt: defaultQrExpiry },
      { restaurantId: spiceRoute.id, tableNumber: 'T-03', section: 'Main Dining', capacity: 6, status: 'Ordering', assignedStaffId: spiceWaiter.id, qrToken: generateSecureQrToken(), qrExpiresAt: defaultQrExpiry },
      { restaurantId: spiceRoute.id, tableNumber: 'T-04', section: 'Main Dining', capacity: 4, status: 'Served', assignedStaffId: spiceWaiter.id, qrToken: generateSecureQrToken(), qrExpiresAt: defaultQrExpiry },
      { restaurantId: spiceRoute.id, tableNumber: 'P-01', section: 'Courtyard Patio', capacity: 4, status: 'Available', assignedStaffId: spiceWaiter.id, qrToken: generateSecureQrToken(), qrExpiresAt: defaultQrExpiry },
      { restaurantId: spiceRoute.id, tableNumber: 'P-02', section: 'Courtyard Patio', capacity: 6, status: 'Billing', assignedStaffId: spiceWaiter.id, qrToken: generateSecureQrToken(), qrExpiresAt: defaultQrExpiry },
      { restaurantId: spiceRoute.id, tableNumber: 'L-01', section: 'AC Lounge', capacity: 8, status: 'Available', assignedStaffId: spiceWaiter.id, qrToken: generateSecureQrToken(), qrExpiresAt: defaultQrExpiry },
    ])
    .returning();

  // Suppliers & Inventory for Restaurant A
  const spiceSuppliers = await db
    .insert(suppliers)
    .values([
      { restaurantId: spiceRoute.id, name: 'Namma Fresh Poultry & Dairy', contactPerson: 'Suresh Gowda', phone: '+91 99001 44551', category: 'Protein & Dairy', address: 'KR Market, Bengaluru' },
      { restaurantId: spiceRoute.id, name: 'Deccan Spice & Grains Co.', contactPerson: 'Farhan Ali', phone: '+91 99001 88772', category: 'Spices & Staples', address: 'Yeshwanthpur APMC, Bengaluru' },
    ])
    .returning();

  const spiceInv = await db
    .insert(inventoryItems)
    .values([
      { restaurantId: spiceRoute.id, supplierId: spiceSuppliers[0].id, name: 'Boneless Chicken Tikka Cut', sku: 'ING-CHK-01', category: 'Proteins', unit: 'kg', currentStock: 18.5, reorderLevel: 6, costPerUnit: 290 },
      { restaurantId: spiceRoute.id, supplierId: spiceSuppliers[0].id, name: 'Malai Fresh Paneer', sku: 'ING-PNR-02', category: 'Dairy', unit: 'kg', currentStock: 4.2, reorderLevel: 5, costPerUnit: 380 }, // Low stock alert!
      { restaurantId: spiceRoute.id, supplierId: spiceSuppliers[0].id, name: 'Cultured Cooking Butter', sku: 'ING-BTR-03', category: 'Dairy', unit: 'kg', currentStock: 9.0, reorderLevel: 4, costPerUnit: 520 },
      { restaurantId: spiceRoute.id, supplierId: spiceSuppliers[1].id, name: 'Dosa Batter Fermented', sku: 'ING-DOS-04', category: 'Prepared Base', unit: 'ltr', currentStock: 3.5, reorderLevel: 5, costPerUnit: 85 }, // Low stock alert!
      { restaurantId: spiceRoute.id, supplierId: spiceSuppliers[1].id, name: 'Refined Wheat Flour (Maida)', sku: 'ING-FLR-05', category: 'Dry Staples', unit: 'kg', currentStock: 32, reorderLevel: 10, costPerUnit: 48 },
    ])
    .returning();

  // Recipe Mapping for Restaurant A
  await db.insert(menuItemRecipes).values([
    { restaurantId: spiceRoute.id, menuItemId: spiceItems[0].id, inventoryItemId: spiceInv[0].id, quantityRequired: 0.25 },
    { restaurantId: spiceRoute.id, menuItemId: spiceItems[0].id, inventoryItemId: spiceInv[2].id, quantityRequired: 0.06 },
    { restaurantId: spiceRoute.id, menuItemId: spiceItems[1].id, inventoryItemId: spiceInv[1].id, quantityRequired: 0.22 },
    { restaurantId: spiceRoute.id, menuItemId: spiceItems[2].id, inventoryItemId: spiceInv[3].id, quantityRequired: 0.2 },
    { restaurantId: spiceRoute.id, menuItemId: spiceItems[4].id, inventoryItemId: spiceInv[4].id, quantityRequired: 0.12 },
  ]);

  await db.insert(stockMovements).values([
    { restaurantId: spiceRoute.id, inventoryItemId: spiceInv[0].id, movementType: 'purchase', quantityDelta: 20, unitCost: 290, notes: 'Morning poultry delivery #PO-881', createdBy: 'Ananya Sharma' },
    { restaurantId: spiceRoute.id, inventoryItemId: spiceInv[1].id, movementType: 'wastage', quantityDelta: -0.8, unitCost: 380, notes: 'Trimming & chiller expiry check', createdBy: 'Chef Vikram Rao' },
  ]);

  // Customers for Restaurant A
  const spiceCustomers = await db
    .insert(customers)
    .values([
      { restaurantId: spiceRoute.id, name: 'Arjun Deshmukh', phone: '+91 98801 55412', email: 'arjun.d@example.in', visitCount: 6, totalSpent: 7840, feedbackRating: 5, feedbackComment: 'Butter chicken and garlic naan were stellar.' },
      { restaurantId: spiceRoute.id, name: 'Priya Nair', phone: '+91 98451 66789', email: 'priya.nair@example.in', visitCount: 3, totalSpent: 3190, feedbackRating: 4, feedbackComment: 'Quick QR ordering on the patio.' },
      { restaurantId: spiceRoute.id, name: 'Siddharth Rao', phone: '+91 99160 11902', email: 'sid.rao@example.in', visitCount: 2, totalSpent: 2450, feedbackRating: 5, feedbackComment: 'Loved the ghee masala dosa.' },
    ])
    .returning();

  // Historical + Active Orders for Restaurant A (across last 6 days + today for charts)
  const now = new Date();
  const daysAgo = (d: number, hour = 13) => {
    const dt = new Date(now);
    dt.setDate(dt.getDate() - d);
    dt.setHours(hour, 15, 0, 0);
    return dt;
  };

  const historicalSpecs = [
    { num: 'SR-1001', day: 5, hour: 13, total: 1480, method: 'upi', cust: spiceCustomers[0], item: spiceItems[0], qty: 2 },
    { num: 'SR-1002', day: 4, hour: 20, total: 1920, method: 'card', cust: spiceCustomers[1], item: spiceItems[5], qty: 1 },
    { num: 'SR-1003', day: 3, hour: 14, total: 1120, method: 'cash', cust: spiceCustomers[2], item: spiceItems[1], qty: 2 },
    { num: 'SR-1004', day: 2, hour: 21, total: 2640, method: 'razorpay', cust: spiceCustomers[0], item: spiceItems[0], qty: 3 },
    { num: 'SR-1005', day: 1, hour: 19, total: 1750, method: 'upi', cust: spiceCustomers[1], item: spiceItems[2], qty: 4 },
    { num: 'SR-1006', day: 0, hour: 12, total: 1386, method: 'upi', cust: spiceCustomers[0], item: spiceItems[0], qty: 2 },
    { num: 'SR-1007', day: 0, hour: 13, total: 913, method: 'card', cust: spiceCustomers[2], item: spiceItems[1], qty: 2 },
  ];

  for (const spec of historicalSpecs) {
    const createdAt = daysAgo(spec.day, spec.hour);
    const sub = Number((spec.total / 1.1).toFixed(2));
    const gst = Number((sub * 0.05).toFixed(2));
    const sc = Number((spec.total - sub - gst).toFixed(2));

    const [ord] = await db
      .insert(orders)
      .values({
        restaurantId: spiceRoute.id,
        orderNumber: spec.num,
        tableId: spiceTables[1].id,
        customerId: spec.cust.id,
        waiterId: spiceWaiter.id,
        customerName: spec.cust.name,
        customerPhone: spec.cust.phone,
        orderType: 'dine_in',
        source: 'pos',
        status: 'Paid',
        subtotal: sub,
        discountAmount: 0,
        gstRateApplied: 5,
        gstAmount: gst,
        serviceChargeRateApplied: 5,
        serviceChargeAmount: sc,
        totalAmount: spec.total,
        paidAmount: spec.total,
        inventoryDeducted: true,
        acceptedAt: createdAt,
        preparingAt: createdAt,
        readyAt: createdAt,
        servedAt: createdAt,
        paidAt: createdAt,
        createdAt,
        updatedAt: createdAt,
      })
      .returning();

    await db.insert(orderItems).values({
      restaurantId: spiceRoute.id,
      orderId: ord.id,
      menuItemId: spec.item.id,
      itemName: spec.item.name,
      unitPrice: Number((sub / spec.qty).toFixed(2)),
      quantity: spec.qty,
      status: 'Served',
      itemTotal: sub,
      createdAt,
    });

    await db.insert(payments).values({
      restaurantId: spiceRoute.id,
      orderId: ord.id,
      amount: spec.total,
      method: spec.method,
      status: 'verified',
      transactionRef: `${spec.method.toUpperCase()}-${spec.num}`,
      collectedBy: 'Rohan Verma',
      createdAt,
    });
  }

  // Active live orders for Spice Route Kitchen (so KDS, Table Floor, & Waiter start alive!)
  const [liveOrd1] = await db
    .insert(orders)
    .values({
      restaurantId: spiceRoute.id,
      orderNumber: 'SR-1008',
      tableId: spiceTables[0].id, // T-01 Preparing
      waiterId: spiceWaiter.id,
      customerName: 'Table T-01 Guest',
      orderType: 'dine_in',
      source: 'qr',
      status: 'Preparing',
      subtotal: 895,
      gstRateApplied: 5,
      gstAmount: 44.75,
      serviceChargeRateApplied: 5,
      serviceChargeAmount: 44.75,
      totalAmount: 984.5,
      specialInstructions: 'Less spicy paneer, extra crispy naan',
      inventoryDeducted: true,
      acceptedAt: new Date(Date.now() - 8 * 60000),
      preparingAt: new Date(Date.now() - 6 * 60000),
    })
    .returning();

  await db.insert(orderItems).values([
    {
      restaurantId: spiceRoute.id,
      orderId: liveOrd1.id,
      menuItemId: spiceItems[0].id,
      itemName: spiceItems[0].name,
      unitPrice: 445,
      quantity: 1,
      selectedVariant: { id: 'v_regular', name: 'Regular Portion', priceDelta: 0 },
      selectedAddons: [{ id: 'a_naan', name: 'Garlic Butter Naan', price: 85 }],
      status: 'Preparing',
      itemTotal: 530,
    },
    {
      restaurantId: spiceRoute.id,
      orderId: liveOrd1.id,
      menuItemId: spiceItems[1].id,
      itemName: spiceItems[1].name,
      unitPrice: 365,
      quantity: 1,
      specialInstructions: 'Less chili',
      status: 'Queued',
      itemTotal: 365,
    },
  ]);

  const [liveOrd2] = await db
    .insert(orders)
    .values({
      restaurantId: spiceRoute.id,
      orderNumber: 'SR-1009',
      tableId: spiceTables[2].id, // T-03 Ordering (New)
      waiterId: spiceWaiter.id,
      customerName: 'Kavita & Group',
      orderType: 'dine_in',
      source: 'qr',
      status: 'New',
      subtotal: 450,
      gstRateApplied: 5,
      gstAmount: 22.5,
      serviceChargeRateApplied: 5,
      serviceChargeAmount: 22.5,
      totalAmount: 495,
      inventoryDeducted: false,
    })
    .returning();

  await db.insert(orderItems).values([
    {
      restaurantId: spiceRoute.id,
      orderId: liveOrd2.id,
      menuItemId: spiceItems[2].id,
      itemName: spiceItems[2].name,
      unitPrice: 225,
      quantity: 2,
      status: 'Queued',
      itemTotal: 450,
    },
  ]);

  const [liveOrd3] = await db
    .insert(orders)
    .values({
      restaurantId: spiceRoute.id,
      orderNumber: 'SR-1010',
      tableId: spiceTables[5].id, // P-02 Billing (Served)
      waiterId: spiceWaiter.id,
      customerName: 'Vikramjit Singh',
      orderType: 'dine_in',
      source: 'pos',
      status: 'Served',
      subtotal: 1149,
      gstRateApplied: 5,
      gstAmount: 57.45,
      serviceChargeRateApplied: 5,
      serviceChargeAmount: 57.45,
      totalAmount: 1263.9,
      inventoryDeducted: true,
      acceptedAt: new Date(Date.now() - 35 * 60000),
      preparingAt: new Date(Date.now() - 30 * 60000),
      readyAt: new Date(Date.now() - 18 * 60000),
      servedAt: new Date(Date.now() - 15 * 60000),
    })
    .returning();

  await db.insert(orderItems).values([
    {
      restaurantId: spiceRoute.id,
      orderId: liveOrd3.id,
      menuItemId: spiceItems[5].id,
      itemName: spiceItems[5].name,
      unitPrice: 1149,
      quantity: 1,
      status: 'Served',
      itemTotal: 1149,
    },
  ]);

  await db.insert(serviceRequests).values({
    restaurantId: spiceRoute.id,
    tableId: spiceTables[5].id,
    requestType: 'bill',
    note: 'Please bring card machine or UPI QR',
    status: 'pending',
  });

  // Expenses for Restaurant A
  const todayStr = now.toISOString().slice(0, 10);
  const twoDaysAgoStr = daysAgo(2).toISOString().slice(0, 10);
  const fiveDaysAgoStr = daysAgo(5).toISOString().slice(0, 10);

  await db.insert(expenses).values([
    { restaurantId: spiceRoute.id, category: 'Raw Materials', title: 'Fresh Poultry & Dairy Weekly Supply', amount: 14200, expenseDate: twoDaysAgoStr, paymentMethod: 'upi', vendorName: 'Namma Fresh Poultry & Dairy', description: 'Invoice #NF-9912', recordedBy: 'Ananya Sharma' },
    { restaurantId: spiceRoute.id, category: 'Utilities', title: 'BESCOM Commercial Electricity Bill', amount: 8450, expenseDate: fiveDaysAgoStr, paymentMethod: 'bank_transfer', vendorName: 'BESCOM', description: 'Monthly kitchen & AC meter', recordedBy: 'Ananya Sharma' },
    { restaurantId: spiceRoute.id, category: 'Marketing', title: 'Local Food Walk Promo Flyers', amount: 2100, expenseDate: todayStr, paymentMethod: 'cash', vendorName: 'Indiranagar Print Hub', description: 'Table QR tent cards & standees', recordedBy: 'Ananya Sharma' },
  ]);

  // 3. Restaurant B: Filter & Crumb Café (Mumbai) — Completely isolated second tenant!
  const [filterCrumb] = await db
    .insert(restaurants)
    .values({
      name: 'Filter & Crumb Café',
      slug: 'filter-and-crumb',
      tagline: 'Single-Origin Filter Coffee & Artisanal Bakes',
      cuisineType: 'Specialty Café & Tiffins',
      address: 'Pali Hill, Bandra West',
      city: 'Mumbai',
      state: 'Maharashtra',
      phone: '+91 22 2600 7744',
      email: 'team@filterandcrumb.in',
      gstin: '27AABCF8821K1Z2',
      fssaiNo: '11523011000899',
      openingHours: '08:00 AM - 10:30 PM',
      gstRate: 5,
      serviceChargeRate: 0,
      receiptHeader: 'Filter & Crumb Café · Pali Hill',
      receiptFooter: 'Brewed fresh daily · GSTIN 27AABCF8821K1Z2',
      soundAlertsEnabled: true,
      qrOrderingEnabled: true,
      autoAcceptQrOrders: true,
      planId: starterPlan.id,
      subscriptionStatus: 'active',
      isActive: true,
      ownerUid: 'seed-owner-filter',
    })
    .returning();

  const pin4444 = hashPin('4444');
  const pin5555 = hashPin('5555');
  const pin6666 = hashPin('6666');
  const filterStaff = await db
    .insert(staffMembers)
    .values([
      { restaurantId: filterCrumb.id, name: 'Kabir Mehta', email: 'kabir@filterandcrumb.in', role: 'manager', pinHash: pin4444.hash, pinSalt: pin4444.salt, permissions: DEFAULT_ROLE_PERMISSIONS.manager },
      { restaurantId: filterCrumb.id, name: 'Meera Nair', email: 'meera@filterandcrumb.in', role: 'waiter', pinHash: pin5555.hash, pinSalt: pin5555.salt, permissions: DEFAULT_ROLE_PERMISSIONS.waiter },
      { restaurantId: filterCrumb.id, name: 'Chef Dev Kulkarni', email: 'dev@filterandcrumb.in', role: 'kitchen', pinHash: pin6666.hash, pinSalt: pin6666.salt, permissions: DEFAULT_ROLE_PERMISSIONS.kitchen },
    ])
    .returning();

  const filterCats = await db
    .insert(menuCategories)
    .values([
      { restaurantId: filterCrumb.id, name: 'Specialty Coffee', description: 'Chikmagalur estate brews & brass davara filter coffee', sortOrder: 1 },
      { restaurantId: filterCrumb.id, name: 'All-Day Sourdough', description: 'Wild-fermented tartines & bakes', sortOrder: 2 },
      { restaurantId: filterCrumb.id, name: 'Tiffins & Combos', description: 'Crisp dosas & morning pairings', sortOrder: 3 },
    ])
    .returning();

  const filterItems = await db
    .insert(menuItems)
    .values([
      {
        restaurantId: filterCrumb.id,
        categoryId: filterCats[0].id,
        name: 'Brass Davara Filter Coffee',
        description: '80:20 Chikmagalur Arabica-chicory decoction whisked with farm-fresh frothy milk.',
        price: 145,
        isVeg: true,
        imageUrl: '/src/assets/images/dish_filter_coffee_1795292950410.jpg',
        prepTimeMins: 5,
        variants: [
          { id: 'v_reg', name: 'Classic Brass Cup', priceDelta: 0 },
          { id: 'v_strong', name: 'Double Decoction', priceDelta: 30 },
        ],
        addons: [{ id: 'a_oat', name: 'Oat Milk Swap', price: 45 }],
        isFeatured: true,
      },
      {
        restaurantId: filterCrumb.id,
        categoryId: filterCats[1].id,
        name: 'Chili Crisp Avocado Sourdough',
        description: 'Country sourdough toast with smashed Hass avocado, sesame chili oil & microgreens.',
        price: 385,
        isVeg: true,
        imageUrl: '/src/assets/images/dish_avocado_toast_1795292950417.jpg',
        prepTimeMins: 10,
        variants: [],
        addons: [{ id: 'a_feta', name: 'Whipped Feta', price: 65 }],
        isFeatured: true,
      },
      {
        restaurantId: filterCrumb.id,
        categoryId: filterCats[2].id,
        name: 'Bandra Morning Dosa & Coffee Combo',
        description: 'Golden masala dosa paired with our signature brass davara filter coffee.',
        price: 310,
        isVeg: true,
        imageUrl: '/src/assets/images/dish_masala_dosa_1795292950456.jpg',
        prepTimeMins: 12,
        variants: [],
        addons: [],
        isCombo: true,
        comboDetails: 'Includes 1 Masala Dosa + 1 Filter Coffee',
      },
    ])
    .returning();

  const filterTables = await db
    .insert(restaurantTables)
    .values([
      { restaurantId: filterCrumb.id, tableNumber: 'C-01', section: 'Indoor Bar', capacity: 2, status: 'Occupied', assignedStaffId: filterStaff[1].id, qrToken: generateSecureQrToken(), qrExpiresAt: defaultQrExpiry },
      { restaurantId: filterCrumb.id, tableNumber: 'C-02', section: 'Indoor Bar', capacity: 4, status: 'Available', assignedStaffId: filterStaff[1].id, qrToken: generateSecureQrToken(), qrExpiresAt: defaultQrExpiry },
      { restaurantId: filterCrumb.id, tableNumber: 'CP-01', section: 'Bandra Verandah', capacity: 4, status: 'Available', assignedStaffId: filterStaff[1].id, qrToken: generateSecureQrToken(), qrExpiresAt: defaultQrExpiry },
    ])
    .returning();

  await db.insert(promotionalOffers).values({
    restaurantId: filterCrumb.id,
    title: '15% Off Morning Brews',
    code: 'BREW15',
    discountType: 'percent',
    discountValue: 15,
    minOrderAmount: 300,
    maxDiscount: 150,
  });

  const filterInv = await db
    .insert(inventoryItems)
    .values([
      { restaurantId: filterCrumb.id, name: 'Chikmagalur Roast Beans', sku: 'FC-COF-01', category: 'Beverages', unit: 'kg', currentStock: 12, reorderLevel: 4, costPerUnit: 820 },
      { restaurantId: filterCrumb.id, name: 'Hass Avocados', sku: 'FC-AVO-02', category: 'Produce', unit: 'pcs', currentStock: 14, reorderLevel: 15, costPerUnit: 95 },
    ])
    .returning();

  await db.insert(menuItemRecipes).values([
    { restaurantId: filterCrumb.id, menuItemId: filterItems[0].id, inventoryItemId: filterInv[0].id, quantityRequired: 0.025 },
    { restaurantId: filterCrumb.id, menuItemId: filterItems[1].id, inventoryItemId: filterInv[1].id, quantityRequired: 1 },
  ]);

  const [filterOrd] = await db
    .insert(orders)
    .values({
      restaurantId: filterCrumb.id,
      orderNumber: 'FC-2001',
      tableId: filterTables[0].id,
      waiterId: filterStaff[1].id,
      customerName: 'Rhea Kapoor',
      orderType: 'dine_in',
      source: 'qr',
      status: 'Paid',
      subtotal: 530,
      gstRateApplied: 5,
      gstAmount: 26.5,
      serviceChargeRateApplied: 0,
      serviceChargeAmount: 0,
      totalAmount: 556.5,
      paidAmount: 556.5,
      inventoryDeducted: true,
      paidAt: daysAgo(0, 10),
      createdAt: daysAgo(0, 10),
    })
    .returning();

  await db.insert(orderItems).values({
    restaurantId: filterCrumb.id,
    orderId: filterOrd.id,
    menuItemId: filterItems[1].id,
    itemName: filterItems[1].name,
    unitPrice: 385,
    quantity: 1,
    status: 'Served',
    itemTotal: 385,
  });

  await db.insert(payments).values({
    restaurantId: filterCrumb.id,
    orderId: filterOrd.id,
    amount: 556.5,
    method: 'upi',
    status: 'verified',
    transactionRef: 'UPI-FC2001',
    collectedBy: 'Meera Nair',
  });

  await db.insert(expenses).values({
    restaurantId: filterCrumb.id,
    category: 'Raw Materials',
    title: 'Single Origin Coffee Roast Batch',
    amount: 6400,
    expenseDate: todayStr,
    paymentMethod: 'bank_transfer',
    vendorName: 'Blue Hills Estate',
    recordedBy: 'Kabir Mehta',
  });

  await db.insert(customers).values({
    restaurantId: filterCrumb.id,
    name: 'Rhea Kapoor',
    phone: '+91 98201 44312',
    visitCount: 4,
    totalSpent: 2140,
    feedbackRating: 5,
    feedbackComment: 'Best filter coffee in Bandra.',
  });

  await db.insert(auditLogs).values({
    restaurantId: spiceRoute.id,
    actorName: 'System',
    actorRole: 'system',
    action: 'TENANT_INITIALIZED',
    entityType: 'restaurant',
    entityId: String(spiceRoute.id),
    details: { slug: spiceRoute.slug },
  });

  // Reset Postgres serial sequences cleanly
  await db.execute(sql`SELECT setval(pg_get_serial_sequence('restaurants', 'id'), COALESCE((SELECT MAX(id) FROM restaurants), 1))`);
}
