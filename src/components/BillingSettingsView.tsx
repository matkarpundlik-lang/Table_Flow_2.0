import React, { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Eye,
  Plus,
  RotateCcw,
  Save,
  Star,
  Trash2,
  Upload,
} from 'lucide-react';
import { apiFetch, getActiveRestaurantId, getAuthToken } from '../lib/api';
import {
  BillingSettingsRecord,
  CustomPaymentMethod,
  ReceiptRecord,
  ReceiptTemplateRecord,
  ReceiptVisibilityConfig,
  Restaurant,
} from '../types/dineflow';
import { DigitalReceiptModal, ReceiptDocument } from './ReceiptDocument';

interface BillingSetupPayload {
  restaurant: Restaurant;
  settings: BillingSettingsRecord;
  templates: ReceiptTemplateRecord[];
  defaultTemplate: ReceiptTemplateRecord;
}

const ACCENT_PRESETS = ['#0F172A', '#EA580C', '#059669', '#1D4ED8', '#7C3AED', '#BE123C'];

const VISIBILITY_LABELS: Array<{ key: keyof ReceiptVisibilityConfig; label: string }> = [
  { key: 'logo', label: 'Restaurant Logo' },
  { key: 'gstin', label: 'GSTIN Number' },
  { key: 'customerName', label: 'Customer Name' },
  { key: 'customerPhone', label: 'Customer Phone' },
  { key: 'tableNumber', label: 'Table Number' },
  { key: 'orderId', label: 'Order Number' },
  { key: 'paymentMethod', label: 'Payment Method' },
  { key: 'transactionId', label: 'Transaction ID' },
  { key: 'taxBreakdown', label: 'CGST / SGST Breakdown' },
  { key: 'discountBreakdown', label: 'Discount Line' },
  { key: 'serviceCharge', label: 'Service Charge' },
  { key: 'footerMessage', label: 'Footer Message' },
  { key: 'socialHandles', label: 'Social Handles' },
];

