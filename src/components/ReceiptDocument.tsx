import React, { useState } from 'react';
import { Check, Download, MessageCircle, Printer, Share2, X } from 'lucide-react';
import { formatInr } from '../lib/api';
import { buildReceiptShareText, buildWhatsAppShareUrl, downloadReceiptPdf } from '../lib/receiptPdf';
import { ReceiptRecord } from '../types/dineflow';

export const ReceiptDocument: React.FC<{
  receipt: ReceiptRecord;
  isPreview?: boolean;
}> = ({ receipt, isPreview = false }) => {
  const tpl = receipt.templateSnapshot;
  const vis = tpl.visibility;
  const isCentered = tpl.layoutMode === 'centered';
  const isCompact = tpl.layoutMode === 'compact' || tpl.paperSize === '58mm';
  const isModern = tpl.templateKey === 'modern';
  const isPremium = tpl.templateKey === 'premium';

  const fontClass =
    tpl.fontStyle === 'serif'
      ? 'font-serif'
      : tpl.fontStyle === 'sans'
      ? 'font-sans'
      : 'font-mono';

  const sizeClass =
    tpl.fontSize === 'sm' ? 'text-[11px]' : tpl.fontSize === 'lg' ? 'text-sm' : 'text-xs';

  const maxWidthClass =
    tpl.paperSize === '58mm'
      ? 'max-w-[290px]'
      : tpl.paperSize === 'A4'
      ? 'max-w-[540px]'
      : 'max-w-[380px]';

  const businessName = tpl.businessName || receipt.restaurantSnapshot?.name || 'DineFlow Outlet';
  const logoUrl = tpl.logoUrl || receipt.restaurantSnapshot?.logoUrl || '';
  const address = tpl.address || receipt.restaurantSnapshot?.address || '';
  const phone = tpl.phone || receipt.restaurantSnapshot?.phone || '';
  const email = tpl.email || receipt.restaurantSnapshot?.email || '';
  const gstin = tpl.gstin || receipt.restaurantSnapshot?.gstin || '';
  const halfGstRate = Number(((receipt.gstRateApplied || 0) / 2).toFixed(2));

  const statusTone =
    receipt.paymentStatus === 'Paid'
      ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
      : receipt.paymentStatus === 'Refunded'
      ? 'text-rose-700 bg-rose-50 border-rose-200'
      : receipt.paymentStatus === 'Partially Paid'
      ? 'text-amber-700 bg-amber-50 border-amber-200'
      : 'text-slate-700 bg-slate-100 border-slate-200';

  return (
    <div
      id={isPreview ? undefined : 'printable-receipt'}
      className={`mx-auto w-full ${maxWidthClass} bg-white text-slate-900 border border-slate-200 shadow-sm ${
        isPremium ? 'rounded-2xl' : isModern ? 'rounded-xl' : 'rounded-md'
      } overflow-hidden ${fontClass} ${sizeClass}`}
    >
      {/* Accent Header Band */}
      <div
        className="h-1.5 w-full"
        style={{ backgroundColor: tpl.accentColor || '#0F172A' }}
      />

      <div className={isCompact ? 'p-4 space-y-3' : 'p-6 space-y-4'}>
        {/* Restaurant Header */}
        <div className={isCentered ? 'text-center space-y-1.5' : 'text-left space-y-1.5'}>
          {vis.logo && logoUrl && (
            <div className={isCentered ? 'flex justify-center mb-2' : 'mb-2'}>
              <img
                src={logoUrl}
                alt={businessName}
                className="h-12 w-12 object-contain rounded-lg border border-slate-200 bg-white p-0.5"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                }}
              />
            </div>
          )}

          <h3
            className="font-bold tracking-tight text-slate-950"
            style={{
              fontSize: tpl.fontSize === 'lg' ? '1.2rem' : tpl.fontSize === 'sm' ? '0.95rem' : '1.05rem',
            }}
          >
            {businessName}
          </h3>
          {address && <p className="text-slate-600 leading-snug">{address}</p>}
          {(phone || email) && (
            <p className="text-slate-500">
              {[phone ? `Tel: ${phone}` : '', email].filter(Boolean).join(' · ')}
            </p>
          )}
          {vis.gstin && gstin && (
            <p className="font-mono-num text-[11px] text-slate-600">GSTIN: {gstin}</p>
          )}
          {tpl.headerMessage && (
            <div
              className="pt-1 font-semibold uppercase tracking-wider text-[10px]"
              style={{ color: tpl.accentColor || '#0F172A' }}
            >
              {tpl.headerMessage}
            </div>
          )}
        </div>

        <div className="border-t border-dashed border-slate-300" />

        {/* Transaction Info */}
        <div className="space-y-1 text-slate-700">
          <div className="flex justify-between gap-2">
            <span className="text-slate-500">Receipt No</span>
            <span className="font-semibold font-mono-num text-slate-900">{receipt.receiptNumber}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-slate-500">Date & Time</span>
            <span className="font-mono-num text-right">
              {new Date(receipt.createdAt).toLocaleString('en-IN', {
                day: '2-digit',
                month: 'short',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          </div>
          {vis.orderId && receipt.orderNumber && (
            <div className="flex justify-between gap-2">
              <span className="text-slate-500">Order No</span>
              <span className="font-mono-num font-medium">{receipt.orderNumber}</span>
            </div>
          )}
          {vis.tableNumber && receipt.tableNumber && (
            <div className="flex justify-between gap-2">
              <span className="text-slate-500">Table</span>
              <span className="font-medium">{receipt.tableNumber}</span>
            </div>
          )}
          {vis.customerName && receipt.customerName && (
            <div className="flex justify-between gap-2">
              <span className="text-slate-500">Guest</span>
              <span className="font-medium">{receipt.customerName}</span>
            </div>
          )}
          {vis.customerPhone && receipt.customerPhone && (
            <div className="flex justify-between gap-2">
              <span className="text-slate-500">Phone</span>
              <span className="font-mono-num">{receipt.customerPhone}</span>
            </div>
          )}
          {vis.paymentMethod && (
            <div className="flex justify-between gap-2">
              <span className="text-slate-500">Payment Method</span>
              <span className="font-medium">{receipt.paymentMethod}</span>
            </div>
          )}
          {vis.transactionId && receipt.transactionId && (
            <div className="flex justify-between gap-2">
              <span className="text-slate-500">Transaction ID</span>
              <span className="font-mono-num text-[11px] break-all text-right">
                {receipt.transactionId}
              </span>
            </div>
          )}
          <div className="flex justify-between items-center gap-2 pt-0.5">
            <span className="text-slate-500">Payment Status</span>
            <span
              className={`px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide border rounded ${statusTone}`}
            >
              {receipt.paymentStatus}
            </span>
          </div>
        </div>

        <div className="border-t border-dashed border-slate-300" />

        {/* Itemised Table */}
        <div>
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 text-[10px] uppercase tracking-wider text-slate-500">
                <th className="py-1.5 pr-2 font-semibold">Item</th>
                <th className="py-1.5 px-1.5 text-center font-semibold">Qty</th>
                <th className="py-1.5 px-1.5 text-right font-semibold">Price</th>
                <th className="py-1.5 pl-1.5 text-right font-semibold">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {receipt.itemsSnapshot.map((item, idx) => (
                <tr key={idx}>
                  <td className="py-1.5 pr-2 align-top">
                    <div className="font-medium text-slate-900">{item.itemName}</div>
                    {(item.variantName || item.addonsSummary) && (
                      <div className="text-[10px] text-slate-500">
                        {[item.variantName, item.addonsSummary].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </td>
                  <td className="py-1.5 px-1.5 text-center align-top font-mono-num">
                    {item.quantity}
                  </td>
                  <td className="py-1.5 px-1.5 text-right align-top font-mono-num text-slate-600">
                    {formatInr(item.unitPrice)}
                  </td>
                  <td className="py-1.5 pl-1.5 text-right align-top font-mono-num font-medium text-slate-900">
                    {formatInr(item.itemTotal)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="border-t border-dashed border-slate-300" />

        {/* Totals Breakdown */}
        <div className="space-y-1 text-slate-700">
          <div className="flex justify-between">
            <span>Subtotal</span>
            <span className="font-mono-num">{formatInr(receipt.subtotal)}</span>
          </div>
          {vis.discountBreakdown && receipt.discountAmount > 0 && (
            <div className="flex justify-between text-emerald-700">
              <span>Discount</span>
              <span className="font-mono-num">-{formatInr(receipt.discountAmount)}</span>
            </div>
          )}
          {vis.taxBreakdown && (receipt.cgstAmount > 0 || receipt.sgstAmount > 0) && (
            <>
              <div className="flex justify-between">
                <span>CGST ({halfGstRate}%)</span>
                <span className="font-mono-num">{formatInr(receipt.cgstAmount)}</span>
              </div>
              <div className="flex justify-between">
                <span>SGST ({halfGstRate}%)</span>
                <span className="font-mono-num">{formatInr(receipt.sgstAmount)}</span>
              </div>
            </>
          )}
          {vis.serviceCharge && receipt.serviceChargeAmount > 0 && (
            <div className="flex justify-between">
              <span>Service Charge ({receipt.serviceChargeRateApplied}%)</span>
              <span className="font-mono-num">{formatInr(receipt.serviceChargeAmount)}</span>
            </div>
          )}
          {receipt.otherChargesAmount > 0 && (
            <div className="flex justify-between">
              <span>{receipt.otherChargesLabel || 'Other Charges'}</span>
              <span className="font-mono-num">{formatInr(receipt.otherChargesAmount)}</span>
            </div>
          )}

          <div
            className="flex justify-between items-baseline pt-2 mt-1.5 border-t border-slate-300 font-bold text-slate-950"
            style={{ fontSize: tpl.fontSize === 'sm' ? '0.85rem' : '1rem' }}
          >
            <span>Grand Total</span>
            <span className="font-mono-num" style={{ color: tpl.accentColor || '#0F172A' }}>
              {formatInr(receipt.grandTotal)}
            </span>
          </div>

          <div className="flex justify-between text-[11px] text-slate-600 pt-0.5">
            <span>Paid Amount</span>
            <span className="font-mono-num font-medium">{formatInr(receipt.amountPaid)}</span>
          </div>
          {receipt.balanceDue > 0.01 && (
            <div className="flex justify-between text-[11px] font-semibold text-amber-700">
              <span>Balance Due</span>
              <span className="font-mono-num">{formatInr(receipt.balanceDue)}</span>
            </div>
          )}
          {receipt.refundedAmount > 0 && (
            <div className="flex justify-between text-[11px] font-semibold text-rose-700">
              <span>Refunded ({receipt.refundReason || 'Processed'})</span>
              <span className="font-mono-num">-{formatInr(receipt.refundedAmount)}</span>
            </div>
          )}
        </div>

        {/* Footer & Social Handles */}
        {(tpl.thankYouMessage || (vis.footerMessage && tpl.footerMessage) || vis.socialHandles) && (
          <>
            <div className="border-t border-dashed border-slate-300" />
            <div className="text-center space-y-1 text-slate-600">
              {tpl.thankYouMessage && (
                <p className="font-semibold text-slate-800">{tpl.thankYouMessage}</p>
              )}
              {vis.footerMessage && tpl.footerMessage && (
                <p className="text-[11px] text-slate-500">{tpl.footerMessage}</p>
              )}
              {vis.socialHandles && tpl.socialHandles && (
                <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5 text-[10px] text-slate-500 pt-1">
                  {tpl.socialHandles.instagram && <span>IG: {tpl.socialHandles.instagram}</span>}
                  {tpl.socialHandles.facebook && <span>FB: {tpl.socialHandles.facebook}</span>}
                  {tpl.socialHandles.website && <span>{tpl.socialHandles.website}</span>}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export const DigitalReceiptModal: React.FC<{
  receipt: ReceiptRecord;
  onClose: () => void;
}> = ({ receipt, onClose }) => {
  const [copiedShare, setCopiedShare] = useState(false);

  const handleShare = async () => {
    const shareText = buildReceiptShareText(receipt);
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({
          title: `Receipt ${receipt.receiptNumber}`,
          text: shareText,
        });
        return;
      } catch {
        // Fallback to clipboard copy
      }
    }
    try {
      await navigator.clipboard.writeText(shareText);
      setCopiedShare(true);
      setTimeout(() => setCopiedShare(false), 2000);
    } catch {
      // ignore clipboard errors
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
      <div className="bg-slate-100 rounded-2xl w-full max-w-xl shadow-2xl overflow-hidden my-auto max-h-[94vh] flex flex-col">
        <div className="no-print px-5 py-3.5 bg-white border-b border-slate-200 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-slate-900">Digital Bill Receipt</h3>
            <p className="text-xs text-slate-500 font-mono-num">{receipt.receiptNumber}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 cursor-pointer"
            aria-label="Close receipt modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 sm:p-6 overflow-y-auto flex-1">
          <ReceiptDocument receipt={receipt} />
        </div>

        <div className="no-print px-4 py-3.5 bg-white border-t border-slate-200 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => downloadReceiptPdf(receipt)}
              className="px-3.5 py-2 text-xs font-semibold bg-slate-900 text-white rounded-lg hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              Download PDF
            </button>
            <button
              type="button"
              onClick={() => window.print()}
              className="px-3.5 py-2 text-xs font-semibold bg-white border border-slate-300 text-slate-800 rounded-lg hover:bg-slate-50 flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <Printer className="w-3.5 h-3.5" />
              Print
            </button>
            <button
              type="button"
              onClick={handleShare}
              className="px-3.5 py-2 text-xs font-semibold bg-white border border-slate-300 text-slate-800 rounded-lg hover:bg-slate-50 flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              {copiedShare ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                  Copied!
                </>
              ) : (
                <>
                  <Share2 className="w-3.5 h-3.5" />
                  Share
                </>
              )}
            </button>
            <a
              href={buildWhatsAppShareUrl(receipt)}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3.5 py-2 text-xs font-semibold bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 flex items-center gap-1.5 whitespace-nowrap"
            >
              <MessageCircle className="w-3.5 h-3.5" />
              WhatsApp
            </a>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 whitespace-nowrap cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
