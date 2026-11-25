import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Eye,
  EyeOff,
  History,
  KeyRound,
  Lock,
  LogOut,
  Play,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react';
import { apiFetch, formatInr } from '../lib/api';
import { DiningSessionItem, DiningSessionsOverviewPayload } from '../types/dineflow';

const SEVERITY_STYLE: Record<string, string> = {
  critical: 'bg-red-100 text-red-800 border-red-300',
  high: 'bg-red-50 text-red-700 border-red-200',
  medium: 'bg-amber-50 text-amber-800 border-amber-200',
  low: 'bg-slate-100 text-slate-700 border-slate-200',
};

const PAYMENT_STATUS_STYLE: Record<string, string> = {
  paid: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  partial: 'bg-amber-50 text-amber-800 border-amber-200',
  initiated: 'bg-sky-50 text-sky-700 border-sky-200',
  failed: 'bg-red-50 text-red-700 border-red-200',
  unpaid: 'bg-slate-100 text-slate-700 border-slate-200',
};

export const CustomerOrderSecurityView: React.FC<{
  refreshTick: number;
}> = ({ refreshTick }) => {
  const [data, setData] = useState<DiningSessionsOverviewPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionMsg, setActionMsg] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [revealedPins, setRevealedPins] = useState<Record<number, boolean>>({});
  const [overrideModal, setOverrideModal] = useState<{
    session: DiningSessionItem;
    tableNumber: string;
  } | null>(null);
  const [overrideReason, setOverrideReason] = useState('');

  const loadData = async () => {
    try {
      const res = await apiFetch<DiningSessionsOverviewPayload>('/dining-sessions');
      setData(res);
      setError('');
    } catch (err: any) {
      setError(err.message || 'Failed to load Customer Order Security');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [refreshTick]);

  const toggleRevealPin = (sessionId: number) => {
    setRevealedPins((prev) => ({ ...prev, [sessionId]: !prev[sessionId] }));
  };

  const handleStartSession = async (tableId: number, tableNumber: string) => {
    setBusyKey(`start-${tableId}`);
    setError('');
    setActionMsg('');
    try {
      await apiFetch('/dining-sessions/start', {
        method: 'POST',
        body: JSON.stringify({ tableId, reason: 'Started from Customer Order Security' }),
      });
      setActionMsg(`Started dining session and generated 3-digit PIN for Table ${tableNumber}.`);
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to start dining session');
    } finally {
      setBusyKey(null);
    }
  };

  const handleRegeneratePin = async (session: DiningSessionItem, tableNumber: string) => {
    setBusyKey(`regen-${session.id}`);
    setError('');
    setActionMsg('');
    try {
      await apiFetch(`/dining-sessions/${session.id}/regenerate-pin`, {
        method: 'POST',
        body: JSON.stringify({ reason: `Manual security regeneration for Table ${tableNumber}` }),
      });
      setRevealedPins((prev) => ({ ...prev, [session.id]: true }));
      setActionMsg(`Generated fresh 3-digit security PIN for Table ${tableNumber}. Previous PIN is now invalid.`);
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to regenerate security PIN');
    } finally {
      setBusyKey(null);
    }
  };

  const handleConfirmDeparture = async (sessionId: number, tableNumber: string) => {
    setBusyKey(`dep-${sessionId}`);
    setError('');
    setActionMsg('');
    try {
      await apiFetch(`/dining-sessions/${sessionId}/confirm-departure`, { method: 'POST' });
      setActionMsg(`Customer departure confirmed for Table ${tableNumber}.`);
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to confirm departure');
    } finally {
      setBusyKey(null);
    }
  };

  const handleCloseSession = async (sessionId: number, tableNumber: string) => {
    setBusyKey(`close-${sessionId}`);
    setError('');
    setActionMsg('');
    try {
      await apiFetch(`/dining-sessions/${sessionId}/close`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setActionMsg(`Dining session closed for Table ${tableNumber}. Table reset and PIN invalidated.`);
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to close dining session');
    } finally {
      setBusyKey(null);
    }
  };

  const handleOverrideCloseSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!overrideModal) return;
    if (overrideReason.trim().length < 5) {
      setError('Enter a clear override reason (at least 5 characters).');
      return;
    }
    setBusyKey(`override-${overrideModal.session.id}`);
    setError('');
    setActionMsg('');
    try {
      await apiFetch(`/dining-sessions/${overrideModal.session.id}/close`, {
        method: 'POST',
        body: JSON.stringify({ override: true, reason: overrideReason.trim() }),
      });
      setActionMsg(
        `Override closure completed for Table ${overrideModal.tableNumber}. Old PIN and QR tokens invalidated.`,
      );
      setOverrideModal(null);
      setOverrideReason('');
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to override close session');
    } finally {
      setBusyKey(null);
    }
  };

  const tableMap = new Map((data?.tables || []).map((t) => [t.id, t]));
  const totalFailedAttempts = (data?.activeSessions || []).reduce(
    (s, sess) => s + (sess.failedPinAttempts || 0),
    0,
  );
  const readyToCloseCount = (data?.activeSessions || []).filter(
    (s) => s.paymentStatus === 'paid' && s.customerDeparted,
  ).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-orange-600" />
            Customer Order Security
          </h2>
          <p className="text-sm text-slate-500">
            Manage table 3-digit dining-session PINs, verify customer departure & settlement, and inspect PIN regeneration & security logs.
          </p>
        </div>

        <button
          onClick={loadData}
          className="px-4 py-2 text-xs font-semibold border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 rounded-lg flex items-center gap-1.5 cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Refresh Live State
        </button>
      </div>

      {actionMsg && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-medium px-4 py-2.5 rounded-lg">
          {actionMsg}
        </div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-xs font-medium px-4 py-2.5 rounded-lg">
          {error}
        </div>
      )}

      {/* KPI Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500 flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" /> Active Dining Sessions
          </div>
          <div className="text-2xl font-bold font-mono-num text-slate-900 mt-1">
            {(data?.activeSessions || []).length}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500 flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5 text-orange-600" /> Ready for Closure
          </div>
          <div className="text-2xl font-bold font-mono-num text-slate-900 mt-1">
            {readyToCloseCount}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500 flex items-center gap-1.5">
            <History className="w-3.5 h-3.5 text-slate-600" /> Closed Sessions
          </div>
          <div className="text-2xl font-bold font-mono-num text-slate-900 mt-1">
            {(data?.closedSessions || []).length}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500 flex items-center gap-1.5">
            <Lock className="w-3.5 h-3.5 text-red-600" /> Active Failed PIN Attempts
          </div>
          <div className="text-2xl font-bold font-mono-num text-red-700 mt-1">
            {totalFailedAttempts}
          </div>
        </div>
      </div>

      {/* Table PIN & Dining Session Controls */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-slate-900">
              Table Dining Sessions & Active 3-Digit Security PINs
            </h3>
            <p className="text-xs text-slate-500">
              PINs stay valid across multiple orders and payment until customer departure is confirmed and the session is closed.
            </p>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                <th className="py-3 px-4">Table</th>
                <th className="py-3 px-4">Session</th>
                <th className="py-3 px-4">Active 3-Digit PIN</th>
                <th className="py-3 px-4">Orders & Payment</th>
                <th className="py-3 px-4">Departure & Attempts</th>
                <th className="py-3 px-4 text-right">Security Controls</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {loading ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-slate-400">
                    Loading dining sessions...
                  </td>
                </tr>
              ) : (data?.tables || []).length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-slate-500">
                    No tables configured for this restaurant.
                  </td>
                </tr>
              ) : (
                data!.tables.map((tbl) => {
                  const s = tbl.activeSession;
                  const revealed = s ? Boolean(revealedPins[s.id]) : false;
                  const canCloseNormally = Boolean(
                    s && s.paymentStatus === 'paid' && s.customerDeparted,
                  );

                  return (
                    <tr key={tbl.id} className="hover:bg-slate-50/70 align-top">
                      <td className="py-3.5 px-4">
                        <div className="font-bold text-sm font-mono-num text-slate-900">
                          {tbl.tableNumber}
                        </div>
                        <div className="text-slate-500">
                          {tbl.section} · {tbl.status}
                        </div>
                      </td>

                      <td className="py-3.5 px-4">
                        {s ? (
                          <div className="space-y-0.5">
                            <div className="font-mono-num font-semibold text-slate-900">
                              {s.sessionUid}
                            </div>
                            <div className="text-slate-500">
                              Started {new Date(s.startedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                            </div>
                            {s.pinLastRegeneratedAt && (
                              <div className="text-[11px] text-slate-400">
                                PIN rotated{' '}
                                {new Date(s.pinLastRegeneratedAt).toLocaleTimeString('en-IN', {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-slate-400">No active session</span>
                        )}
                      </td>

                      <td className="py-3.5 px-4">
                        {s && data?.canViewPins ? (
                          <div className="flex items-center gap-2">
                            <span className="inline-flex items-center px-3 py-1.5 rounded-lg bg-slate-900 text-white font-mono-num text-base font-bold tracking-[0.25em]">
                              {revealed ? s.activePin || '---' : '•••'}
                            </span>
                            <button
                              onClick={() => toggleRevealPin(s.id)}
                              className="p-2 border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-100 cursor-pointer"
                              title={revealed ? 'Mask PIN' : 'Reveal PIN'}
                            >
                              {revealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                            </button>
                            <span className="text-[11px] text-slate-400 font-mono-num">
                              v{s.pinVersion}
                            </span>
                          </div>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>

                      <td className="py-3.5 px-4">
                        {s ? (
                          <div className="space-y-1">
                            <div className="font-semibold text-slate-900 font-mono-num">
                              {s.orderCount} order{s.orderCount === 1 ? '' : 's'} · {formatInr(s.totalBill)}
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span
                                className={`px-2 py-0.5 rounded border text-[11px] font-semibold uppercase ${
                                  PAYMENT_STATUS_STYLE[s.paymentStatus] || PAYMENT_STATUS_STYLE.unpaid
                                }`}
                              >
                                {s.paymentStatus}
                              </span>
                              {s.billRequested && (
                                <span className="text-[11px] font-semibold text-red-700">
                                  Bill Requested
                                </span>
                              )}
                            </div>
                          </div>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>

                      <td className="py-3.5 px-4">
                        {s ? (
                          <div className="space-y-1">
                            <div
                              className={
                                s.customerDeparted
                                  ? 'text-emerald-700 font-semibold'
                                  : 'text-slate-600'
                              }
                            >
                              {s.customerDeparted
                                ? `Departed (${s.departureConfirmedBy || 'Staff'})`
                                : 'Guests at table'}
                            </div>
                            <div className="text-slate-500 font-mono-num">
                              Failed PINs:{' '}
                              <span
                                className={
                                  s.failedPinAttempts >= 3 ? 'text-red-700 font-bold' : 'text-slate-700'
                                }
                              >
                                {s.failedPinAttempts}
                              </span>
                            </div>
                          </div>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>

                      <td className="py-3.5 px-4 text-right">
                        {!s ? (
                          <button
                            disabled={busyKey === `start-${tbl.id}`}
                            onClick={() => handleStartSession(tbl.id, tbl.tableNumber)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-orange-600 hover:bg-orange-700 text-white rounded-lg cursor-pointer disabled:opacity-50"
                          >
                            <Play className="w-3.5 h-3.5" /> Start Session
                          </button>
                        ) : (
                          <div className="flex flex-wrap items-center justify-end gap-1.5">
                            {data?.canRegeneratePins && (
                              <button
                                disabled={busyKey === `regen-${s.id}`}
                                onClick={() => handleRegeneratePin(s, tbl.tableNumber)}
                                className="px-2.5 py-1.5 text-xs font-semibold border border-slate-300 hover:bg-slate-50 text-slate-800 rounded-lg inline-flex items-center gap-1 cursor-pointer disabled:opacity-50"
                              >
                                <RefreshCw className="w-3 h-3" /> Regenerate PIN
                              </button>
                            )}
                            {!s.customerDeparted && (
                              <button
                                disabled={busyKey === `dep-${s.id}`}
                                onClick={() => handleConfirmDeparture(s.id, tbl.tableNumber)}
                                className="px-2.5 py-1.5 text-xs font-semibold border border-sky-200 bg-sky-50 hover:bg-sky-100 text-sky-800 rounded-lg inline-flex items-center gap-1 cursor-pointer disabled:opacity-50"
                              >
                                <LogOut className="w-3 h-3" /> Confirm Departure
                              </button>
                            )}
                            {data?.canCloseSessions && (
                              <button
                                disabled={!canCloseNormally || busyKey === `close-${s.id}`}
                                onClick={() => handleCloseSession(s.id, tbl.tableNumber)}
                                title={
                                  canCloseNormally
                                    ? 'Close session & issue fresh setup'
                                    : 'Requires paid payment status and departure confirmation'
                                }
                                className="px-2.5 py-1.5 text-xs font-semibold bg-slate-900 hover:bg-slate-800 text-white rounded-lg cursor-pointer disabled:opacity-40"
                              >
                                Close Session
                              </button>
                            )}
                            {data?.canOverrideClose && (
                              <button
                                onClick={() => {
                                  setOverrideReason('');
                                  setOverrideModal({ session: s, tableNumber: tbl.tableNumber });
                                }}
                                className="px-2.5 py-1.5 text-xs font-semibold border border-red-200 text-red-700 hover:bg-red-50 rounded-lg cursor-pointer"
                              >
                                Override Close
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* PIN Regeneration History & Closed Sessions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-900">PIN Regeneration & Lifecycle History</h3>
            <KeyRound className="w-4 h-4 text-orange-600" />
          </div>
          <div className="divide-y divide-slate-100 max-h-80 overflow-y-auto">
            {(data?.pinHistory || []).length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-500">
                No PIN generation events yet.
              </div>
            ) : (
              data!.pinHistory.map((h) => {
                const tbl = tableMap.get(h.tableId);
                return (
                  <div key={h.id} className="p-3.5 flex items-center justify-between gap-3 text-xs">
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-900">
                        Table {tbl?.tableNumber || `#${h.tableId}`} · v{h.pinVersion} ·{' '}
                        <span
                          className={
                            h.action === 'invalidated'
                              ? 'text-red-600 uppercase'
                              : h.action === 'regenerated'
                              ? 'text-amber-700 uppercase'
                              : 'text-emerald-700 uppercase'
                          }
                        >
                          {h.action}
                        </span>
                      </div>
                      <div className="text-slate-500 truncate">
                        {h.actorName} ({h.actorRole}) — {h.reason}
                      </div>
                    </div>
                    <div className="text-right font-mono-num text-[11px] text-slate-400 shrink-0">
                      <div>{(h.pinDigest || 'digest').slice(0, 10)}…</div>
                      <div>{new Date(h.createdAt).toLocaleString('en-IN')}</div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-900">Closed Dining Sessions</h3>
            <History className="w-4 h-4 text-slate-600" />
          </div>
          <div className="divide-y divide-slate-100 max-h-80 overflow-y-auto">
            {(data?.closedSessions || []).length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-500">
                No closed dining sessions recorded yet.
              </div>
            ) : (
              data!.closedSessions.map((cs) => {
                const tbl = tableMap.get(cs.tableId);
                return (
                  <div key={cs.id} className="p-3.5 flex items-center justify-between gap-3 text-xs">
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-900">
                        Table {tbl?.tableNumber || `#${cs.tableId}`} · {cs.sessionUid}
                        {cs.isOverrideClose && (
                          <span className="ml-2 text-red-700 uppercase font-bold">[Override]</span>
                        )}
                      </div>
                      <div className="text-slate-500 truncate">
                        Closed by {cs.closedBy || 'Staff'} ({cs.closedByRole || 'staff'}) ·{' '}
                        {cs.closeReason}
                      </div>
                    </div>
                    <div className="text-right font-mono-num shrink-0">
                      <div className="font-bold text-slate-900">{formatInr(cs.paidTotal)}</div>
                      <div className="text-[11px] text-slate-400">
                        {cs.closedAt ? new Date(cs.closedAt).toLocaleTimeString('en-IN') : ''}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>
      </div>

      {/* Security Logs */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
            <ShieldAlert className="w-4 h-4 text-orange-600" />
            PIN & Dining Session Security Logs
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                <th className="py-2.5 px-4">Time</th>
                <th className="py-2.5 px-4">Severity</th>
                <th className="py-2.5 px-4">Event</th>
                <th className="py-2.5 px-4">Actor / IP</th>
                <th className="py-2.5 px-4">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {(data?.securityLogs || []).length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-500">
                    No security events logged yet.
                  </td>
                </tr>
              ) : (
                data!.securityLogs.map((ev) => (
                  <tr key={ev.id} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-4 font-mono-num text-slate-500 whitespace-nowrap">
                      {new Date(ev.createdAt).toLocaleString('en-IN')}
                    </td>
                    <td className="py-2.5 px-4">
                      <span
                        className={`px-2 py-0.5 rounded border text-[11px] font-semibold uppercase ${
                          SEVERITY_STYLE[ev.severity] || SEVERITY_STYLE.low
                        }`}
                      >
                        {ev.severity}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 font-semibold text-slate-900">{ev.eventType}</td>
                    <td className="py-2.5 px-4 text-slate-600">
                      <div>{ev.actorIdentifier || 'Anonymous'}</div>
                      <div className="font-mono-num text-[11px] text-slate-400">{ev.ipAddress}</div>
                    </td>
                    <td className="py-2.5 px-4 font-mono-num text-slate-600">
                      {ev.method} {ev.statusCode}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Owner Override Close Modal */}
      {overrideModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleOverrideCloseSubmit}
            className="bg-white w-full max-w-md rounded-2xl p-6 space-y-4 shadow-xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900">
                Owner Override Close · Table {overrideModal.tableNumber}
              </h3>
              <button
                type="button"
                onClick={() => setOverrideModal(null)}
                className="text-slate-500 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-slate-600">
              This will immediately close dining session{' '}
              <span className="font-mono-num font-semibold">{overrideModal.session.sessionUid}</span>,
              invalidate the current 3-digit PIN, revoke customer QR sessions, and reset the table to Available.
            </p>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Mandatory Audit Reason
              </label>
              <textarea
                required
                minLength={5}
                rows={3}
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                placeholder="e.g. Guests moved to outdoor patio / manual cash settlement verified..."
                className="w-full p-3 text-sm border border-slate-300 rounded-xl"
              />
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setOverrideModal(null)}
                className="px-4 py-2 text-xs font-semibold border border-slate-300 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busyKey === `override-${overrideModal.session.id}`}
                className="px-4 py-2 text-xs font-semibold bg-red-600 hover:bg-red-700 text-white rounded-lg cursor-pointer disabled:opacity-50"
              >
                Confirm Override Close
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
