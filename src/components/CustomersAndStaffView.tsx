import React, { useEffect, useState } from 'react';
import { KeyRound, Star, UserPlus } from 'lucide-react';
import { apiFetch, formatInr } from '../lib/api';
import { AuditLog, Customer, StaffMember } from '../types/dineflow';

export const CustomersAndStaffView: React.FC<{
  mode: 'customers' | 'staff';
  canManageStaff: boolean;
}> = ({ mode, canManageStaff }) => {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);

  const [custForm, setCustForm] = useState({ name: '', phone: '', email: '', notes: '' });
  const [staffForm, setStaffForm] = useState({
    name: '',
    role: 'waiter' as 'manager' | 'waiter' | 'kitchen',
    phone: '',
    email: '',
    pin: '',
  });
  const [resetPinId, setResetPinId] = useState<number | null>(null);
  const [newPinVal, setNewPinVal] = useState('');

  const loadData = async () => {
    setLoading(true);
    try {
      if (mode === 'customers') {
        const res = await apiFetch<{ customers: Customer[] }>('/customers');
        setCustomers(res.customers);
      } else {
        const res = await apiFetch<{ staff: StaffMember[]; auditLogs: AuditLog[] }>('/staff');
        setStaff(res.staff);
        setAuditLogs(res.auditLogs);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [mode]);

  const handleAddCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/customers', {
      method: 'POST',
      body: JSON.stringify(custForm),
    });
    setCustForm({ name: '', phone: '', email: '', notes: '' });
    await loadData();
  };

  const handleAddStaff = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/staff', {
      method: 'POST',
      body: JSON.stringify(staffForm),
    });
    setStaffForm({ name: '', role: 'waiter', phone: '', email: '', pin: '' });
    await loadData();
  };

  const handleToggleStaffActive = async (member: StaffMember) => {
    await apiFetch(`/staff/${member.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive: !member.isActive }),
    });
    await loadData();
  };

  const handleResetPin = async (id: number) => {
    if (newPinVal.length < 4) return;
    await apiFetch(`/staff/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ pin: newPinVal }),
    });
    setResetPinId(null);
    setNewPinVal('');
    await loadData();
  };

  if (mode === 'customers') {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Customers & Guest Feedback</h2>
          <p className="text-sm text-slate-500">
            Guest profiles, visit counts, lifetime spend, and dine-in QR feedback ratings.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
          <form
            onSubmit={handleAddCustomer}
            className="bg-white border border-slate-200 rounded-xl p-5 space-y-3"
          >
            <h3 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
              <UserPlus className="w-4 h-4 text-orange-600" /> Add Customer Profile
            </h3>
            <input
              required
              value={custForm.name}
              onChange={(e) => setCustForm({ ...custForm, name: e.target.value })}
              placeholder="Full Name"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
            <input
              required
              value={custForm.phone}
              onChange={(e) => setCustForm({ ...custForm, phone: e.target.value })}
              placeholder="Phone Number"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
            <input
              value={custForm.email}
              onChange={(e) => setCustForm({ ...custForm, email: e.target.value })}
              placeholder="Email (Optional)"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
            <input
              value={custForm.notes}
              onChange={(e) => setCustForm({ ...custForm, notes: e.target.value })}
              placeholder="Dietary preferences / notes"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
            <button
              type="submit"
              className="w-full py-2.5 text-sm font-semibold bg-orange-600 text-white rounded-lg cursor-pointer"
            >
              Save Guest
            </button>
          </form>

          <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                    <th className="py-3 px-4">Customer</th>
                    <th className="py-3 px-4 text-right">Visits</th>
                    <th className="py-3 px-4 text-right">Total Spend</th>
                    <th className="py-3 px-4">Feedback</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {loading ? (
                    <tr>
                      <td colSpan={4} className="py-10 text-center text-slate-400">
                        Loading customers...
                      </td>
                    </tr>
                  ) : (
                    customers.map((c) => (
                      <tr key={c.id} className="hover:bg-slate-50/70">
                        <td className="py-3 px-4">
                          <div className="font-semibold text-slate-900">{c.name}</div>
                          <div className="text-xs text-slate-500 font-mono-num">{c.phone}</div>
                        </td>
                        <td className="py-3 px-4 text-right font-mono-num">{c.visitCount}</td>
                        <td className="py-3 px-4 text-right font-mono-num font-semibold text-slate-900">
                          {formatInr(c.totalSpent)}
                        </td>
                        <td className="py-3 px-4 text-xs">
                          {c.feedbackRating ? (
                            <div className="space-y-0.5">
                              <div className="flex items-center gap-1 font-semibold text-amber-600">
                                <Star className="w-3.5 h-3.5 fill-current" />
                                {c.feedbackRating}/5
                              </div>
                              <div className="text-slate-500 truncate max-w-xs">{c.feedbackComment}</div>
                            </div>
                          ) : (
                            <span className="text-slate-400">No feedback yet</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-900">Staff, Roles & Activity Log</h2>
        <p className="text-sm text-slate-500">
          Manage outlet employees, assign PIN-based floor & kitchen access, toggle active status, and audit actions.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {canManageStaff && (
          <form
            onSubmit={handleAddStaff}
            className="bg-white border border-slate-200 rounded-xl p-5 space-y-3"
          >
            <h3 className="text-sm font-bold text-slate-900">Add Staff Member</h3>
            <input
              required
              value={staffForm.name}
              onChange={(e) => setStaffForm({ ...staffForm, name: e.target.value })}
              placeholder="Employee Full Name"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
            <select
              value={staffForm.role}
              onChange={(e) =>
                setStaffForm({ ...staffForm, role: e.target.value as 'manager' | 'waiter' | 'kitchen' })
              }
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
            >
              <option value="manager">Restaurant Manager</option>
              <option value="waiter">Waiter / Captain</option>
              <option value="kitchen">Kitchen Staff (KDS)</option>
            </select>
            <input
              required
              minLength={4}
              maxLength={6}
              value={staffForm.pin}
              onChange={(e) => setStaffForm({ ...staffForm, pin: e.target.value })}
              placeholder="4–6 digit Login PIN"
              className="w-full px-3 py-2 text-sm font-mono-num border border-slate-300 rounded-lg"
            />
            <input
              value={staffForm.phone}
              onChange={(e) => setStaffForm({ ...staffForm, phone: e.target.value })}
              placeholder="Phone (Optional)"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
            <button
              type="submit"
              className="w-full py-2.5 text-sm font-semibold bg-orange-600 text-white rounded-lg cursor-pointer"
            >
              Create Staff Account
            </button>
          </form>
        )}

        <div className="lg:col-span-2 space-y-6">
          <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100">
            {staff.map((m) => (
              <div key={m.id} className="p-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-900">{m.name}</span>
                    <span className="text-xs uppercase font-semibold text-orange-700 bg-orange-50 px-2 py-0.5 rounded">
                      {m.role}
                    </span>
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    {m.phone || m.email || 'PIN Access'} ·{' '}
                    {m.lastActiveAt
                      ? `Last active ${new Date(m.lastActiveAt).toLocaleDateString('en-IN')}`
                      : 'Never signed in'}
                  </div>
                </div>

                {canManageStaff && (
                  <div className="flex items-center gap-2">
                    {resetPinId === m.id ? (
                      <div className="flex items-center gap-1.5">
                        <input
                          value={newPinVal}
                          onChange={(e) => setNewPinVal(e.target.value)}
                          placeholder="New PIN"
                          maxLength={6}
                          className="w-24 px-2 py-1 text-xs font-mono-num border border-slate-300 rounded"
                        />
                        <button
                          onClick={() => handleResetPin(m.id)}
                          className="px-2.5 py-1 text-xs bg-slate-900 text-white rounded cursor-pointer"
                        >
                          Save
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          setResetPinId(m.id);
                          setNewPinVal('');
                        }}
                        className="px-2.5 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50 flex items-center gap-1 cursor-pointer"
                      >
                        <KeyRound className="w-3 h-3" /> Reset PIN
                      </button>
                    )}

                    <button
                      onClick={() => handleToggleStaffActive(m)}
                      className={`px-2.5 py-1 text-xs font-semibold rounded border cursor-pointer ${
                        m.isActive
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                          : 'bg-slate-100 text-slate-500 border-slate-200'
                      }`}
                    >
                      {m.isActive ? 'Active' : 'Inactive'}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Audit Activity Log */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
            <h3 className="text-sm font-bold text-slate-900">Recent Outlet Audit Activity</h3>
            <div className="divide-y divide-slate-100 max-h-64 overflow-y-auto text-xs">
              {auditLogs.map((log) => (
                <div key={log.id} className="py-2 flex items-center justify-between gap-2">
                  <div>
                    <span className="font-semibold text-slate-900">{log.actorName}</span>{' '}
                    <span className="text-slate-500">({log.actorRole})</span> ·{' '}
                    <span className="font-mono-num text-slate-700">{log.action}</span>
                  </div>
                  <span className="font-mono-num text-slate-400 shrink-0">
                    {new Date(log.createdAt).toLocaleTimeString('en-IN', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
