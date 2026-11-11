import { Fragment, useMemo, useState } from 'react';
import type { AlocacaoMes } from '../../engine/contrato';
import { DATA_INFO } from '../../lib/dataInfo';
import { dataVersion, secureText, subscribeData } from '../../secure';
import { useSyncExternalStore } from 'react';
import { brl, CHART, LineChart, monthLabel, n0, n1, pct } from './ui';

/* Measured data per plant, from the demo files. Units in the files are kWh. */
export interface UnitMonth { uc: string; rateio: number; consumo: number; compensado: number; injetado: number; saldo: number }
export interface CpMonth { nUCs: number; consumo: number; compensado: number; injecao: number; ucs: UnitMonth[] }
let cpCache: Map<string, Record<string, CpMonth>> | null = null;
let injCache: Record<string, { serie: Record<string, { injetadoMWh: number | null }> }> | null = null;
let cacheVer = -1;
const fresh = () => { if (cacheVer !== dataVersion()) { cpCache = null; injCache = null; cacheVer = dataVersion(); } };
/** Re-render when a file loaded in the Data centre replaces the data. */
export const useDataVersion = () => useSyncExternalStore(subscribeData, dataVersion);
export const compPortfolio = () => (fresh(), cpCache ??= new Map((JSON.parse(secureText('comp_portfolio.json')) as { usina: string; meses: Record<string, CpMonth> }[]).map((p) => [p.usina, p.meses])));
export const injections = () => (fresh(), injCache ??= JSON.parse(secureText('injecao_excel.json')));

const CLOSED = DATA_INFO.MeterHub.fechadoAte;
type Source = 'measured' | 'bank' | 'assumption' | 'injection' | 'construction';
const SOURCE: Record<Source, { label: string; hint: string }> = {
  measured: { label: 'measured', hint: 'Credits actually used by the consumer units, read from their bills' },
  bank: { label: 'credit bank', hint: 'Projected unit by unit from the credit balance, each unit\'s share and its recent consumption. Click for the details.' },
  assumption: { label: 'assumption', hint: 'Compensation assumption of the official forecast' },
  injection: { label: 'measured injection', hint: 'Take-or-pay contract: billed on the energy injected, read from the meter' },
  construction: { label: 'construction', hint: 'Not in commercial operation this month' },
};

interface SimUnit { uc: string; share: number; cons: number; used: number; balance: number; eff: number }
interface Sim { start: number; units: number; eff: number; months: Record<string, { comp: number; balance: number; units: SimUnit[] }> }

/** Credit bank projection, unit by unit: balance + share of injection, used up to recent consumption,
 *  scaled by how much of the available credit each unit actually used in the last three closed months. */
function simulate(cp: Record<string, CpMonth>, future: { mes: string; injKwh: number }[]): Sim | null {
  const closed = Object.keys(cp).filter((m) => m <= CLOSED).sort();
  if (closed.length < 4) return null;
  const last3 = closed.slice(-3);
  const prevOf = (m: string) => closed[closed.indexOf(m) - 1];
  const units = cp[CLOSED].ucs.filter((u) => u.injetado === 0);
  let effNum = 0, effDen = 0;
  const state = units.map((u) => {
    let num = 0, den = 0, cons = 0;
    for (const m of last3) {
      const row = cp[m].ucs.find((x) => x.uc === u.uc);
      const prev = cp[prevOf(m)]?.ucs.find((x) => x.uc === u.uc);
      if (!row) continue;
      const avail = (prev?.saldo ?? 0) + u.rateio * cp[m].injecao;
      num += row.compensado; den += Math.min(row.consumo, avail); cons += row.consumo;
    }
    effNum += num; effDen += den;
    return { uc: u.uc, share: u.rateio, cons: cons / last3.length, eff: den ? Math.min(1, num / den) : 1, balance: u.saldo };
  });
  const start = state.reduce((s, u) => s + u.balance, 0);
  const months: Sim['months'] = {};
  for (const f of future) {
    const rows: SimUnit[] = state.map((u) => {
      const avail = u.balance + u.share * f.injKwh;
      const used = u.eff * Math.min(u.cons, avail);
      u.balance = avail - used;
      return { uc: u.uc, share: u.share, cons: u.cons, used, balance: u.balance, eff: u.eff };
    });
    months[f.mes] = { comp: rows.reduce((s, r) => s + r.used, 0), balance: rows.reduce((s, r) => s + r.balance, 0), units: rows };
  }
  return { start, units: state.length, eff: effDen ? effNum / effDen : 1, months };
}

