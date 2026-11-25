import React, { useState } from 'react';
import { formatInr } from '../lib/api';

interface DailyPoint {
  date: string;
  label: string;
  revenue: number;
  expenses: number;
  orders: number;
}

export const RevenueExpenseChart: React.FC<{ data: DailyPoint[] }> = ({ data }) => {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  if (!data || data.length === 0) {
    return (
      <div className="h-64 flex items-center justify-center text-sm text-slate-500">
        No daily financial records in this date window yet.
      </div>
    );
  }

  const maxVal = Math.max(
    1000,
    ...data.map((d) => Math.max(d.revenue, d.expenses)),
  );
  const niceMax = Math.ceil(maxVal / 1000) * 1000;
  const chartHeight = 200;
  const chartWidth = 620;
  const padLeft = 58;
  const padRight = 16;
  const padTop = 16;
  const padBottom = 32;
  const plotW = chartWidth - padLeft - padRight;
  const plotH = chartHeight - padTop - padBottom;

  const groupWidth = plotW / data.length;
  const barWidth = Math.min(20, Math.max(8, groupWidth * 0.28));

  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="relative w-full">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-5 text-xs text-slate-600">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-orange-600 inline-block" />
            Revenue
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-slate-300 inline-block" />
            Expenses
          </span>
        </div>
        {hoveredIdx !== null && data[hoveredIdx] && (
          <div className="text-xs font-mono-num text-slate-700 bg-slate-100 px-2.5 py-1 rounded-md border border-slate-200">
            {data[hoveredIdx].label} · Rev {formatInr(data[hoveredIdx].revenue)} · Exp{' '}
            {formatInr(data[hoveredIdx].expenses)} · {data[hoveredIdx].orders} orders
          </div>
        )}
      </div>

      <svg
        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
        className="w-full h-56 overflow-visible"
        role="img"
        aria-label="Revenue versus Expenses daily comparison chart"
      >
        {ticks.map((t) => {
          const y = padTop + plotH * (1 - t);
          const val = Math.round(niceMax * t);
          return (
            <g key={t}>
              <line
                x1={padLeft}
                x2={chartWidth - padRight}
                y1={y}
                y2={y}
                stroke="#e2e8f0"
                strokeDasharray={t === 0 ? undefined : '3 3'}
              />
              <text
                x={padLeft - 8}
                y={y + 4}
                textAnchor="end"
                className="fill-slate-400 text-[10px]"
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                {val >= 1000 ? `₹${(val / 1000).toFixed(0)}k` : `₹${val}`}
              </text>
            </g>
          );
        })}

        {data.map((d, i) => {
          const cx = padLeft + i * groupWidth + groupWidth / 2;
          const revH = (d.revenue / niceMax) * plotH;
          const expH = (d.expenses / niceMax) * plotH;
          const isHovered = hoveredIdx === i;

          return (
            <g
              key={d.date}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
              className="cursor-pointer"
            >
              <rect
                x={cx - groupWidth / 2}
                y={padTop}
                width={groupWidth}
                height={plotH}
                fill={isHovered ? '#f8fafc' : 'transparent'}
              />
              <rect
                x={cx - barWidth - 2}
                y={padTop + plotH - revH}
                width={barWidth}
                height={Math.max(2, revH)}
                rx={3}
                fill={isHovered ? '#c2410c' : '#ea580c'}
              />
              <rect
                x={cx + 2}
                y={padTop + plotH - expH}
                width={barWidth}
                height={Math.max(2, expH)}
                rx={3}
                fill={isHovered ? '#94a3b8' : '#cbd5e1'}
              />
              <text
                x={cx}
                y={chartHeight - 10}
                textAnchor="middle"
                className="fill-slate-500 text-[10px]"
              >
                {d.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
};

export const PaymentMixChart: React.FC<{
  data: Array<{ method: string; amount: number }>;
}> = ({ data }) => {
  const total = data.reduce((s, d) => s + d.amount, 0);
  if (total <= 0) {
    return (
      <div className="py-10 text-center text-sm text-slate-500">
        No verified payment transactions recorded yet.
      </div>
    );
  }

  const colors: Record<string, string> = {
    upi: 'bg-orange-600',
    card: 'bg-slate-800',
    cash: 'bg-emerald-600',
    razorpay: 'bg-amber-500',
  };

  const labels: Record<string, string> = {
    upi: 'UPI QR / Apps',
    card: 'Debit & Credit Card',
    cash: 'Cash Drawer',
    razorpay: 'Razorpay Online',
  };

  return (
    <div className="space-y-4">
      <div className="h-3 w-full rounded-full bg-slate-100 overflow-hidden flex">
        {data.map((d) => {
          const pct = (d.amount / total) * 100;
          return (
            <div
              key={d.method}
              style={{ width: `${pct}%` }}
              className={`${colors[d.method] || 'bg-slate-400'} h-full transition-all`}
              title={`${labels[d.method] || d.method}: ${formatInr(d.amount)}`}
            />
          );
        })}
      </div>

      <div className="divide-y divide-slate-100">
        {data.map((d) => {
          const pct = ((d.amount / total) * 100).toFixed(1);
          return (
            <div key={d.method} className="py-2.5 flex items-center justify-between text-sm">
              <div className="flex items-center gap-2.5">
                <span className={`w-2.5 h-2.5 rounded-sm ${colors[d.method] || 'bg-slate-400'}`} />
                <span className="font-medium text-slate-700">{labels[d.method] || d.method}</span>
              </div>
              <div className="flex items-center gap-4 font-mono-num">
                <span className="text-xs text-slate-500">{pct}%</span>
                <span className="font-semibold text-slate-900">{formatInr(d.amount)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const BestSellersChart: React.FC<{
  items: Array<{ name: string; qty: number; revenue: number }>;
}> = ({ items }) => {
  if (!items || items.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-slate-500">
        Orders placed in this period will populate best-selling dishes here.
      </div>
    );
  }
  const maxRev = Math.max(1, ...items.map((i) => i.revenue));

  return (
    <div className="space-y-3.5">
      {items.map((item, idx) => {
        const pct = Math.max(6, (item.revenue / maxRev) * 100);
        return (
          <div key={item.name} className="space-y-1.5">
            <div className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs font-mono-num text-slate-400 w-4">0{idx + 1}</span>
                <span className="font-medium text-slate-800 truncate">{item.name}</span>
                <span className="text-xs text-slate-500 shrink-0">· {item.qty} sold</span>
              </div>
              <span className="font-mono-num font-semibold text-slate-900 shrink-0">
                {formatInr(item.revenue)}
              </span>
            </div>
            <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-orange-500 rounded-full transition-all duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
};
