import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Download,
  Eye,
  RefreshCw,
  RotateCcw,
  Search,
  X,
  XCircle,
} from 'lucide-react';
import { apiFetch, formatInr } from '../lib/api';
import { downloadReceiptPdf } from '../lib/receiptPdf';
import { PaymentRecord, ReceiptRecord } from '../types/dineflow';
import { DigitalReceiptModal } from './ReceiptDocument';

interface BillingHistoryPayload {
  receipts: ReceiptRecord[];
  pendingPayments: PaymentRecord[];
}

export const BillingHistoryView: React.FC<{
  canConfirmPayments: boolean;
  canRefund: boolean;
  refreshKey?: number;
}> = ({ canConfirmPayments, canRefund, refreshKey = 0 }) => {
  const [receipts, setReceipts] = useState<ReceiptRecord[]>([]);
  const [pendingPayments, setPendingPayments] = useState<PaymentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionMsg, setActionMsg] = useState('');

  // Filters
  const [search, setSearch] = useState('');
  const [methodFilter, setMethodFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const [selectedReceipt, setSelectedReceipt] = useState<ReceiptRecord | null>(null);
  const [confirmBusyId, setConfirmBusyId] = useState<number | null>(null);
  const [confirmRefMap, setConfirmRefMap] = useState<Record<number, string>>({});

  // Refund Modal state
  const [refundTarget, setRefundTarget] = useState<ReceiptRecord | null>(null);
  const [refundAmount, setRefundAmount] = useState('');
  const [refundReason, setRefundReason] = useState('');
  const [refundBusy, setRefundBusy] = useState(false);

  const loadHistory = async () => {
    setLoading(true);
    setError('');
    try {
      const qs = new URLSearchParams();
      if (search.trim()) qs.set('search', search.trim());
      if (methodFilter !== 'all') qs.set('method', methodFilter);
      if (statusFilter !== 'all') qs.set('status', statusFilter);
      if (dateFrom) qs.set('dateFrom', dateFrom);
      if (dateTo) qs.set('dateTo', dateTo);

      const data = await apiFetch<BillingHistoryPayload>(`/billing/history?${qs.toString()}`);
      setReceipts(data.receipts);
      setPendingPayments(data.pendingPayments);
    } catch (err: any) {
      setError(err.message || 'Failed to load billing history');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadHistory();
  }, [refreshKey, methodFilter, statusFilter, dateFrom, dateTo]);

  const handleConfirmPayment = async (pay: PaymentRecord) => {
    setConfirmBusyId(pay.id);
    setError('');
    setActionMsg('');
    try {
      const refVal = confirmRefMap[pay.id] ?? (pay.customerUtrSubmitted || pay.transactionRef || '');
      const res = await apiFetch<{ payment: PaymentRecord; receipt: ReceiptRecord }>(
        `/payments/${pay.id}/confirm`,
        {
          method: 'POST',
          body: JSON.stringify({ transactionRef: refVal }),
        },
      );
      setActionMsg(
        `Payment confirmed for ${pay.tableNumber || pay.orderNumber}. Receipt ${res.receipt.receiptNumber} generated.`,
      );
      await loadHistory();
    } catch (err: any) {
      setError(err.message || 'Failed to confirm payment');
    } finally {
      setConfirmBusyId(null);
    }
  };

  const handleRejectPayment = async (pay: PaymentRecord) => {
    setConfirmBusyId(pay.id);
    setError('');
    try {
      await apiFetch(`/payments/${pay.id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'Payment not received / verification failed' }),
      });
      setActionMsg(`Rejected payment #${pay.id} (${pay.orderNumber || ''}).`);
      await loadHistory();
    } catch (err: any) {
      setError(err.message || 'Failed to reject payment');
    } finally {
      setConfirmBusyId(null);
    }
  };

  const openRefundModal = (r: ReceiptRecord) => {
    const refundable = Math.max(0, Number((r.amountPaid - r.refundedAmount).toFixed(2)));
    setRefundTarget(r);
    setRefundAmount(refundable > 0 ? String(refundable) : '');
    setRefundReason('');
  };

  const submitRefund = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!refundTarget || !refundTarget.paymentId) return;
    setRefundBusy(true);
    setError('');
    try {
      const res = await apiFetch<{ receipt: ReceiptRecord | null }>(
        `/payments/${refundTarget.paymentId}/refund`,
        {
          method: 'POST',
          body: JSON.stringify({
            amount: Number(refundAmount),
            reason: refundReason || 'Refund processed by management',
          }),
        },
      );
      setRefundTarget(null);
      setActionMsg(`Refund recorded for ${refundTarget.receiptNumber}.`);
      if (res.receipt && selectedReceipt?.id === res.receipt.id) {
        setSelectedReceipt(res.receipt);
      }
      await loadHistory();
    } catch (err: any) {
      setError(err.message || 'Failed to issue refund');
    } finally {
      setRefundBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Billing History & Verifications</h2>
          <p className="text-sm text-slate-500">
            Verify pending customer UPI/Cash payments, view immutable digital receipts, and manage refunds.
          </p>
        </div>

        <button
          type="button"
          onClick={loadHistory}
          className="px-3.5 py-2 text-xs font-semibold bg-white border border-slate-300 text-slate-800 rounded-lg hover:bg-slate-50 flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-xs font-medium px-4 py-3 rounded-xl">
          {error}
        </div>
      )}
      {actionMsg && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-medium px-4 py-3 rounded-xl">
          {actionMsg}
        </div>
      )}

      {/* Pending Customer Payment Verifications */}
      {pendingPayments.length > 0 && (
        <div className="bg-amber-50/70 border border-amber-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-amber-200 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-amber-950">
                Pending Customer Payment Verifications ({pendingPayments.length})
              </h3>
              <p className="text-xs text-amber-800">
                Bills stay unpaid until an authorised staff member confirms receipt of UPI, Cash, or Card payment.
              </p>
            </div>
          </div>

          <div className="divide-y divide-amber-200/70">
            {pendingPayments.map((pay) => (
              <div
                key={pay.id}
                className="p-4 flex flex-wrap items-center justify-between gap-4 bg-white/80"
              >
                <div className="space-y-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900">
                    <span>{pay.tableNumber ? `Table ${pay.tableNumber}` : pay.orderNumber}</span>
                    <span className="text-slate-400">·</span>
                    <span className="font-mono-num">{formatInr(pay.amount)}</span>
                    <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-900 font-semibold">
                      {pay.paymentMethodLabel || pay.method.toUpperCase()}
                    </span>
                    <span className="text-xs font-semibold text-amber-700">
                      {pay.status === 'processing' ? 'UTR Submitted · Verify' : 'Awaiting Confirmation'}
                    </span>
                  </div>
                  <div className="text-xs text-slate-500 flex flex-wrap gap-3">
                    <span>Guest: {pay.customerName || 'Guest'}</span>
                    <span>Order: {pay.orderNumber}</span>
                    {pay.customerUtrSubmitted && (
                      <span className="font-mono-num text-slate-800 font-medium">
                        Customer UTR: {pay.customerUtrSubmitted}
                      </span>
                    )}
                    <span>{new Date(pay.createdAt).toLocaleTimeString('en-IN')}</span>
                  </div>
                </div>

                {canConfirmPayments && (
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      value={confirmRefMap[pay.id] ?? pay.customerUtrSubmitted ?? ''}
                      onChange={(e) =>
                        setConfirmRefMap((prev) => ({ ...prev, [pay.id]: e.target.value }))
                      }
                      placeholder="UTR / Auth Ref"
                      className="px-2.5 py-1.5 text-xs font-mono-num border border-slate-300 rounded-lg bg-white w-36"
                    />
                    <button
                      type="button"
                      disabled={confirmBusyId === pay.id}
                      onClick={() => handleConfirmPayment(pay)}
                      className="px-3 py-1.5 text-xs font-semibold bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 flex items-center gap-1 whitespace-nowrap cursor-pointer disabled:opacity-50"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Confirm Paid
                    </button>
                    <button
                      type="button"
                      disabled={confirmBusyId === pay.id}
                      onClick={() => handleRejectPayment(pay)}
                      className="px-3 py-1.5 text-xs font-semibold bg-white border border-red-200 text-red-700 rounded-lg hover:bg-red-50 flex items-center gap-1 whitespace-nowrap cursor-pointer disabled:opacity-50"
                    >
                      <XCircle className="w-3.5 h-3.5" />
                      Reject
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filter Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') loadHistory();
            }}
            placeholder="Search receipt #, order #, guest, table, or txn ID..."
            className="w-full pl-9 pr-3 py-2 text-xs border border-slate-300 rounded-lg"
          />
        </div>
        <select
          value={methodFilter}
          onChange={(e) => setMethodFilter(e.target.value)}
          className="px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
        >
          <option value="all">All Methods</option>
          <option value="upi">UPI</option>
          <option value="cash">Cash</option>
          <option value="card">Card</option>
          <option value="gateway">Online Gateway</option>
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
        >
          <option value="all">All Statuses</option>
          <option value="Paid">Paid</option>
          <option value="Partially Paid">Partially Paid</option>
          <option value="Refunded">Refunded</option>
        </select>
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="px-2.5 py-2 text-xs border border-slate-300 rounded-lg bg-white"
        />
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="px-2.5 py-2 text-xs border border-slate-300 rounded-lg bg-white"
        />
        <button
          type="button"
          onClick={loadHistory}
          className="px-3.5 py-2 text-xs font-semibold bg-slate-900 text-white rounded-lg hover:bg-slate-800 whitespace-nowrap cursor-pointer"
        >
          Apply
        </button>
      </div>

      {/* Receipts Ledger */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                <th className="py-3 px-4">Receipt #</th>
                <th className="py-3 px-4">Date & Time</th>
                <th className="py-3 px-4">Table / Order</th>
                <th className="py-3 px-4">Guest</th>
                <th className="py-3 px-4">Method</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Amount</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {loading && (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-xs text-slate-500">
                    Loading receipts...
                  </td>
                </tr>
              )}
              {!loading && receipts.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-10 text-center text-xs text-slate-500">
                    No receipts found matching your filters. Receipts are generated automatically upon verified payments.
                  </td>
                </tr>
              )}
              {!loading &&
                receipts.map((r) => {
                  const statusColor =
                    r.paymentStatus === 'Paid'
                      ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                      : r.paymentStatus === 'Refunded'
                      ? 'text-rose-700 bg-rose-50 border-rose-200'
                      : 'text-amber-700 bg-amber-50 border-amber-200';
                  const refundable = r.amountPaid - (r.refundedAmount || 0) > 0.5 && r.paymentId;

                  return (
                    <tr key={r.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4 font-mono-num text-xs font-semibold text-slate-900">
                        {r.receiptNumber}
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600 font-mono-num whitespace-nowrap">
                        {new Date(r.createdAt).toLocaleString('en-IN', {
                          day: '2-digit',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </td>
                      <td className="py-3 px-4 text-xs">
                        <div className="font-medium text-slate-900">
                          {r.tableNumber ? `Table ${r.tableNumber}` : 'Takeaway'}
                        </div>
                        <div className="text-slate-500 font-mono-num">{r.orderNumber}</div>
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-700">{r.customerName}</td>
                      <td className="py-3 px-4 text-xs text-slate-700">
                        <div>{r.paymentMethod}</div>
                        {r.transactionId && (
                          <div className="text-[11px] font-mono-num text-slate-400 truncate max-w-[140px]">
                            {r.transactionId}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`inline-block px-2 py-0.5 text-[11px] font-semibold border rounded ${statusColor}`}
                        >
                          {r.paymentStatus}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right font-mono-num text-xs font-semibold text-slate-900">
                        {formatInr(r.grandTotal)}
                        {r.refundedAmount > 0 && (
                          <div className="text-[11px] font-normal text-rose-600">
                            -{formatInr(r.refundedAmount)} refunded
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setSelectedReceipt(r)}
                            className="px-2.5 py-1.5 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg inline-flex items-center gap-1 whitespace-nowrap cursor-pointer"
                          >
                            <Eye className="w-3.5 h-3.5" /> View
                          </button>
                          <button
                            type="button"
                            onClick={() => downloadReceiptPdf(r)}
                            className="px-2.5 py-1.5 text-xs font-medium bg-white border border-slate-200 hover:bg-slate-50 text-slate-800 rounded-lg inline-flex items-center gap-1 whitespace-nowrap cursor-pointer"
                          >
                            <Download className="w-3.5 h-3.5" /> PDF
                          </button>
                          {canRefund && refundable && (
                            <button
                              type="button"
                              onClick={() => openRefundModal(r)}
                              className="px-2.5 py-1.5 text-xs font-medium bg-white border border-rose-200 hover:bg-rose-50 text-rose-700 rounded-lg inline-flex items-center gap-1 whitespace-nowrap cursor-pointer"
                            >
                              <RotateCcw className="w-3.5 h-3.5" /> Refund
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </div>

      {selectedReceipt && (
        <DigitalReceiptModal
          receipt={selectedReceipt}
          onClose={() => setSelectedReceipt(null)}
        />
      )}

      {refundTarget && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <form
            onSubmit={submitRefund}
            className="bg-white rounded-2xl w-full max-w-md p-6 space-y-4 shadow-xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900">
                Issue Refund · {refundTarget.receiptNumber}
              </h3>
              <button
                type="button"
                onClick={() => setRefundTarget(null)}
                className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-slate-500">
              Paid Amount: {formatInr(refundTarget.amountPaid)} · Previously Refunded:{' '}
              {formatInr(refundTarget.refundedAmount || 0)}
            </p>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Refund Amount (₹)
              </label>
              <input
                type="number"
                step="0.01"
                min="1"
                max={Math.max(1, refundTarget.amountPaid - (refundTarget.refundedAmount || 0))}
                value={refundAmount}
                onChange={(e) => setRefundAmount(e.target.value)}
                required
                className="w-full px-3 py-2 text-sm font-mono-num border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Reason for Refund
              </label>
              <input
                value={refundReason}
                onChange={(e) => setRefundReason(e.target.value)}
                placeholder="Duplicate charge / Item unavailable / Guest adjustment"
                required
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setRefundTarget(null)}
                className="px-4 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={refundBusy}
                className="px-4 py-2 text-xs font-semibold bg-rose-600 text-white rounded-lg hover:bg-rose-700 cursor-pointer disabled:opacity-50"
              >
                {refundBusy ? 'Processing...' : 'Confirm Refund'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
