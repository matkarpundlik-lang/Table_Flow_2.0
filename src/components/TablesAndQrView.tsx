import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowRightLeft,
  Ban,
  Bell,
  CheckCircle2,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  LogOut,
  Play,
  Plus,
  Printer,
  QrCode,
  Receipt,
  RefreshCw,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { apiFetch, formatInr } from '../lib/api';
import {
  DiningSessionItem,
  DiningSessionsOverviewPayload,
  Order,
  Restaurant,
  RestaurantTable,
  ServiceRequest,
  StaffMember,
  TableStatus,
} from '../types/dineflow';

const TABLE_STATUSES: TableStatus[] = [
  'Available',
  'Occupied',
  'Ordering',
  'Preparing',
  'Served',
  'Billing',
  'Cleaning',
];

const STATUS_STYLE: Record<TableStatus, string> = {
  Available: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  Occupied: 'bg-slate-100 text-slate-800 border-slate-300',
  Ordering: 'bg-orange-50 text-orange-800 border-orange-200',
  Preparing: 'bg-amber-50 text-amber-800 border-amber-200',
  Served: 'bg-sky-50 text-sky-800 border-sky-200',
  Billing: 'bg-red-50 text-red-800 border-red-200',
  Cleaning: 'bg-slate-100 text-slate-600 border-slate-200',
};

