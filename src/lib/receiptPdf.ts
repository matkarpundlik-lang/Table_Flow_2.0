import { jsPDF } from 'jspdf';
import { ReceiptRecord } from '../types/dineflow';

function moneyPdf(val: number): string {
  return `Rs. ${Number(val || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function buildReceiptShareText(receipt: ReceiptRecord): string {
  const restName = receipt.restaurantSnapshot?.name || receipt.templateSnapshot?.businessName || 'Restaurant';
  const lines: string[] = [
    `*${restName}*`,
    `Receipt No: ${receipt.receiptNumber}`,
    `Order: ${receipt.orderNumber || '-'}`,
    receipt.tableNumber ? `Table: ${receipt.tableNumber}` : '',
    `Date: ${new Date(receipt.createdAt).toLocaleString('en-IN')}`,
    `Status: ${receipt.paymentStatus} (${receipt.paymentMethod})`,
    '--------------------------------',
    ...receipt.itemsSnapshot.map(
      (it) => `${it.itemName} x${it.quantity} = INR ${it.itemTotal.toFixed(2)}`,
    ),
    '--------------------------------',
    `Subtotal: INR ${receipt.subtotal.toFixed(2)}`,
    receipt.discountAmount > 0 ? `Discount: -INR ${receipt.discountAmount.toFixed(2)}` : '',
    receipt.cgstAmount > 0 ? `CGST: INR ${receipt.cgstAmount.toFixed(2)}` : '',
    receipt.sgstAmount > 0 ? `SGST: INR ${receipt.sgstAmount.toFixed(2)}` : '',
    receipt.serviceChargeAmount > 0
      ? `Service Charge: INR ${receipt.serviceChargeAmount.toFixed(2)}`
      : '',
    receipt.otherChargesAmount > 0
      ? `${receipt.otherChargesLabel || 'Other Charges'}: INR ${receipt.otherChargesAmount.toFixed(2)}`
      : '',
    `*Grand Total: INR ${receipt.grandTotal.toFixed(2)}*`,
    receipt.transactionId ? `Txn Ref: ${receipt.transactionId}` : '',
    receipt.templateSnapshot?.thankYouMessage || 'Thank you for dining with us!',
  ];
  return lines.filter(Boolean).join('\n');
}

export function buildWhatsAppShareUrl(receipt: ReceiptRecord): string {
  const text = encodeURIComponent(buildReceiptShareText(receipt));
  return `https://wa.me/?text=${text}`;
}

