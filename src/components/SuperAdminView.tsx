import React, { useEffect, useState } from 'react';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { apiFetch, formatInr } from '../lib/api';
import { PlatformPlan, Restaurant } from '../types/dineflow';

interface AdminRestaurant extends Restaurant {
  ordersCount: number;
  gmv: number;
}

interface PlatformSettings {
  id: number;
  platformName: string;
  supportEmail: string;
  defaultGstRate: number;
  maintenanceMode: boolean;
  allowSelfRegistration: boolean;
}

export const SuperAdminView: React.FC<{
  onSwitchToRestaurant: (rest: Restaurant) => void;
}> = ({ onSwitchToRestaurant }) => {
  const [restaurants, setRestaurants] = useState<AdminRestaurant[]>([]);
  const [plans, setPlans] = useState<PlatformPlan[]>([]);
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [totals, setTotals] = useState({
    totalRestaurants: 0,
    activeRestaurants: 0,
    totalOrders: 0,
    totalGmv: 0,
  });
  const [loading, setLoading] = useState(true);

  const loadOverview = async () => {
    try {
      const res = await apiFetch<{
        restaurants: AdminRestaurant[];
        plans: PlatformPlan[];
        settings: PlatformSettings;
        totals: typeof totals;
      }>('/super-admin/overview');
      setRestaurants(res.restaurants);
      setPlans(res.plans);
      setSettings(res.settings);
      setTotals(res.totals);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadOverview();
  }, []);

  const handleUpdateRestaurant = async (id: number, patch: Record<string, unknown>) => {
    await apiFetch(`/super-admin/restaurants/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    await loadOverview();
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    await apiFetch('/super-admin/settings', {
      method: 'PATCH',
      body: JSON.stringify(settings),
    });
    await loadOverview();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-orange-600" />
            DineFlow Platform Super Admin
          </h2>
          <p className="text-sm text-slate-500">
            Govern multi-tenant restaurants, subscription tiers, platform GMV, and system configuration.
          </p>
        </div>
      </div>

      {/* Global Platform KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">Total Restaurants</div>
          <div className="text-2xl font-bold font-mono-num text-slate-900 mt-1">
            {totals.totalRestaurants}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">Active Tenants</div>
          <div className="text-2xl font-bold font-mono-num text-emerald-700 mt-1">
            {totals.activeRestaurants}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">Platform Orders</div>
          <div className="text-2xl font-bold font-mono-num text-slate-900 mt-1">
            {totals.totalOrders}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">Platform GMV</div>
          <div className="text-2xl font-bold font-mono-num text-orange-600 mt-1">
            {formatInr(totals.totalGmv)}
          </div>
        </div>
      </div>

      {/* Tenant Directory */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 font-semibold text-sm text-slate-900">
          Registered Restaurant Tenants
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                <th className="py-3 px-4">Restaurant</th>
                <th className="py-3 px-4">Plan</th>
                <th className="py-3 px-4 text-right">Orders</th>
                <th className="py-3 px-4 text-right">GMV</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Workspace</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {loading ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-slate-400">
                    Loading tenants...
                  </td>
                </tr>
              ) : (
                restaurants.map((r) => (
                  <tr key={r.id}>
                    <td className="py-3 px-4">
                      <div className="font-semibold text-slate-900">{r.name}</div>
                      <div className="text-xs text-slate-500">
                        {r.city} · {r.email}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <select
                        value={r.planId || ''}
                        onChange={(e) =>
                          handleUpdateRestaurant(r.id, { planId: Number(e.target.value) })
                        }
                        className="px-2.5 py-1 text-xs border border-slate-200 rounded-lg bg-white"
                      >
                        {plans.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({formatInr(p.monthlyPriceInr)}/mo)
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-3 px-4 text-right font-mono-num">{r.ordersCount}</td>
                    <td className="py-3 px-4 text-right font-mono-num font-semibold">
                      {formatInr(r.gmv)}
                    </td>
                    <td className="py-3 px-4">
                      <button
                        onClick={() => handleUpdateRestaurant(r.id, { isActive: !r.isActive })}
                        className={`px-2.5 py-1 text-xs font-semibold rounded border cursor-pointer ${
                          r.isActive
                            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                            : 'bg-red-50 text-red-700 border-red-200'
                        }`}
                      >
                        {r.isActive ? 'Active' : 'Suspended'}
                      </button>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        onClick={() => onSwitchToRestaurant(r)}
                        className="px-3 py-1.5 text-xs font-semibold bg-slate-900 text-white rounded-lg inline-flex items-center gap-1 cursor-pointer"
                      >
                        Inspect <ArrowRight className="w-3 h-3" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Plans & System Settings */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
          <h3 className="text-sm font-bold text-slate-900">SaaS Subscription Tiers</h3>
          <div className="divide-y divide-slate-100">
            {plans.map((p) => (
              <div key={p.id} className="py-3 flex items-center justify-between gap-4 text-sm">
                <div>
                  <div className="font-semibold text-slate-900">{p.name}</div>
                  <div className="text-xs text-slate-500">
                    Up to {p.maxTables} tables · {p.maxStaff} staff
                  </div>
                </div>
                <span className="font-mono-num font-bold text-slate-900">
                  {formatInr(p.monthlyPriceInr)}/mo
                </span>
              </div>
            ))}
          </div>
        </div>

        {settings && (
          <form
            onSubmit={handleSaveSettings}
            className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
          >
            <h3 className="text-sm font-bold text-slate-900">Global Platform Settings</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-600 mb-1">Platform Name</label>
                <input
                  value={settings.platformName}
                  onChange={(e) => setSettings({ ...settings, platformName: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-600 mb-1">Support Email</label>
                <input
                  value={settings.supportEmail}
                  onChange={(e) => setSettings({ ...settings, supportEmail: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
            </div>
            <div className="flex items-center gap-5 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={settings.allowSelfRegistration}
                  onChange={(e) =>
                    setSettings({ ...settings, allowSelfRegistration: e.target.checked })
                  }
                />
                Allow Self-Service Outlet Registration
              </label>
            </div>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold bg-orange-600 text-white rounded-lg cursor-pointer"
            >
              Update Platform Config
            </button>
          </form>
        )}
      </div>
    </div>
  );
};