interface Row {
  m: AlocacaoMes; source: Source; inj: number; injMeasured: boolean; compPct: number; energy: number; revenue: number;
  balance: number | null; units: { uc: string; share: number; cons: number; used: number; balance: number }[] | null; partial?: string;
}

export function PlantMonthly({ usina, meses }: { usina: string; meses: AlocacaoMes[] }) {
  const [sel, setSel] = useState<string | null>(null);
  const [explain, setExplain] = useState(false);
  const [allUnits, setAllUnits] = useState(false);
  const ver = useDataVersion();
  const { rows, sim, byComp } = useMemo(() => {
    const cp = compPortfolio().get(usina) ?? null;
    const inj = injections()[usina]?.serie ?? {};
    const sim = cp ? simulate(cp, meses.filter((m) => m.mes > CLOSED && m.status === 'COD').map((m) => ({ mes: m.mes, injKwh: m.injecao * 1000 }))) : null;
    const rows: Row[] = meses.map((m) => {
      const adj = (energy: number) => (m.base != null ? m.receitaTotal + m.base * (energy - m.energiaFinal) : m.receitaTotal);
      const base = { m, inj: m.injecao, injMeasured: false, compPct: m.perfComp, energy: m.energiaFinal, revenue: m.receitaTotal, balance: null, units: null };
      if (m.status !== 'COD') return { ...base, source: 'construction' as Source };
      if (cp) {
        const c = cp[m.mes];
        if (m.mes <= CLOSED && c) {
          const units = c.ucs.filter((u) => u.injetado === 0);
          const energy = c.compensado / 1000;
          return { ...base, source: 'measured' as Source, inj: c.injecao / 1000, injMeasured: true, compPct: c.injecao ? c.compensado / c.injecao : 0, energy, revenue: adj(energy),
            balance: units.reduce((s, u) => s + u.saldo, 0) / 1000, units: units.map((u) => ({ uc: u.uc, share: u.rateio, cons: u.consumo, used: u.compensado, balance: u.saldo })) };
        }
        const p = sim?.months[m.mes];
        if (p) {
          const energy = p.comp / 1000;
          const partial = c ? `${c.ucs.length - 1} of ${cp[CLOSED].ucs.length - 1} unit bills received so far, so this month is still projected` : undefined;
          return { ...base, source: 'bank' as Source, compPct: m.injecao ? energy / m.injecao : 0, energy, revenue: adj(energy), balance: p.balance / 1000, units: p.units, partial };
        }
        return { ...base, source: 'assumption' as Source };
      }
      const measured = m.mes <= CLOSED ? inj[m.mes]?.injetadoMWh : null;
      if (measured != null) return { ...base, source: 'injection' as Source, inj: measured, injMeasured: true, compPct: 1, energy: measured, revenue: adj(measured) };
      return { ...base, source: 'assumption' as Source };
    });
    return { rows, sim, byComp: !!cp };
  }, [usina, meses, ver]); // eslint-disable-line react-hooks/exhaustive-deps

  const totForecast = meses.reduce((s, m) => s + m.receitaTotal, 0);
  const totAdj = rows.reduce((s, r) => s + r.revenue, 0);
  const lastClosed = [...rows].reverse().find((r) => r.source === 'measured');
  const avgUse = rows.filter((r) => r.source === 'measured').slice(-3).reduce((s, r, _, a) => s + r.energy / a.length, 0);
  const d = rows.find((r) => r.m.mes === sel);
  const cod = rows.filter((r) => r.source !== 'construction');
  if (!cod.length) return <section className="pm"><h4 className="pm-h">Energy and compensation by month</h4><p className="muted">Not in commercial operation this year, so there is no energy or compensation to show yet.</p></section>;

  return (
    <section className="pm">
      <div className="pm-head">
        <div>
          <h4>Energy and compensation by month</h4>
          <p className="muted">
            {byComp
              ? `Billed on compensated energy. Closed months use the credits measured on each consumer unit's bill (closed through ${monthLabel(CLOSED)}). Later months are projected unit by unit from the credit bank.`
              : `Take-or-pay on injected energy. Closed months use the metered injection (closed through ${monthLabel(CLOSED)}). Later months follow the forecast.`}
            {' '}Click a month to open it.
          </p>
        </div>
        <div className="pm-kpis">
          <span>Revenue, measured and projected<b>{brl(totAdj)}</b></span>
          <span>Official forecast<b>{brl(totForecast)}</b></span>
          <span>Difference<b className={totAdj - totForecast >= 0 ? 'ok-text' : 'warn-text'}>{totAdj - totForecast >= 0 ? '+' : ''}{brl(totAdj - totForecast)}</b></span>
          {byComp && lastClosed?.balance != null && <span>Credit balance, {monthLabel(lastClosed.m.mes)}<b>{n0(lastClosed.balance)} MWh</b><small>{avgUse ? `${n1(lastClosed.balance / avgUse)} months of use` : ''}</small></span>}
        </div>
      </div>

      {cod.length > 1 && (
        <LineChart labels={cod.map((r) => monthLabel(r.m.mes))} format={(v) => `${n0(v)} MWh`} height={200}
          series={[
            { name: 'Forecast injection', color: CHART.blue, values: cod.map((r) => r.m.injecao), dash: true },
            { name: byComp ? 'Injected (measured)' : 'Injected (metered)', color: CHART.blue, values: cod.map((r) => (r.injMeasured ? r.inj : null)) },
            ...(byComp ? [{ name: 'Credits used (measured, then projected)', color: CHART.orange, values: cod.map((r) => r.energy) }] : []),
          ]} />
      )}

      <div className="tablewrap"><table className="pm-table">
        <thead><tr>
          <th>Month</th><th className="r">P50 (MWh)</th><th className="r">Oper. perf.</th><th className="r">Injected (MWh)</th>
          <th className="r">{byComp ? 'Compensated' : 'Billed share'}</th><th>Source</th><th className="r">Billable energy (MWh)</th>
          {byComp && <th className="r">Credit balance (MWh)</th>}<th className="r">Revenue</th><th className="r">vs forecast</th>
        </tr></thead>
        <tbody>{rows.map((r) => {
          const diff = r.revenue - r.m.receitaTotal;
          return (
            <Fragment key={r.m.mes}>
              <tr className={`clickable${sel === r.m.mes ? ' on' : ''}${r.m.mes === CLOSED ? ' pm-cut' : ''}`} onClick={() => { setSel(sel === r.m.mes ? null : r.m.mes); setAllUnits(false); setExplain(false); }}>
                <td className="strong">{monthLabel(r.m.mes)}</td>
                <td className="r">{n1(r.m.p50)}</td>
                <td className="r">{pct(r.m.perfOper, 0)}</td>
                <td className="r">{n1(r.inj)}{r.injMeasured ? '' : <small className="muted"> fcst</small>}</td>
                <td className="r">{r.source === 'construction' ? '–' : pct(r.compPct, 0)}</td>
                <td>
                  {r.source === 'bank'
                    ? <button type="button" className="pm-tag pm-bank" title={SOURCE.bank.hint} onClick={(e) => { e.stopPropagation(); setSel(r.m.mes); setExplain(true); }}>{SOURCE.bank.label}</button>
                    : <span className={`pm-tag pm-${r.source}`} title={SOURCE[r.source].hint}>{SOURCE[r.source].label}</span>}
                </td>
                <td className="r">{n1(r.energy)}</td>
                {byComp && <td className="r">{r.balance == null ? '–' : n0(r.balance)}</td>}
                <td className="r strong">{brl(r.revenue)}</td>
                <td className={`r ${Math.abs(diff) < 1 ? 'muted' : diff > 0 ? 'ok-text' : 'warn-text'}`}>{Math.abs(diff) < 1 ? '–' : `${diff > 0 ? '+' : ''}${brl(diff)}`}</td>
              </tr>
              {d && d.m.mes === r.m.mes && (
                <tr className="panel-row"><td colSpan={byComp ? 10 : 9}><MonthDetail r={d} sim={sim} explain={explain} setExplain={setExplain} allUnits={allUnits} setAllUnits={setAllUnits} /></td></tr>
              )}
            </Fragment>
          );
        })}</tbody>
        <tfoot><tr className="totais">
          <td>Year</td><td className="r">{n0(rows.reduce((s, r) => s + r.m.p50, 0))}</td><td /><td className="r">{n0(rows.reduce((s, r) => s + r.inj, 0))}</td><td /><td />
          <td className="r">{n0(rows.reduce((s, r) => s + r.energy, 0))}</td>{byComp && <td />}<td className="r">{brl(totAdj)}</td>
          <td className={`r ${totAdj - totForecast >= 0 ? 'ok-text' : 'warn-text'}`}>{totAdj - totForecast >= 0 ? '+' : ''}{brl(totAdj - totForecast)}</td>
        </tr></tfoot>
      </table></div>
    </section>
  );
}

