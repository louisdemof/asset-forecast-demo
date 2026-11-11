import { useRef, useState } from 'react';
import Papa from 'papaparse';
import { DATA_INFO } from '../../lib/dataInfo';
import { replaceText, secureText } from '../../secure';
import { useForecastStore } from '../../store/forecastStore';
import { parseFaturaGeradora, type FaturaGeradora } from '../../data/parseFaturaGeradora';
import { compPortfolio, injections, useDataVersion, type CpMonth, type UnitMonth } from './PlantMonthly';
import { monthLabel, n0, n1, pct, ScreenHead } from './ui';

/* ------------------------------------------------------------------ data */
const OPEN = DATA_INFO.MeterHub.parcial;      // month still being received
const CLOSED = DATA_INFO.MeterHub.fechadoAte;
type Portfolio = { usina: string; meses: Record<string, CpMonth> }[];
type PerfUsinas = Record<string, { serie: { mes: string; injetado: number; compensado: number; saldo: number; perfMes: number; perfMovel: number }[] }>;
type InjExcel = Record<string, { excelNome: string; serie: Record<string, { injetadoMWh: number | null; pvsystMWh: number }> }>;
const readJson = <T,>(name: string): T => JSON.parse(secureText(name)) as T;
const genUnit = (m: CpMonth | undefined) => m?.ucs.find((u) => u.injetado > 0);
const unitsOf = (m: CpMonth | undefined) => (m ? m.ucs.filter((u) => u.injetado === 0) : []);

/** Known units per plant: every unit seen in any month, with its latest share. */
function unitRegistry() {
  const reg = new Map<string, Map<string, UnitMonth>>();
  for (const [plant, meses] of compPortfolio()) {
    const m = new Map<string, UnitMonth>();
    for (const k of Object.keys(meses).sort()) for (const u of unitsOf(meses[k])) m.set(u.uc, u);
    reg.set(plant, m);
  }
  return reg;
}
const allPlants = () => [...new Set([...compPortfolio().keys(), ...Object.keys(injections())])].sort();

