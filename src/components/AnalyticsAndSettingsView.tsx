import React, { useEffect, useState } from 'react';
import { Download, Save } from 'lucide-react';
import { apiFetch, formatInr, getActiveRestaurantId, getAuthToken } from '../lib/api';
import { DashboardSummary, Restaurant } from '../types/dineflow';

export const AnalyticsView: React.FC = () => {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [range, setRange] = useState<'7d' | '30d' | 'all'>('30d');

  useEffect(() => {
    apiFetch<DashboardSummary>(`/dashboard/summary?range=${range}`)
      .then(setSummary)
      .catch(console.error);
  }, [range]);

  const downloadCsv = async (type: 'sales' | 'expenses' | 'inventory') => {
    const token = getAuthToken();
    const restId = getActiveRestaurantId();
    const res = await fetch(`/api/reports/export?type=${type}`, {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(restId ? { 'x-restaurant-id': String(restId) } : {}),
      },
    });
    const text = await res.text();
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dineflow-${type}-report.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Analytics & CSV Reports</h2>
          <p className="text-sm text-slate-500">
            Profit & Loss breakdown, menu velocity, payment reconciliation, and downloadable CSV ledgers.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={range}
            onChange={(e) => setRange(e.target.value as typeof range)}
            className="px-3 py-2 text-xs font-medium bg-white border border-slate-200 rounded-lg"
          >
            <option value="7d">Last 7 Days</option>
            <option value="30d">Last 30 Days</option>
            <option value="all">All Time</option>
          </select>
          <button
            onClick={() => downloadCsv('sales')}
            className="px-3 py-2 text-xs font-semibold bg-slate-900 text-white rounded-lg flex items-center gap-1.5 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" /> Sales CSV
          </button>
          <button
            onClick={() => downloadCsv('expenses')}
            className="px-3 py-2 text-xs font-semibold bg-white border border-slate-300 text-slate-800 rounded-lg flex items-center gap-1.5 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" /> Expenses CSV
          </button>
          <button
            onClick={() => downloadCsv('inventory')}
            className="px-3 py-2 text-xs font-semibold bg-white border border-slate-300 text-slate-800 rounded-lg flex items-center gap-1.5 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" /> Inventory CSV
          </button>
        </div>
      </div>

      {summary && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="text-xs text-slate-500">Period Revenue</div>
            <div className="text-2xl font-bold font-mono-num text-slate-900 mt-1">
              {formatInr(summary.kpis.rangeRevenue)}
            </div>
            <div className="text-xs text-slate-500 mt-1">{summary.kpis.totalOrders} orders</div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="text-xs text-slate-500">Monthly Operating Expenses</div>
            <div className="text-2xl font-bold font-mono-num text-slate-900 mt-1">
              {formatInr(summary.kpis.monthlyExpenses)}
            </div>
            <div className="text-xs text-slate-500 mt-1">Recorded vendor & utility spend</div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="text-xs text-slate-500">Net Estimated P&L</div>
            <div
              className={`text-2xl font-bold font-mono-num mt-1 ${
                summary.kpis.estimatedProfit >= 0 ? 'text-emerald-700' : 'text-red-600'
              }`}
            >
              {formatInr(summary.kpis.estimatedProfit)}
            </div>
            <div className="text-xs text-slate-500 mt-1">AOV {formatInr(summary.kpis.averageOrderValue)}</div>
          </div>
        </div>
      )}

      {summary && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 font-semibold text-sm text-slate-900">
            Daily Sales & Expense Ledger
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <th className="py-3 px-4">Date</th>
                  <th className="py-3 px-4 text-right">Orders</th>
                  <th className="py-3 px-4 text-right">Revenue</th>
                  <th className="py-3 px-4 text-right">Expenses</th>
                  <th className="py-3 px-4 text-right">Daily Net</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm font-mono-num">
                {summary.dailySeries.map((d) => {
                  const net = d.revenue - d.expenses;
                  return (
                    <tr key={d.date}>
                      <td className="py-2.5 px-4 text-slate-700">{d.date}</td>
                      <td className="py-2.5 px-4 text-right">{d.orders}</td>
                      <td className="py-2.5 px-4 text-right text-slate-900">{formatInr(d.revenue)}</td>
                      <td className="py-2.5 px-4 text-right text-slate-600">{formatInr(d.expenses)}</td>
                      <td
                        className={`py-2.5 px-4 text-right font-semibold ${
                          net >= 0 ? 'text-emerald-700' : 'text-red-600'
                        }`}
                      >
                        {formatInr(net)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export const SettingsView: React.FC<{
  restaurant: Restaurant;
  canManageSettings: boolean;
  onUpdated: (rest: Restaurant) => void;
}> = ({ restaurant, canManageSettings, onUpdated }) => {
  const [form, setForm] = useState<Restaurant>(restaurant);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');

  useEffect(() => {
    setForm(restaurant);
  }, [restaurant]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSavedMsg('');
    try {
      const res = await apiFetch<{ restaurant: Restaurant }>('/settings', {
        method: 'PATCH',
        body: JSON.stringify(form),
      });
      onUpdated(res.restaurant);
      setSavedMsg('Restaurant configuration saved.');
    } catch (err: any) {
      setSavedMsg(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h2 className="text-xl font-bold text-slate-900">Restaurant Settings & Tax Rules</h2>
        <p className="text-sm text-slate-500">
          Configure outlet profile, GSTIN, service charge, receipt branding, and QR ordering behavior.
        </p>
      </div>

      <form onSubmit={handleSave} className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Restaurant Name</label>
            <input
              disabled={!canManageSettings}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Tagline</label>
            <input
              disabled={!canManageSettings}
              value={form.tagline || ''}
              onChange={(e) => setForm({ ...form, tagline: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Address</label>
            <input
              disabled={!canManageSettings}
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Opening Hours</label>
            <input
              disabled={!canManageSettings}
              value={form.openingHours}
              onChange={(e) => setForm({ ...form, openingHours: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">GSTIN</label>
            <input
              disabled={!canManageSettings}
              value={form.gstin || ''}
              onChange={(e) => setForm({ ...form, gstin: e.target.value })}
              className="w-full px-3 py-2 text-sm font-mono-num border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">FSSAI License</label>
            <input
              disabled={!canManageSettings}
              value={form.fssaiNo || ''}
              onChange={(e) => setForm({ ...form, fssaiNo: e.target.value })}
              className="w-full px-3 py-2 text-sm font-mono-num border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">GST Rate (%)</label>
            <input
              type="number"
              step="0.5"
              disabled={!canManageSettings}
              value={form.gstRate}
              onChange={(e) => setForm({ ...form, gstRate: Number(e.target.value) })}
              className="w-full px-3 py-2 text-sm font-mono-num border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Service Charge (%)</label>
            <input
              type="number"
              step="0.5"
              disabled={!canManageSettings}
              value={form.serviceChargeRate}
              onChange={(e) => setForm({ ...form, serviceChargeRate: Number(e.target.value) })}
              className="w-full px-3 py-2 text-sm font-mono-num border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Receipt Header</label>
            <input
              disabled={!canManageSettings}
              value={form.receiptHeader || ''}
              onChange={(e) => setForm({ ...form, receiptHeader: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Receipt Footer</label>
            <input
              disabled={!canManageSettings}
              value={form.receiptFooter || ''}
              onChange={(e) => setForm({ ...form, receiptFooter: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-6 pt-2 border-t border-slate-100 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              disabled={!canManageSettings}
              checked={form.qrOrderingEnabled}
              onChange={(e) => setForm({ ...form, qrOrderingEnabled: e.target.checked })}
            />
            Enable Customer QR Ordering
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              disabled={!canManageSettings}
              checked={form.autoAcceptQrOrders}
              onChange={(e) => setForm({ ...form, autoAcceptQrOrders: e.target.checked })}
            />
            Auto-Accept QR Orders to Kitchen
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              disabled={!canManageSettings}
              checked={form.soundAlertsEnabled}
              onChange={(e) => setForm({ ...form, soundAlertsEnabled: e.target.checked })}
            />
            KDS Sound Chime Alerts
          </label>
        </div>

        {savedMsg && <p className="text-xs font-medium text-emerald-700">{savedMsg}</p>}

        {canManageSettings && (
          <button
            type="submit"
            disabled={saving}
            className="px-5 py-2.5 text-sm font-semibold bg-orange-600 hover:bg-orange-700 text-white rounded-lg flex items-center gap-2 cursor-pointer"
          >
            <Save className="w-4 h-4" />
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        )}
      </form>
    </div>
  );
};
