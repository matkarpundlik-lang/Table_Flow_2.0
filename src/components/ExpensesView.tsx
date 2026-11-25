import React, { useEffect, useMemo, useState } from 'react';
import { FileText, Plus, Trash2, Upload, X } from 'lucide-react';
import { apiFetch, fetchAuthorizedBlobUrl, formatInr } from '../lib/api';
import { Expense } from '../types/dineflow';

const EXPENSE_CATEGORIES = [
  'Raw Materials',
  'Rent',
  'Utilities',
  'Salaries',
  'Marketing',
  'Maintenance',
  'Other',
];

export const ExpensesView: React.FC<{
  canManageExpenses: boolean;
}> = ({ canManageExpenses }) => {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [receiptPreview, setReceiptPreview] = useState<{
    title: string;
    blobUrl: string;
    contentType: string;
  } | null>(null);

  const [form, setForm] = useState({
    category: 'Raw Materials',
    title: '',
    amount: '',
    expenseDate: new Date().toISOString().slice(0, 10),
    paymentMethod: 'upi',
    vendorName: '',
    description: '',
    receiptUrl: '',
  });

  const loadExpenses = async () => {
    try {
      const res = await apiFetch<{ expenses: Expense[] }>('/expenses');
      setExpenses(res.expenses);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadExpenses();
  }, []);

  const handleReceiptUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadError('');
    try {
      const fd = new FormData();
      fd.append('receipt', file);
      const res = await apiFetch<{ receiptUrl: string }>('/uploads/receipt', {
        method: 'POST',
        body: fd,
      });
      setForm((prev) => ({ ...prev, receiptUrl: res.receiptUrl }));
    } catch (err: any) {
      setUploadError(err.message || 'Receipt upload rejected');
    } finally {
      setUploading(false);
    }
  };

  const handleViewReceipt = async (exp: Expense) => {
    if (!exp.receiptUrl) return;
    setUploadError('');
    try {
      const { blobUrl, contentType } = await fetchAuthorizedBlobUrl(exp.receiptUrl);
      setReceiptPreview({ title: exp.title, blobUrl, contentType });
    } catch (err: any) {
      setUploadError(err.message || 'Could not open receipt');
    }
  };

  const closeReceiptPreview = () => {
    if (receiptPreview?.blobUrl) {
      URL.revokeObjectURL(receiptPreview.blobUrl);
    }
    setReceiptPreview(null);
  };

  const handleCreateExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/expenses', {
      method: 'POST',
      body: JSON.stringify({
        ...form,
        amount: Number(form.amount),
      }),
    });
    setForm({
      category: 'Raw Materials',
      title: '',
      amount: '',
      expenseDate: new Date().toISOString().slice(0, 10),
      paymentMethod: 'upi',
      vendorName: '',
      description: '',
      receiptUrl: '',
    });
    await loadExpenses();
  };

  const totalSpend = useMemo(() => expenses.reduce((s, e) => s + e.amount, 0), [expenses]);

  const byCategory = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of expenses) {
      map.set(e.category, (map.get(e.category) || 0) + e.amount);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [expenses]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Expenses & Receipts</h2>
          <p className="text-sm text-slate-500">
            Log vendor bills, utilities, rent, and upload expense receipts for monthly P&L accuracy.
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl px-4 py-2 text-right">
          <div className="text-xs text-slate-500">Total Logged Spend</div>
          <div className="text-lg font-bold font-mono-num text-slate-900">{formatInr(totalSpend)}</div>
        </div>
      </div>

      {/* Category Breakdown */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {byCategory.slice(0, 4).map(([cat, amt]) => (
          <div key={cat} className="bg-white border border-slate-200 rounded-xl p-3.5">
            <div className="text-xs text-slate-500">{cat}</div>
            <div className="text-base font-bold font-mono-num text-slate-900 mt-1">
              {formatInr(amt)}
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {canManageExpenses && (
          <form
            onSubmit={handleCreateExpense}
            className="bg-white border border-slate-200 rounded-xl p-5 space-y-3.5"
          >
            <h3 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
              <Plus className="w-4 h-4 text-orange-600" /> Log New Expense
            </h3>

            <select
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
            >
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>

            <input
              required
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="Expense Title (e.g. Milk & Dairy Invoice)"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />

            <div className="grid grid-cols-2 gap-2">
              <input
                required
                type="number"
                step="0.01"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
                placeholder="Amount ₹"
                className="px-3 py-2 text-sm font-mono-num border border-slate-300 rounded-lg"
              />
              <input
                type="date"
                value={form.expenseDate}
                onChange={(e) => setForm({ ...form, expenseDate: e.target.value })}
                className="px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <select
                value={form.paymentMethod}
                onChange={(e) => setForm({ ...form, paymentMethod: e.target.value })}
                className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option value="upi">UPI</option>
                <option value="cash">Cash</option>
                <option value="card">Card</option>
                <option value="bank_transfer">Bank Transfer</option>
              </select>
              <input
                value={form.vendorName}
                onChange={(e) => setForm({ ...form, vendorName: e.target.value })}
                placeholder="Vendor Name"
                className="px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>

            <input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Notes / Invoice ref"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />

            <label className="block border border-dashed border-slate-300 rounded-lg p-3 text-center cursor-pointer hover:bg-slate-50">
              <input type="file" accept="image/*,.pdf" onChange={handleReceiptUpload} className="hidden" />
              <div className="flex items-center justify-center gap-2 text-xs font-medium text-slate-700">
                <Upload className="w-4 h-4 text-orange-600" />
                {uploading
                  ? 'Uploading receipt...'
                  : form.receiptUrl
                  ? 'Receipt attached (Click to replace)'
                  : 'Upload Receipt Image / PDF'}
              </div>
            </label>

            {uploadError && <p className="text-xs text-red-600">{uploadError}</p>}

            <button
              type="submit"
              className="w-full py-2.5 text-sm font-semibold bg-orange-600 hover:bg-orange-700 text-white rounded-lg cursor-pointer"
            >
              Record Expense
            </button>
          </form>
        )}

        <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <th className="py-3 px-4">Date</th>
                  <th className="py-3 px-4">Expense</th>
                  <th className="py-3 px-4">Category</th>
                  <th className="py-3 px-4 text-right">Amount</th>
                  <th className="py-3 px-4 text-right">Receipt</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {loading ? (
                  <tr>
                    <td colSpan={5} className="py-10 text-center text-slate-400">
                      Loading expenses...
                    </td>
                  </tr>
                ) : (
                  expenses.map((exp) => (
                    <tr key={exp.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4 text-xs font-mono-num text-slate-500">{exp.expenseDate}</td>
                      <td className="py-3 px-4">
                        <div className="font-semibold text-slate-900">{exp.title}</div>
                        <div className="text-xs text-slate-500">
                          {exp.vendorName || 'Direct'} · {exp.paymentMethod.toUpperCase()}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600">{exp.category}</td>
                      <td className="py-3 px-4 text-right font-mono-num font-bold text-slate-900">
                        {formatInr(exp.amount)}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          {exp.receiptUrl && (
                            <button
                              type="button"
                              onClick={() => handleViewReceipt(exp)}
                              className="text-xs text-orange-600 hover:underline flex items-center gap-1 cursor-pointer"
                            >
                              <FileText className="w-3.5 h-3.5" /> View
                            </button>
                          )}
                          {canManageExpenses && (
                            <button
                              onClick={async () => {
                                await apiFetch(`/expenses/${exp.id}`, { method: 'DELETE' });
                                await loadExpenses();
                              }}
                              className="text-slate-400 hover:text-red-600 cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Authenticated Receipt Preview Modal */}
      {receiptPreview && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-2xl rounded-2xl p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-sm font-bold text-slate-900">Receipt: {receiptPreview.title}</h3>
              <button onClick={closeReceiptPreview} className="text-slate-500 hover:text-slate-900 cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
            {receiptPreview.contentType.includes('pdf') ? (
              <iframe
                src={receiptPreview.blobUrl}
                title={receiptPreview.title}
                className="w-full h-[70vh] rounded-lg border border-slate-200"
              />
            ) : (
              <img
                src={receiptPreview.blobUrl}
                alt={receiptPreview.title}
                className="max-h-[70vh] mx-auto rounded-lg object-contain border border-slate-200"
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
};
