import React, { useEffect, useMemo, useState } from 'react';
import {
  CreditCard,
  Minus,
  Plus,
  Printer,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { apiFetch, createIdempotencyKey, formatInr } from '../lib/api';
import {
  MenuCategory,
  MenuItem,
  Order,
  PaymentRecord,
  ReceiptRecord,
  Restaurant,
  RestaurantTable,
} from '../types/dineflow';
import { DigitalReceiptModal } from './ReceiptDocument';

interface PosCartItem {
  menuItem: MenuItem;
  quantity: number;
  selectedVariantId?: string;
  selectedVariantName?: string;
  unitPrice: number;
  notes: string;
}

export const OrdersAndPosView: React.FC<{
  restaurant: Restaurant;
  refreshTick: number;
  initialPosTableId?: number | null;
  canCancelOrders: boolean;
  canManageBilling: boolean;
  onClearInitialTable?: () => void;
}> = ({
  restaurant,
  refreshTick,
  initialPosTableId,
  canCancelOrders,
  canManageBilling,
  onClearInitialTable,
}) => {
  const [orders, setOrders] = useState<Order[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [tables, setTables] = useState<RestaurantTable[]>([]);
  const [loading, setLoading] = useState(true);

  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'Paid' | 'Cancelled'>('all');
  const [searchTerm, setSearchTerm] = useState('');

  // POS Modal State
  const [showPos, setShowPos] = useState(Boolean(initialPosTableId));
  const [posOrderType, setPosOrderType] = useState<'dine_in' | 'takeaway' | 'parcel'>('dine_in');
  const [posTableId, setPosTableId] = useState<number | ''>(initialPosTableId || '');
  const [posCustomerName, setPosCustomerName] = useState('');
  const [posCustomerPhone, setPosCustomerPhone] = useState('');
  const [posPromo, setPosPromo] = useState('');
  const [posDiscount, setPosDiscount] = useState(0);
  const [posNotes, setPosNotes] = useState('');
  const [posCatId, setPosCatId] = useState<number | 'all'>('all');
  const [posSearch, setPosSearch] = useState('');
  const [posCart, setPosCart] = useState<PosCartItem[]>([]);
  const [posSubmitting, setPosSubmitting] = useState(false);
  const [posError, setPosError] = useState('');
  const [posIdempKey, setPosIdempKey] = useState(() => createIdempotencyKey());
  const [statusError, setStatusError] = useState('');

  // Billing & Razorpay Modal State
  const [billingOrder, setBillingOrder] = useState<Order | null>(null);
  const [payMethod, setPayMethod] = useState<'cash' | 'upi' | 'card' | 'razorpay'>('upi');
  const [payAmount, setPayAmount] = useState('');
  const [payRef, setPayRef] = useState('');
  const [paySubmitting, setPaySubmitting] = useState(false);
  const [payError, setPayError] = useState('');
  const [razorpayPending, setRazorpayPending] = useState<{
    paymentId: number;
    razorpayOrderId: string;
    amountInr: number;
  } | null>(null);

  // Receipt & Cancel Modals
  const [receiptOrder, setReceiptOrder] = useState<Order | null>(null);
  const [generatedReceipt, setGeneratedReceipt] = useState<ReceiptRecord | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Order | null>(null);
  const [cancelReason, setCancelReason] = useState('');

  const loadAll = async () => {
    try {
      const [ordRes, menuRes, tblRes] = await Promise.all([
        apiFetch<{ orders: Order[] }>('/orders'),
        apiFetch<{ categories: MenuCategory[]; items: MenuItem[] }>('/menu'),
        apiFetch<{ tables: RestaurantTable[] }>('/tables'),
      ]);
      setOrders(ordRes.orders);
      setCategories(menuRes.categories);
      setMenuItems(menuRes.items);
      setTables(tblRes.tables);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, [refreshTick]);

  useEffect(() => {
    if (initialPosTableId) {
      setPosOrderType('dine_in');
      setPosTableId(initialPosTableId);
      setShowPos(true);
      onClearInitialTable?.();
    }
  }, [initialPosTableId]);

  const filteredOrders = useMemo(() => {
    return orders.filter((o) => {
      if (statusFilter === 'active' && ['Paid', 'Closed', 'Cancelled'].includes(o.status)) return false;
      if (statusFilter === 'Paid' && !['Paid', 'Closed'].includes(o.status)) return false;
      if (statusFilter === 'Cancelled' && o.status !== 'Cancelled') return false;
      if (searchTerm.trim()) {
        const q = searchTerm.toLowerCase();
        const match =
          o.orderNumber.toLowerCase().includes(q) ||
          o.customerName.toLowerCase().includes(q) ||
          (o.tableNumber || '').toLowerCase().includes(q);
        if (!match) return false;
      }
      return true;
    });
  }, [orders, statusFilter, searchTerm]);

  const filteredMenu = useMemo(() => {
    return menuItems.filter((m) => {
      if (!m.isAvailable) return false;
      if (posCatId !== 'all' && m.categoryId !== posCatId) return false;
      if (posSearch.trim() && !m.name.toLowerCase().includes(posSearch.toLowerCase())) return false;
      return true;
    });
  }, [menuItems, posCatId, posSearch]);

  const addPosItem = (item: MenuItem) => {
    setPosIdempKey(createIdempotencyKey());
    setPosCart((prev) => {
      const idx = prev.findIndex((c) => c.menuItem.id === item.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], quantity: next[idx].quantity + 1 };
        return next;
      }
      return [
        ...prev,
        { menuItem: item, quantity: 1, unitPrice: item.price, notes: '' },
      ];
    });
  };

  const posTotals = useMemo(() => {
    const subtotal = posCart.reduce((s, c) => s + c.unitPrice * c.quantity, 0);
    const taxable = Math.max(0, subtotal - Number(posDiscount || 0));
    const gst = (taxable * restaurant.gstRate) / 100;
    const sc = (taxable * restaurant.serviceChargeRate) / 100;
    return {
      subtotal,
      gst,
      sc,
      total: taxable + gst + sc,
    };
  }, [posCart, posDiscount, restaurant]);

  const handleSubmitPos = async (e: React.FormEvent) => {
    e.preventDefault();
    if (posCart.length === 0) return;
    setPosError('');
    setPosSubmitting(true);
    try {
      await apiFetch('/orders', {
        method: 'POST',
        headers: {
          'x-idempotency-key': posIdempKey,
        },
        body: JSON.stringify({
          idempotencyKey: posIdempKey,
          orderType: posOrderType,
          tableId: posOrderType === 'dine_in' && posTableId ? Number(posTableId) : null,
          customerName: posCustomerName || 'Walk-in Guest',
          customerPhone: posCustomerPhone,
          promoCode: posPromo,
          manualDiscountAmount: Number(posDiscount) || 0,
          specialInstructions: posNotes,
          items: posCart.map((c) => ({
            menuItemId: c.menuItem.id,
            quantity: c.quantity,
            specialInstructions: c.notes,
          })),
        }),
      });
      setPosCart([]);
      setPosIdempKey(createIdempotencyKey());
      setPosCustomerName('');
      setPosCustomerPhone('');
      setPosPromo('');
      setPosDiscount(0);
      setPosNotes('');
      setShowPos(false);
      await loadAll();
    } catch (err: any) {
      setPosError(err.message || 'Failed to place POS order');
    } finally {
      setPosSubmitting(false);
    }
  };

  const updateStatus = async (orderId: number, status: string, reason?: string) => {
    setStatusError('');
    try {
      await apiFetch(`/orders/${orderId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status, reason }),
      });
      await loadAll();
    } catch (err: any) {
      setStatusError(err.message || 'Could not update order status');
    }
  };

  const openBilling = (ord: Order) => {
    const remaining = Math.max(0, Number((ord.totalAmount - ord.paidAmount).toFixed(2)));
    setBillingOrder(ord);
    setPayAmount(String(remaining));
    setPayMethod('upi');
    setPayRef('');
    setPayError('');
    setRazorpayPending(null);
  };

  const handleRecordPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!billingOrder) return;
    setPayError('');
    setPaySubmitting(true);
    try {
      if (payMethod === 'razorpay') {
        const res = await apiFetch<{
          paymentId: number;
          razorpayOrderId: string;
          amountInr: number;
        }>(`/orders/${billingOrder.id}/razorpay/create-order`, {
          method: 'POST',
          body: JSON.stringify({ amount: Number(payAmount) }),
        });
        setRazorpayPending(res);
      } else {
        const res = await apiFetch<{ payment: PaymentRecord; order: Order; receipt?: ReceiptRecord }>(
          `/orders/${billingOrder.id}/payments`,
          {
            method: 'POST',
            body: JSON.stringify({
              method: payMethod,
              amount: Number(payAmount),
              transactionRef: payRef,
            }),
          },
        );
        setBillingOrder(null);
        await loadAll();
        if (res.receipt) {
          setGeneratedReceipt(res.receipt);
        }
      }
    } catch (err: any) {
      setPayError(err.message || 'Payment failed');
    } finally {
      setPaySubmitting(false);
    }
  };

  const handleVerifyRazorpay = async (outcome: 'success' | 'fail') => {
    if (!billingOrder || !razorpayPending) return;
    setPaySubmitting(true);
    setPayError('');
    try {
      const res = await apiFetch<{ payment: PaymentRecord; order: Order; receipt?: ReceiptRecord }>(
        `/orders/${billingOrder.id}/razorpay/verify`,
        {
          method: 'POST',
          body: JSON.stringify({
            paymentId: razorpayPending.paymentId,
            razorpayOrderId: razorpayPending.razorpayOrderId,
            authorizeTestPayment: true,
            outcome,
          }),
        },
      );
      setRazorpayPending(null);
      setBillingOrder(null);
      await loadAll();
      if (res.receipt) {
        setGeneratedReceipt(res.receipt);
      }
    } catch (err: any) {
      setPayError(err.message || 'Razorpay verification failed');
      setRazorpayPending(null);
    } finally {
      setPaySubmitting(false);
    }
  };

  const nextActionLabel: Record<string, { label: string; next: string } | undefined> = {
    New: { label: 'Accept', next: 'Accepted' },
    Accepted: { label: 'Prepare', next: 'Preparing' },
    Preparing: { label: 'Ready', next: 'Ready' },
    Ready: { label: 'Serve', next: 'Served' },
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Orders, POS & Billing</h2>
          <p className="text-sm text-slate-500">
            Create dine-in, takeaway, or parcel tickets, track live lifecycle stages, settle split/GST bills, and print receipts.
          </p>
        </div>

        <button
          onClick={() => {
            setPosIdempKey(createIdempotencyKey());
            setShowPos(true);
          }}
          className="px-4 py-2 text-sm font-semibold bg-orange-600 hover:bg-orange-700 text-white rounded-lg flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
        >
          <Plus className="w-4 h-4" />
          New POS Order
        </button>
      </div>

      {statusError && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-xs font-medium px-4 py-2.5 rounded-lg flex items-center justify-between">
          <span>{statusError}</span>
          <button onClick={() => setStatusError('')} className="cursor-pointer">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-slate-100 border border-slate-200 rounded-lg">
          {[
            { id: 'all', label: 'All Orders' },
            { id: 'active', label: 'Active Queue' },
            { id: 'Paid', label: 'Paid / Closed' },
            { id: 'Cancelled', label: 'Cancelled' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setStatusFilter(tab.id as typeof statusFilter)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer whitespace-nowrap ${
                statusFilter === tab.id ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-72">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search order #, table, guest..."
            className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-slate-200 rounded-lg"
          />
        </div>
      </div>

      {/* Orders Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                <th className="py-3 px-4">Order</th>
                <th className="py-3 px-4">Type / Table</th>
                <th className="py-3 px-4">Items</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Total</th>
                <th className="py-3 px-4 text-right">Paid</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-slate-400">
                    Loading orders...
                  </td>
                </tr>
              ) : filteredOrders.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-slate-500">
                    No matching orders found.
                  </td>
                </tr>
              ) : (
                filteredOrders.map((ord) => {
                  const action = nextActionLabel[ord.status];
                  const balance = Math.max(0, ord.totalAmount - ord.paidAmount);
                  return (
                    <tr key={ord.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4">
                        <div className="font-mono-num font-bold text-slate-900">{ord.orderNumber}</div>
                        <div className="text-xs text-slate-500">
                          {ord.customerName} · {ord.source.toUpperCase()}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-xs">
                        <div className="font-medium text-slate-800">
                          {ord.tableNumber ? `Table ${ord.tableNumber}` : ord.orderType.toUpperCase()}
                        </div>
                        <div className="text-slate-500">
                          {new Date(ord.createdAt).toLocaleTimeString('en-IN', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600 max-w-xs truncate">
                        {ord.items.map((i) => `${i.quantity}× ${i.itemName}`).join(', ')}
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`text-xs font-semibold px-2 py-0.5 rounded border ${
                            ord.status === 'Paid' || ord.status === 'Closed'
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              : ord.status === 'Cancelled'
                              ? 'bg-red-50 text-red-700 border-red-200'
                              : 'bg-orange-50 text-orange-800 border-orange-200'
                          }`}
                        >
                          {ord.status}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right font-mono-num font-semibold text-slate-900">
                        {formatInr(ord.totalAmount)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono-num text-xs">
                        <span className={balance <= 0.5 ? 'text-emerald-700 font-semibold' : 'text-amber-700'}>
                          {formatInr(ord.paidAmount)}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {action && (
                            <button
                              onClick={() => updateStatus(ord.id, action.next)}
                              className="px-2.5 py-1 text-xs font-medium bg-slate-900 text-white rounded hover:bg-slate-800 cursor-pointer"
                            >
                              {action.label}
                            </button>
                          )}
                          {canManageBilling &&
                            ord.status !== 'Cancelled' &&
                            balance > 0.5 && (
                              <button
                                onClick={() => openBilling(ord)}
                                className="px-2.5 py-1 text-xs font-medium bg-orange-600 text-white rounded hover:bg-orange-700 flex items-center gap-1 cursor-pointer"
                              >
                                <CreditCard className="w-3 h-3" /> Collect
                              </button>
                            )}
                          <button
                            onClick={() => setReceiptOrder(ord)}
                            title="Print GST Receipt"
                            className="p-1.5 text-slate-500 hover:text-slate-900 border border-slate-200 rounded cursor-pointer"
                          >
                            <Printer className="w-3.5 h-3.5" />
                          </button>
                          {canCancelOrders &&
                            !['Paid', 'Closed', 'Cancelled'].includes(ord.status) && (
                              <button
                                onClick={() => {
                                  setCancelTarget(ord);
                                  setCancelReason('');
                                }}
                                title="Cancel Order"
                                className="p-1.5 text-slate-400 hover:text-red-600 border border-slate-200 rounded cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* POS Order Builder Modal */}
      {showPos && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-5xl rounded-2xl max-h-[92vh] flex flex-col overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900">POS Order Terminal</h3>
              <button onClick={() => setShowPos(false)} className="cursor-pointer">
                <X className="w-5 h-5 text-slate-500" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto grid grid-cols-1 lg:grid-cols-12">
              {/* Left: Menu Selection */}
              <div className="lg:col-span-7 p-5 border-b lg:border-b-0 lg:border-r border-slate-200 space-y-4">
                <div className="flex flex-wrap gap-2">
                  <input
                    value={posSearch}
                    onChange={(e) => setPosSearch(e.target.value)}
                    placeholder="Search dishes..."
                    className="flex-1 min-w-[180px] px-3 py-2 text-sm border border-slate-200 rounded-lg"
                  />
                  <select
                    value={posCatId}
                    onChange={(e) =>
                      setPosCatId(e.target.value === 'all' ? 'all' : Number(e.target.value))
                    }
                    className="px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    <option value="all">All Categories</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[55vh] overflow-y-auto pr-1">
                  {filteredMenu.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => addPosItem(item)}
                      className="text-left p-3 border border-slate-200 hover:border-orange-500 rounded-xl transition-colors flex items-center justify-between gap-2 cursor-pointer"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-900 truncate">
                          {item.name}
                        </div>
                        <div className="text-xs text-slate-500">
                          {item.isVeg ? 'Veg' : 'Non-Veg'} · {item.prepTimeMins}m
                        </div>
                      </div>
                      <span className="font-mono-num text-sm font-bold text-orange-600 shrink-0">
                        {formatInr(item.price)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Right: Order Cart & Details */}
              <form onSubmit={handleSubmitPos} className="lg:col-span-5 p-5 flex flex-col justify-between space-y-4">
                <div className="space-y-3">
                  <div className="grid grid-cols-3 gap-1 p-1 bg-slate-100 rounded-lg">
                    {(['dine_in', 'takeaway', 'parcel'] as const).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setPosOrderType(t)}
                        className={`py-1.5 text-xs font-medium rounded-md cursor-pointer ${
                          posOrderType === t ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                        }`}
                      >
                        {t === 'dine_in' ? 'Dine-In' : t === 'takeaway' ? 'Takeaway' : 'Parcel'}
                      </button>
                    ))}
                  </div>

                  {posOrderType === 'dine_in' && (
                    <select
                      required
                      value={posTableId}
                      onChange={(e) => setPosTableId(e.target.value ? Number(e.target.value) : '')}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="">Select Table...</option>
                      {tables.map((t) => (
                        <option key={t.id} value={t.id}>
                          Table {t.tableNumber} ({t.section} · {t.status})
                        </option>
                      ))}
                    </select>
                  )}

                  <div className="grid grid-cols-2 gap-2">
                    <input
                      value={posCustomerName}
                      onChange={(e) => setPosCustomerName(e.target.value)}
                      placeholder="Guest Name"
                      className="px-3 py-2 text-sm border border-slate-200 rounded-lg"
                    />
                    <input
                      value={posCustomerPhone}
                      onChange={(e) => setPosCustomerPhone(e.target.value)}
                      placeholder="Phone"
                      className="px-3 py-2 text-sm border border-slate-200 rounded-lg"
                    />
                  </div>

                  <div className="max-h-44 overflow-y-auto divide-y divide-slate-100 border border-slate-200 rounded-xl px-3">
                    {posCart.length === 0 ? (
                      <div className="py-6 text-center text-xs text-slate-400">
                        Select dishes on the left to build ticket.
                      </div>
                    ) : (
                      posCart.map((c) => (
                        <div key={c.menuItem.id} className="py-2 flex items-center justify-between gap-2 text-sm">
                          <span className="truncate font-medium text-slate-800">
                            {c.menuItem.name}
                          </span>
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              type="button"
                              onClick={() =>
                                setPosCart((prev) =>
                                  prev
                                    .map((p) =>
                                      p.menuItem.id === c.menuItem.id
                                        ? { ...p, quantity: p.quantity - 1 }
                                        : p,
                                    )
                                    .filter((p) => p.quantity > 0),
                                )
                              }
                              className="p-1 border border-slate-200 rounded cursor-pointer"
                            >
                              <Minus className="w-3 h-3" />
                            </button>
                            <span className="font-mono-num text-xs font-bold">{c.quantity}</span>
                            <button
                              type="button"
                              onClick={() => addPosItem(c.menuItem)}
                              className="p-1 border border-slate-200 rounded cursor-pointer"
                            >
                              <Plus className="w-3 h-3" />
                            </button>
                            <span className="font-mono-num text-xs w-14 text-right">
                              {formatInr(c.unitPrice * c.quantity)}
                            </span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <input
                      value={posPromo}
                      onChange={(e) => setPosPromo(e.target.value.toUpperCase())}
                      placeholder="Promo Code"
                      className="px-3 py-2 text-xs font-mono-num border border-slate-200 rounded-lg"
                    />
                    <input
                      type="number"
                      min={0}
                      value={posDiscount || ''}
                      onChange={(e) => setPosDiscount(Number(e.target.value))}
                      placeholder="Manual Discount ₹"
                      className="px-3 py-2 text-xs font-mono-num border border-slate-200 rounded-lg"
                    />
                  </div>
                  <input
                    value={posNotes}
                    onChange={(e) => setPosNotes(e.target.value)}
                    placeholder="Kitchen instructions..."
                    className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg"
                  />
                </div>

                <div className="space-y-3 pt-2 border-t border-slate-200">
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between text-slate-600">
                      <span>Subtotal</span>
                      <span className="font-mono-num">{formatInr(posTotals.subtotal)}</span>
                    </div>
                    <div className="flex justify-between text-slate-600">
                      <span>GST ({restaurant.gstRate}%) + Service ({restaurant.serviceChargeRate}%)</span>
                      <span className="font-mono-num">{formatInr(posTotals.gst + posTotals.sc)}</span>
                    </div>
                    <div className="flex justify-between text-sm font-bold text-slate-900 pt-1">
                      <span>Estimated Bill</span>
                      <span className="font-mono-num">{formatInr(posTotals.total)}</span>
                    </div>
                  </div>
                  {posError && <p className="text-xs text-red-600">{posError}</p>}
                  <button
                    type="submit"
                    disabled={posSubmitting || posCart.length === 0}
                    className="w-full py-2.5 text-sm font-semibold bg-orange-600 hover:bg-orange-700 text-white rounded-xl cursor-pointer disabled:opacity-50"
                  >
                    {posSubmitting ? 'Creating Order...' : 'Fire Order to Kitchen'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Billing & Payment Checkout Modal (Cash, UPI, Card, Split & Razorpay Test Mode) */}
      {billingOrder && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-md rounded-2xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  Settle Bill · {billingOrder.orderNumber}
                </h3>
                <p className="text-xs text-slate-500">
                  Total {formatInr(billingOrder.totalAmount)} · Paid {formatInr(billingOrder.paidAmount)} · Balance{' '}
                  <span className="font-mono-num font-bold text-slate-900">
                    {formatInr(Math.max(0, billingOrder.totalAmount - billingOrder.paidAmount))}
                  </span>
                </p>
              </div>
              <button onClick={() => setBillingOrder(null)} className="cursor-pointer">
                <X className="w-5 h-5 text-slate-500" />
              </button>
            </div>

            {razorpayPending ? (
              <div className="border border-slate-200 rounded-xl p-4 space-y-4 bg-slate-50">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-700">
                    Razorpay Test Checkout
                  </span>
                  <ShieldCheck className="w-4 h-4 text-emerald-600" />
                </div>
                <div className="text-sm text-slate-700 space-y-1">
                  <div>
                    Order Ref:{' '}
                    <span className="font-mono-num font-semibold">{razorpayPending.razorpayOrderId}</span>
                  </div>
                  <div>
                    Payable:{' '}
                    <span className="font-mono-num font-bold text-slate-900">
                      {formatInr(razorpayPending.amountInr)}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 pt-1">
                    Payment record is currently pending in PostgreSQL. Server HMAC verification is required to mark it paid.
                  </p>
                </div>

                {payError && <p className="text-xs text-red-600">{payError}</p>}

                <div className="grid grid-cols-2 gap-2">
                  <button
                    disabled={paySubmitting}
                    onClick={() => handleVerifyRazorpay('fail')}
                    className="py-2.5 text-xs font-semibold border border-red-200 text-red-700 bg-white hover:bg-red-50 rounded-lg cursor-pointer"
                  >
                    Simulate Declined
                  </button>
                  <button
                    disabled={paySubmitting}
                    onClick={() => handleVerifyRazorpay('success')}
                    className="py-2.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg cursor-pointer"
                  >
                    {paySubmitting ? 'Verifying...' : 'Authorize & Verify'}
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleRecordPayment} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Payment Method
                  </label>
                  <div className="grid grid-cols-4 gap-1.5">
                    {(['upi', 'cash', 'card', 'razorpay'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setPayMethod(m)}
                        className={`py-2 text-xs font-semibold rounded-lg border uppercase cursor-pointer ${
                          payMethod === m
                            ? 'bg-orange-600 text-white border-orange-600'
                            : 'bg-white text-slate-700 border-slate-200'
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Amount to Collect (Supports Partial / Split)
                  </label>
                  <input
                    required
                    type="number"
                    step="0.01"
                    min="1"
                    value={payAmount}
                    onChange={(e) => setPayAmount(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono-num border border-slate-300 rounded-lg"
                  />
                </div>

                {payMethod !== 'razorpay' && (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Transaction / UTR Reference (Optional)
                    </label>
                    <input
                      value={payRef}
                      onChange={(e) => setPayRef(e.target.value)}
                      placeholder="e.g. UPI Ref 41928371"
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                )}

                {payError && <p className="text-xs text-red-600">{payError}</p>}

                <button
                  type="submit"
                  disabled={paySubmitting}
                  className="w-full py-2.5 text-sm font-semibold bg-slate-900 hover:bg-slate-800 text-white rounded-xl cursor-pointer"
                >
                  {payMethod === 'razorpay' ? 'Launch Razorpay Test Checkout' : 'Record Payment'}
                </button>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Printable GST Thermal Receipt Modal */}
      {receiptOrder && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-sm rounded-2xl p-6 space-y-4">
            <div className="flex items-center justify-between no-print">
              <h3 className="text-sm font-bold text-slate-900">Tax Invoice / Receipt</h3>
              <button onClick={() => setReceiptOrder(null)} className="cursor-pointer">
                <X className="w-5 h-5 text-slate-500" />
              </button>
            </div>

            <div className="border border-slate-200 rounded-xl p-4 font-mono-num text-xs space-y-3 bg-white">
              <div className="text-center space-y-0.5 border-b border-dashed border-slate-300 pb-3">
                <div className="text-sm font-bold text-slate-900">{restaurant.name}</div>
                <div className="text-[11px] text-slate-600">{restaurant.address}, {restaurant.city}</div>
                {restaurant.gstin && <div className="text-[11px] text-slate-600">GSTIN: {restaurant.gstin}</div>}
                {restaurant.receiptHeader && <div className="text-[11px] text-slate-500">{restaurant.receiptHeader}</div>}
              </div>

              <div className="flex justify-between text-[11px] text-slate-600">
                <span>Bill: {receiptOrder.orderNumber}</span>
                <span>{receiptOrder.tableNumber ? `Table ${receiptOrder.tableNumber}` : receiptOrder.orderType}</span>
              </div>

              <div className="border-t border-b border-dashed border-slate-300 py-2 space-y-1.5">
                {receiptOrder.items.map((it) => (
                  <div key={it.id} className="flex justify-between gap-2">
                    <span className="truncate">
                      {it.quantity}× {it.itemName}
                    </span>
                    <span className="shrink-0">{formatInr(it.itemTotal)}</span>
                  </div>
                ))}
              </div>

              <div className="space-y-1 text-[11px]">
                <div className="flex justify-between">
                  <span>Subtotal</span>
                  <span>{formatInr(receiptOrder.subtotal)}</span>
                </div>
                {receiptOrder.discountAmount > 0 && (
                  <div className="flex justify-between text-emerald-700">
                    <span>Discount {receiptOrder.promoCode}</span>
                    <span>-{formatInr(receiptOrder.discountAmount)}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span>CGST ({receiptOrder.gstRateApplied / 2}%)</span>
                  <span>{formatInr(receiptOrder.gstAmount / 2)}</span>
                </div>
                <div className="flex justify-between">
                  <span>SGST ({receiptOrder.gstRateApplied / 2}%)</span>
                  <span>{formatInr(receiptOrder.gstAmount / 2)}</span>
                </div>
                {receiptOrder.serviceChargeAmount > 0 && (
                  <div className="flex justify-between">
                    <span>Service Charge ({receiptOrder.serviceChargeRateApplied}%)</span>
                    <span>{formatInr(receiptOrder.serviceChargeAmount)}</span>
                  </div>
                )}
                <div className="flex justify-between text-sm font-bold text-slate-900 pt-1 border-t border-slate-200">
                  <span>Grand Total</span>
                  <span>{formatInr(receiptOrder.totalAmount)}</span>
                </div>
                <div className="flex justify-between text-[11px] text-slate-600">
                  <span>Paid</span>
                  <span>{formatInr(receiptOrder.paidAmount)}</span>
                </div>
              </div>

              <div className="text-center text-[10px] text-slate-500 pt-2 border-t border-dashed border-slate-300">
                {restaurant.receiptFooter}
              </div>
            </div>

            <button
              onClick={() => window.print()}
              className="w-full py-2.5 text-sm font-semibold bg-slate-900 text-white rounded-xl flex items-center justify-center gap-2 no-print cursor-pointer"
            >
              <Printer className="w-4 h-4" />
              Print Receipt
            </button>
          </div>
        </div>
      )}

      {generatedReceipt && (
        <DigitalReceiptModal
          receipt={generatedReceipt}
          onClose={() => setGeneratedReceipt(null)}
        />
      )}

      {/* Cancel Order Confirmation Modal */}
      {cancelTarget && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-md rounded-2xl p-6 space-y-4">
            <h3 className="text-base font-bold text-slate-900">
              Cancel Order {cancelTarget.orderNumber}?
            </h3>
            <p className="text-sm text-slate-600">
              This action updates the kitchen queue and releases any assigned table.
            </p>
            <input
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Reason for cancellation..."
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setCancelTarget(null)}
                className="px-4 py-2 text-sm text-slate-600 cursor-pointer"
              >
                Keep Order
              </button>
              <button
                onClick={async () => {
                  await updateStatus(cancelTarget.id, 'Cancelled', cancelReason || 'Cancelled by manager');
                  setCancelTarget(null);
                }}
                className="px-4 py-2 text-sm font-semibold bg-red-600 text-white rounded-lg cursor-pointer"
              >
                Confirm Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