function MonthDetail({ r, sim, explain, setExplain, allUnits, setAllUnits }: {
  r: Row; sim: Sim | null; explain: boolean; setExplain: (v: boolean) => void; allUnits: boolean; setAllUnits: (v: boolean) => void;
}) {
  const m = r.m;
  const rowsChain: [string, string, string][] = [
    ['P50 generation', `${n1(m.p50)} MWh`, `${n1(m.p50)} MWh`],
    ['× operational performance', pct(m.perfOper, 1), r.injMeasured ? 'measured' : pct(m.perfOper, 1)],
    ['= injected energy', `${n1(m.injecao)} MWh`, `${n1(r.inj)} MWh`],
    ['× compensation', pct(m.perfComp, 1), r.source === 'construction' ? '–' : pct(r.compPct, 1)],
    ['= billable energy', `${n1(m.energiaFinal)} MWh`, `${n1(r.energy)} MWh`],
    ['× calculation base', m.base != null ? `R$ ${n0(m.base)}/MWh` : 'fixed fee', m.base != null ? `R$ ${n0(m.base)}/MWh` : 'fixed fee'],
    ['= gross revenue', brl(m.receitaBruta), brl(m.receitaBruta + (m.base ?? 0) * (r.energy - m.energiaFinal))],
    ['− PV demand charge', brl(m.demanda), brl(m.demanda)],
    ['= revenue', brl(m.receitaTotal), brl(r.revenue)],
  ];
  const units = r.units ? [...r.units].sort((a, b) => b.cons - a.cons) : null;
  const shown = units && !allUnits ? units.slice(0, 10) : units;
  return (
    <div className="pm-detail">
      <div className="pm-detail-grid">
        <div>
          <h5>{monthLabel(m.mes)}: from P50 to revenue</h5>
          <table className="pm-chain"><thead><tr><th /><th className="r">Forecast</th><th className="r">{r.source === 'bank' ? 'Projected' : r.source === 'assumption' || r.source === 'construction' ? 'Used' : 'Measured'}</th></tr></thead>
            <tbody>{rowsChain.map(([k, a, b]) => <tr key={k} className={k.startsWith('=') ? 'pm-eq' : ''}><td>{k}</td><td className="r">{a}</td><td className="r">{b}</td></tr>)}</tbody>
          </table>
          {r.partial && <p className="muted pm-note">{r.partial}.</p>}
        </div>
        {r.source === 'bank' && sim && (
          <div className="pm-explain">
            <h5>How the credit bank projection works {!explain && <button className="sc-link" onClick={() => setExplain(true)}>show</button>}</h5>
            {explain && (
              <ol>
                <li>Start from each unit's credit balance at the end of {monthLabel(CLOSED)}: <b>{n0(sim.start / 1000)} MWh</b> over <b>{sim.units}</b> units.</li>
                <li>Add each unit's share of the month's forecast injection.</li>
                <li>Each unit uses credits up to its average consumption of the last three closed months.</li>
                <li>Scale by how much of the available credit each unit actually used in those months. Across this plant that was <b>{pct(sim.eff, 0)}</b>. Units the distributor did not credit in full keep that pattern.</li>
                <li>What is not used stays in the balance and carries to the next month.</li>
              </ol>
            )}
            <p className="muted pm-note">Result for {monthLabel(m.mes)}: {n1(r.energy)} MWh of credits used, against {n1(m.energiaFinal)} MWh in the forecast assumption.</p>
          </div>
        )}
      </div>
      {shown && (
        <>
          <h5>Consumer units, {monthLabel(m.mes)} {r.source === 'bank' ? '(projected)' : '(from the bills)'}</h5>
          <div className="tablewrap"><table className="pm-units">
            <thead><tr><th>Unit</th><th className="r">Share</th><th className="r">Consumption (kWh)</th><th className="r">Credits used (kWh)</th><th className="r">Covered</th><th className="r">Balance (kWh)</th></tr></thead>
            <tbody>{shown.map((u) => (
              <tr key={u.uc}><td className="strong">{u.uc}</td><td className="r">{pct(u.share)}</td><td className="r">{n0(u.cons)}</td><td className="r">{n0(u.used)}</td>
                <td className={`r${u.cons && u.used / u.cons < 0.6 ? ' warn-text' : ''}`}>{u.cons ? pct(u.used / u.cons, 0) : '–'}</td><td className="r">{n0(u.balance)}</td></tr>
            ))}</tbody>
          </table></div>
          {units && units.length > 10 && <button className="sc-link" onClick={() => setAllUnits(!allUnits)}>{allUnits ? 'Show the 10 largest' : `Show all ${units.length} units`}</button>}
        </>
      )}
    </div>
  );
}
