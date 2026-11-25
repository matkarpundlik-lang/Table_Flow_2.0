import React, { useEffect, useMemo, useState } from 'react';
import { Check, ChefHat, Clock, Volume2, VolumeX } from 'lucide-react';
import { apiFetch, formatElapsedMinutes, playKitchenChime } from '../lib/api';
import { Order } from '../types/dineflow';

export const KitchenDisplay: React.FC<{
  refreshTick: number;
  soundEnabled: boolean;
}> = ({ refreshTick, soundEnabled: initialSound }) => {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'active' | 'New' | 'Accepted' | 'Preparing' | 'Ready'>('active');
  const [soundOn, setSoundOn] = useState(initialSound);
  const [busyOrderIds, setBusyOrderIds] = useState<Record<number, boolean>>({});
  const [errorMsg, setErrorMsg] = useState('');
  const [, setTick] = useState(0);

  const loadOrders = async () => {
    try {
      const res = await apiFetch<{ orders: Order[] }>('/orders');
      setOrders(res.orders);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to load kitchen orders');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadOrders();
  }, [refreshTick]);

  // Refresh elapsed wait timers every 30s
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  const kdsOrders = useMemo(() => {
    const activeStatuses = ['New', 'Accepted', 'Preparing', 'Ready'];
    return orders
      .filter((o) => {
        if (filter === 'active') return activeStatuses.includes(o.status);
        return o.status === filter;
      })
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }, [orders, filter]);

  const updateOrderStatus = async (orderId: number, status: string) => {
    if (busyOrderIds[orderId]) return;
    setErrorMsg('');
    setBusyOrderIds((prev) => ({ ...prev, [orderId]: true }));
    try {
      await apiFetch(`/orders/${orderId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      await loadOrders();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Could not update kitchen order status');
      await loadOrders();
    } finally {
      setBusyOrderIds((prev) => ({ ...prev, [orderId]: false }));
    }
  };

  const toggleItemStatus = async (orderId: number, itemId: number, current: string) => {
    if (busyOrderIds[orderId] || current === 'Ready' || current === 'Served') return;
    const next = current === 'Queued' ? 'Preparing' : 'Ready';
    setErrorMsg('');
    setBusyOrderIds((prev) => ({ ...prev, [orderId]: true }));
    try {
      await apiFetch(`/orders/${orderId}/items/${itemId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: next }),
      });
      await loadOrders();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Could not update item status');
      await loadOrders();
    } finally {
      setBusyOrderIds((prev) => ({ ...prev, [orderId]: false }));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Kitchen Display System</h2>
          <p className="text-sm text-slate-500">
            Live KOT queue sorted oldest-first. Tap any dish to update prep state or bump finished tickets.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 p-1 bg-slate-100 border border-slate-200 rounded-lg">
            {[
              { id: 'active', label: 'All Active' },
              { id: 'New', label: 'New' },
              { id: 'Accepted', label: 'Accepted' },
              { id: 'Preparing', label: 'Preparing' },
              { id: 'Ready', label: 'Ready' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setFilter(tab.id as typeof filter)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer whitespace-nowrap ${
                  filter === tab.id ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <button
            onClick={() => {
              const next = !soundOn;
              setSoundOn(next);
              if (next) playKitchenChime();
            }}
            className={`px-3.5 py-2 text-xs font-medium rounded-lg border flex items-center gap-1.5 cursor-pointer ${
              soundOn
                ? 'bg-orange-50 border-orange-200 text-orange-800'
                : 'bg-white border-slate-200 text-slate-600'
            }`}
          >
            {soundOn ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
            {soundOn ? 'Sound Chime On' : 'Muted'}
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2.5 rounded-lg flex items-center justify-between">
          <span>{errorMsg}</span>
          <button onClick={() => setErrorMsg('')} className="text-xs underline cursor-pointer">
            Dismiss
          </button>
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-64 bg-white border border-slate-200 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : kdsOrders.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center space-y-2">
          <ChefHat className="w-8 h-8 text-slate-400 mx-auto" />
          <p className="text-base font-semibold text-slate-900">Kitchen Queue Clear</p>
          <p className="text-sm text-slate-500">
            New dine-in, takeaway, parcel, and QR orders appear here instantly with audio chimes.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-start">
          {kdsOrders.map((ord) => {
            const elapsed = formatElapsedMinutes(ord.createdAt);
            const isDelayed = elapsed.mins >= 20;
            const isWarning = elapsed.mins >= 10 && elapsed.mins < 20;

            return (
              <div
                key={ord.id}
                className="bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col"
              >
                <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono-num font-bold text-base text-slate-900">
                        {ord.orderNumber}
                      </span>
                      <span className="text-xs font-semibold text-slate-700">
                        {ord.tableNumber
                          ? `Table ${ord.tableNumber}`
                          : ord.orderType.toUpperCase()}
                      </span>
                    </div>
                    <div className="text-xs text-slate-500">
                      {ord.source === 'qr' ? 'QR Guest Order' : 'POS Ticket'} · {ord.status}
                    </div>
                  </div>

                  <div
                    className={`px-2.5 py-1 rounded-md text-xs font-mono-num font-semibold flex items-center gap-1 ${
                      isDelayed
                        ? 'bg-red-50 text-red-700 border border-red-200'
                        : isWarning
                        ? 'bg-amber-50 text-amber-800 border border-amber-200'
                        : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                    }`}
                  >
                    <Clock className="w-3.5 h-3.5" />
                    {elapsed.label}
                  </div>
                </div>

                <div className="p-4 space-y-2.5 flex-1">
                  {ord.specialInstructions && (
                    <div className="text-xs bg-amber-50 border border-amber-200 text-amber-900 px-3 py-2 rounded-lg">
                      Note: {ord.specialInstructions}
                    </div>
                  )}

                  <div className="divide-y divide-slate-100">
                    {ord.items.map((item) => (
                      <button
                        key={item.id}
                        disabled={Boolean(busyOrderIds[ord.id]) || item.status === 'Ready' || item.status === 'Served'}
                        onClick={() => toggleItemStatus(ord.id, item.id, item.status)}
                        className="w-full py-2.5 text-left flex items-start justify-between gap-3 hover:bg-slate-50 rounded-md px-1 transition-colors cursor-pointer disabled:cursor-default disabled:hover:bg-transparent"
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-slate-900">
                            <span className="font-mono-num text-orange-600 mr-1.5">
                              {item.quantity}×
                            </span>
                            <span className={item.status === 'Ready' ? 'line-through text-slate-400' : ''}>
                              {item.itemName}
                            </span>
                          </div>
                          {(item.selectedVariant || item.selectedAddons.length > 0 || item.specialInstructions) && (
                            <div className="text-xs text-slate-500 mt-0.5">
                              {item.selectedVariant?.name}
                              {item.selectedAddons.length > 0 &&
                                ` + ${item.selectedAddons.map((a) => a.name).join(', ')}`}
                              {item.specialInstructions && ` · ${item.specialInstructions}`}
                            </div>
                          )}
                        </div>
                        <span
                          className={`text-[11px] font-semibold px-2 py-0.5 rounded shrink-0 ${
                            item.status === 'Ready'
                              ? 'bg-emerald-100 text-emerald-800'
                              : item.status === 'Preparing'
                              ? 'bg-orange-100 text-orange-800'
                              : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {item.status}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="p-3 border-t border-slate-100 bg-slate-50 flex items-center gap-2">
                  {ord.status === 'New' && (
                    <button
                      disabled={Boolean(busyOrderIds[ord.id])}
                      onClick={() => updateOrderStatus(ord.id, 'Accepted')}
                      className="flex-1 py-2 text-xs font-semibold bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white rounded-lg cursor-pointer"
                    >
                      Accept KOT
                    </button>
                  )}
                  {(ord.status === 'New' || ord.status === 'Accepted') && (
                    <button
                      disabled={Boolean(busyOrderIds[ord.id])}
                      onClick={() => updateOrderStatus(ord.id, 'Preparing')}
                      className="flex-1 py-2 text-xs font-semibold bg-orange-600 hover:bg-orange-700 disabled:opacity-50 text-white rounded-lg cursor-pointer"
                    >
                      Start Preparing
                    </button>
                  )}
                  {ord.status !== 'Ready' && (
                    <button
                      disabled={Boolean(busyOrderIds[ord.id])}
                      onClick={() => updateOrderStatus(ord.id, 'Ready')}
                      className="flex-1 py-2 text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg flex items-center justify-center gap-1 cursor-pointer"
                    >
                      <Check className="w-3.5 h-3.5" />
                      Mark Ready
                    </button>
                  )}
                  {ord.status === 'Ready' && (
                    <button
                      disabled={Boolean(busyOrderIds[ord.id])}
                      onClick={() => updateOrderStatus(ord.id, 'Served')}
                      className="flex-1 py-2 text-xs font-semibold bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white rounded-lg cursor-pointer"
                    >
                      Mark Served / Bump
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
