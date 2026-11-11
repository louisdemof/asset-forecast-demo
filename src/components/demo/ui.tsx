import { useEffect, useRef, useState, type ReactNode } from 'react';

export const CHART = { blue: '#2a7fa8', orange: '#d0672e', violet: '#8a6cc4' };

const nf0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
export const n0 = (v: number) => nf0.format(v);
export const n1 = (v: number) => nf1.format(v);
export const brl = (v: number) => `R$ ${nf0.format(v)}`;
export const brlM = (v: number) => (Math.abs(v) >= 1e6 ? `R$ ${nf1.format(v / 1e6)} M` : `R$ ${nf0.format(v / 1e3)} k`);
export const pct = (v: number, d = 1) => `${(v * 100).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d })}%`;
export const signed = (v: number) => `${v > 0 ? '+' : ''}${brlM(v)}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthLabel = (ym: string) => `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(2, 4)}`;

export type Maturity = 'live' | 'partial' | 'concept';
const MATURITY: Record<Maturity, string> = { live: 'In production', partial: 'Partly in production', concept: 'Demo concept' };
export const MaturityTag = ({ level }: { level: Maturity }) => <span className={`mat mat-${level}`}>{MATURITY[level]}</span>;

export function ScreenHead({ title, level, children }: { title: string; level: Maturity; children: ReactNode }) {
  return (
    <header className="sc-head">
      <div className="sc-title"><h2>{title}</h2><MaturityTag level={level} /></div>
      <p>{children}</p>
    </header>
  );
}

export const Kpi = ({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) => (
  <div className={`kpi${accent ? ' accent' : ''}`}>
    <div className="kpi-label">{label}</div>
    <div className="kpi-value">{value}</div>
    {sub && <div className="kpi-sub">{sub}</div>}
  </div>
);

export function downloadCsv(filename: string, rows: (string | number)[][]) {
  const text = rows.map((r) => r.map((c) => (/[",;\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export interface Series { name: string; color: string; values: (number | null)[]; dash?: boolean }

function niceTicks(lo: number, hi: number) {
  const step0 = (hi - lo) / 4 || 1;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0;
  const start = Math.floor(lo / step) * step;
  const out: number[] = [];
  for (let v = start; v < hi + step * 0.999; v += step) out.push(v);
  return out;
}

/** Line chart with one y axis, a crosshair and a tooltip. */
export function LineChart({ labels, series, format, height = 240, zero = false }: {
  labels: string[]; series: Series[]; format: (v: number) => string; height?: number; zero?: boolean;
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const vals = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const lo = zero ? Math.min(0, ...vals) : Math.min(...vals);
  const hi = Math.max(...vals);
  const pad = zero ? 0 : (hi - lo) * 0.08;
  const ticks = niceTicks(lo - pad, hi + pad);
  const yMin = ticks[0], yMax = ticks[ticks.length - 1];
  const m = { l: 74, r: 34, t: 10, b: 26 };
  const w = width - m.l - m.r, h = height - m.t - m.b;
  const x = (i: number) => m.l + (labels.length > 1 ? (i / (labels.length - 1)) * w : w / 2);
  const y = (v: number) => m.t + h - ((v - yMin) / (yMax - yMin || 1)) * h;
  const every = Math.ceil(labels.length / Math.max(2, Math.floor(w / 62)));
  const pathOf = (s: Series) => {
    let d = '', pen = false;
    s.values.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const move = (e: React.MouseEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - box.left) / box.width) * (labels.length - 1));
    setHover(Math.max(0, Math.min(labels.length - 1, i)));
  };
  return (
    <div className="ch" ref={ref}>
      {series.length > 1 && (
        <div className="ch-legend">
          {series.map((s) => <span key={s.name}><i className={s.dash ? 'dash' : ''} style={{ borderColor: s.color }} />{s.name}</span>)}
        </div>
      )}
      <div className="ch-plot">
        <svg width={width} height={height} role="img" aria-label={series.map((s) => s.name).join(', ')}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={m.l} x2={width - m.r} y1={y(t)} y2={y(t)} className="ch-grid" />
              <text x={m.l - 8} y={y(t) + 4} textAnchor="end" className="ch-ax">{format(t)}</text>
            </g>
          ))}
          {labels.map((l, i) => (i % every === 0 ? <text key={l} x={x(i)} y={height - 8} textAnchor="middle" className="ch-ax">{l}</text> : null))}
          {series.map((s) => <path key={s.name} d={pathOf(s)} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dash ? '6 4' : undefined} strokeLinejoin="round" strokeLinecap="round" />)}
          {hover != null && <line x1={x(hover)} x2={x(hover)} y1={m.t} y2={m.t + h} className="ch-cross" />}
          {hover != null && series.map((s) => (s.values[hover] != null ? <circle key={s.name} cx={x(hover)} cy={y(s.values[hover] as number)} r={4.5} fill={s.color} stroke="#fff" strokeWidth={2} /> : null))}
          <rect x={m.l} y={m.t} width={w} height={h} fill="transparent" onMouseMove={move} onMouseLeave={() => setHover(null)} />
        </svg>
        {hover != null && (
          <div className="ch-tip" style={{ left: Math.min(x(hover) + 12, width - 190), top: 8 }}>
            <b>{labels[hover]}</b>
            {series.map((s) => <div key={s.name}><i style={{ background: s.color }} />{s.name}<span>{s.values[hover] == null ? 'n/a' : format(s.values[hover] as number)}</span></div>)}
          </div>
        )}
      </div>
    </div>
  );
}

export function Spark({ values, color = CHART.blue }: { values: number[]; color?: string }) {
  const lo = Math.min(...values), hi = Math.max(...values);
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * 96 + 2},${22 - ((v - lo) / (hi - lo || 1)) * 18}`).join(' ');
  return <svg width={100} height={26} aria-hidden="true"><polyline points={pts} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" /></svg>;
}

/** Signed horizontal bars around a zero line. */
export function DivergingBars({ rows, format }: { rows: { label: string; value: number }[]; format: (v: number) => string }) {
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  return (
    <div className="dbars">
      {rows.map((r) => (
        <div className="dbar" key={r.label} title={`${r.label}: ${format(r.value)}`}>
          <span className="dbar-l">{r.label}</span>
          <div className="dbar-t">
            <i className={r.value < 0 ? 'neg' : 'pos'} style={r.value < 0 ? { right: '50%', width: `${(-r.value / max) * 50}%` } : { left: '50%', width: `${(r.value / max) * 50}%` }} />
          </div>
          <span className="dbar-v">{format(r.value)}</span>
        </div>
      ))}
    </div>
  );
}