/* ----------------------------------------------------------- file reading */
type Cell = string | number | Date | null;
async function readTable(file: File): Promise<Cell[][]> {
  if (/\.csv$/i.test(file.name)) {
    const text = await file.text();
    return (Papa.parse<string[]>(text.replace(/^﻿/, ''), { skipEmptyLines: true }).data as string[][]).map((r) => r.map((c) => c));
  }
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const ws = wb.worksheets.find((w) => w.actualRowCount > 1) ?? wb.worksheets[0];
  const out: Cell[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals = (row.values as unknown[]).slice(1).map((v): Cell => {
      if (v == null) return null;
      if (v instanceof Date || typeof v === 'number' || typeof v === 'string') return v;
      const o = v as { result?: unknown; richText?: { text: string }[]; text?: string };
      if (o.result !== undefined) return o.result as Cell;
      if (o.richText) return o.richText.map((t) => t.text).join('');
      if (o.text) return o.text;
      return String(v);
    });
    out.push(vals);
  });
  return out;
}
const norm = (s: unknown) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
function num(v: Cell): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  let s = String(v).trim().replace(/\s/g, '');
  if (/,\d{1,3}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); // 1.234,5
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function month(v: Cell): string | null {
  if (v instanceof Date) return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}`;
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?/);
  if (m) return +m[2] >= 1 && +m[2] <= 12 ? `${m[1]}-${m[2].padStart(2, '0')}` : null;
  m = s.match(/^(?:\d{1,2}\/)?(\d{1,2})\/(\d{4})$/);
  if (m) return +m[1] >= 1 && +m[1] <= 12 ? `${m[2]}-${m[1].padStart(2, '0')}` : null;
  return null;
}

/* ------------------------------------------------------------- templates */
type Kind = 'bills' | 'meter';
const COLS: Record<Kind, { key: string; label: string; alias: string[] }[]> = {
  bills: [
    { key: 'plant', label: 'Plant', alias: ['plant', 'usina', 'site'] },
    { key: 'unit', label: 'Unit', alias: ['unit', 'uc', 'consumer unit', 'unidade consumidora'] },
    { key: 'month', label: 'Month', alias: ['month', 'mes', 'reference month', 'referencia'] },
    { key: 'cons', label: 'Consumption kWh', alias: ['consumption kwh', 'consumption', 'consumo kwh', 'consumo'] },
    { key: 'used', label: 'Credits used kWh', alias: ['credits used kwh', 'credits used', 'compensado kwh', 'compensado', 'energia compensada'] },
    { key: 'balance', label: 'Credit balance kWh', alias: ['credit balance kwh', 'credit balance', 'balance', 'saldo kwh', 'saldo'] },
  ],
  meter: [
    { key: 'plant', label: 'Plant', alias: ['plant', 'usina', 'site'] },
    { key: 'month', label: 'Month', alias: ['month', 'mes', 'reference month'] },
    { key: 'inj', label: 'Injected kWh', alias: ['injected kwh', 'injected', 'injection', 'injecao kwh', 'injecao', 'energia injetada'] },
  ],
};
const KIND_LABEL: Record<Kind | 'invoice', string> = { bills: 'Consumer unit bills', meter: 'Meter readings', invoice: 'Generator invoice (PDF)' };

function detect(header: Cell[]): { kind: Kind; idx: Record<string, number> } | null {
  const h = header.map(norm);
  for (const kind of ['bills', 'meter'] as Kind[]) {
    const idx: Record<string, number> = {};
    for (const c of COLS[kind]) {
      const i = h.findIndex((x) => c.alias.includes(x));
      if (i < 0) break;
      idx[c.key] = i;
    }
    if (Object.keys(idx).length === COLS[kind].length) return { kind, idx };
  }
  return null;
}

interface Reject { row: number; values: string; reason: string }
interface Change { plant: string; month: string; what: string; before: string; after: string; warn?: string }
interface BillRow { plant: string; month: string; unit: string; cons: number; used: number; balance: number }
interface MeterRow { plant: string; month: string; kwh: number }
interface Load {
  id: number; file: string; kind: Kind | 'invoice' | 'unknown'; read: number; accepted: number; rejects: Reject[]; changes: Change[];
  bills?: BillRow[]; meters?: MeterRow[]; invoice?: FaturaGeradora & { plant: string }; note?: string; applied?: string; error?: string;
}

function checkBills(rows: Cell[][], idx: Record<string, number>): Pick<Load, 'read' | 'accepted' | 'rejects' | 'changes' | 'bills'> {
  const reg = unitRegistry();
  const cp = compPortfolio();
  const seen = new Set<string>();
  const rejects: Reject[] = [], bills: BillRow[] = [];
  rows.forEach((r, i) => {
    const rowNo = i + 2;
    const values = COLS.bills.map((c) => String(r[idx[c.key]] ?? '')).join(' · ');
    const bad = (reason: string) => rejects.push({ row: rowNo, values, reason });
    const plant = String(r[idx.plant] ?? '').trim();
    const unit = String(r[idx.unit] ?? '').trim();
    const mon = month(r[idx.month]);
    const cons = num(r[idx.cons]), used = num(r[idx.used]), balance = num(r[idx.balance]);
    if (!plant || !reg.has(plant)) return bad(injections()[plant] ? 'Take-or-pay plant: billed on injection, no unit bills expected' : 'Unknown plant');
    if (!mon) return bad('Month not recognised (use yyyy-mm)');
    if (mon > OPEN) return bad(`Month not open yet (latest is ${monthLabel(OPEN)})`);
    if (!cp.get(plant)?.[mon]) return bad('No injection loaded for this plant and month. Load the meter reading first');
    if (!reg.get(plant)!.has(unit)) return bad('Unit not registered for this plant');
    if (cons == null || used == null || balance == null) return bad('A number is missing or not readable');
    if (cons < 0 || used < 0 || balance < 0) return bad('Negative value');
    if (used > cons) return bad('Credits used above consumption, which a bill cannot show');
    const key = `${plant}|${unit}|${mon}`;
    if (seen.has(key)) return bad('Duplicate of an earlier row in this file');
    seen.add(key);
    bills.push({ plant, month: mon, unit, cons, used, balance });
  });
  // preview per plant-month
  const groups = new Map<string, BillRow[]>();
  for (const b of bills) groups.set(`${b.plant}|${b.month}`, [...(groups.get(`${b.plant}|${b.month}`) ?? []), b]);
  const changes: Change[] = [...groups].map(([k, bs]) => {
    const [plant, mon] = k.split('|');
    const m = cp.get(plant)![mon];
    const have = new Map(unitsOf(m).map((u) => [u.uc, u]));
    const replaced = bs.filter((b) => have.has(b.unit)).length;
    const after = unitsOf(m).filter((u) => !bs.some((b) => b.unit === u.uc)).reduce((s, u) => s + u.compensado, 0) + bs.reduce((s, b) => s + b.used, 0);
    const total = unitRegistry().get(plant)!.size;
    const nAfter = new Set([...have.keys(), ...bs.map((b) => b.unit)]).size;
    return {
      plant, month: mon, what: `${bs.length - replaced} new unit bills${replaced ? `, ${replaced} replaced` : ''} · ${nAfter} of ${total} units`,
      before: `${n1(unitsOf(m).reduce((s, u) => s + u.compensado, 0) / 1000)} MWh credits used`, after: `${n1(after / 1000)} MWh`,
      warn: mon <= CLOSED ? 'Changes a closed month' : undefined,
    };
  }).sort((a, b) => a.plant.localeCompare(b.plant));
  return { read: rows.length, accepted: bills.length, rejects, changes, bills };
}

function checkMeters(rows: Cell[][], idx: Record<string, number>): Pick<Load, 'read' | 'accepted' | 'rejects' | 'changes' | 'meters'> {
  const cp = compPortfolio(), inj = injections() as InjExcel;
  const seen = new Set<string>();
  const rejects: Reject[] = [], meters: MeterRow[] = [], changes: Change[] = [];
  rows.forEach((r, i) => {
    const values = COLS.meter.map((c) => String(r[idx[c.key]] ?? '')).join(' · ');
    const bad = (reason: string) => rejects.push({ row: i + 2, values, reason });
    const plant = String(r[idx.plant] ?? '').trim();
    const mon = month(r[idx.month]);
    const kwh = num(r[idx.inj]);
    if (!plant || (!cp.has(plant) && !inj[plant])) return bad('Unknown plant');
    if (!mon) return bad('Month not recognised (use yyyy-mm)');
    if (mon > OPEN) return bad(`Month not open yet (latest is ${monthLabel(OPEN)})`);
    if (kwh == null) return bad('Injection missing or not readable');
    if (kwh <= 0) return bad('No injection: check the meter or the invoice');
    const history = cp.has(plant) ? Object.values(cp.get(plant)!).map((m) => m.injecao / 1000) : Object.values(inj[plant].serie).map((s) => s.injetadoMWh ?? s.pvsystMWh);
    const top = Math.max(...history.filter((v) => v > 0));
    if (kwh / 1000 > 2 * top) return bad(`Implausible: ${n0(kwh / 1000)} MWh is more than twice the plant's best month (${n0(top)} MWh)`);
    const key = `${plant}|${mon}`;
    if (seen.has(key)) return bad('Duplicate of an earlier row in this file');
    seen.add(key);
    meters.push({ plant, month: mon, kwh });
    const before = cp.has(plant) ? (cp.get(plant)![mon]?.injecao ?? null) : (inj[plant].serie[mon]?.injetadoMWh != null ? inj[plant].serie[mon].injetadoMWh! * 1000 : null);
    const p50 = !cp.has(plant) ? inj[plant].serie[mon]?.pvsystMWh : null;
    changes.push({
      plant, month: mon, what: 'Injected energy', before: before == null ? 'not loaded' : `${n1(before / 1000)} MWh`, after: `${n1(kwh / 1000)} MWh${p50 ? ` (${pct(kwh / 1000 / p50, 0)} of P50)` : ''}`,
      warn: before != null ? 'Replaces a value already loaded' : undefined,
    });
  });
  return { read: rows.length, accepted: meters.length, rejects, changes, meters };
}

