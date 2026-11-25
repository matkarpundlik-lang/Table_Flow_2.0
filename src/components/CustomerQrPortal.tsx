import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Bell,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  CreditCard,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  KeyRound,
  Lock,
  Minus,
  Plus,
  QrCode,
  Receipt,
  Search,
  ShieldCheck,
  ShoppingBag,
  Smartphone,
  Star,
  Utensils,
  Wallet,
  X,
} from 'lucide-react';
import { apiFetch, createIdempotencyKey, formatInr } from '../lib/api';
import { downloadReceiptPdf } from '../lib/receiptPdf';
import {
  CustomerBillPayload,
  CustomerDiningSessionInfo,
  CustomerQrPinState,
  MenuAddon,
  MenuCategory,
  MenuItem,
  MenuVariant,
  Order,
  PaymentRecord,
  PromotionalOffer,
  ReceiptRecord,
  RestaurantTable,
} from '../types/dineflow';
import { DigitalReceiptModal } from './ReceiptDocument';

interface QrPayload {
  sessionToken: string;
  diningSession: CustomerDiningSessionInfo;
  pinState: CustomerQrPinState;
  restaurant: {
    id: number;
    name: string;
    tagline: string;
    cuisineType: string;
    city: string;
    gstRate: number;
    serviceChargeRate: number;
    openingHours: string;
  };
  table: RestaurantTable;
  categories: MenuCategory[];
  items: MenuItem[];
  offers: PromotionalOffer[];
  activeOrders: Order[];
}

interface CartEntry {
  key: string;
  menuItem: MenuItem;
  quantity: number;
  selectedVariant: MenuVariant | null;
  selectedAddons: MenuAddon[];
  specialInstructions: string;
  unitPrice: number;
}