export const TablesAndQrView: React.FC<{
  restaurant: Restaurant;
  refreshTick: number;
  canManageTables: boolean;
  onOpenQr: (qrToken: string) => void;
  onOpenPosForTable: (tableId: number) => void;
}> = ({ restaurant, refreshTick, canManageTables, onOpenQr, onOpenPosForTable }) => {
  const [tables, setTables] = useState<RestaurantTable[]>([]);
  const [requests, setRequests] = useState<ServiceRequest[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [diningSessionsMap, setDiningSessionsMap] = useState<Record<number, DiningSessionItem>>({});
  const [canViewPins, setCanViewPins] = useState(false);
  const [canRegeneratePins, setCanRegeneratePins] = useState(false);
  const [canCloseSessions, setCanCloseSessions] = useState(false);
  const [revealedPins, setRevealedPins] = useState<Record<number, boolean>>({});
  const [sessionBusyId, setSessionBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedSection, setSelectedSection] = useState('All');

  const [showAddModal, setShowAddModal] = useState(false);
  const [newTable, setNewTable] = useState({
    tableNumber: '',
    section: 'Main Dining',
    capacity: 4,
    assignedStaffId: '',
  });

  const [qrModal, setQrModal] = useState<{
    table: RestaurantTable;
    qrUrl: string;
    dataUrl: string;
  } | null>(null);
  const [qrActionLoading, setQrActionLoading] = useState(false);
  const [actionFeedback, setActionFeedback] = useState('');

  const [transferModal, setTransferModal] = useState<{
    sourceTable: RestaurantTable;
    order: Order;
    targetTableId: number;
  } | null>(null);

  const loadData = async () => {
    try {
      const [tblRes, ordRes, stfRes, sessRes] = await Promise.all([
        apiFetch<{ tables: RestaurantTable[]; serviceRequests: ServiceRequest[] }>('/tables'),
        apiFetch<{ orders: Order[] }>('/orders'),
        apiFetch<{ staff: StaffMember[] }>('/staff'),
        apiFetch<DiningSessionsOverviewPayload>('/dining-sessions').catch(() => null),
      ]);
      setTables(tblRes.tables);
      setRequests(tblRes.serviceRequests);
      setOrders(ordRes.orders);
      setStaff(stfRes.staff);
      if (sessRes) {
        const map: Record<number, DiningSessionItem> = {};
        for (const s of sessRes.activeSessions || []) {
          map[s.tableId] = s;
        }
        setDiningSessionsMap(map);
        setCanViewPins(Boolean(sessRes.canViewPins));
        setCanRegeneratePins(Boolean(sessRes.canRegeneratePins));
        setCanCloseSessions(Boolean(sessRes.canCloseSessions));
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [refreshTick]);

  const sections = useMemo(() => {
    const unique = Array.from(new Set(tables.map((t) => t.section)));
    return ['All', ...unique];
  }, [tables]);

  const filteredTables = useMemo(() => {
    if (selectedSection === 'All') return tables;
    return tables.filter((t) => t.section === selectedSection);
  }, [tables, selectedSection]);

  const activeOrderForTable = (tableId: number) =>
    orders.find(
      (o) => o.tableId === tableId && !['Paid', 'Closed', 'Cancelled'].includes(o.status),
    );

  const handleCreateTable = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/tables', {
        method: 'POST',
        body: JSON.stringify({
          tableNumber: newTable.tableNumber,
          section: newTable.section,
          capacity: Number(newTable.capacity),
          assignedStaffId: newTable.assignedStaffId ? Number(newTable.assignedStaffId) : null,
        }),
      });
      setShowAddModal(false);
      setNewTable({ tableNumber: '', section: 'Main Dining', capacity: 4, assignedStaffId: '' });
      await loadData();
    } catch (err: any) {
      console.error(err);
    }
  };

  const handleUpdateTable = async (id: number, patch: Record<string, unknown>) => {
    try {
      await apiFetch(`/tables/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      await loadData();
    } catch (err) {
      console.error(err);
    }
  };

  const handleDeleteTable = async (id: number) => {
    try {
      await apiFetch(`/tables/${id}`, { method: 'DELETE' });
      await loadData();
    } catch (err) {
      console.error(err);
    }
  };

  const openQrStudio = async (table: RestaurantTable) => {
    setActionFeedback('');
    try {
      const res = await apiFetch<{ qrUrl: string; dataUrl: string }>(`/tables/${table.id}/qr`);
      setQrModal({ table, ...res });
    } catch (err: any) {
      setActionFeedback(err.message || 'Unable to load table QR');
    }
  };

  const handleRegenerateQr = async (table: RestaurantTable) => {
    setQrActionLoading(true);
    setActionFeedback('');
    try {
      const res = await apiFetch<{ table: RestaurantTable }>(`/tables/${table.id}/qr/regenerate`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'Regenerated from QR Studio' }),
      });
      await loadData();
      const qrRes = await apiFetch<{ qrUrl: string; dataUrl: string }>(`/tables/${table.id}/qr`);
      setQrModal({ table: res.table, ...qrRes });
      setActionFeedback(`Table ${table.tableNumber} QR code rotated. Previous QR is now invalid.`);
    } catch (err: any) {
      setActionFeedback(err.message || 'Failed to regenerate QR token');
    } finally {
      setQrActionLoading(false);
    }
  };

  const handleRevokeQr = async (table: RestaurantTable) => {
    setQrActionLoading(true);
    setActionFeedback('');
    try {
      const res = await apiFetch<{ table: RestaurantTable }>(`/tables/${table.id}/qr/revoke`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'Revoked from QR Studio' }),
      });
      await loadData();
      if (qrModal && qrModal.table.id === table.id) {
        setQrModal({ ...qrModal, table: res.table });
      }
      setActionFeedback(`Table ${table.tableNumber} QR code revoked.`);
    } catch (err: any) {
      setActionFeedback(err.message || 'Failed to revoke QR token');
    } finally {
      setQrActionLoading(false);
    }
  };

  const resolveRequest = async (id: number) => {
    try {
      await apiFetch(`/service-requests/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'resolved' }),
      });
      await loadData();
    } catch (err) {
      console.error(err);
    }
  };

  const handleTransferTable = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!transferModal) return;
    try {
      await apiFetch(`/orders/${transferModal.order.id}/transfer-table`, {
        method: 'POST',
        body: JSON.stringify({ targetTableId: transferModal.targetTableId }),
      });
      setTransferModal(null);
      await loadData();
    } catch (err) {
      console.error(err);
    }
  };

  const runSessionAction = async (
    busyKey: string,
    url: string,
    body: Record<string, unknown>,
    successMsg: string,
    revealSessionId?: (res: any) => number | null,
  ) => {
    setSessionBusyId(busyKey);
    setActionFeedback('');
    try {
      const res = await apiFetch<any>(url, { method: 'POST', body: JSON.stringify(body) });
      const targetRevealId = revealSessionId ? revealSessionId(res) : null;
      if (targetRevealId) {
        setRevealedPins((prev) => ({ ...prev, [targetRevealId]: true }));
      }
      setActionFeedback(successMsg);
      await loadData();
    } catch (err: any) {
      setActionFeedback(err.message || 'Session action failed');
    } finally {
      setSessionBusyId(null);
    }
  };

  const waiters = staff.filter((s) => s.isActive && ['waiter', 'manager', 'owner'].includes(s.role));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Floor Tables & QR Studio</h2>
          <p className="text-sm text-slate-500">
            Manage table sections, live dining statuses, waiter assignments, table transfers, and printable QR standees.
          </p>
        </div>
        {canManageTables && (
          <button
            onClick={() => setShowAddModal(true)}
            className="px-4 py-2 text-sm font-medium bg-orange-600 hover:bg-orange-700 text-white rounded-lg flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            Add Table
          </button>
        )}
      </div>

      {actionFeedback && (
        <div className="bg-slate-900 text-white text-xs font-medium px-4 py-2.5 rounded-lg flex items-center justify-between gap-3">
          <span>{actionFeedback}</span>
          <button onClick={() => setActionFeedback('')} className="text-slate-300 hover:text-white cursor-pointer">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Live Customer QR Service Alerts */}
      {requests.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-2.5">
          <div className="flex items-center gap-2 text-sm font-semibold text-amber-900">
            <Bell className="w-4 h-4 text-amber-700" />
            Active Guest Table Requests ({requests.length})
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {requests.map((req) => {
              const tbl = tables.find((t) => t.id === req.tableId);
              return (
                <div
                  key={req.id}
                  className="bg-white border border-amber-200 rounded-lg p-3 flex items-center justify-between gap-3"
                >
                  <div>
                    <div className="text-sm font-semibold text-slate-900">
                      Table {tbl?.tableNumber || req.tableId} ·{' '}
                      {req.requestType === 'bill'
                        ? 'Bill Requested'
                        : req.requestType === 'closure'
                        ? 'Session Closure Requested'
                        : 'Waiter Assistance'}
                    </div>
                    {req.note && <div className="text-xs text-slate-500">{req.note}</div>}
                  </div>
                  <button
                    onClick={() => resolveRequest(req.id)}
                    className="px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-md hover:bg-slate-800 cursor-pointer shrink-0"
                  >
                    Resolve
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Section Filter Bar */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {sections.map((sec) => (
          <button
            key={sec}
            onClick={() => setSelectedSection(sec)}
            className={`px-3.5 py-2 text-xs font-medium rounded-lg border transition-colors cursor-pointer whitespace-nowrap ${
              selectedSection === sec
                ? 'bg-slate-900 text-white border-slate-900'
                : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
            }`}
          >
            {sec}
          </button>
        ))}
      </div>

      {/* Tables Grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-44 bg-white border border-slate-200 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredTables.map((table) => {
            const activeOrd = activeOrderForTable(table.id);
            const assignedWaiter = staff.find((s) => s.id === table.assignedStaffId);
            return (
              <div
                key={table.id}
                className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col justify-between space-y-4"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-lg font-bold font-mono-num text-slate-900">
                        {table.tableNumber}
                      </span>
                      <span
                        className={`text-[11px] font-semibold px-2 py-0.5 rounded border ${
                          STATUS_STYLE[table.status]
                        }`}
                      >
                        {table.status}
                      </span>
                    </div>
                    <div className="text-xs text-slate-500 mt-1 flex items-center gap-1.5">
                      <span>{table.section}</span>
                      <span>·</span>
                      <span className="flex items-center gap-1">
                        <Users className="w-3 h-3" /> {table.capacity} seats
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => openQrStudio(table)}
                      title="Generate & Print QR"
                      className="p-2 text-slate-600 hover:text-orange-600 hover:bg-orange-50 rounded-lg cursor-pointer"
                    >
                      <QrCode className="w-4 h-4" />
                    </button>
                    {canManageTables && !activeOrd && (
                      <button
                        onClick={() => handleDeleteTable(table.id)}
                        title="Delete Table"
                        className="p-2 text-slate-400 hover:text-red-600 rounded-lg cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Active Order Summary or Available Info */}
                {activeOrd ? (
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 flex items-center justify-between text-xs">
                    <div>
                      <div className="font-mono-num font-semibold text-slate-900">
                        {activeOrd.orderNumber} · {activeOrd.status}
                      </div>
                      <div className="text-slate-500">
                        {activeOrd.items.length} items · {activeOrd.customerName}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono-num font-bold text-slate-900">
                        {formatInr(activeOrd.totalAmount)}
                      </div>
                      {canManageTables && (
                        <button
                          onClick={() => {
                            const target = tables.find(
                              (t) => t.id !== table.id && t.status === 'Available',
                            );
                            if (target) {
                              setTransferModal({
                                sourceTable: table,
                                order: activeOrd,
                                targetTableId: target.id,
                              });
                            }
                          }}
                          className="text-orange-600 hover:underline font-medium flex items-center gap-1 mt-0.5 cursor-pointer"
                        >
                          <ArrowRightLeft className="w-3 h-3" /> Transfer
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-slate-500 py-2">
                    No active bill · Ready for walk-in or QR scan
                  </div>
                )}

                {/* Controls */}
                <div className="space-y-2.5 pt-2 border-t border-slate-100">
                  <div className="grid grid-cols-2 gap-2">
                    <select
                      aria-label="Table Status"
                      value={table.status}
                      disabled={!canManageTables}
                      onChange={(e) => handleUpdateTable(table.id, { status: e.target.value })}
                      className="px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                    >
                      {TABLE_STATUSES.map((st) => (
                        <option key={st} value={st}>
                          {st}
                        </option>
                      ))}
                    </select>

                    <select
                      aria-label="Assigned Waiter"
                      value={table.assignedStaffId || ''}
                      disabled={!canManageTables}
                      onChange={(e) =>
                        handleUpdateTable(table.id, {
                          assignedStaffId: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                      className="px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                    >
                      <option value="">Unassigned</option>
                      {waiters.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => onOpenPosForTable(table.id)}
                      className="flex-1 py-2 text-xs font-semibold bg-slate-900 hover:bg-slate-800 text-white rounded-lg cursor-pointer"
                    >
                      New POS Order
                    </button>
                    <button
                      onClick={() => onOpenQr(table.qrToken)}
                      disabled={Boolean(table.qrRevokedAt)}
                      className="px-3 py-2 text-xs font-medium border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-lg cursor-pointer disabled:opacity-40"
                    >
                      {table.qrRevokedAt ? 'QR Revoked' : 'Test QR'}
                    </button>
                  </div>

                  {/* Dining Session & Easy-Access 3-Digit Customer Security PIN */}
                  {(() => {
                    const ds = diningSessionsMap[table.id];
                    if (!ds) {
                      return (
                        <button
                          disabled={sessionBusyId === `start-${table.id}`}
                          onClick={() =>
                            runSessionAction(
                              `start-${table.id}`,
                              '/dining-sessions/start',
                              { tableId: table.id, reason: 'Started from Floor Tables & QR Studio' },
                              canViewPins
                                ? `Dining session started and 3-digit PIN generated for Table ${table.tableNumber}.`
                                : `Dining session started for Table ${table.tableNumber}.`,
                              (res) => (res?.session?.activePin && res?.session?.id ? res.session.id : null),
                            )
                          }
                          className="w-full py-2 text-xs font-semibold border border-orange-200 bg-orange-50/70 hover:bg-orange-100/80 text-orange-800 rounded-lg flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                        >
                          {canViewPins ? (
                            <KeyRound className="w-3.5 h-3.5 text-orange-600" />
                          ) : (
                            <Play className="w-3 h-3 text-orange-600" />
                          )}
                          {canViewPins ? 'Start Session & Generate PIN' : 'Start Dining Session'}
                        </button>
                      );
                    }
                    const readyToClose = ds.paymentStatus === 'paid' && ds.customerDeparted;
                    const isPinRevealed = Boolean(revealedPins[ds.id]);
                    return (
                      <div className="bg-slate-50 border border-slate-200 rounded-lg p-2.5 space-y-2 text-[11px]">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono-num font-semibold text-slate-800">
                            {ds.sessionUid.slice(0, 12)} · {ds.orderCount} ord
                          </span>
                          <span
                            className={`font-semibold uppercase ${
                              ds.paymentStatus === 'paid'
                                ? 'text-emerald-700'
                                : ds.paymentStatus === 'failed'
                                ? 'text-red-700'
                                : 'text-amber-700'
                            }`}
                          >
                            Pay: {ds.paymentStatus}
                          </span>
                        </div>

                        {canViewPins && (
                          <div className="bg-white border border-slate-200 rounded-md px-2.5 py-2 flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <KeyRound className="w-3.5 h-3.5 text-orange-600 shrink-0" />
                              <span className="text-[11px] font-medium text-slate-600">PIN:</span>
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded bg-slate-900 text-white font-mono-num text-sm font-bold tracking-[0.2em]">
                                {isPinRevealed ? ds.activePin || '---' : '•••'}
                              </span>
                              <span className="text-[10px] text-slate-400 font-mono-num">
                                v{ds.pinVersion}
                              </span>
                            </div>

                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                type="button"
                                onClick={() =>
                                  setRevealedPins((prev) => ({ ...prev, [ds.id]: !prev[ds.id] }))
                                }
                                className="p-1.5 border border-slate-200 rounded text-slate-600 hover:bg-slate-100 cursor-pointer"
                                title={isPinRevealed ? 'Hide PIN' : 'Show PIN'}
                              >
                                {isPinRevealed ? (
                                  <EyeOff className="w-3.5 h-3.5" />
                                ) : (
                                  <Eye className="w-3.5 h-3.5" />
                                )}
                              </button>
                              {canRegeneratePins && (
                                <button
                                  type="button"
                                  disabled={sessionBusyId === `regen-${ds.id}`}
                                  onClick={() =>
                                    runSessionAction(
                                      `regen-${ds.id}`,
                                      `/dining-sessions/${ds.id}/regenerate-pin`,
                                      { reason: `Regenerated from Tables section for Table ${table.tableNumber}` },
                                      `Fresh 3-digit PIN generated for Table ${table.tableNumber}. Previous PIN invalidated.`,
                                      (res) => res?.diningSessionId || ds.id,
                                    )
                                  }
                                  className="px-2 py-1 border border-slate-200 rounded bg-slate-50 hover:bg-slate-100 text-slate-700 font-semibold flex items-center gap-1 cursor-pointer disabled:opacity-50"
                                  title="Generate new 3-digit PIN for this table"
                                >
                                  <RefreshCw className="w-3 h-3" />
                                  New PIN
                                </button>
                              )}
                            </div>
                          </div>
                        )}

                        <div className="flex flex-wrap items-center gap-1.5">
                          {!ds.billRequested && (
                            <button
                              disabled={sessionBusyId === `bill-${ds.id}`}
                              onClick={() =>
                                runSessionAction(
                                  `bill-${ds.id}`,
                                  `/dining-sessions/${ds.id}/request-bill`,
                                  {},
                                  `Table ${table.tableNumber} marked as bill requested.`,
                                )
                              }
                              className="px-2 py-1 font-semibold bg-white border border-slate-200 hover:bg-slate-100 text-slate-700 rounded flex items-center gap-1 cursor-pointer"
                            >
                              <Receipt className="w-3 h-3" /> Mark Bill
                            </button>
                          )}
                          {!ds.customerDeparted ? (
                            <button
                              disabled={sessionBusyId === `dep-${ds.id}`}
                              onClick={() =>
                                runSessionAction(
                                  `dep-${ds.id}`,
                                  `/dining-sessions/${ds.id}/confirm-departure`,
                                  {},
                                  `Departure confirmed for Table ${table.tableNumber}.`,
                                )
                              }
                              className="px-2 py-1 font-semibold bg-sky-50 border border-sky-200 hover:bg-sky-100 text-sky-800 rounded flex items-center gap-1 cursor-pointer"
                            >
                              <LogOut className="w-3 h-3" /> Confirm Departure
                            </button>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold">
                              <CheckCircle2 className="w-3 h-3" /> Departed
                            </span>
                          )}
                          {canCloseSessions ? (
                            <button
                              disabled={!readyToClose || sessionBusyId === `close-${ds.id}`}
                              onClick={() =>
                                runSessionAction(
                                  `close-${ds.id}`,
                                  `/dining-sessions/${ds.id}/close`,
                                  {},
                                  `Session closed for Table ${table.tableNumber}. Old PIN invalidated.`,
                                )
                              }
                              title={
                                readyToClose
                                  ? 'Close paid dining session'
                                  : 'Complete payment and confirm departure first'
                              }
                              className="ml-auto px-2 py-1 font-semibold bg-slate-900 text-white rounded cursor-pointer disabled:opacity-40"
                            >
                              Close Session
                            </button>
                          ) : (
                            <button
                              disabled={sessionBusyId === `reqclose-${ds.id}`}
                              onClick={() =>
                                runSessionAction(
                                  `reqclose-${ds.id}`,
                                  `/dining-sessions/${ds.id}/request-closure`,
                                  {},
                                  `Closure request sent for Table ${table.tableNumber}.`,
                                )
                              }
                              className="ml-auto px-2 py-1 font-semibold border border-slate-300 bg-white text-slate-700 rounded cursor-pointer"
                            >
                              Request Closure
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  <div className="flex items-center justify-between text-[11px] text-slate-400">
                    <span>{assignedWaiter ? `Server: ${assignedWaiter.name}` : 'QR Security: Active'}</span>
                    <span className={table.qrRevokedAt ? 'text-red-600 font-semibold' : 'text-emerald-700'}>
                      {table.qrRevokedAt
                        ? 'Revoked'
                        : table.qrExpiresAt
                        ? `Exp ${new Date(table.qrExpiresAt).toLocaleDateString('en-IN')}`
                        : 'Active'}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add Table Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleCreateTable}
            className="bg-white w-full max-w-md rounded-2xl p-6 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900">Create Dining Table</h3>
              <button type="button" onClick={() => setShowAddModal(false)} className="cursor-pointer">
                <X className="w-5 h-5 text-slate-500" />
              </button>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Table Number</label>
              <input
                required
                value={newTable.tableNumber}
                onChange={(e) => setNewTable({ ...newTable, tableNumber: e.target.value })}
                placeholder="e.g. T-08"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Section</label>
                <input
                  required
                  value={newTable.section}
                  onChange={(e) => setNewTable({ ...newTable, section: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Capacity</label>
                <input
                  type="number"
                  min={1}
                  max={24}
                  value={newTable.capacity}
                  onChange={(e) => setNewTable({ ...newTable, capacity: Number(e.target.value) })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Assign Waiter</label>
              <select
                value={newTable.assignedStaffId}
                onChange={(e) => setNewTable({ ...newTable, assignedStaffId: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              >
                <option value="">Unassigned</option>
                {waiters.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              className="w-full py-2.5 text-sm font-semibold bg-orange-600 hover:bg-orange-700 text-white rounded-lg cursor-pointer"
            >
              Create Table & Generate QR
            </button>
          </form>
        </div>
      )}

      {/* QR Code Download & Print Tent Card Modal */}
      {qrModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-md rounded-2xl p-6 space-y-5 text-center">
            <div className="flex items-center justify-between no-print">
              <h3 className="text-base font-bold text-slate-900">
                Table {qrModal.table.tableNumber} QR Standee
              </h3>
              <button onClick={() => setQrModal(null)} className="cursor-pointer">
                <X className="w-5 h-5 text-slate-500" />
              </button>
            </div>

            <div className="border-2 border-slate-900 rounded-2xl p-6 space-y-3 bg-white">
              <div className="text-xs font-semibold tracking-wider uppercase text-orange-600">
                {restaurant.name}
              </div>
              <div className="text-2xl font-bold text-slate-900">
                Table {qrModal.table.tableNumber}
              </div>
              <img
                src={qrModal.dataUrl}
                alt={`QR code for table ${qrModal.table.tableNumber}`}
                className="w-56 h-56 mx-auto"
              />
              <p className="text-xs text-slate-600">
                Scan to view menu, customize dishes, call your waiter & track order live.
              </p>
              <div className="text-[11px] font-mono-num text-slate-400 break-all">
                Token: {qrModal.table.qrToken}
              </div>
              <div className="text-[11px] font-medium">
                {qrModal.table.qrRevokedAt ? (
                  <span className="text-red-600">Status: REVOKED (Customers cannot order)</span>
                ) : (
                  <span className="text-emerald-700">
                    Status: Active
                    {qrModal.table.qrExpiresAt
                      ? ` · Expires ${new Date(qrModal.table.qrExpiresAt).toLocaleDateString('en-IN')}`
                      : ''}
                  </span>
                )}
              </div>
            </div>

            {canViewPins && (
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 flex items-center justify-between gap-2 text-left no-print">
                {(() => {
                  const modalDs = diningSessionsMap[qrModal.table.id];
                  if (!modalDs) {
                    return (
                      <>
                        <div className="text-xs text-slate-600">
                          No active 3-digit customer PIN yet.
                        </div>
                        <button
                          type="button"
                          disabled={sessionBusyId === `start-${qrModal.table.id}`}
                          onClick={() =>
                            runSessionAction(
                              `start-${qrModal.table.id}`,
                              '/dining-sessions/start',
                              { tableId: qrModal.table.id, reason: 'Generated from QR Studio modal' },
                              `3-digit customer PIN generated for Table ${qrModal.table.tableNumber}.`,
                              (res) => (res?.session?.activePin && res?.session?.id ? res.session.id : null),
                            )
                          }
                          className="px-3 py-1.5 text-xs font-semibold bg-orange-600 hover:bg-orange-700 text-white rounded-lg flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                        >
                          <KeyRound className="w-3.5 h-3.5" /> Generate PIN
                        </button>
                      </>
                    );
                  }
                  const revealed = Boolean(revealedPins[modalDs.id]);
                  return (
                    <>
                      <div className="flex items-center gap-2">
                        <KeyRound className="w-4 h-4 text-orange-600" />
                        <span className="text-xs font-medium text-slate-700">Customer PIN:</span>
                        <span className="px-2.5 py-0.5 rounded bg-slate-900 text-white font-mono-num text-sm font-bold tracking-[0.2em]">
                          {revealed ? modalDs.activePin || '---' : '•••'}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() =>
                            setRevealedPins((prev) => ({ ...prev, [modalDs.id]: !prev[modalDs.id] }))
                          }
                          className="p-1.5 border border-slate-200 bg-white rounded text-slate-600 hover:bg-slate-100 cursor-pointer"
                          title={revealed ? 'Hide PIN' : 'Show PIN'}
                        >
                          {revealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        </button>
                        {canRegeneratePins && (
                          <button
                            type="button"
                            disabled={sessionBusyId === `regen-${modalDs.id}`}
                            onClick={() =>
                              runSessionAction(
                                `regen-${modalDs.id}`,
                                `/dining-sessions/${modalDs.id}/regenerate-pin`,
                                { reason: `Regenerated from QR Studio modal for Table ${qrModal.table.tableNumber}` },
                                `Fresh 3-digit PIN generated for Table ${qrModal.table.tableNumber}.`,
                                (res) => res?.diningSessionId || modalDs.id,
                              )
                            }
                            className="px-2.5 py-1 text-xs font-semibold border border-slate-200 bg-white hover:bg-slate-100 text-slate-800 rounded flex items-center gap-1 cursor-pointer disabled:opacity-50"
                          >
                            <RefreshCw className="w-3 h-3" /> New PIN
                          </button>
                        )}
                      </div>
                    </>
                  );
                })()}
              </div>
            )}

            <div className="grid grid-cols-3 gap-2 no-print">
              <a
                href={qrModal.dataUrl}
                download={`${restaurant.slug}-table-${qrModal.table.tableNumber}-qr.png`}
                className="py-2.5 px-3 text-xs font-semibold bg-slate-900 text-white rounded-lg flex items-center justify-center gap-1.5"
              >
                <Download className="w-3.5 h-3.5" /> PNG
              </a>
              <button
                onClick={() => window.print()}
                className="py-2.5 px-3 text-xs font-semibold border border-slate-300 text-slate-800 rounded-lg flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Printer className="w-3.5 h-3.5" /> Print
              </button>
              <button
                disabled={Boolean(qrModal.table.qrRevokedAt)}
                onClick={() => {
                  const token = qrModal.table.qrToken;
                  setQrModal(null);
                  onOpenQr(token);
                }}
                className="py-2.5 px-3 text-xs font-semibold bg-orange-600 text-white rounded-lg cursor-pointer disabled:opacity-40"
              >
                Open Menu
              </button>
            </div>

            {canManageTables && (
              <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-100 no-print">
                <button
                  disabled={qrActionLoading}
                  onClick={() => handleRegenerateQr(qrModal.table)}
                  className="py-2 px-3 text-xs font-semibold border border-slate-300 hover:bg-slate-50 text-slate-800 rounded-lg flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> Regenerate QR
                </button>
                <button
                  disabled={qrActionLoading || Boolean(qrModal.table.qrRevokedAt)}
                  onClick={() => handleRevokeQr(qrModal.table)}
                  className="py-2 px-3 text-xs font-semibold border border-red-200 hover:bg-red-50 text-red-700 rounded-lg flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-40"
                >
                  <Ban className="w-3.5 h-3.5" /> Revoke QR
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Table Transfer Modal */}
      {transferModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleTransferTable}
            className="bg-white w-full max-w-md rounded-2xl p-6 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900">
                Transfer Order {transferModal.order.orderNumber}
              </h3>
              <button type="button" onClick={() => setTransferModal(null)} className="cursor-pointer">
                <X className="w-5 h-5 text-slate-500" />
              </button>
            </div>
            <p className="text-sm text-slate-600">
              Move active ticket from Table {transferModal.sourceTable.tableNumber} to:
            </p>
            <select
              value={transferModal.targetTableId}
              onChange={(e) =>
                setTransferModal({ ...transferModal, targetTableId: Number(e.target.value) })
              }
              className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-lg"
            >
              {tables
                .filter((t) => t.id !== transferModal.sourceTable.id)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    Table {t.tableNumber} ({t.section} · {t.status})
                  </option>
                ))}
            </select>
            <button
              type="submit"
              className="w-full py-2.5 text-sm font-semibold bg-orange-600 hover:bg-orange-700 text-white rounded-lg cursor-pointer"
            >
              Confirm Table Transfer
            </button>
          </form>
        </div>
      )}
    </div>
  );
};