export const BillingSettingsView: React.FC<{
  onRestaurantUpdated?: (rest: Restaurant) => void;
}> = ({ onRestaurantUpdated }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusMsg, setStatusMsg] = useState('');
  const [restaurant, setRestaurant] = useState<Restaurant | null>(null);
  const [settings, setSettings] = useState<BillingSettingsRecord | null>(null);
  const [templates, setTemplates] = useState<ReceiptTemplateRecord[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draftTemplate, setDraftTemplate] = useState<ReceiptTemplateRecord | null>(null);

  // Payment settings draft
  const [upiId, setUpiId] = useState('');
  const [upiPayeeName, setUpiPayeeName] = useState('');
  const [acceptedMethods, setAcceptedMethods] = useState<string[]>(['upi', 'cash', 'card', 'razorpay']);
  const [customMethods, setCustomMethods] = useState<CustomPaymentMethod[]>([]);
  const [newMethodLabel, setNewMethodLabel] = useState('');
  const [newMethodInstr, setNewMethodInstr] = useState('');
  const [otherLabel, setOtherLabel] = useState('Other Charges');
  const [otherAmount, setOtherAmount] = useState(0);

  const [savingSettings, setSavingSettings] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [showPreviewModal, setShowPreviewModal] = useState(false);

  const loadSetup = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch<BillingSetupPayload>('/billing/settings');
      setRestaurant(data.restaurant);
      setSettings(data.settings);
      setTemplates(data.templates);
      const initialTpl = data.defaultTemplate || data.templates[0] || null;
      if (initialTpl) {
        setSelectedId(initialTpl.id);
        setDraftTemplate(initialTpl);
      }
      setUpiId(data.settings.upiId || data.restaurant.upiId || '');
      setUpiPayeeName(data.settings.upiPayeeName || data.restaurant.upiPayeeName || data.restaurant.name);
      setAcceptedMethods(
        data.restaurant.acceptedPaymentMethods && data.restaurant.acceptedPaymentMethods.length > 0
          ? data.restaurant.acceptedPaymentMethods
          : ['upi', 'cash', 'card', 'razorpay'],
      );
      setCustomMethods(data.settings.customPaymentMethods || []);
      setOtherLabel(data.settings.otherChargesLabel || 'Other Charges');
      setOtherAmount(Number(data.settings.otherChargesAmount || 0));
    } catch (err: any) {
      setError(err.message || 'Unable to load billing settings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSetup();
  }, []);

  const handleSelectTemplate = (tpl: ReceiptTemplateRecord) => {
    setSelectedId(tpl.id);
    setDraftTemplate({ ...tpl });
    setStatusMsg('');
  };

  const handleLogoUpload = async (file: File) => {
    if (!draftTemplate) return;
    setUploadingLogo(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('logo', file);
      const token = getAuthToken();
      const restId = getActiveRestaurantId();
      const res = await fetch('/api/uploads/logo', {
        method: 'POST',
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(restId ? { 'x-restaurant-id': String(restId) } : {}),
        },
        body: formData,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Logo upload failed');
      setDraftTemplate({ ...draftTemplate, logoUrl: json.logoUrl });
      setStatusMsg('Logo uploaded. Click Save Template to apply.');
    } catch (err: any) {
      setError(err.message || 'Failed to upload logo');
    } finally {
      setUploadingLogo(false);
    }
  };

  const savePaymentConfiguration = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingSettings(true);
    setError('');
    setStatusMsg('');
    try {
      const res = await apiFetch<{ settings: BillingSettingsRecord; restaurant: Restaurant }>(
        '/billing/settings',
        {
          method: 'PATCH',
          body: JSON.stringify({
            upiId,
            upiPayeeName,
            acceptedPaymentMethods: acceptedMethods,
            customPaymentMethods: customMethods,
            otherChargesLabel: otherLabel,
            otherChargesAmount: Number(otherAmount) || 0,
            logoUrl: draftTemplate?.logoUrl,
          }),
        },
      );
      setSettings(res.settings);
      setRestaurant(res.restaurant);
      onRestaurantUpdated?.(res.restaurant);
      setStatusMsg('UPI & payment methods saved.');
    } catch (err: any) {
      setError(err.message || 'Failed to save payment configuration');
    } finally {
      setSavingSettings(false);
    }
  };

  const saveTemplate = async () => {
    if (!draftTemplate) return;
    setSavingTemplate(true);
    setError('');
    setStatusMsg('');
    try {
      const res = await apiFetch<{ template: ReceiptTemplateRecord }>(
        `/billing/templates/${draftTemplate.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify(draftTemplate),
        },
      );
      setTemplates((prev) => prev.map((t) => (t.id === res.template.id ? res.template : t)));
      setDraftTemplate(res.template);
      setStatusMsg(`Saved "${res.template.name}" template.`);
    } catch (err: any) {
      setError(err.message || 'Failed to save template');
    } finally {
      setSavingTemplate(false);
    }
  };

  const setAsDefaultTemplate = async () => {
    if (!draftTemplate) return;
    setSavingTemplate(true);
    setError('');
    setStatusMsg('');
    try {
      // Save edits first, then mark default
      await apiFetch(`/billing/templates/${draftTemplate.id}`, {
        method: 'PATCH',
        body: JSON.stringify(draftTemplate),
      });
      const res = await apiFetch<{
        templates: ReceiptTemplateRecord[];
        defaultTemplate: ReceiptTemplateRecord;
      }>(`/billing/templates/${draftTemplate.id}/set-default`, {
        method: 'POST',
      });
      setTemplates(res.templates);
      if (res.defaultTemplate) {
        setDraftTemplate(res.defaultTemplate);
        setSelectedId(res.defaultTemplate.id);
      }
      setStatusMsg(`"${draftTemplate.name}" is now the active default receipt template.`);
    } catch (err: any) {
      setError(err.message || 'Failed to set default template');
    } finally {
      setSavingTemplate(false);
    }
  };

  const resetTemplate = async () => {
    if (!draftTemplate) return;
    setSavingTemplate(true);
    setError('');
    setStatusMsg('');
    try {
      const res = await apiFetch<{ template: ReceiptTemplateRecord }>(
        `/billing/templates/${draftTemplate.id}/reset`,
        { method: 'POST' },
      );
      setTemplates((prev) => prev.map((t) => (t.id === res.template.id ? res.template : t)));
      setDraftTemplate(res.template);
      setStatusMsg(`Reset "${res.template.name}" to default layout.`);
    } catch (err: any) {
      setError(err.message || 'Failed to reset template');
    } finally {
      setSavingTemplate(false);
    }
  };

  const toggleAcceptedMethod = (code: string) => {
    setAcceptedMethods((prev) => {
      if (prev.includes(code)) {
        if (prev.length === 1) return prev; // Keep at least 1 method
        return prev.filter((c) => c !== code);
      }
      return [...prev, code];
    });
  };

  const addCustomMethod = () => {
    const label = newMethodLabel.trim();
    if (!label) return;
    const code = `custom_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
    if (customMethods.some((m) => m.code === code)) return;
    setCustomMethods((prev) => [
      ...prev,
      { code, label, enabled: true, instructions: newMethodInstr.trim() },
    ]);
    setNewMethodLabel('');
    setNewMethodInstr('');
  };

  const sampleReceipt: ReceiptRecord | null = useMemo(() => {
    if (!draftTemplate || !restaurant) return null;
    const gstRate = restaurant.gstRate ?? 5;
    const scRate = restaurant.serviceChargeRate ?? 5;
    const subtotal = 840;
    const discountAmount = 40;
    const taxable = subtotal - discountAmount;
    const gstTotal = Number(((taxable * gstRate) / 100).toFixed(2));
    const cgst = Number((gstTotal / 2).toFixed(2));
    const sgst = Number((gstTotal - cgst).toFixed(2));
    const sc = Number(((taxable * scRate) / 100).toFixed(2));
    const otherAmt = Number(otherAmount || 0);
    const grandTotal = Number((taxable + gstTotal + sc + otherAmt).toFixed(2));

    return {
      id: 0,
      receiptNumber: 'INV-PREVIEW-001',
      restaurantId: restaurant.id,
      orderId: 101,
      diningSessionId: 1,
      paymentId: 1,
      tableId: 4,
      tableNumber: 'T-04',
      orderNumber: 'QR-48219',
      customerName: 'Aarav Sharma',
      customerPhone: '+91 98765 43210',
      paymentMethod: 'UPI QR',
      paymentStatus: 'Paid',
      transactionId: 'UTR429081726354',
      subtotal,
      discountAmount,
      gstRateApplied: gstRate,
      cgstAmount: cgst,
      sgstAmount: sgst,
      serviceChargeRateApplied: scRate,
      serviceChargeAmount: sc,
      otherChargesLabel: otherLabel || 'Other Charges',
      otherChargesAmount: otherAmt,
      grandTotal,
      amountPaid: grandTotal,
      balanceDue: 0,
      refundedAmount: 0,
      refundReason: '',
      refundedAt: null,
      itemsSnapshot: [
        {
          itemName: 'Paneer Tikka Masala',
          quantity: 1,
          unitPrice: 360,
          itemTotal: 360,
          variantName: 'Full Portion',
        },
        {
          itemName: 'Butter Garlic Naan',
          quantity: 4,
          unitPrice: 75,
          itemTotal: 300,
        },
        {
          itemName: 'Fresh Lime Soda',
          quantity: 2,
          unitPrice: 90,
          itemTotal: 180,
          addonsSummary: 'Sweet & Salted',
        },
      ],
      restaurantSnapshot: {
        name: draftTemplate.businessName || restaurant.name,
        logoUrl: draftTemplate.logoUrl || restaurant.logoUrl || '',
        address: draftTemplate.address || restaurant.address,
        city: restaurant.city,
        state: restaurant.state,
        phone: draftTemplate.phone || restaurant.phone,
        email: draftTemplate.email || restaurant.email,
        gstin: draftTemplate.gstin || restaurant.gstin,
      },
      templateSnapshot: draftTemplate,
      generatedBy: 'Live Preview',
      createdAt: new Date().toISOString(),
    };
  }, [draftTemplate, restaurant, otherLabel, otherAmount]);

  if (loading) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-8 text-sm text-slate-500">
        Loading billing configuration and receipt templates...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Billing & Receipt Settings</h2>
          <p className="text-sm text-slate-500">
            Configure outlet UPI payments, custom methods, and live-preview digital receipt templates.
          </p>
        </div>

        {draftTemplate && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowPreviewModal(true)}
              className="px-3.5 py-2 text-xs font-semibold bg-white border border-slate-300 text-slate-800 rounded-lg hover:bg-slate-50 flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <Eye className="w-3.5 h-3.5" />
              Preview Receipt
            </button>
            <button
              type="button"
              onClick={resetTemplate}
              disabled={savingTemplate}
              className="px-3.5 py-2 text-xs font-semibold bg-white border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 flex items-center gap-1.5 whitespace-nowrap cursor-pointer disabled:opacity-50"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset Default
            </button>
            <button
              type="button"
              onClick={saveTemplate}
              disabled={savingTemplate}
              className="px-3.5 py-2 text-xs font-semibold bg-slate-900 text-white rounded-lg hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap cursor-pointer disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5" />
              {savingTemplate ? 'Saving...' : 'Save Template'}
            </button>
            {!draftTemplate.isDefault && (
              <button
                type="button"
                onClick={setAsDefaultTemplate}
                disabled={savingTemplate}
                className="px-3.5 py-2 text-xs font-semibold bg-orange-600 text-white rounded-lg hover:bg-orange-700 flex items-center gap-1.5 whitespace-nowrap cursor-pointer disabled:opacity-50"
              >
                <Star className="w-3.5 h-3.5" />
                Set as Default
              </button>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-xs font-medium px-4 py-3 rounded-xl">
          {error}
        </div>
      )}
      {statusMsg && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-medium px-4 py-3 rounded-xl flex items-center gap-2">
          <Check className="w-4 h-4 text-emerald-600 shrink-0" />
          {statusMsg}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left: Controls */}
        <div className="xl:col-span-7 space-y-6">
          {/* UPI & Accepted Payment Methods */}
          <form
            onSubmit={savePaymentConfiguration}
            className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900">UPI & Payment Methods</h3>
                <p className="text-xs text-slate-500">
                  Customers see these methods when paying their table bill via QR.
                </p>
              </div>
              <button
                type="submit"
                disabled={savingSettings}
                className="px-3.5 py-2 text-xs font-semibold bg-slate-900 text-white rounded-lg hover:bg-slate-800 whitespace-nowrap cursor-pointer disabled:opacity-50"
              >
                {savingSettings ? 'Saving...' : 'Save Payment Rules'}
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Merchant UPI ID (VPA)
                </label>
                <input
                  value={upiId}
                  onChange={(e) => setUpiId(e.target.value)}
                  placeholder="restaurant@okaxis"
                  className="w-full px-3 py-2 text-sm font-mono-num border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  UPI Payee Display Name
                </label>
                <input
                  value={upiPayeeName}
                  onChange={(e) => setUpiPayeeName(e.target.value)}
                  placeholder="Spice Route Kitchen"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Other Charges Label (Optional)
                </label>
                <input
                  value={otherLabel}
                  onChange={(e) => setOtherLabel(e.target.value)}
                  placeholder="Packaging / Cutlery Fee"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Other Charges Amount (₹)
                </label>
                <input
                  type="number"
                  min={0}
                  step="1"
                  value={otherAmount}
                  onChange={(e) => setOtherAmount(Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm font-mono-num border border-slate-300 rounded-lg"
                />
              </div>
            </div>

            <div className="pt-2 border-t border-slate-100">
              <div className="text-xs font-medium text-slate-700 mb-2">Accepted Standard Methods</div>
              <div className="flex flex-wrap gap-3 text-xs">
                {[
                  { code: 'upi', label: 'UPI QR Code' },
                  { code: 'cash', label: 'Cash at Table / Counter' },
                  { code: 'card', label: 'Card Swipe / Tap' },
                  { code: 'razorpay', label: 'Online Gateway (Razorpay)' },
                ].map((m) => (
                  <label
                    key={m.code}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-200 bg-slate-50 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={acceptedMethods.includes(m.code)}
                      onChange={() => toggleAcceptedMethod(m.code)}
                    />
                    <span className="font-medium text-slate-800">{m.label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="pt-2 border-t border-slate-100 space-y-2.5">
              <div className="text-xs font-medium text-slate-700">
                Custom Owner-Configured Payment Methods
              </div>
              {customMethods.length > 0 && (
                <div className="space-y-1.5">
                  {customMethods.map((cm) => (
                    <div
                      key={cm.code}
                      className="flex items-center justify-between gap-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs"
                    >
                      <div className="min-w-0">
                        <span className="font-semibold text-slate-800">{cm.label}</span>
                        {cm.instructions && (
                          <span className="text-slate-500 ml-2">· {cm.instructions}</span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setCustomMethods((prev) => prev.filter((p) => p.code !== cm.code))
                        }
                        className="text-slate-400 hover:text-red-600 p-1 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
                <input
                  value={newMethodLabel}
                  onChange={(e) => setNewMethodLabel(e.target.value)}
                  placeholder="Method name (e.g. Sodexo / Wallet)"
                  className="sm:col-span-5 px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
                />
                <input
                  value={newMethodInstr}
                  onChange={(e) => setNewMethodInstr(e.target.value)}
                  placeholder="Instructions for guest"
                  className="sm:col-span-5 px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
                />
                <button
                  type="button"
                  onClick={addCustomMethod}
                  className="sm:col-span-2 px-3 py-1.5 text-xs font-semibold bg-slate-100 text-slate-800 hover:bg-slate-200 rounded-lg flex items-center justify-center gap-1 whitespace-nowrap cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" /> Add
                </button>
              </div>
            </div>
          </form>

          {/* Template Selector & Editor */}
          {draftTemplate && (
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-5">
              <div>
                <h3 className="text-sm font-bold text-slate-900">1. Choose Receipt Template</h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mt-3">
                  {templates.map((tpl) => {
                    const active = tpl.id === selectedId;
                    return (
                      <button
                        key={tpl.id}
                        type="button"
                        onClick={() => handleSelectTemplate(tpl)}
                        className={`p-3 rounded-xl border text-left transition cursor-pointer ${
                          active
                            ? 'border-orange-500 bg-orange-50/70'
                            : 'border-slate-200 bg-white hover:border-slate-300'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-xs font-bold text-slate-900 truncate">
                            {tpl.name}
                          </span>
                          {tpl.isDefault && (
                            <Star className="w-3.5 h-3.5 text-orange-600 fill-orange-500 shrink-0" />
                          )}
                        </div>
                        <div className="text-[11px] text-slate-500 mt-1">
                          {tpl.paperSize} · {tpl.fontStyle}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Branding & Content */}
              <div className="pt-4 border-t border-slate-100 space-y-3.5">
                <h3 className="text-sm font-bold text-slate-900">2. Restaurant Branding & Copy</h3>

                <div className="flex flex-wrap items-center gap-3">
                  {draftTemplate.logoUrl && (
                    <img
                      src={draftTemplate.logoUrl}
                      alt="Logo preview"
                      className="h-12 w-12 object-contain rounded-lg border border-slate-200 bg-white p-1"
                    />
                  )}
                  <label className="px-3.5 py-2 text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg flex items-center gap-1.5 cursor-pointer whitespace-nowrap">
                    <Upload className="w-3.5 h-3.5" />
                    {uploadingLogo ? 'Uploading...' : 'Upload Logo (PNG/JPG/WEBP)'}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) handleLogoUpload(f);
                      }}
                    />
                  </label>
                  {draftTemplate.logoUrl && (
                    <button
                      type="button"
                      onClick={() => setDraftTemplate({ ...draftTemplate, logoUrl: '' })}
                      className="text-xs text-slate-500 hover:text-red-600 cursor-pointer"
                    >
                      Remove Logo
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Business Display Name
                    </label>
                    <input
                      value={draftTemplate.businessName}
                      onChange={(e) =>
                        setDraftTemplate({ ...draftTemplate, businessName: e.target.value })
                      }
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">GSTIN</label>
                    <input
                      value={draftTemplate.gstin}
                      onChange={(e) =>
                        setDraftTemplate({ ...draftTemplate, gstin: e.target.value })
                      }
                      className="w-full px-3 py-2 text-sm font-mono-num border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Outlet Address
                    </label>
                    <input
                      value={draftTemplate.address}
                      onChange={(e) =>
                        setDraftTemplate({ ...draftTemplate, address: e.target.value })
                      }
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Contact Number
                    </label>
                    <input
                      value={draftTemplate.phone}
                      onChange={(e) =>
                        setDraftTemplate({ ...draftTemplate, phone: e.target.value })
                      }
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Contact Email
                    </label>
                    <input
                      value={draftTemplate.email}
                      onChange={(e) =>
                        setDraftTemplate({ ...draftTemplate, email: e.target.value })
                      }
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Header Message
                    </label>
                    <input
                      value={draftTemplate.headerMessage}
                      onChange={(e) =>
                        setDraftTemplate({ ...draftTemplate, headerMessage: e.target.value })
                      }
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Thank-You Message
                    </label>
                    <input
                      value={draftTemplate.thankYouMessage}
                      onChange={(e) =>
                        setDraftTemplate({ ...draftTemplate, thankYouMessage: e.target.value })
                      }
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Footer Note (Terms / Feedback Link)
                    </label>
                    <input
                      value={draftTemplate.footerMessage}
                      onChange={(e) =>
                        setDraftTemplate({ ...draftTemplate, footerMessage: e.target.value })
                      }
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Instagram Handle
                    </label>
                    <input
                      value={draftTemplate.socialHandles?.instagram || ''}
                      onChange={(e) =>
                        setDraftTemplate({
                          ...draftTemplate,
                          socialHandles: {
                            ...draftTemplate.socialHandles,
                            instagram: e.target.value,
                          },
                        })
                      }
                      placeholder="@spiceroute.blr"
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Website</label>
                    <input
                      value={draftTemplate.socialHandles?.website || ''}
                      onChange={(e) =>
                        setDraftTemplate({
                          ...draftTemplate,
                          socialHandles: {
                            ...draftTemplate.socialHandles,
                            website: e.target.value,
                          },
                        })
                      }
                      placeholder="https://spiceroutekitchen.in"
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>
              </div>

              {/* Layout & Styling */}
              <div className="pt-4 border-t border-slate-100 space-y-3.5">
                <h3 className="text-sm font-bold text-slate-900">3. Styling & Paper Format</h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Paper Width
                    </label>
                    <select
                      value={draftTemplate.paperSize}
                      onChange={(e) =>
                        setDraftTemplate({ ...draftTemplate, paperSize: e.target.value })
                      }
                      className="w-full px-2.5 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="58mm">58mm Thermal</option>
                      <option value="80mm">80mm Thermal</option>
                      <option value="A4">A4 Invoice</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Font Style
                    </label>
                    <select
                      value={draftTemplate.fontStyle}
                      onChange={(e) =>
                        setDraftTemplate({ ...draftTemplate, fontStyle: e.target.value })
                      }
                      className="w-full px-2.5 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="mono">Thermal Mono</option>
                      <option value="sans">Modern Sans</option>
                      <option value="serif">Editorial Serif</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Font Size
                    </label>
                    <select
                      value={draftTemplate.fontSize}
                      onChange={(e) =>
                        setDraftTemplate({ ...draftTemplate, fontSize: e.target.value })
                      }
                      className="w-full px-2.5 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="sm">Small</option>
                      <option value="md">Medium</option>
                      <option value="lg">Large</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Header Layout
                    </label>
                    <select
                      value={draftTemplate.layoutMode}
                      onChange={(e) =>
                        setDraftTemplate({ ...draftTemplate, layoutMode: e.target.value })
                      }
                      className="w-full px-2.5 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="centered">Centered</option>
                      <option value="left">Left Aligned</option>
                      <option value="compact">Compact</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Brand Accent Color
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    {ACCENT_PRESETS.map((hex) => (
                      <button
                        key={hex}
                        type="button"
                        onClick={() => setDraftTemplate({ ...draftTemplate, accentColor: hex })}
                        className={`w-7 h-7 rounded-full border-2 cursor-pointer ${
                          draftTemplate.accentColor === hex
                            ? 'border-slate-900 scale-110'
                            : 'border-white shadow-xs'
                        }`}
                        style={{ backgroundColor: hex }}
                        aria-label={`Select color ${hex}`}
                      />
                    ))}
                    <input
                      type="color"
                      value={draftTemplate.accentColor}
                      onChange={(e) =>
                        setDraftTemplate({ ...draftTemplate, accentColor: e.target.value })
                      }
                      className="w-8 h-8 rounded cursor-pointer border border-slate-300 p-0.5"
                    />
                  </div>
                </div>
              </div>

              {/* Field Visibility */}
              <div className="pt-4 border-t border-slate-100 space-y-2.5">
                <h3 className="text-sm font-bold text-slate-900">4. Receipt Visibility Controls</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs">
                  {VISIBILITY_LABELS.map((item) => (
                    <label key={item.key} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={Boolean(draftTemplate.visibility[item.key])}
                        onChange={(e) =>
                          setDraftTemplate({
                            ...draftTemplate,
                            visibility: {
                              ...draftTemplate.visibility,
                              [item.key]: e.target.checked,
                            },
                          })
                        }
                      />
                      <span className="text-slate-700">{item.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right: Sticky Live Preview */}
        <div className="xl:col-span-5 xl:sticky xl:top-6 space-y-3">
          <div className="bg-slate-100 border border-slate-200 rounded-xl p-5">
            <div className="flex items-center justify-between gap-2 mb-4">
              <div>
                <div className="text-xs font-bold uppercase tracking-wider text-slate-700">
                  Live Receipt Preview
                </div>
                <div className="text-[11px] text-slate-500">
                  Historical paid receipts stay frozen; new bills use your active default template.
                </div>
              </div>
              {draftTemplate?.isDefault && (
                <span className="text-[11px] font-semibold text-orange-700 bg-orange-100 px-2.5 py-0.5 rounded-md whitespace-nowrap">
                  Active Default
                </span>
              )}
            </div>

            {sampleReceipt && <ReceiptDocument receipt={sampleReceipt} isPreview />}
          </div>
        </div>
      </div>

      {showPreviewModal && sampleReceipt && (
        <DigitalReceiptModal
          receipt={sampleReceipt}
          onClose={() => setShowPreviewModal(false)}
        />
      )}
    </div>
  );
};