export const CustomerQrPortal: React.FC<{
  qrToken: string;
  onExit: () => void;
}> = ({ qrToken, onExit }) => {
  const [data, setData] = useState<QrPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [activeCategoryId, setActiveCategoryId] = useState<number | 'all'>('all');
  const [vegOnly, setVegOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const [customizingItem, setCustomizingItem] = useState<MenuItem | null>(null);
  const [chosenVariant, setChosenVariant] = useState<MenuVariant | null>(null);
  const [chosenAddons, setChosenAddons] = useState<MenuAddon[]>([]);
  const [itemNotes, setItemNotes] = useState('');
  const [itemQty, setItemQty] = useState(1);

  const [cart, setCart] = useState<CartEntry[]>([]);
  const [showCartSheet, setShowCartSheet] = useState(false);
  const [showTrackerSheet, setShowTrackerSheet] = useState(false);
  const [guestName, setGuestName] = useState('');
  const [guestPhone, setGuestPhone] = useState('');
  const [orderNotes, setOrderNotes] = useState('');
  const [promoCode, setPromoCode] = useState('');
  const [submittingOrder, setSubmittingOrder] = useState(false);

  const [toastMsg, setToastMsg] = useState('');
  const [showFeedbackModal, setShowFeedbackModal] = useState(false);
  const [rating, setRating] = useState(5);
  const [feedbackComment, setFeedbackComment] = useState('');

  const [draftIdempotencyKey, setDraftIdempotencyKey] = useState(() => createIdempotencyKey());
  const [showPinModal, setShowPinModal] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [showPinDigits, setShowPinDigits] = useState(false);
  const [verifyingPin, setVerifyingPin] = useState(false);
  const [pinError, setPinError] = useState('');
  const [lockSeconds, setLockSeconds] = useState(0);

  // Customer Payment & Digital Receipt State
  const [showPaySheet, setShowPaySheet] = useState(false);
  const [billData, setBillData] = useState<CustomerBillPayload | null>(null);
  const [loadingBill, setLoadingBill] = useState(false);
  const [payStep, setPayStep] = useState<'summary' | 'methods'>('summary');
  const [selectedPayMethod, setSelectedPayMethod] = useState<string>('upi');
  const [activePayTx, setActivePayTx] = useState<PaymentRecord | null>(null);
  const [upiQrDataUrl, setUpiQrDataUrl] = useState('');
  const [upiUri, setUpiUri] = useState('');
  const [utrInput, setUtrInput] = useState('');
  const [copiedUpi, setCopiedUpi] = useState(false);
  const [payBusy, setPayBusy] = useState(false);
  const [payError, setPayError] = useState('');
  const [payIdempKey, setPayIdempKey] = useState(() => createIdempotencyKey());
  const [activeReceipt, setActiveReceipt] = useState<ReceiptRecord | null>(null);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(''), 3500);
  };

  const loadBill = async (sessionTokenOverride?: string) => {
    const token = sessionTokenOverride || data?.sessionToken;
    if (!token) return;
    setLoadingBill(true);
    try {
      const bill = await apiFetch<CustomerBillPayload>(`/qr/${encodeURIComponent(qrToken)}/bill`, {
        headers: { 'x-qr-session': token },
      });
      setBillData(bill);
      if (bill.pendingPayment) {
        setActivePayTx(bill.pendingPayment);
        setSelectedPayMethod(bill.pendingPayment.method);
        if (bill.pendingPayment.upiUri) setUpiUri(bill.pendingPayment.upiUri);
        if (bill.pendingUpiQrDataUrl) setUpiQrDataUrl(bill.pendingUpiQrDataUrl);
      } else {
        setActivePayTx(null);
      }
    } catch {
      // ignore background bill sync errors
    } finally {
      setLoadingBill(false);
    }
  };

  const loadMenu = async (existingSessionToken?: string) => {
    try {
      const tokenToSend = existingSessionToken || data?.sessionToken;
      const res = await apiFetch<QrPayload>(`/qr/${encodeURIComponent(qrToken)}`, {
        headers: tokenToSend ? { 'x-qr-session': tokenToSend } : undefined,
      });
      setData(res);
      setLockSeconds(res.pinState?.lockRemainingSeconds || 0);
      setError('');
      await loadBill(res.sessionToken);
    } catch (err: any) {
      setError(err.message || 'Unable to load table menu');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    setData(null);
    loadMenu();
  }, [qrToken]);

  useEffect(() => {
    if (lockSeconds <= 0) return;
    const timer = setInterval(() => {
      setLockSeconds((prev) => (prev > 1 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [lockSeconds]);

  useEffect(() => {
    if (!data?.sessionToken) return;
    const token = data.sessionToken;
    const es = new EventSource(
      `/api/qr/${encodeURIComponent(qrToken)}/stream?session=${encodeURIComponent(token)}`,
    );
    const refresh = () => loadMenu(token);
    const onPaymentOrReceipt = (evt: MessageEvent) => {
      loadMenu(token);
      try {
        const parsed = JSON.parse(evt.data);
        if (parsed?.receipt && parsed?.payment?.status === 'verified') {
          setActiveReceipt(parsed.receipt);
          showToast('Payment verified! Your digital receipt is ready.');
        } else if (parsed?.receipt && evt.type === 'receipt:created') {
          setActiveReceipt(parsed.receipt);
        }
      } catch {
        // ignore parse failure
      }
    };
    es.addEventListener('order:created', refresh);
    es.addEventListener('order:updated', refresh);
    es.addEventListener('menu:updated', refresh);
    es.addEventListener('table:updated', refresh);
    es.addEventListener('dining_session:updated', refresh);
    es.addEventListener('payment:updated', onPaymentOrReceipt);
    es.addEventListener('receipt:created', onPaymentOrReceipt);
    return () => {
      es.close();
    };
  }, [qrToken, data?.sessionToken]);

  const filteredItems = useMemo(() => {
    if (!data) return [];
    return data.items.filter((item) => {
      if (activeCategoryId !== 'all' && item.categoryId !== activeCategoryId) return false;
      if (vegOnly && !item.isVeg) return false;
      if (
        searchQuery.trim() &&
        !item.name.toLowerCase().includes(searchQuery.toLowerCase()) &&
        !item.description.toLowerCase().includes(searchQuery.toLowerCase())
      ) {
        return false;
      }
      return true;
    });
  }, [data, activeCategoryId, vegOnly, searchQuery]);

  const openCustomizer = (item: MenuItem) => {
    setCustomizingItem(item);
    setChosenVariant(item.variants?.[0] || null);
    setChosenAddons([]);
    setItemNotes('');
    setItemQty(1);
  };

  const addToCart = () => {
    if (!customizingItem) return;
    const addonTotal = chosenAddons.reduce((s, a) => s + a.price, 0);
    const variantDelta = chosenVariant ? chosenVariant.priceDelta : 0;
    const unitPrice = customizingItem.price + variantDelta + addonTotal;
    const key = `${customizingItem.id}-${chosenVariant?.id || 'std'}-${chosenAddons.map((a) => a.id).sort().join(',')}-${itemNotes}`;

    setCart((prev) => {
      const idx = prev.findIndex((c) => c.key === key);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], quantity: next[idx].quantity + itemQty };
        return next;
      }
      return [
        ...prev,
        {
          key,
          menuItem: customizingItem,
          quantity: itemQty,
          selectedVariant: chosenVariant,
          selectedAddons: chosenAddons,
          specialInstructions: itemNotes,
          unitPrice,
        },
      ];
    });
    setCustomizingItem(null);
    setDraftIdempotencyKey(createIdempotencyKey());
    showToast(`Added ${customizingItem.name} to cart`);
  };

  const updateCartQty = (key: string, delta: number) => {
    setDraftIdempotencyKey(createIdempotencyKey());
    setCart((prev) =>
      prev
        .map((c) => (c.key === key ? { ...c, quantity: c.quantity + delta } : c))
        .filter((c) => c.quantity > 0),
    );
  };

  const cartSummary = useMemo(() => {
    const count = cart.reduce((s, c) => s + c.quantity, 0);
    const subtotal = cart.reduce((s, c) => s + c.unitPrice * c.quantity, 0);
    const gstRate = data?.restaurant.gstRate ?? 5;
    const scRate = data?.restaurant.serviceChargeRate ?? 0;
    const gst = (subtotal * gstRate) / 100;
    const sc = (subtotal * scRate) / 100;
    return {
      count,
      subtotal,
      gst,
      sc,
      estimatedTotal: subtotal + gst + sc,
    };
  }, [cart, data]);

  const executeOrderWithToken = async (orderAuthToken: string) => {
    if (!data || cart.length === 0) return;
    await apiFetch(`/qr/${encodeURIComponent(qrToken)}/orders`, {
      method: 'POST',
      headers: {
        'x-qr-session': data.sessionToken,
        'x-idempotency-key': draftIdempotencyKey,
        'x-order-auth-token': orderAuthToken,
      },
      body: JSON.stringify({
        idempotencyKey: draftIdempotencyKey,
        orderAuthToken,
        customerName: guestName || `Table ${data.table.tableNumber} Guest`,
        customerPhone: guestPhone,
        promoCode: promoCode.trim(),
        specialInstructions: orderNotes,
        items: cart.map((c) => ({
          menuItemId: c.menuItem.id,
          quantity: c.quantity,
          selectedVariantId: c.selectedVariant?.id,
          selectedAddonIds: c.selectedAddons.map((a) => a.id),
          specialInstructions: c.specialInstructions,
        })),
      }),
    });
    setCart([]);
    setDraftIdempotencyKey(createIdempotencyKey());
    setShowCartSheet(false);
    setShowTrackerSheet(true);
    await loadMenu(data.sessionToken);
    showToast('Order sent to kitchen!');
  };

  const requestOrderAuthRaw = async () => {
    if (!data) throw new Error('Session unavailable');
    const res = await fetch(`/api/qr/${encodeURIComponent(qrToken)}/order-auth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-qr-session': data.sessionToken,
      },
      body: JSON.stringify({}),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(payload?.error || 'Could not authorize order') as Error & {
        status?: number;
        requiresPin?: boolean;
        pinInvalidated?: boolean;
      };
      err.status = res.status;
      err.requiresPin = Boolean(payload?.requiresPin);
      err.pinInvalidated = Boolean(payload?.pinInvalidated);
      throw err;
    }
    return payload as { orderAuthToken: string };
  };

  const submitQrOrder = async () => {
    if (!data || cart.length === 0) return;
    setPinError('');
    if (!data.pinState?.verified) {
      setPinInput('');
      setShowPinModal(true);
      return;
    }

    setSubmittingOrder(true);
    try {
      const { orderAuthToken } = await requestOrderAuthRaw();
      await executeOrderWithToken(orderAuthToken);
    } catch (err: any) {
      if (err?.requiresPin || err?.pinInvalidated) {
        setData((prev) =>
          prev
            ? { ...prev, pinState: { ...prev.pinState, verified: false, requiresPin: true } }
            : prev,
        );
        setPinError(err.message || 'Please ask your waiter for the 3-digit security PIN.');
        setPinInput('');
        setShowPinModal(true);
      } else if (err?.status === 401) {
        setShowCartSheet(false);
        setError(err.message || 'Your ordering session has expired. Please scan the table QR code again.');
      } else {
        showToast(err.message || 'Could not place order');
      }
    } finally {
      setSubmittingOrder(false);
    }
  };

  const handleVerifyPinAndPlaceOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!data) return;
    if (!/^\d{3}$/.test(pinInput)) {
      setPinError('Enter the 3-digit numeric security PIN from your waiter.');
      return;
    }
    setPinError('');
    setVerifyingPin(true);
    try {
      const res = await fetch(`/api/qr/${encodeURIComponent(qrToken)}/verify-pin`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-qr-session': data.sessionToken,
        },
        body: JSON.stringify({ pin: pinInput }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (payload?.lockRemainingSeconds) {
          setLockSeconds(Number(payload.lockRemainingSeconds));
        }
        if (res.status === 401 && String(payload?.error || '').includes('scan the table QR')) {
          setShowPinModal(false);
          setShowCartSheet(false);
          setError(payload.error);
          return;
        }
        setPinError(payload?.error || 'Incorrect security PIN. Please ask your waiter for the latest code.');
        setPinInput('');
        return;
      }

      setPinInput('');
      setLockSeconds(0);
      setData((prev) =>
        prev
          ? {
              ...prev,
              pinState: { ...prev.pinState, verified: true, requiresPin: false, failedAttempts: 0 },
            }
          : prev,
      );
      setShowPinModal(false);
      showToast(payload?.message || 'PIN verified. You can now place your order.');

      setSubmittingOrder(true);
      try {
        await executeOrderWithToken(payload.orderAuthToken);
      } finally {
        setSubmittingOrder(false);
      }
    } catch (err: any) {
      setPinError(err.message || 'Failed to verify security PIN');
    } finally {
      setVerifyingPin(false);
    }
  };

  const triggerServiceRequest = async (requestType: 'waiter' | 'bill') => {
    if (!data) return;
    try {
      await apiFetch(`/qr/${encodeURIComponent(qrToken)}/service-request`, {
        method: 'POST',
        headers: {
          'x-qr-session': data.sessionToken,
        },
        body: JSON.stringify({ requestType }),
      });
      if (requestType === 'bill') {
        await openBillAndPaySheet();
        showToast('Bill summary loaded. You can pay here or at the table.');
      } else {
        showToast('Waiter has been notified at your table.');
      }
    } catch (err: any) {
      showToast(err.message || 'Could not send request');
    }
  };

  const openBillAndPaySheet = async () => {
    if (!data) return;
    setPayError('');
    setPayStep('summary');
    setShowPaySheet(true);
    await loadBill(data.sessionToken);
  };

  const initiateCustomerPayment = async (methodCode: string) => {
    if (!data || !billData) return;
    setPayBusy(true);
    setPayError('');
    try {
      const res = await apiFetch<{
        payment: PaymentRecord;
        upiUri: string;
        upiQrDataUrl: string;
        razorpayOrderId: string;
      }>(`/qr/${encodeURIComponent(qrToken)}/payments/initiate`, {
        method: 'POST',
        headers: {
          'x-qr-session': data.sessionToken,
          'x-idempotency-key': payIdempKey,
        },
        body: JSON.stringify({
          method: methodCode,
          amount: billData.summary.balanceDue,
          idempotencyKey: payIdempKey,
        }),
      });
      setSelectedPayMethod(methodCode);
      setActivePayTx(res.payment);
      setUpiUri(res.upiUri || '');
      setUpiQrDataUrl(res.upiQrDataUrl || '');
      setPayIdempKey(createIdempotencyKey());
      await loadBill(data.sessionToken);
    } catch (err: any) {
      setPayError(err.message || 'Could not initiate payment');
    } finally {
      setPayBusy(false);
    }
  };

  const handleSubmitUpiProof = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!data || !activePayTx) return;
    setPayBusy(true);
    setPayError('');
    try {
      const res = await apiFetch<{ payment: PaymentRecord; message: string }>(
        `/qr/${encodeURIComponent(qrToken)}/payments/${activePayTx.id}/submit-proof`,
        {
          method: 'POST',
          headers: { 'x-qr-session': data.sessionToken },
          body: JSON.stringify({ utr: utrInput }),
        },
      );
      setActivePayTx(res.payment);
      setUtrInput('');
      showToast(res.message);
      await loadBill(data.sessionToken);
    } catch (err: any) {
      setPayError(err.message || 'Could not submit UTR reference');
    } finally {
      setPayBusy(false);
    }
  };

  const handleVerifyCustomerRazorpay = async (outcome: 'success' | 'fail') => {
    if (!data || !activePayTx) return;
    setPayBusy(true);
    setPayError('');
    try {
      const res = await apiFetch<{ payment: PaymentRecord; receipt: ReceiptRecord }>(
        `/qr/${encodeURIComponent(qrToken)}/payments/${activePayTx.id}/razorpay-verify`,
        {
          method: 'POST',
          headers: { 'x-qr-session': data.sessionToken },
          body: JSON.stringify({
            razorpayOrderId: activePayTx.razorpayOrderId,
            authorizeTestPayment: true,
            outcome,
          }),
        },
      );
      setActivePayTx(null);
      setActiveReceipt(res.receipt);
      showToast('Payment verified & receipt generated!');
      await loadMenu(data.sessionToken);
    } catch (err: any) {
      setPayError(err.message || 'Payment verification failed');
      await loadBill(data.sessionToken);
    } finally {
      setPayBusy(false);
    }
  };

  const copyUpiAddress = async (upiText: string) => {
    try {
      await navigator.clipboard.writeText(upiText);
      setCopiedUpi(true);
      setTimeout(() => setCopiedUpi(false), 2000);
    } catch {
      // ignore clipboard errors
    }
  };

  const submitFeedback = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!data) return;
    try {
      await apiFetch(`/qr/${encodeURIComponent(qrToken)}/feedback`, {
        method: 'POST',
        headers: {
          'x-qr-session': data.sessionToken,
        },
        body: JSON.stringify({
          name: guestName || 'Dine-In Guest',
          phone: guestPhone,
          rating,
          comment: feedbackComment,
        }),
      });
      setShowFeedbackModal(false);
      setFeedbackComment('');
      showToast('Thank you for your feedback!');
    } catch (err: any) {
      showToast(err.message || 'Could not submit feedback');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="text-sm text-slate-500">Loading digital table menu...</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-xl p-6 text-center space-y-4">
          <p className="text-base font-semibold text-slate-900">QR Session Unavailable</p>
          <p className="text-sm text-slate-500">{error || 'Table code invalid.'}</p>
          <button
            onClick={onExit}
            className="px-4 py-2.5 text-sm font-medium bg-slate-900 text-white rounded-lg cursor-pointer"
          >
            Back to DineFlow Hub
          </button>
        </div>
      </div>
    );
  }

  const lifecycleSteps = ['New', 'Accepted', 'Preparing', 'Ready', 'Served', 'Paid'];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 pb-24">
      {/* Compact Sticky Header (<= 56px, well within 15% mobile cap) */}
      <header className="sticky top-0 z-30 h-14 bg-white/95 backdrop-blur-md border-b border-slate-200 px-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <button
            onClick={onExit}
            aria-label="Back to DineFlow"
            className="min-h-[44px] min-w-[44px] -ml-2 flex items-center justify-center text-slate-600 hover:text-slate-900 cursor-pointer"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="min-w-0">
            <h1 className="text-sm font-bold text-slate-900 truncate">{data.restaurant.name}</h1>
            <p className="text-xs text-slate-500 truncate">
              Table {data.table.tableNumber} · {data.table.section}
            </p>
          </div>
        </div>

        <button
          onClick={() => setShowTrackerSheet(true)}
          className="min-h-[40px] px-3 text-xs font-semibold bg-orange-50 text-orange-700 border border-orange-200 rounded-lg flex items-center gap-1.5 shrink-0 cursor-pointer"
        >
          <Clock className="w-3.5 h-3.5" />
          Orders ({data.activeOrders.length})
        </button>
      </header>

      {toastMsg && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 bg-slate-900 text-white text-xs font-medium px-4 py-2.5 rounded-lg shadow-lg">
          {toastMsg}
        </div>
      )}

      <div className="max-w-6xl mx-auto px-4 pt-4 space-y-5">
        {/* Table Service Quick Actions & Dining Session Status */}
        <div className="bg-white border border-slate-200 rounded-xl p-3.5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-slate-600">
              <span className="font-semibold text-slate-900">{data.restaurant.cuisineType}</span>
              {' · '}
              <span>{data.restaurant.openingHours}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => triggerServiceRequest('waiter')}
                className="min-h-[44px] px-3.5 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
              >
                <Bell className="w-3.5 h-3.5 text-orange-600" />
                Call Waiter
              </button>
              <button
                onClick={openBillAndPaySheet}
                className="min-h-[44px] px-3.5 text-xs font-semibold bg-slate-900 hover:bg-slate-800 text-white rounded-lg flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
              >
                <Receipt className="w-3.5 h-3.5 text-orange-400" />
                View & Pay Bill
              </button>
              {billData && billData.receipts.length > 0 && (
                <button
                  onClick={() => setActiveReceipt(billData.receipts[0])}
                  className="min-h-[44px] px-3.5 text-xs font-semibold bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 rounded-lg flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                >
                  <FileText className="w-3.5 h-3.5" />
                  Receipt ({billData.receipts.length})
                </button>
              )}
              <button
                onClick={() => setShowFeedbackModal(true)}
                className="min-h-[44px] px-3.5 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
              >
                <Star className="w-3.5 h-3.5 text-amber-500" />
                Rate
              </button>
            </div>
          </div>

          <div className="pt-2.5 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2">
              {data.pinState?.verified ? (
                <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-700">
                  <ShieldCheck className="w-4 h-4" />
                  Session PIN Verified · Multi-order active
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 font-medium text-amber-700">
                  <KeyRound className="w-4 h-4" />
                  3-digit waiter security PIN required at checkout
                </span>
              )}
            </div>
            <div className="text-slate-500 font-mono-num">
              Session {data.diningSession?.sessionUid?.slice(0, 10) || 'ACTIVE'} · Bill:{' '}
              <span className="font-semibold uppercase text-slate-800">
                {data.diningSession?.paymentStatus || 'unpaid'}
              </span>
            </div>
          </div>
        </div>

        {/* Active Offers Banner */}
        {data.offers.length > 0 && (
          <div className="flex items-center gap-3 overflow-x-auto pb-1">
            {data.offers.map((off) => (
              <button
                key={off.id}
                onClick={() => {
                  setPromoCode(off.code);
                  showToast(`Promo code ${off.code} selected for checkout`);
                }}
                className="shrink-0 px-3.5 py-2 bg-orange-50 border border-orange-200 rounded-lg text-left cursor-pointer"
              >
                <div className="text-xs font-bold text-orange-800">{off.code} · {off.title}</div>
                <div className="text-[11px] text-orange-700">
                  Min order {formatInr(off.minOrderAmount)} · Tap to apply
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Search & Category Filter Controls */}
        <div className="space-y-3">
          <div className="flex items-center gap-2.5">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search dishes, dosas, coffee..."
                className="w-full min-h-[44px] pl-9 pr-3 text-sm bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
            </div>
            <button
              onClick={() => setVegOnly((v) => !v)}
              className={`min-h-[44px] px-3.5 text-xs font-semibold rounded-xl border transition-colors cursor-pointer shrink-0 ${
                vegOnly
                  ? 'bg-emerald-600 text-white border-emerald-600'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              Veg Only
            </button>
          </div>

          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            <button
              onClick={() => setActiveCategoryId('all')}
              className={`min-h-[40px] px-3.5 text-xs font-medium rounded-lg shrink-0 transition-colors cursor-pointer ${
                activeCategoryId === 'all'
                  ? 'bg-slate-900 text-white'
                  : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              All Dishes
            </button>
            {data.categories.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setActiveCategoryId(cat.id)}
                className={`min-h-[40px] px-3.5 text-xs font-medium rounded-lg shrink-0 transition-colors cursor-pointer ${
                  activeCategoryId === cat.id
                    ? 'bg-slate-900 text-white'
                    : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
                }`}
              >
                {cat.name}
              </button>
            ))}
          </div>
        </div>

        {/* Responsive Menu Grid (1-col mobile, 2-col tablet, 3-col desktop) */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredItems.map((item) => (
            <article
              key={item.id}
              className={`bg-white border border-slate-200 rounded-2xl overflow-hidden flex flex-col justify-between ${
                !item.isAvailable ? 'opacity-60' : ''
              }`}
            >
              <div className="aspect-[4/3] bg-slate-100 relative overflow-hidden">
                {item.imageUrl ? (
                  <img
                    src={item.imageUrl}
                    alt={item.name}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full bg-gradient-to-br from-orange-50 via-slate-50 to-amber-50 flex flex-col items-center justify-center p-4 text-center">
                    <Utensils className="w-8 h-8 text-orange-400 mb-2" />
                    <span className="text-xs font-medium text-slate-600">{item.name}</span>
                  </div>
                )}
              </div>

              <div className="p-4 flex-1 flex flex-col justify-between space-y-3">
                <div className="space-y-1.5">
                  <div className="text-xs text-slate-500">
                    <span className={item.isVeg ? 'text-emerald-700 font-semibold' : 'text-red-700 font-semibold'}>
                      {item.isVeg ? 'Veg' : 'Non-Veg'}
                    </span>
                    {' · '}
                    <span>{item.prepTimeMins} min prep</span>
                    {item.isCombo && (
                      <>
                        {' · '}
                        <span className="text-orange-600 font-medium">Combo</span>
                      </>
                    )}
                  </div>
                  <h3 className="text-base font-semibold text-slate-900">{item.name}</h3>
                  <p className="text-xs text-slate-600 line-clamp-2">{item.description}</p>
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-slate-100">
                  <span className="text-base font-bold font-mono-num text-slate-900">
                    {formatInr(item.price)}
                  </span>
                  <button
                    disabled={!item.isAvailable}
                    onClick={() => openCustomizer(item)}
                    className="min-h-[44px] px-4 text-xs font-semibold bg-orange-600 hover:bg-orange-700 disabled:bg-slate-300 text-white rounded-xl transition-colors cursor-pointer"
                  >
                    {item.isAvailable ? 'Add +' : 'Sold Out'}
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>

      {/* Sticky Bottom Cart CTA Bar (<= 15% mobile height) */}
      {cartSummary.count > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-30 p-3 bg-gradient-to-t from-white via-white to-transparent">
          <div className="max-w-2xl mx-auto">
            <button
              onClick={() => setShowCartSheet(true)}
              className="w-full h-12 px-5 rounded-xl bg-orange-600 hover:bg-orange-700 text-white font-semibold text-sm flex items-center justify-between shadow-lg cursor-pointer"
            >
              <span className="flex items-center gap-2">
                <ShoppingBag className="w-4 h-4" />
                {cartSummary.count} {cartSummary.count === 1 ? 'Item' : 'Items'}
              </span>
              <span className="font-mono-num">
                View Cart · {formatInr(cartSummary.estimatedTotal)}
              </span>
            </button>
          </div>
        </div>
      )}

      {/* Dish Customization Bottom Sheet */}
      {customizingItem && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-end md:items-center justify-center">
          <div className="bg-white w-full max-w-lg rounded-t-3xl md:rounded-2xl max-h-[88vh] flex flex-col overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-slate-900">{customizingItem.name}</h3>
                <p className="text-xs text-slate-500">
                  Base price {formatInr(customizingItem.price)}
                </p>
              </div>
              <button
                onClick={() => setCustomizingItem(null)}
                className="min-h-[44px] min-w-[44px] flex items-center justify-center text-slate-500 hover:text-slate-900 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 overflow-y-auto space-y-5">
              {customizingItem.variants.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-slate-700">Choose Portion / Style</h4>
                  <div className="space-y-2">
                    {customizingItem.variants.map((v) => (
                      <label
                        key={v.id}
                        className={`min-h-[44px] px-3.5 py-2.5 rounded-xl border flex items-center justify-between cursor-pointer ${
                          chosenVariant?.id === v.id
                            ? 'border-orange-600 bg-orange-50'
                            : 'border-slate-200'
                        }`}
                      >
                        <span className="flex items-center gap-2.5 text-sm font-medium text-slate-800">
                          <input
                            type="radio"
                            name="variant"
                            checked={chosenVariant?.id === v.id}
                            onChange={() => setChosenVariant(v)}
                            className="accent-orange-600"
                          />
                          {v.name}
                        </span>
                        <span className="text-xs font-mono-num text-slate-600">
                          {v.priceDelta > 0 ? `+${formatInr(v.priceDelta)}` : 'Included'}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {customizingItem.addons.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-slate-700">Optional Add-ons</h4>
                  <div className="space-y-2">
                    {customizingItem.addons.map((a) => {
                      const checked = chosenAddons.some((ca) => ca.id === a.id);
                      return (
                        <label
                          key={a.id}
                          className={`min-h-[44px] px-3.5 py-2.5 rounded-xl border flex items-center justify-between cursor-pointer ${
                            checked ? 'border-orange-600 bg-orange-50' : 'border-slate-200'
                          }`}
                        >
                          <span className="flex items-center gap-2.5 text-sm font-medium text-slate-800">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                setChosenAddons((prev) =>
                                  checked ? prev.filter((x) => x.id !== a.id) : [...prev, a],
                                )
                              }
                              className="accent-orange-600"
                            />
                            {a.name}
                          </span>
                          <span className="text-xs font-mono-num text-slate-600">
                            +{formatInr(a.price)}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-700">Special Kitchen Notes</label>
                <input
                  value={itemNotes}
                  onChange={(e) => setItemNotes(e.target.value)}
                  placeholder="e.g. Less spicy, no onion, extra crispy..."
                  className="w-full min-h-[44px] px-3 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>
            </div>

            <div className="p-4 border-t border-slate-100 flex items-center gap-3">
              <div className="flex items-center border border-slate-200 rounded-xl">
                <button
                  onClick={() => setItemQty((q) => Math.max(1, q - 1))}
                  className="min-h-[44px] min-w-[44px] flex items-center justify-center cursor-pointer"
                >
                  <Minus className="w-4 h-4" />
                </button>
                <span className="px-2 text-sm font-mono-num font-bold">{itemQty}</span>
                <button
                  onClick={() => setItemQty((q) => q + 1)}
                  className="min-h-[44px] min-w-[44px] flex items-center justify-center cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
              <button
                onClick={addToCart}
                className="flex-1 min-h-[44px] bg-orange-600 hover:bg-orange-700 text-white text-sm font-semibold rounded-xl cursor-pointer"
              >
                Add to Order ·{' '}
                {formatInr(
                  (customizingItem.price +
                    (chosenVariant?.priceDelta || 0) +
                    chosenAddons.reduce((s, a) => s + a.price, 0)) *
                    itemQty,
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Cart & Checkout Sheet */}
      {showCartSheet && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-end md:items-center justify-center">
          <div className="bg-white w-full max-w-lg rounded-t-3xl md:rounded-2xl max-h-[90vh] flex flex-col overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900">
                Your Table {data.table.tableNumber} Order
              </h3>
              <button
                onClick={() => setShowCartSheet(false)}
                className="min-h-[44px] min-w-[44px] flex items-center justify-center cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 overflow-y-auto space-y-4">
              <div className="divide-y divide-slate-100">
                {cart.map((c) => (
                  <div key={c.key} className="py-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-900">{c.menuItem.name}</div>
                      <div className="text-xs text-slate-500">
                        {c.selectedVariant ? c.selectedVariant.name : 'Standard'}
                        {c.selectedAddons.length > 0 &&
                          ` · +${c.selectedAddons.map((a) => a.name).join(', ')}`}
                        {c.specialInstructions && ` · "${c.specialInstructions}"`}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <div className="flex items-center border border-slate-200 rounded-lg">
                        <button
                          onClick={() => updateCartQty(c.key, -1)}
                          className="min-h-[36px] min-w-[36px] flex items-center justify-center cursor-pointer"
                        >
                          <Minus className="w-3.5 h-3.5" />
                        </button>
                        <span className="px-2 text-xs font-mono-num font-semibold">{c.quantity}</span>
                        <button
                          onClick={() => updateCartQty(c.key, 1)}
                          className="min-h-[36px] min-w-[36px] flex items-center justify-center cursor-pointer"
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <span className="text-sm font-mono-num font-semibold w-16 text-right">
                        {formatInr(c.unitPrice * c.quantity)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-3 pt-2">
                <input
                  value={guestName}
                  onChange={(e) => setGuestName(e.target.value)}
                  placeholder="Your Name (optional)"
                  className="min-h-[44px] px-3 text-sm border border-slate-200 rounded-xl"
                />
                <input
                  value={guestPhone}
                  onChange={(e) => setGuestPhone(e.target.value)}
                  placeholder="Phone (optional)"
                  className="min-h-[44px] px-3 text-sm border border-slate-200 rounded-xl"
                />
              </div>

              <input
                value={promoCode}
                onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
                placeholder="Promo code (e.g. SPICE10)"
                className="w-full min-h-[44px] px-3 text-sm font-mono-num border border-slate-200 rounded-xl"
              />

              <input
                value={orderNotes}
                onChange={(e) => setOrderNotes(e.target.value)}
                placeholder="Overall order notes for kitchen..."
                className="w-full min-h-[44px] px-3 text-sm border border-slate-200 rounded-xl"
              />

              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 space-y-1.5 text-sm">
                <div className="flex justify-between text-slate-600">
                  <span>Subtotal</span>
                  <span className="font-mono-num">{formatInr(cartSummary.subtotal)}</span>
                </div>
                <div className="flex justify-between text-slate-600">
                  <span>GST ({data.restaurant.gstRate}%)</span>
                  <span className="font-mono-num">{formatInr(cartSummary.gst)}</span>
                </div>
                {data.restaurant.serviceChargeRate > 0 && (
                  <div className="flex justify-between text-slate-600">
                    <span>Service Charge ({data.restaurant.serviceChargeRate}%)</span>
                    <span className="font-mono-num">{formatInr(cartSummary.sc)}</span>
                  </div>
                )}
                <div className="flex justify-between font-bold text-slate-900 pt-1.5 border-t border-slate-200">
                  <span>Estimated Total</span>
                  <span className="font-mono-num">{formatInr(cartSummary.estimatedTotal)}</span>
                </div>
              </div>
            </div>

            <div className="p-4 border-t border-slate-100">
              <button
                onClick={submitQrOrder}
                disabled={submittingOrder || cart.length === 0}
                className="w-full min-h-[48px] bg-orange-600 hover:bg-orange-700 text-white text-sm font-semibold rounded-xl cursor-pointer disabled:opacity-50"
              >
                {submittingOrder ? 'Sending to Kitchen...' : 'Place Order Now'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Live Order Progress Tracker Sheet */}
      {showTrackerSheet && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-end md:items-center justify-center">
          <div className="bg-white w-full max-w-lg rounded-t-3xl md:rounded-2xl max-h-[85vh] flex flex-col overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900">
                Live Table {data.table.tableNumber} Orders
              </h3>
              <button
                onClick={() => setShowTrackerSheet(false)}
                className="min-h-[44px] min-w-[44px] flex items-center justify-center cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 overflow-y-auto space-y-4">
              {data.activeOrders.length === 0 ? (
                <div className="py-10 text-center text-sm text-slate-500">
                  No active orders on this table yet. Add dishes from the menu to get started.
                </div>
              ) : (
                data.activeOrders.map((ord) => {
                  const stepIndex = lifecycleSteps.indexOf(ord.status);
                  return (
                    <div key={ord.id} className="border border-slate-200 rounded-xl p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="font-mono-num font-bold text-slate-900">
                            {ord.orderNumber}
                          </span>
                          <span className="text-xs text-slate-500 ml-2">
                            {new Date(ord.createdAt).toLocaleTimeString('en-IN', {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                        </div>
                        <span className="text-xs font-semibold text-orange-700 bg-orange-50 px-2.5 py-1 rounded-md">
                          {ord.status}
                        </span>
                      </div>

                      <div className="grid grid-cols-6 gap-1 pt-1">
                        {lifecycleSteps.map((step, i) => (
                          <div key={step} className="space-y-1">
                            <div
                              className={`h-1.5 rounded-full ${
                                i <= stepIndex ? 'bg-orange-600' : 'bg-slate-200'
                              }`}
                            />
                            <div className="text-[10px] text-center text-slate-500 truncate">
                              {step}
                            </div>
                          </div>
                        ))}
                      </div>

                      <div className="divide-y divide-slate-100 text-xs pt-1">
                        {ord.items.map((it) => (
                          <div key={it.id} className="py-1.5 flex items-center justify-between">
                            <span className="text-slate-800">
                              {it.quantity}× {it.itemName}
                            </span>
                            <span className="text-slate-500 font-medium">{it.status}</span>
                          </div>
                        ))}
                      </div>

                      <div className="flex items-center justify-between pt-2 border-t border-slate-100 text-sm font-bold">
                        <span>Total</span>
                        <span className="font-mono-num">{formatInr(ord.totalAmount)}</span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* Feedback Modal */}
      {showFeedbackModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <form
            onSubmit={submitFeedback}
            className="bg-white w-full max-w-md rounded-2xl p-6 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900">How was your experience?</h3>
              <button
                type="button"
                onClick={() => setShowFeedbackModal(false)}
                className="text-slate-500 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex items-center gap-2">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setRating(n)}
                  className={`min-h-[44px] min-w-[44px] rounded-xl border flex items-center justify-center cursor-pointer ${
                    n <= rating ? 'bg-amber-50 border-amber-400 text-amber-600' : 'border-slate-200 text-slate-300'
                  }`}
                >
                  <Star className="w-5 h-5 fill-current" />
                </button>
              ))}
            </div>
            <textarea
              rows={3}
              value={feedbackComment}
              onChange={(e) => setFeedbackComment(e.target.value)}
              placeholder="Tell us about the food, speed, or hospitality..."
              className="w-full p-3 text-sm border border-slate-200 rounded-xl"
            />
            <button
              type="submit"
              className="w-full min-h-[44px] bg-orange-600 hover:bg-orange-700 text-white text-sm font-semibold rounded-xl flex items-center justify-center gap-2 cursor-pointer"
            >
              <CheckCircle2 className="w-4 h-4" />
              Submit Feedback
            </button>
          </form>
        </div>
      )}

      {/* 3-Digit Waiter Security PIN Verification Modal */}
      {showPinModal && (
        <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-xs flex items-end md:items-center justify-center p-0 md:p-4">
          <form
            onSubmit={handleVerifyPinAndPlaceOrder}
            className="bg-white w-full max-w-md rounded-t-3xl md:rounded-2xl p-6 space-y-5 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-orange-600 uppercase tracking-wide">
                  <Lock className="w-3.5 h-3.5" />
                  Table {data.table.tableNumber} Security Check
                </div>
                <h3 className="text-lg font-bold text-slate-900">Verify Your Order</h3>
                <p className="text-sm text-slate-600">Enter your 3-digit security PIN.</p>
              </div>
              <button
                type="button"
                onClick={() => setShowPinModal(false)}
                className="min-h-[44px] min-w-[44px] flex items-center justify-center text-slate-500 hover:text-slate-900 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {lockSeconds > 0 && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-xs font-medium px-3.5 py-2.5 rounded-xl">
                Too many incorrect attempts. PIN verification is temporarily locked. Try again in{' '}
                <span className="font-mono-num font-bold">
                  {Math.floor(lockSeconds / 60)}:{String(lockSeconds % 60).padStart(2, '0')}
                </span>
                .
              </div>
            )}

            {pinError && lockSeconds <= 0 && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-xs font-medium px-3.5 py-2.5 rounded-xl">
                {pinError}
              </div>
            )}

            <div className="space-y-2">
              <div className="relative flex items-center">
                <input
                  type={showPinDigits ? 'text' : 'password'}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="one-time-code"
                  maxLength={3}
                  autoFocus
                  disabled={verifyingPin || lockSeconds > 0}
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value.replace(/\D/g, '').slice(0, 3))}
                  placeholder="_ _ _"
                  aria-label="3-digit security PIN"
                  className="w-full min-h-[56px] px-4 text-center text-2xl font-mono-num font-bold tracking-[0.55em] bg-slate-50 border-2 border-slate-300 focus:border-orange-600 rounded-xl focus:outline-none disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => setShowPinDigits((v) => !v)}
                  aria-label={showPinDigits ? 'Hide PIN' : 'Show PIN'}
                  className="absolute right-3 min-h-[40px] min-w-[40px] flex items-center justify-center text-slate-500 hover:text-slate-900 cursor-pointer"
                >
                  {showPinDigits ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-xs text-slate-500 text-center">
                Ask your waiter for the security code. It stays valid for your entire meal at this table.
              </p>
            </div>

            <button
              type="submit"
              disabled={verifyingPin || lockSeconds > 0 || pinInput.length !== 3}
              className="w-full min-h-[48px] bg-orange-600 hover:bg-orange-700 text-white text-sm font-semibold rounded-xl cursor-pointer disabled:opacity-50"
            >
              {verifyingPin ? 'Verifying PIN...' : 'Verify & Place Order'}
            </button>
          </form>
        </div>
      )}

      {/* Customer Bill Summary & Payment Sheet */}
      {showPaySheet && (
        <div className="fixed inset-0 z-50 bg-black/55 backdrop-blur-xs flex items-end md:items-center justify-center">
          <div className="bg-white w-full max-w-lg rounded-t-3xl md:rounded-2xl max-h-[92vh] flex flex-col overflow-hidden shadow-2xl">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  Table {data.table.tableNumber} · Bill & Payment
                </h3>
                <p className="text-xs text-slate-500">
                  {billData?.orderNumbers?.length
                    ? `Orders: ${billData.orderNumbers.join(', ')}`
                    : 'Session Bill Summary'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowPaySheet(false)}
                className="min-h-[44px] min-w-[44px] flex items-center justify-center text-slate-500 hover:text-slate-900 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 overflow-y-auto space-y-4">
              {loadingBill && !billData && (
                <div className="py-10 text-center text-sm text-slate-500">
                  Calculating your itemized bill...
                </div>
              )}

              {billData && billData.items.length === 0 && (
                <div className="py-10 text-center text-sm text-slate-500">
                  No active orders on this table yet. Place an order first to generate your bill.
                </div>
              )}

              {billData && billData.items.length > 0 && (
                <>
                  {/* Settled / Digital Receipt Ready Banner */}
                  {billData.summary.balanceDue <= 0.01 && billData.receipts.length > 0 && (
                    <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 space-y-3">
                      <div className="flex items-center gap-2 text-emerald-800 font-bold text-sm">
                        <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                        Bill Paid · Digital Receipt Generated
                      </div>
                      <p className="text-xs text-emerald-700">
                        Receipt <span className="font-mono-num font-semibold">{billData.receipts[0].receiptNumber}</span> has been issued.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => setActiveReceipt(billData.receipts[0])}
                          className="px-3.5 py-2 text-xs font-semibold bg-emerald-700 text-white rounded-lg hover:bg-emerald-800 flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                        >
                          <Receipt className="w-3.5 h-3.5" />
                          View Digital Receipt
                        </button>
                        <button
                          type="button"
                          onClick={() => downloadReceiptPdf(billData.receipts[0])}
                          className="px-3.5 py-2 text-xs font-semibold bg-white border border-emerald-300 text-emerald-800 rounded-lg hover:bg-emerald-100 flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                        >
                          <Download className="w-3.5 h-3.5" />
                          Download PDF
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Step 1: Complete Order & Tax Summary */}
                  {payStep === 'summary' && (
                    <div className="space-y-4">
                      <div className="border border-slate-200 rounded-xl overflow-hidden">
                        <table className="w-full text-left border-collapse text-xs">
                          <thead>
                            <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                              <th className="py-2.5 px-3 font-semibold">Item</th>
                              <th className="py-2.5 px-2 text-center font-semibold">Qty</th>
                              <th className="py-2.5 px-2 text-right font-semibold">Price</th>
                              <th className="py-2.5 px-3 text-right font-semibold">Total</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {billData.items.map((it, i) => (
                              <tr key={i}>
                                <td className="py-2.5 px-3">
                                  <div className="font-medium text-slate-900">{it.itemName}</div>
                                  {(it.variantName || it.addonsSummary) && (
                                    <div className="text-[11px] text-slate-500">
                                      {[it.variantName, it.addonsSummary].filter(Boolean).join(' · ')}
                                    </div>
                                  )}
                                </td>
                                <td className="py-2.5 px-2 text-center font-mono-num">{it.quantity}</td>
                                <td className="py-2.5 px-2 text-right font-mono-num text-slate-600">
                                  {formatInr(it.unitPrice)}
                                </td>
                                <td className="py-2.5 px-3 text-right font-mono-num font-semibold text-slate-900">
                                  {formatInr(it.itemTotal)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-1.5 text-xs">
                        <div className="flex justify-between text-slate-600">
                          <span>Subtotal</span>
                          <span className="font-mono-num">{formatInr(billData.summary.subtotal)}</span>
                        </div>
                        {billData.summary.discountAmount > 0 && (
                          <div className="flex justify-between text-emerald-700">
                            <span>Discounts</span>
                            <span className="font-mono-num">
                              -{formatInr(billData.summary.discountAmount)}
                            </span>
                          </div>
                        )}
                        <div className="flex justify-between text-slate-600">
                          <span>CGST ({billData.summary.gstRateApplied / 2}%)</span>
                          <span className="font-mono-num">{formatInr(billData.summary.cgstAmount)}</span>
                        </div>
                        <div className="flex justify-between text-slate-600">
                          <span>SGST ({billData.summary.gstRateApplied / 2}%)</span>
                          <span className="font-mono-num">{formatInr(billData.summary.sgstAmount)}</span>
                        </div>
                        {billData.summary.serviceChargeAmount > 0 && (
                          <div className="flex justify-between text-slate-600">
                            <span>Service Charge ({billData.summary.serviceChargeRateApplied}%)</span>
                            <span className="font-mono-num">
                              {formatInr(billData.summary.serviceChargeAmount)}
                            </span>
                          </div>
                        )}
                        {billData.summary.otherChargesAmount > 0 && (
                          <div className="flex justify-between text-slate-600">
                            <span>{billData.summary.otherChargesLabel}</span>
                            <span className="font-mono-num">
                              {formatInr(billData.summary.otherChargesAmount)}
                            </span>
                          </div>
                        )}
                        <div className="flex justify-between font-bold text-sm text-slate-950 pt-2 border-t border-slate-200">
                          <span>Grand Total</span>
                          <span className="font-mono-num">{formatInr(billData.summary.grandTotal)}</span>
                        </div>
                        {billData.summary.amountPaid > 0 && (
                          <div className="flex justify-between text-emerald-700 font-medium">
                            <span>Already Paid</span>
                            <span className="font-mono-num">-{formatInr(billData.summary.amountPaid)}</span>
                          </div>
                        )}
                        <div className="flex justify-between font-bold text-base text-orange-700 pt-1">
                          <span>Payable Balance</span>
                          <span className="font-mono-num">{formatInr(billData.summary.balanceDue)}</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Step 2: Payment Method Selection & Verification Workflow */}
                  {payStep === 'methods' && billData.summary.balanceDue > 0.01 && (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between bg-slate-900 text-white rounded-xl p-4">
                        <div>
                          <div className="text-[11px] uppercase tracking-wider text-slate-300">
                            Final Payable Amount
                          </div>
                          <div className="text-2xl font-bold font-mono-num">
                            {formatInr(billData.summary.balanceDue)}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setPayStep('summary')}
                          className="text-xs underline text-slate-300 hover:text-white cursor-pointer"
                        >
                          Review Items
                        </button>
                      </div>

                      <div className="space-y-2">
                        <div className="text-xs font-semibold text-slate-700">Select Payment Method</div>
                        <div className="grid grid-cols-2 gap-2">
                          {billData.acceptedMethods.includes('upi') && (
                            <button
                              type="button"
                              disabled={payBusy}
                              onClick={() => initiateCustomerPayment('upi')}
                              className={`p-3 rounded-xl border text-left flex items-center gap-2.5 cursor-pointer ${
                                selectedPayMethod === 'upi' && activePayTx
                                  ? 'border-orange-600 bg-orange-50'
                                  : 'border-slate-200 hover:border-slate-300'
                              }`}
                            >
                              <QrCode className="w-5 h-5 text-orange-600 shrink-0" />
                              <div>
                                <div className="text-xs font-bold text-slate-900">UPI QR Pay</div>
                                <div className="text-[11px] text-slate-500">GPay / PhonePe / Paytm</div>
                              </div>
                            </button>
                          )}

                          {billData.acceptedMethods.includes('razorpay') && (
                            <button
                              type="button"
                              disabled={payBusy}
                              onClick={() => initiateCustomerPayment('razorpay')}
                              className={`p-3 rounded-xl border text-left flex items-center gap-2.5 cursor-pointer ${
                                selectedPayMethod === 'razorpay' && activePayTx
                                  ? 'border-orange-600 bg-orange-50'
                                  : 'border-slate-200 hover:border-slate-300'
                              }`}
                            >
                              <ShieldCheck className="w-5 h-5 text-emerald-600 shrink-0" />
                              <div>
                                <div className="text-xs font-bold text-slate-900">Online Gateway</div>
                                <div className="text-[11px] text-slate-500">Instant verified</div>
                              </div>
                            </button>
                          )}

                          {billData.acceptedMethods.includes('cash') && (
                            <button
                              type="button"
                              disabled={payBusy}
                              onClick={() => initiateCustomerPayment('cash')}
                              className={`p-3 rounded-xl border text-left flex items-center gap-2.5 cursor-pointer ${
                                selectedPayMethod === 'cash' && activePayTx
                                  ? 'border-orange-600 bg-orange-50'
                                  : 'border-slate-200 hover:border-slate-300'
                              }`}
                            >
                              <Wallet className="w-5 h-5 text-slate-700 shrink-0" />
                              <div>
                                <div className="text-xs font-bold text-slate-900">Pay Cash</div>
                                <div className="text-[11px] text-slate-500">Staff collects at table</div>
                              </div>
                            </button>
                          )}

                          {billData.acceptedMethods.includes('card') && (
                            <button
                              type="button"
                              disabled={payBusy}
                              onClick={() => initiateCustomerPayment('card')}
                              className={`p-3 rounded-xl border text-left flex items-center gap-2.5 cursor-pointer ${
                                selectedPayMethod === 'card' && activePayTx
                                  ? 'border-orange-600 bg-orange-50'
                                  : 'border-slate-200 hover:border-slate-300'
                              }`}
                            >
                              <CreditCard className="w-5 h-5 text-slate-700 shrink-0" />
                              <div>
                                <div className="text-xs font-bold text-slate-900">Card Machine</div>
                                <div className="text-[11px] text-slate-500">POS terminal at table</div>
                              </div>
                            </button>
                          )}

                          {billData.customMethods.map((cm) => (
                            <button
                              key={cm.code}
                              type="button"
                              disabled={payBusy}
                              onClick={() => initiateCustomerPayment(cm.code)}
                              className={`p-3 rounded-xl border text-left flex items-center gap-2.5 cursor-pointer ${
                                activePayTx?.paymentMethodLabel === cm.label
                                  ? 'border-orange-600 bg-orange-50'
                                  : 'border-slate-200 hover:border-slate-300'
                              }`}
                            >
                              <Smartphone className="w-5 h-5 text-indigo-600 shrink-0" />
                              <div className="min-w-0">
                                <div className="text-xs font-bold text-slate-900 truncate">{cm.label}</div>
                                <div className="text-[11px] text-slate-500 truncate">
                                  {cm.instructions || 'Staff confirmation'}
                                </div>
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>

                      {payError && (
                        <div className="bg-red-50 border border-red-200 text-red-700 text-xs px-3.5 py-2.5 rounded-xl">
                          {payError}
                        </div>
                      )}

                      {/* Active UPI Payment Box */}
                      {activePayTx && activePayTx.method === 'upi' && (
                        <div className="border border-slate-200 rounded-xl p-4 space-y-4 bg-slate-50/70">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-bold text-slate-900">
                              Scan & Pay {formatInr(activePayTx.amount)} via UPI
                            </span>
                            <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-amber-100 text-amber-900 uppercase">
                              {activePayTx.status}
                            </span>
                          </div>

                          {upiQrDataUrl && (
                            <div className="flex flex-col items-center gap-2 bg-white border border-slate-200 rounded-xl p-4">
                              <img
                                src={upiQrDataUrl}
                                alt="Restaurant UPI Payment QR"
                                className="w-44 h-44 object-contain"
                              />
                              <div className="text-[11px] text-slate-500">
                                Payee: {billData.restaurant.upiPayeeName}
                              </div>
                            </div>
                          )}

                          <div className="flex items-center justify-between gap-2 bg-white border border-slate-200 rounded-lg px-3 py-2">
                            <div className="min-w-0">
                              <div className="text-[10px] uppercase text-slate-400 font-semibold">
                                Restaurant UPI ID
                              </div>
                              <div className="text-xs font-mono-num font-bold text-slate-900 truncate">
                                {billData.restaurant.upiId}
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                type="button"
                                onClick={() => copyUpiAddress(billData.restaurant.upiId)}
                                className="px-2.5 py-1.5 text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg flex items-center gap-1 cursor-pointer"
                              >
                                {copiedUpi ? (
                                  <>
                                    <Check className="w-3.5 h-3.5 text-emerald-600" /> Copied
                                  </>
                                ) : (
                                  <>
                                    <Copy className="w-3.5 h-3.5" /> Copy
                                  </>
                                )}
                              </button>
                              {upiUri && (
                                <a
                                  href={upiUri}
                                  className="px-2.5 py-1.5 text-xs font-semibold bg-orange-600 hover:bg-orange-700 text-white rounded-lg flex items-center gap-1 whitespace-nowrap"
                                >
                                  Open App <ExternalLink className="w-3 h-3" />
                                </a>
                              )}
                            </div>
                          </div>

                          {activePayTx.status === 'processing' ? (
                            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-900 space-y-1">
                              <div className="font-bold">Verification In Progress</div>
                              <p>
                                Submitted UTR <span className="font-mono-num font-semibold">{activePayTx.customerUtrSubmitted}</span>.
                                Our cashier/waiter is confirming receipt — your bill will update to Paid automatically.
                              </p>
                            </div>
                          ) : (
                            <form onSubmit={handleSubmitUpiProof} className="space-y-2.5">
                              <label className="block text-xs font-medium text-slate-700">
                                Completed UPI transfer? Enter 12-digit UTR / Reference ID for staff verification:
                              </label>
                              <div className="flex gap-2">
                                <input
                                  required
                                  minLength={4}
                                  value={utrInput}
                                  onChange={(e) => setUtrInput(e.target.value)}
                                  placeholder="e.g. 429081726354"
                                  className="flex-1 min-h-[42px] px-3 text-xs font-mono-num bg-white border border-slate-300 rounded-lg"
                                />
                                <button
                                  type="submit"
                                  disabled={payBusy || utrInput.trim().length < 4}
                                  className="px-3.5 min-h-[42px] text-xs font-semibold bg-slate-900 text-white rounded-lg hover:bg-slate-800 whitespace-nowrap cursor-pointer disabled:opacity-50"
                                >
                                  {payBusy ? 'Sending...' : 'Submit for Verification'}
                                </button>
                              </div>
                            </form>
                          )}
                        </div>
                      )}

                      {/* Active Razorpay Gateway Verification Box */}
                      {activePayTx && activePayTx.method === 'razorpay' && (
                        <div className="border border-slate-200 rounded-xl p-4 space-y-3 bg-slate-50">
                          <div className="text-xs font-bold text-slate-900">
                            Verified Gateway Checkout ({formatInr(activePayTx.amount)})
                          </div>
                          <div className="text-[11px] font-mono-num text-slate-500">
                            Order Ref: {activePayTx.razorpayOrderId}
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <button
                              type="button"
                              disabled={payBusy}
                              onClick={() => handleVerifyCustomerRazorpay('fail')}
                              className="py-2.5 text-xs font-semibold bg-white border border-red-200 text-red-700 rounded-lg hover:bg-red-50 cursor-pointer"
                            >
                              Decline Test
                            </button>
                            <button
                              type="button"
                              disabled={payBusy}
                              onClick={() => handleVerifyCustomerRazorpay('success')}
                              className="py-2.5 text-xs font-semibold bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 cursor-pointer"
                            >
                              {payBusy ? 'Verifying...' : 'Complete Verified Payment'}
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Cash / Card / Custom Method Pending Notice */}
                      {activePayTx && ['cash', 'card', 'other'].includes(activePayTx.method) && (
                        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-xs text-amber-900 space-y-1.5">
                          <div className="font-bold flex items-center justify-between">
                            <span>{activePayTx.paymentMethodLabel || activePayTx.method.toUpperCase()} Request Sent</span>
                            <span className="uppercase">{activePayTx.status}</span>
                          </div>
                          <p>
                            Our staff has been notified to collect{' '}
                            <span className="font-mono-num font-bold">{formatInr(activePayTx.amount)}</span> at Table{' '}
                            {data.table.tableNumber}. Your digital receipt will open automatically once staff confirms payment.
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            {billData && billData.items.length > 0 && billData.summary.balanceDue > 0.01 && payStep === 'summary' && (
              <div className="p-4 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => {
                    setPayStep('methods');
                    if (!activePayTx && billData.acceptedMethods.includes('upi')) {
                      initiateCustomerPayment('upi');
                    }
                  }}
                  className="w-full min-h-[48px] bg-orange-600 hover:bg-orange-700 text-white text-sm font-semibold rounded-xl cursor-pointer flex items-center justify-center gap-2"
                >
                  <CreditCard className="w-4 h-4" />
                  Proceed to Payment · {formatInr(billData.summary.balanceDue)}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {activeReceipt && (
        <DigitalReceiptModal
          receipt={activeReceipt}
          onClose={() => setActiveReceipt(null)}
        />
      )}
    </div>
  );
};