/* ------------------------------------------------------------------ apply */
function applyBills(bills: BillRow[]) {
  const cp = readJson<Portfolio>('comp_portfolio.json');
  const perf = readJson<PerfUsinas>('perfcomp_usinas.json');
  const reg = unitRegistry();
  const touched = new Set<string>();
  for (const b of bills) {
    const m = cp.find((p) => p.usina === b.plant)!.meses[b.month];
    const known = reg.get(b.plant)!.get(b.unit)!;
    const row: UnitMonth = { uc: b.unit, rateio: known.rateio, consumo: b.cons, compensado: b.used, injetado: 0, saldo: b.balance };
    const i = m.ucs.findIndex((u) => u.uc === b.unit);
    if (i >= 0) m.ucs[i] = { ...m.ucs[i], ...row, rateio: m.ucs[i].rateio };
    else m.ucs.push({ ...row, ...({ dist: (m.ucs[0] as UnitMonth & { dist?: string }).dist } as object) });
    touched.add(`${b.plant}|${b.month}`);
  }
  for (const k of touched) {
    const [plant, mon] = k.split('|');
    const m = cp.find((p) => p.usina === plant)!.meses[mon] as CpMonth & { perfComp: number; aproveit: number; rateioPct: number };
    const us = unitsOf(m);
    m.nUCs = m.ucs.length;
    m.consumo = m.ucs.reduce((s, u) => s + u.consumo, 0);
    m.compensado = m.ucs.reduce((s, u) => s + u.compensado, 0);
    m.perfComp = m.injecao ? +(m.compensado / m.injecao).toFixed(4) : 0;
    m.aproveit = m.consumo ? +(m.compensado / m.consumo).toFixed(4) : 0;
    m.rateioPct = +us.reduce((s, u) => s + u.rateio, 0).toFixed(4);
    const s = perf[plant]?.serie.find((x) => x.mes === mon);
    if (s) { s.compensado = Math.round(us.reduce((t, u) => t + u.compensado, 0)); s.saldo = Math.round(us.reduce((t, u) => t + u.saldo, 0)); s.perfMes = m.injecao ? Math.round((s.compensado / m.injecao) * 100) : 0; }
  }
  replaceText('perfcomp_usinas.json', JSON.stringify(perf));
  replaceText('comp_portfolio.json', JSON.stringify(cp));
}

