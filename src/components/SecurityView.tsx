import React, { useEffect, useState } from 'react';
import {
  Activity,
  Ban,
  KeyRound,
  Lock,
  QrCode,
  RefreshCw,
  ShieldAlert,
  Unlock,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { SecurityOverviewPayload } from '../types/dineflow';

const SEVERITY_STYLE: Record<string, string> = {
  critical: 'bg-red-100 text-red-800 border-red-300',
  high: 'bg-red-50 text-red-700 border-red-200',
  medium: 'bg-amber-50 text-amber-800 border-amber-200',
  low: 'bg-slate-100 text-slate-700 border-slate-200',
};

export const SecurityView: React.FC = () => {
  const [data, setData] = useState<SecurityOverviewPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionMsg, setActionMsg] = useState('');

  const loadOverview = async () => {
    setError('');
    try {
      const res = await apiFetch<SecurityOverviewPayload>('/security/overview');
      setData(res);
    } catch (err: any) {
      setError(err.message || 'Unable to load security overview');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadOverview();
  }, []);

  const handleRevokeSession = async (sessionId: string) => {
    setActionMsg('');
    try {
      await apiFetch(`/security/sessions/${encodeURIComponent(sessionId)}/revoke`, {
        method: 'POST',
      });
      setActionMsg('Session revoked immediately.');
      await loadOverview();
    } catch (err: any) {
      setError(err.message || 'Failed to revoke session');
    }
  };

  const handleUnlockStaff = async (staffId: number) => {
    setActionMsg('');
    try {
      await apiFetch(`/staff/${staffId}/unlock`, { method: 'POST' });
      setActionMsg('Staff account unlocked.');
      await loadOverview();
    } catch (err: any) {
      setError(err.message || 'Failed to unlock staff account');
    }
  };

  const activeSessions = (data?.sessions || []).filter(
    (s) => !s.revokedAt && new Date(s.expiresAt).getTime() > Date.now(),
  );
  const highAlerts = (data?.events || []).filter(
    (e) => e.severity === 'high' || e.severity === 'critical',
  );
  const lockedAccounts = (data?.staffLockStatus || []).filter(
    (st) => st.lockedUntil && new Date(st.lockedUntil).getTime() > Date.now(),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-orange-600" />
            Security Activity & Session Control
          </h2>
          <p className="text-sm text-slate-500">
            Monitor authentication alerts, revoke active terminal sessions, unlock accounts, and inspect QR token audit history.
          </p>
        </div>

        <button
          onClick={loadOverview}
          className="px-4 py-2 text-xs font-semibold border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 rounded-lg flex items-center gap-1.5 cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Refresh Feed
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

      {/* Summary KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500 flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5 text-orange-600" /> Logged Events
          </div>
          <div className="text-2xl font-bold font-mono-num text-slate-900 mt-1">
            {(data?.events || []).length}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500 flex items-center gap-1.5">
            <ShieldAlert className="w-3.5 h-3.5 text-red-600" /> High-Severity Alerts
          </div>
          <div className="text-2xl font-bold font-mono-num text-red-700 mt-1">
            {highAlerts.length}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500 flex items-center gap-1.5">
            <KeyRound className="w-3.5 h-3.5 text-emerald-600" /> Active Sessions
          </div>
          <div className="text-2xl font-bold font-mono-num text-slate-900 mt-1">
            {activeSessions.length}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500 flex items-center gap-1.5">
            <Lock className="w-3.5 h-3.5 text-amber-600" /> Locked Staff
          </div>
          <div className="text-2xl font-bold font-mono-num text-slate-900 mt-1">
            {lockedAccounts.length}
          </div>
        </div>
      </div>

      {/* Staff Lockout Controls & Active Sessions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-900">Active & Recent Staff Sessions</h3>
            <span className="text-xs text-slate-500">{activeSessions.length} active</span>
          </div>
          <div className="divide-y divide-slate-100 max-h-80 overflow-y-auto">
            {loading ? (
              <div className="p-6 text-center text-xs text-slate-400">Loading sessions...</div>
            ) : (data?.sessions || []).length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-500">No recorded sessions yet.</div>
            ) : (
              data!.sessions.map((s) => {
                const isExpired = new Date(s.expiresAt).getTime() <= Date.now();
                const isActive = !s.revokedAt && !isExpired;
                return (
                  <div key={s.id} className="p-3.5 flex items-center justify-between gap-3 text-xs">
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-900 truncate">
                        {s.actorName} · <span className="uppercase text-orange-600">{s.role}</span>
                      </div>
                      <div className="text-slate-500 font-mono-num truncate">
                        IP {s.ipAddress || 'unknown'} · Last seen{' '}
                        {new Date(s.lastSeenAt).toLocaleString('en-IN')}
                      </div>
                    </div>
                    {isActive ? (
                      <button
                        onClick={() => handleRevokeSession(s.sessionId)}
                        className="px-2.5 py-1.5 text-xs font-semibold border border-red-200 text-red-700 hover:bg-red-50 rounded-md flex items-center gap-1 cursor-pointer shrink-0"
                      >
                        <Ban className="w-3 h-3" /> Revoke
                      </button>
                    ) : (
                      <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-500 font-medium shrink-0">
                        {s.revokedAt ? 'Revoked' : 'Expired'}
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </section>

        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-900">QR Token Lifecycle Audit</h3>
            <QrCode className="w-4 h-4 text-orange-600" />
          </div>
          <div className="divide-y divide-slate-100 max-h-80 overflow-y-auto">
            {loading ? (
              <div className="p-6 text-center text-xs text-slate-400">Loading QR history...</div>
            ) : (data?.qrHistory || []).length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-500">No QR token events recorded.</div>
            ) : (
              data!.qrHistory.map((h) => (
                <div key={h.id} className="p-3.5 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-900">
                      Table #{h.tableId} · v{h.tokenVersion} ·{' '}
                      <span
                        className={
                          h.action === 'revoked' ? 'text-red-600 uppercase' : 'text-emerald-700 uppercase'
                        }
                      >
                        {h.action}
                      </span>
                    </div>
                    <div className="text-slate-500 truncate">
                      By {h.actorName} — {h.reason}
                    </div>
                  </div>
                  <div className="text-right font-mono-num text-[11px] text-slate-400 shrink-0">
                    <div>{(h.tokenDigest || 'unavailable').slice(0, 10)}…</div>
                    <div>{new Date(h.createdAt).toLocaleDateString('en-IN')}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      {/* Staff Lock Status (Only show if any have failed attempts or locks) */}
      {(data?.staffLockStatus || []).some((st) => st.failedLoginAttempts > 0 || st.lockedUntil) && (
        <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
          <h3 className="text-sm font-bold text-slate-900">Staff PIN Lockout Status</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {data!.staffLockStatus
              .filter((st) => st.failedLoginAttempts > 0 || st.lockedUntil)
              .map((st) => {
                const isLocked = st.lockedUntil && new Date(st.lockedUntil).getTime() > Date.now();
                return (
                  <div
                    key={st.id}
                    className="border border-slate-200 rounded-lg p-3 flex items-center justify-between gap-3 text-xs"
                  >
                    <div>
                      <div className="font-semibold text-slate-900">
                        {st.name} ({st.role})
                      </div>
                      <div className="text-slate-500">
                        Failed attempts: {st.failedLoginAttempts}
                        {isLocked && ` · Locked until ${new Date(st.lockedUntil!).toLocaleTimeString('en-IN')}`}
                      </div>
                    </div>
                    <button
                      onClick={() => handleUnlockStaff(st.id)}
                      className="px-3 py-1.5 text-xs font-semibold bg-slate-900 text-white rounded-md hover:bg-slate-800 flex items-center gap-1 cursor-pointer"
                    >
                      <Unlock className="w-3 h-3" /> Unlock
                    </button>
                  </div>
                );
              })}
          </div>
        </section>
      )}

      {/* Security Event Stream Table */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
          <h3 className="text-sm font-bold text-slate-900">Security Event Audit Stream</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                <th className="py-2.5 px-4">Time</th>
                <th className="py-2.5 px-4">Severity</th>
                <th className="py-2.5 px-4">Event</th>
                <th className="py-2.5 px-4">Actor / IP</th>
                <th className="py-2.5 px-4">Endpoint</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {loading ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-400">
                    Loading security feed...
                  </td>
                </tr>
              ) : (data?.events || []).length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-500">
                    No security events logged yet.
                  </td>
                </tr>
              ) : (
                data!.events.map((ev) => (
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
                      {ev.method} {ev.path} ({ev.statusCode})
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