export function downloadReceiptPdf(receipt: ReceiptRecord) {
  const tpl = receipt.templateSnapshot;
  const vis = tpl.visibility;
  const paper = tpl.paperSize || '80mm';
  const pageWidthMm = paper === '58mm' ? 58 : paper === 'A4' ? 210 : 80;
  const margin = paper === 'A4' ? 16 : 4;
  const contentWidth = pageWidthMm - margin * 2;
  const estHeight = Math.max(150, 120 + receipt.itemsSnapshot.length * 8);

  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: paper === 'A4' ? 'a4' : [pageWidthMm, estHeight],
  });

  const fontName =
    tpl.fontStyle === 'serif' ? 'times' : tpl.fontStyle === 'sans' ? 'helvetica' : 'courier';
  const baseFont = paper === 'A4' ? 10 : paper === '58mm' ? 7.5 : 8.5;
  let y = paper === 'A4' ? 18 : 8;

  const isCentered = tpl.layoutMode === 'centered';
  const centerX = pageWidthMm / 2;

  const drawText = (text: string, size: number, bold = false, align: 'left' | 'center' | 'right' = 'left') => {
    doc.setFont(fontName, bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    const wrapped = doc.splitTextToSize(text, contentWidth);
    const x = align === 'center' ? centerX : align === 'right' ? pageWidthMm - margin : margin;
    for (const line of wrapped) {
      doc.text(line, x, y, { align });
      y += size * 0.44 + 1;
    }
  };

  const drawRow = (left: string, right: string, size = baseFont, bold = false) => {
    doc.setFont(fontName, bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    const leftClipped = left.length > (paper === '58mm' ? 20 : 34) ? `${left.slice(0, paper === '58mm' ? 19 : 33)}…` : left;
    doc.text(leftClipped, margin, y);
    doc.text(right, pageWidthMm - margin, y, { align: 'right' });
    y += size * 0.44 + 1.2;
  };

  const drawDivider = () => {
    doc.setDrawColor(180, 180, 180);
    doc.setLineDashPattern([1, 1], 0);
    doc.line(margin, y, pageWidthMm - margin, y);
    doc.setLineDashPattern([], 0);
    y += 3.5;
  };

  const businessName = tpl.businessName || receipt.restaurantSnapshot?.name || 'DineFlow Outlet';
  const address = tpl.address || receipt.restaurantSnapshot?.address || '';
  const phone = tpl.phone || receipt.restaurantSnapshot?.phone || '';
  const gstin = tpl.gstin || receipt.restaurantSnapshot?.gstin || '';

  drawText(businessName.toUpperCase(), baseFont + 2.5, true, isCentered ? 'center' : 'left');
  if (address) drawText(address, baseFont - 1, false, isCentered ? 'center' : 'left');
  if (phone) drawText(`Tel: ${phone}`, baseFont - 1, false, isCentered ? 'center' : 'left');
  if (vis.gstin && gstin) drawText(`GSTIN: ${gstin}`, baseFont - 1, false, isCentered ? 'center' : 'left');
  if (tpl.headerMessage) drawText(tpl.headerMessage, baseFont - 0.5, true, isCentered ? 'center' : 'left');

  y += 1.5;
  drawDivider();

  drawRow('Receipt #', receipt.receiptNumber, baseFont - 0.5, true);
  drawRow('Date', new Date(receipt.createdAt).toLocaleString('en-IN'), baseFont - 1);
  if (vis.orderId && receipt.orderNumber) drawRow('Order #', receipt.orderNumber, baseFont - 0.5);
  if (vis.tableNumber && receipt.tableNumber) drawRow('Table', receipt.tableNumber, baseFont - 0.5);
  if (vis.customerName && receipt.customerName) drawRow('Guest', receipt.customerName, baseFont - 0.5);
  if (vis.customerPhone && receipt.customerPhone) drawRow('Phone', receipt.customerPhone, baseFont - 0.5);
  if (vis.paymentMethod) drawRow('Method', receipt.paymentMethod, baseFont - 0.5);
  drawRow('Status', receipt.paymentStatus.toUpperCase(), baseFont - 0.5, true);
  if (vis.transactionId && receipt.transactionId) {
    drawRow('Txn ID', receipt.transactionId, baseFont - 1);
  }

  y += 1;
  drawDivider();
  drawRow('ITEM', 'AMOUNT', baseFont - 0.5, true);
  y += 0.5;

  for (const item of receipt.itemsSnapshot) {
    const lineLabel = `${item.itemName} x${item.quantity}`;
    drawRow(lineLabel, moneyPdf(item.itemTotal), baseFont - 0.5);
    if (item.variantName || item.addonsSummary) {
      drawText(
        `  ${[item.variantName, item.addonsSummary].filter(Boolean).join(' · ')}`,
        baseFont - 1.4,
      );
    }
  }

  y += 1;
  drawDivider();

  drawRow('Subtotal', moneyPdf(receipt.subtotal), baseFont - 0.5);
  if (vis.discountBreakdown && receipt.discountAmount > 0) {
    drawRow('Discount', `-${moneyPdf(receipt.discountAmount)}`, baseFont - 0.5);
  }
  if (vis.taxBreakdown && (receipt.cgstAmount > 0 || receipt.sgstAmount > 0)) {
    const halfRate = Number((receipt.gstRateApplied / 2).toFixed(2));
    drawRow(`CGST (${halfRate}%)`, moneyPdf(receipt.cgstAmount), baseFont - 0.5);
    drawRow(`SGST (${halfRate}%)`, moneyPdf(receipt.sgstAmount), baseFont - 0.5);
  }
  if (vis.serviceCharge && receipt.serviceChargeAmount > 0) {
    drawRow(
      `Service Charge (${receipt.serviceChargeRateApplied}%)`,
      moneyPdf(receipt.serviceChargeAmount),
      baseFont - 0.5,
    );
  }
  if (receipt.otherChargesAmount > 0) {
    drawRow(
      receipt.otherChargesLabel || 'Other Charges',
      moneyPdf(receipt.otherChargesAmount),
      baseFont - 0.5,
    );
  }

  y += 1;
  drawDivider();
  drawRow('GRAND TOTAL', moneyPdf(receipt.grandTotal), baseFont + 1.5, true);
  drawRow('Paid Amount', moneyPdf(receipt.amountPaid), baseFont - 0.5);
  if (receipt.balanceDue > 0.01) {
    drawRow('Balance Due', moneyPdf(receipt.balanceDue), baseFont - 0.5, true);
  }
  if (receipt.refundedAmount > 0) {
    drawRow('Refunded', moneyPdf(receipt.refundedAmount), baseFont - 0.5);
  }

  y += 2;
  drawDivider();
  if (tpl.thankYouMessage) {
    drawText(tpl.thankYouMessage, baseFont - 0.5, true, 'center');
  }
  if (vis.footerMessage && tpl.footerMessage) {
    drawText(tpl.footerMessage, baseFont - 1, false, 'center');
  }
  if (vis.socialHandles && tpl.socialHandles) {
    const socials = [
      tpl.socialHandles.instagram ? `IG: ${tpl.socialHandles.instagram}` : '',
      tpl.socialHandles.website || '',
    ]
      .filter(Boolean)
      .join(' | ');
    if (socials) drawText(socials, baseFont - 1.2, false, 'center');
  }

  doc.save(`${receipt.receiptNumber}.pdf`);
}