function applyMeters(meters: MeterRow[], importa: (r: { usina: string; mes: string; injecao: number }[]) => unknown) {
  const cp = readJson<Portfolio>('comp_portfolio.json');
  const inj = readJson<InjExcel>('injecao_excel.json');
  const perf = readJson<PerfUsinas>('perfcomp_usinas.json');
  for (const r of meters) {
    const p = cp.find((x) => x.usina === r.plant);
    if (p) {
      const prev = Object.keys(p.meses).filter((k) => k < r.month).sort().pop();
      const g0 = prev ? genUnit(p.meses[prev]) : undefined;
      if (!p.meses[r.month] && !g0) continue;
      const m = (p.meses[r.month] ??= { nUCs: 1, consumo: 0, compensado: 0, injecao: 0, ucs: [{ ...g0!, consumo: 0, compensado: 0 }] } as CpMonth) as CpMonth & { perfComp: number };
      m.injecao = r.kwh;
      const g = genUnit(m) ?? m.ucs[0];
      if (g) g.injetado = r.kwh;
      m.perfComp = r.kwh ? +(m.compensado / r.kwh).toFixed(4) : 0;
      const s = perf[r.plant]?.serie.find((x) => x.mes === r.month);
      if (s) s.injetado = Math.round(r.kwh);
    } else if (inj[r.plant]) {
      inj[r.plant].serie[r.month] = { ...(inj[r.plant].serie[r.month] ?? { pvsystMWh: 0 }), injetadoMWh: +(r.kwh / 1000).toFixed(2) };
    }
  }
  replaceText('injecao_excel.json', JSON.stringify(inj));
  replaceText('perfcomp_usinas.json', JSON.stringify(perf));
  replaceText('comp_portfolio.json', JSON.stringify(cp));
  importa(meters.map((r) => ({ usina: r.plant, mes: r.month, injecao: r.kwh / 1000 })));
}

