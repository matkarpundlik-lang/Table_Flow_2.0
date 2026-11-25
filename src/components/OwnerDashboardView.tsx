import React, { useEffect, useState } from 'react';
import { AlertTriangle, ArrowUpRight, RefreshCw } from 'lucide-react';
import { apiFetch, formatInr } from '../lib/api';
import { DashboardSummary } from '../types/dineflow';
import { BestSellersChart, PaymentMixChart, RevenueExpenseChart } from './Charts';

export const OwnerDashboardView: React.FC<{
  onNavigate: (tab: string) => void;
  refreshTick: number;
}> = ({ onNavigate, refreshTick }) => {
  const [range, setRange] = useState<'today' | '7d' | '30d' | 'all'>('7d');
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadSummary = async () => {
    setLoading(true);
    try {
      const data = await apiFetch<DashboardSummary>(`/dashboard/summary?range=${range}`);
      setSummary(data);
      setError('');
    } catch (err: any) {
      setError(err.message || 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSummary();
  }, [range, refreshTick]);

  const kpis = summary?.kpis;

  const statCards = kpis
    ? [
        { label: "Today's Revenue", value: formatInr(kpis.todaysRevenue), sub: 'Realized + Active Today' },
        { label: 'Total Orders', value: String(kpis.totalOrders), sub: `${kpis.completedOrders} completed · ${kpis.pendingOrders} active` },
        { label: 'Average Order Value', value: formatInr(kpis.averageOrderValue), sub: 'Per non-cancelled ticket' },
        { label: 'Active Tables', value: `${kpis.activeTables} / ${kpis.totalTables}`, sub: 'Occupied or billing now' },
        { label: 'Pending Orders', value: String(kpis.pendingOrders), sub: 'New to Served queue' },
        { label: 'Completed Orders', value: String(kpis.completedOrders), sub: 'Paid & Closed bills' },
        { label: 'Monthly Expenses', value: formatInr(kpis.monthlyExpenses), sub: 'Logged outlet spend' },
        {
          label: 'Estimated Profit',
          value: formatInr(kpis.estimatedProfit),
          sub: `${range.toUpperCase()} Revenue - Expenses`,
          accent: kpis.estimatedProfit >= 0 ? 'text-emerald-700' : 'text-red-600',
        },
      ]
    : [];

  return (
    <div className="space-y-6">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Executive Overview</h2>
          <p className="text-sm text-slate-500">
            Live financial, floor, and kitchen metrics computed directly from PostgreSQL records.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg border border-slate-200">
            {[
              { id: 'today', label: 'Today' },
              { id: '7d', label: '7 Days' },
              { id: '30d', label: '30 Days' },
              { id: 'all', label: 'All Time' },
            ].map((opt) => (
              <button
                key={opt.id}
                onClick={() => setRange(opt.id as typeof range)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                  range === opt.id
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button
            onClick={loadSummary}
            className="p-2 bg-white border border-slate-200 rounded-lg text-slate-600 hover:text-slate-900 cursor-pointer"
            title="Refresh dashboard"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl">
          {error}
        </div>
      )}

      {/* 8-Card KPI Grid */}
      {loading && !summary ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-24 bg-white border border-slate-200 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {statCards.map((card) => (
            <div key={card.label} className="bg-white border border-slate-200 rounded-xl p-4 space-y-1.5">
              <div className="text-xs font-medium text-slate-500">{card.label}</div>
              <div className={`text-2xl font-bold font-mono-num ${card.accent || 'text-slate-900'}`}>
                {card.value}
              </div>
              <div className="text-xs text-slate-500">{card.sub}</div>
            </div>
          ))}
        </div>
      )}

      {/* Charts Row */}
      {summary && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold text-slate-900">Revenue vs. Expenses</h3>
                <p className="text-xs text-slate-500">Daily comparison across realized orders and logged expenses</p>
              </div>
              <span className="text-sm font-mono-num font-bold text-slate-900">
                {formatInr(summary.kpis.rangeRevenue)}
              </span>
            </div>
            <RevenueExpenseChart data={summary.dailySeries} />
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div>
              <h3 className="text-base font-semibold text-slate-900">Payment Method Mix</h3>
              <p className="text-xs text-slate-500">Verified settlements by channel</p>
            </div>
            <PaymentMixChart data={summary.paymentMethods} />
          </div>
        </div>
      )}

      {/* Best Sellers, Low Stock Alerts & Recent Transactions */}
      {summary && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">Best-Selling Products</h3>
              <button
                onClick={() => onNavigate('menu')}
                className="text-xs font-medium text-orange-600 hover:text-orange-700 flex items-center gap-0.5 cursor-pointer"
              >
                Menu <ArrowUpRight className="w-3.5 h-3.5" />
              </button>
            </div>
            <BestSellersChart items={summary.bestSellingProducts} />
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">Low-Stock Alerts</h3>
              <button
                onClick={() => onNavigate('inventory')}
                className="text-xs font-medium text-orange-600 hover:text-orange-700 flex items-center gap-0.5 cursor-pointer"
              >
                Restock <ArrowUpRight className="w-3.5 h-3.5" />
              </button>
            </div>
            {summary.lowStockAlerts.length === 0 ? (
              <div className="py-10 text-center text-sm text-slate-500">
                All tracked ingredients are above reorder thresholds.
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {summary.lowStockAlerts.map((item) => (
                  <div key={item.id} className="py-2.5 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-900 truncate flex items-center gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                        {item.name}
                      </div>
                      <div className="text-xs text-slate-500">
                        Reorder threshold: {item.reorderLevel} {item.unit}
                      </div>
                    </div>
                    <span className="text-xs font-mono-num font-bold text-red-700 bg-red-50 px-2 py-1 rounded-md shrink-0">
                      {item.currentStock.toFixed(1)} {item.unit}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">Recent Transactions</h3>
              <button
                onClick={() => onNavigate('orders')}
                className="text-xs font-medium text-orange-600 hover:text-orange-700 flex items-center gap-0.5 cursor-pointer"
              >
                All Bills <ArrowUpRight className="w-3.5 h-3.5" />
              </button>
            </div>
            {summary.recentTransactions.length === 0 ? (
              <div className="py-10 text-center text-sm text-slate-500">
                No completed payment transactions yet.
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {summary.recentTransactions.map((tx) => (
                  <div key={tx.id} className="py-2.5 flex items-center justify-between gap-2 text-sm">
                    <div className="min-w-0">
                      <div className="font-medium text-slate-900 truncate">
                        {tx.orderNumber} · {tx.customerName}
                      </div>
                      <div className="text-xs text-slate-500 uppercase">
                        {tx.method} · {new Date(tx.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                    <span className="font-mono-num font-semibold text-emerald-700 shrink-0">
                      {formatInr(tx.amount)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