/* ---------------------------------------------------------------- samples */
// Deterministic wobble so a sample downloaded twice is the same file.
const wob = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return 0.95 + ((h >>> 0) % 1000) / 10000; };

function sampleBills(): (string | number)[][] {
  const rows: (string | number)[][] = [];
  for (const [plant, meses] of compPortfolio()) {
    const sep = meses[CLOSED], oct = meses[OPEN];
    if (!sep || !oct) continue;
    const have = new Set(unitsOf(oct).map((u) => u.uc));
    const hist = Object.keys(meses).filter((k) => k <= CLOSED).sort().slice(-3);
    for (const u of unitsOf(sep)) {
      if (have.has(u.uc)) continue;
      const avg = hist.reduce((s, k) => s + (meses[k].ucs.find((x) => x.uc === u.uc)?.consumo ?? 0), 0) / hist.length;
      const cons = Math.round(avg * wob(u.uc + plant));
      const avail = u.saldo + u.rateio * oct.injecao;
      const used = Math.round(Math.min(cons, avail) * 0.97);
      rows.push([plant, u.uc, OPEN, cons, used, Math.round(avail - used)]);
    }
  }
  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  // deliberate mistakes, so the checks have something to catch
  if (rows.length < 45) return rows;
  const [a, b, c, d] = [rows[3], rows[10], rows[20], rows[40]];
  // inserted from the end so earlier positions stay put; each bad row sits before its valid twin
  rows.splice(38, 0, [d[0], d[1], OPEN, 1000, 1800, 400]); // credits above consumption
  rows.splice(25, 0, [...c]);                              // duplicate of row c
  rows.splice(9, 0, [b[0], b[1], OPEN, -350, 0, b[5]]);    // negative consumption
  rows.splice(5, 0, [a[0], '91999999', OPEN, 4200, 3900, 1200]); // unit not registered
  return rows;
}

function sampleMeters(): (string | number)[][] {
  const inj = injections() as InjExcel;
  const rows: (string | number)[][] = Object.entries(inj).filter(([, v]) => v.serie[OPEN] && v.serie[OPEN].injetadoMWh == null && v.serie[CLOSED]?.injetadoMWh != null)
    .map(([plant, v]) => [plant, OPEN, Math.round(v.serie[OPEN].pvsystMWh * ((v.serie[CLOSED].injetadoMWh ?? 0) / v.serie[CLOSED].pvsystMWh) * wob(plant) * 1000)]);
  rows.splice(2, 0, ['Orion 99', OPEN, 412000]);
  rows.splice(6, 0, [rows[5][0], OPEN, 0]);
  rows.splice(9, 0, [rows[8][0], OPEN, Number(rows[8][2]) * 3]);
  return rows;
}

async function downloadXlsx(name: string, sheet: string, header: string[], rows: (string | number)[][], notes: string[]) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  ws.addRow(header).font = { bold: true };
  rows.forEach((r) => ws.addRow(r));
  ws.columns.forEach((c, i) => { c.width = i === 0 ? 14 : 18; });
  const rm = wb.addWorksheet('Read me');
  notes.forEach((n) => rm.addRow([n]));
  rm.getColumn(1).width = 110;
  const buf = await wb.xlsx.writeBuffer();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* --------------------------------------------------------------------- UI */
let loadId = 1;
export function DataCentrePanel({ go }: { go: (tab: string) => void }) {
  useDataVersion();
  const importa = useForecastStore((s) => s.importaMedicoes);
  const [loads, setLoads] = useState<Load[]>([]);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const update = (id: number, p: Partial<Load>) => setLoads((ls) => ls.map((l) => (l.id === id ? { ...l, ...p } : l)));

  // status of the open month
  const cp = compPortfolio(), inj = injections() as InjExcel, reg = unitRegistry();
  let billsHave = 0, billsAll = 0, plantsDone = 0, plantsAll = 0;
  for (const [plant, meses] of cp) {
    if (!meses[CLOSED]) continue;
    plantsAll++;
    const all = reg.get(plant)!.size, have = unitsOf(meses[OPEN]).length;
    billsAll += all; billsHave += have;
    if (have >= all) plantsDone++;
  }
  const gc = Object.values(inj).filter((v) => v.serie[OPEN] && v.serie[CLOSED]?.injetadoMWh != null);
  const gcHave = gc.filter((v) => v.serie[OPEN].injetadoMWh != null).length;

  async function handle(files: File[]) {
    setBusy(true);
    for (const f of files) {
      const id = loadId++;
      const base: Load = { id, file: f.name, kind: 'unknown', read: 0, accepted: 0, rejects: [], changes: [] };
      try {
        if (/\.pdf$/i.test(f.name)) {
          const r = await parseFaturaGeradora(f);
          const byUnit = new Map<string, string>();
          for (const [plant, meses] of cp) for (const m of Object.values(meses)) { const g = genUnit(m); if (g) byUnit.set(g.uc, plant); }
          const plant = [r.uc, ...(r.ucs ?? [])].map((u) => byUnit.get(u)).find(Boolean) ?? allPlants().find((p) => norm(f.name).includes(norm(p))) ?? '';
          const ok = !!r.mes && r.injecao > 0 && !/implaus|senha/.test(r.flag);
          setLoads((ls) => [{ ...base, kind: 'invoice', read: 1, accepted: ok ? 1 : 0, invoice: { ...r, plant },
            note: r.flag === 'senha' ? 'This PDF is password-protected. The platform asks for the password and reads it again.' : !ok ? `Could not read a month and an injection from this invoice${r.flag ? ` (${r.flag})` : ''}.` : undefined }, ...ls]);
          continue;
        }
        if (!/\.(xlsx|xlsm|csv)$/i.test(f.name)) { setLoads((ls) => [{ ...base, error: 'Not a supported file. Use a PDF invoice, or an Excel (.xlsx) or CSV file.' }, ...ls]); continue; }
        const table = await readTable(f);
        const hi = table.findIndex((r) => !!detect(r));
        if (hi < 0) {
          setLoads((ls) => [{ ...base, error: `Columns not recognised. Found: ${(table[0] ?? []).filter(Boolean).join(', ') || 'nothing'}. Expected the columns of one of the templates on this page.` }, ...ls]);
          continue;
        }
        const { kind, idx } = detect(table[hi])!;
        const rows = table.slice(hi + 1).filter((r) => r.some((c) => c != null && c !== ''));
        const res = kind === 'bills' ? checkBills(rows, idx) : checkMeters(rows, idx);
        setLoads((ls) => [{ ...base, kind, ...res }, ...ls]);
      } catch (e) {
        setLoads((ls) => [{ ...base, error: `Could not read the file: ${(e as Error).message}` }, ...ls]);
      }
    }
    setBusy(false);
    if (input.current) input.current.value = '';
  }

  const apply = (l: Load) => {
    if (l.kind === 'bills' && l.bills) applyBills(l.bills);
    if (l.kind === 'meter' && l.meters) applyMeters(l.meters, importa);
    if (l.kind === 'invoice' && l.invoice?.plant) applyMeters([{ plant: l.invoice.plant, month: l.invoice.mes, kwh: l.invoice.injecao }], importa);
    update(l.id, { applied: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) });
  };

  return (
    <div className="sc">
      <ScreenHead title="Data centre" level="live">
        Drop the month's files here: distributor invoices as PDF, and spreadsheets in Excel or CSV. Each file is recognised by its content, checked row by row, and shown as a list of changes. Nothing changes until you apply it, and every load is kept in the history. In this demo, files are read inside your browser and never uploaded. Reloading the page restores the original data.
      </ScreenHead>
      <section className="kpis">
        <div className="kpi accent"><div className="kpi-label">{monthLabel(OPEN)} unit bills</div><div className="kpi-value">{n0(billsHave)} of {n0(billsAll)}</div><div className="kpi-sub">{plantsDone} of {plantsAll} plants complete</div></div>
        <div className="kpi"><div className="kpi-label">{monthLabel(OPEN)} meter readings</div><div className="kpi-value">{gcHave} of {gc.length}</div><div className="kpi-sub">take-or-pay plants</div></div>
        <div className="kpi"><div className="kpi-label">Closed through</div><div className="kpi-value">{monthLabel(CLOSED)}</div><div className="kpi-sub">{billsHave >= billsAll && gcHave >= gc.length ? `All ${monthLabel(OPEN)} files received: ready to close the month` : `${monthLabel(OPEN)} still being received`}</div></div>
      </section>

      <div className={`dc-drop${over ? ' over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); void handle(Array.from(e.dataTransfer.files)); }}>
        <b>Drop files here</b>
        <span className="muted">PDF invoices, Excel (.xlsx) or CSV. Several at once is fine.</span>
        <button className="pc-btn" onClick={() => input.current?.click()} disabled={busy}>{busy ? 'Reading…' : 'Choose files'}</button>
        <input ref={input} type="file" multiple accept=".pdf,.xlsx,.xlsm,.csv" style={{ display: 'none' }} onChange={(e) => void handle(Array.from(e.target.files ?? []))} />
      </div>

      <div className="sc-grid">
        <div className="sc-card">
          <h3>Consumer unit bills</h3>
          <p className="dc-p">One row per unit and month: <code>{COLS.bills.map((c) => c.label).join(' · ')}</code>. Feeds Compensation, the plant pages and Client 360. Portuguese headers (UC, consumo, compensado, saldo) are recognised too.</p>
          <button className="chip-btn" onClick={() => void downloadXlsx(`unit_bills_${OPEN}.xlsx`, 'Unit bills', COLS.bills.map((c) => c.label), sampleBills(), [
            `Sample: the ${monthLabel(OPEN)} bills not received yet, for every plant billed on credits.`,
            'Four rows contain deliberate mistakes (unknown unit, negative value, duplicate, credits above consumption) to show the checks.',
            'Drop this file in the Data centre, review the changes, then apply.',
          ])}>Download sample ({monthLabel(OPEN)}, .xlsx)</button>
        </div>
        <div className="sc-card">
          <h3>Meter readings</h3>
          <p className="dc-p">One row per plant and month: <code>{COLS.meter.map((c) => c.label).join(' · ')}</code>. Feeds Generation, Compensation and the revenue of take-or-pay plants.</p>
          <button className="chip-btn" onClick={() => void downloadXlsx(`meter_readings_${OPEN}.xlsx`, 'Meter readings', COLS.meter.map((c) => c.label), sampleMeters(), [
            `Sample: the ${monthLabel(OPEN)} injection of the take-or-pay plants, which is not loaded yet.`,
            'Three rows contain deliberate mistakes (unknown plant, zero injection, three times the expected value).',
          ])}>Download sample ({monthLabel(OPEN)}, .xlsx)</button>
        </div>
        <div className="sc-card">
          <h3>Generator invoices (PDF)</h3>
          <p className="dc-p">Reads injection, credits, credit balance and the demand charge from Brazilian distributor invoices, in seven layouts (Energisa, COSERN, Equatorial, COPEL, CPFL, Enel CE, Elektro), including password-protected and scanned PDFs. The invoice is matched to its plant by the generator unit number.</p>
        </div>
      </div>

      {loads.length > 0 && <h3 className="dc-h">Loaded files</h3>}
      {loads.map((l) => <LoadCard key={l.id} l={l} apply={() => apply(l)} discard={() => setLoads((ls) => ls.filter((x) => x.id !== l.id))} setPlant={(p) => l.invoice && update(l.id, { invoice: { ...l.invoice, plant: p } })} go={go} />)}
    </div>
  );
}

function LoadCard({ l, apply, discard, setPlant, go }: { l: Load; apply: () => void; discard: () => void; setPlant: (p: string) => void; go: (t: string) => void }) {
  const [showRej, setShowRej] = useState(true);
  const [showAll, setShowAll] = useState(false);
  if (l.error) return <div className="sc-card dc-card dc-err"><b>{l.file}</b><p>{l.error}</p><button className="sc-link" onClick={discard}>Remove</button></div>;
  const changes = showAll ? l.changes : l.changes.slice(0, 12);
  const inv = l.invoice;
  const canApply = !l.applied && (l.kind === 'invoice' ? !!inv?.plant && l.accepted > 0 : l.accepted > 0);
  return (
    <div className={`sc-card dc-card${l.applied ? ' dc-done' : ''}`}>
      <div className="sc-cardhead">
        <div><b>{l.file}</b> <span className="sc-stage">{KIND_LABEL[l.kind as Kind | 'invoice']}</span></div>
        <div className="dc-actions">
          {l.applied ? <span className="st st-ok">✓ Applied at {l.applied}</span> : <>
            <button className="chip-btn" onClick={discard}>Discard</button>
            <button className="pc-btn" disabled={!canApply} onClick={apply}>Apply {l.kind === 'invoice' ? 'invoice' : `${l.accepted} rows`}</button>
          </>}
        </div>
      </div>
      {l.kind !== 'invoice' && (
        <div className="dc-counts">
          <span>Rows read<b>{l.read}</b></span><span>Accepted<b>{l.accepted}</b></span>
          <span className={l.rejects.length ? 'bad' : ''}>Rejected<b>{l.rejects.length}</b></span><span>Plants affected<b>{new Set(l.changes.map((c) => c.plant)).size}</b></span>
        </div>
      )}
      {inv && (
        <div className="dc-invoice">
          <span>Layout<b>{inv.doc || '–'}</b></span><span>Generator unit<b>{inv.uc || '–'}</b></span><span>Month<b>{inv.mes ? monthLabel(inv.mes) : '–'}</b></span>
          <span>Injected<b>{n0(inv.injecao)} kWh</b></span><span>Credits<b>{n0(inv.compensado)} kWh</b></span><span>Credit balance<b>{n0(inv.banco)} kWh</b></span><span>Demand charge<b>R$ {n0(inv.demanda)}</b></span>
          <label className="sc-field">Plant<select value={inv.plant} disabled={!!l.applied} onChange={(e) => setPlant(e.target.value)}><option value="">Not matched: choose…</option>{allPlants().map((p) => <option key={p}>{p}</option>)}</select></label>
        </div>
      )}
      {l.note && <p className="muted">{l.note}</p>}
      {l.rejects.length > 0 && (
        <div>
          <button className="sc-link" onClick={() => setShowRej(!showRej)}>{showRej ? 'Hide' : 'Show'} rejected rows ({l.rejects.length})</button>
          {showRej && <div className="tablewrap"><table className="dc-table"><thead><tr><th className="r">Row</th><th>Values</th><th>Reason</th></tr></thead>
            <tbody>{l.rejects.map((r) => <tr key={r.row}><td className="r">{r.row}</td><td>{r.values}</td><td className="dc-reason">{r.reason}</td></tr>)}</tbody></table></div>}
        </div>
      )}
      {l.changes.length > 0 && (
        <div>
          <h4 className="pt-h4">{l.applied ? 'Changes applied' : 'Changes on apply'}</h4>
          <div className="tablewrap"><table className="dc-table"><thead><tr><th>Plant</th><th>Month</th><th>What</th><th className="r">Before</th><th className="r">After</th><th /></tr></thead>
            <tbody>{changes.map((c, i) => <tr key={i}><td className="strong">{c.plant}</td><td>{monthLabel(c.month)}</td><td>{c.what}</td><td className="r">{c.before}</td><td className="r">{c.after}</td><td>{c.warn && <span className="st st-warn">▲ {c.warn}</span>}</td></tr>)}</tbody></table></div>
          {l.changes.length > 12 && <button className="sc-link" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer' : `Show all ${l.changes.length}`}</button>}
        </div>
      )}
      {l.applied && (
        <p className="dc-next">See it in{' '}
          <button className="sc-link" onClick={() => go('compensacao')}>Actuals › Compensation</button>{l.kind !== 'bills' && <>, <button className="sc-link" onClick={() => go('geracao')}>Actuals › Generation</button></>}, or open a plant in{' '}
          <button className="sc-link" onClick={() => go('clients')}>Customer portal › Client 360</button>.
        </p>
      )}
    </div>
  );
}
