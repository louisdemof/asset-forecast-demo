import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useForecastStore } from './store/forecastStore';
import { fimContrato } from './engine/comercial';
import { ColHint } from './components/ColHint';
import { StickyScrollbar } from './components/StickyScrollbar';
import { rodaContrato } from './engine/contrato';
import { fmtMes } from './lib/date';
import { carimboForecast } from './lib/dataInfo';
import ContratoPanel from './components/ContratoPanel';
import PVsystTable from './components/PVsystTable';
import TarifasTable from './components/TarifasTable';
import AlertasPanel from './components/AlertasPanel';
import CompensacaoPanel from './components/CompensacaoPanel';
import AuditoriaPanel from './components/AuditoriaPanel';
import ReconciliacaoPanel from './components/ReconciliacaoPanel';
import GeracaoPanel from './components/GeracaoPanel';
import MetodosPanel from './components/MetodosPanel';
import FormulasHelp from './components/FormulasHelp';
import AuthButton from './components/AuthButton';
import AdminPanel from './components/AdminPanel';
import ValidacaoBar from './components/ValidacaoBar';
import CadastroUsina from './components/CadastroUsina';
import { useAuthStore } from './store/authStore';
import { hidratarUsinas } from './data/db/usinas';
import type { UsinaResumo } from './engine/types';
import './App.css';

const brl = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const mwh = (v: number) => `${v.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} MWh`;

/** Classifica o "Match Excel" de uma usina: motor ÷ Forecast oficial + motivo curto da divergência. */
function divergencia(u: UsinaResumo, baseFixa?: number): { m: number | null; tag: string; motivo: string; cls: string } {
  if (u.semForecast || !u.receitaForecast) return { m: null, tag: 'no forecast', motivo: 'plant is not in the official Forecast tab', cls: 'muted' };
  const m = u.receitaEngine / u.receitaForecast;
  const dif = u.receitaEngine - u.receitaForecast;
  if (Math.abs(m - 1) < 0.001) return { m, tag: '', motivo: 'reproduces the Excel exactly', cls: 'match-ok' };
  const base = `engine ${brl(u.receitaEngine)} · official ${brl(u.receitaForecast)} · diff ${brl(dif)} (${((m - 1) * 100).toFixed(1)}%)`;
  if (Math.abs(m - 1) < 0.02) return { m, tag: '≈ ok', motivo: `≈ within 2% · ${base}`, cls: 'match-near' };
  if (baseFixa && baseFixa > 0) return { m, tag: 'fixed base', motivo: `calculation base hardcoded in the Excel · ${base}`, cls: 'match-bad' };
  return { m, tag: 'Excel adjustment', motivo: `difference absorbed by manual adjustment/cap in the Excel · ${base}`, cls: 'match-bad' };
}

type Agrupar = 'usina' | 'cliente' | 'disco';
interface GrupoRollup { chave: string; n: number; mwac: number; ef: number; receita: number; forecast: number; budget: number }
/** Agrega as usinas por cliente ou distribuidora p/ a visão de rollup. */
function rollup(usinas: UsinaResumo[], por: Exclude<Agrupar, 'usina'>): GrupoRollup[] {
  const acc = new Map<string, GrupoRollup>();
  for (const u of usinas) {
    const chave = (por === 'cliente' ? u.cliente : u.disco) || '— no ' + (por === 'cliente' ? 'client' : 'utility');
    const g = acc.get(chave) ?? { chave, n: 0, mwac: 0, ef: 0, receita: 0, forecast: 0, budget: 0 };
    g.n += 1; g.mwac += u.potMWac; g.ef += u.energiaFinalTotal;
    g.receita += u.receitaEngine; g.forecast += u.receitaForecast; g.budget += u.budget;
    acc.set(chave, g);
  }
  return [...acc.values()].sort((a, b) => b.receita - a.receita);
}

/** Exporta o forecast (linhas filtradas) em CSV — separador ';' e BOM p/ Excel pt-BR. */
function exportarCSV(usinas: UsinaResumo[]) {
  const header = ['Plant', 'Utility', 'Client', 'MWac', 'Final Energy (MWh)', 'Revenue Forecast (R$)', 'Budget (R$)', 'vs Budget %', 'Status'];
  const linhas = usinas.map((u) => [
    u.projeto, u.disco, u.cliente || '',
    u.potMWac.toFixed(1),
    u.energiaFinalTotal.toFixed(0),
    u.receitaEngine.toFixed(0),
    u.budget.toFixed(0),
    u.budget ? ((u.receitaEngine / u.budget - 1) * 100).toFixed(1) : '',
    u.semForecast ? 'off-forecast' : u.noPipeline ? 'in pipeline' : '',
  ]);
  const total = ['TOTAL', '', '', '',
    usinas.reduce((s, u) => s + u.energiaFinalTotal, 0).toFixed(0),
    usinas.reduce((s, u) => s + u.receitaEngine, 0).toFixed(0),
    usinas.reduce((s, u) => s + u.budget, 0).toFixed(0), '', ''];
  const csv = [header, ...linhas, total].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'forecast-asset.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

type SortKey = 'projeto' | 'disco' | 'cliente' | 'potMWac' | 'energiaFinalTotal' | 'perfCompMedia' | 'receitaEngine' | 'margem' | 'rMwh' | 'vsBudget';

export default function App() {
  const { usinas, rows, contratos, loading, error, load } = useForecastStore();
  const [busca, setBusca] = useState('');
  const [expandida, setExpandida] = useState<string | null>(null);
  const [aba, setAba] = useState<'receita' | 'pvsyst' | 'tarifas' | 'metodos' | 'alertas' | 'compensacao' | 'auditoria' | 'reconciliacao' | 'geracao' | 'admin'>('receita');
  const podeAdmin = useAuthStore((s) => s.can('users', 'read'));
  const userIdAuth = useAuthStore((s) => s.userId);
  const [novaUsina, setNovaUsina] = useState(false);
  useEffect(() => { if (userIdAuth) void hidratarUsinas().catch(() => {}); }, [userIdAuth]);
  const [compMax, setCompMax] = useState(100);
  const [fDisco, setFDisco] = useState('todas');
  const [fStatus, setFStatus] = useState<'todos' | 'pipeline' | 'fora' | 'negativa' | 'abaixo'>('todos');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'receitaEngine', dir: -1 });
  const [agrupar, setAgrupar] = useState<Agrupar>('usina');
  const [compAlvo, setCompAlvo] = useState<{ usina: string; uc?: string } | null>(null);
  const tabelaRef = useRef<HTMLDivElement>(null);

  const discos = useMemo(() => [...new Set(usinas.map((u) => u.disco))].sort(), [usinas]);

  useEffect(() => {
    load();
  }, [load]);

  const kpi = useMemo(() => {
    const receita = usinas.reduce((s, u) => s + u.receitaEngine, 0);
    const forecast = usinas.reduce((s, u) => s + u.receitaForecast, 0);
    const budget = usinas.reduce((s, u) => s + u.budget, 0);
    const p50 = usinas.reduce((s, u) => s + u.p50Total, 0);
    const mwac = usinas.reduce((s, u) => s + u.potMWac, 0);
    return { receita, forecast, budget, p50, mwac, nUsinas: usinas.length, nLinhas: rows.length };
  }, [usinas, rows]);

  const compBucket = (x: number): 'nao' | 'ramp' | 'ok' => (x < 0.05 ? 'nao' : x < 0.9 ? 'ramp' : 'ok');

  const filtradas = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return usinas.filter((u) => {
      if (q && !(u.projeto.toLowerCase().includes(q) || u.disco.toLowerCase().includes(q) || u.cliente.toLowerCase().includes(q))) return false;
      if (u.perfCompMedia * 100 > compMax + 0.001) return false;
      if (fDisco !== 'todas' && u.disco !== fDisco) return false;
      if (fStatus === 'pipeline' && !u.noPipeline) return false;
      if (fStatus === 'fora' && !u.semForecast) return false;
      if (fStatus === 'negativa' && u.receitaEngine >= 0) return false;
      if (fStatus === 'abaixo' && !(u.budget > 0 && u.receitaEngine < u.budget)) return false;
      return true;
    });
  }, [usinas, busca, compMax, fDisco, fStatus]);

  const totais = useMemo(() => {
    const mwac = filtradas.reduce((s, u) => s + u.potMWac, 0);
    const ef = filtradas.reduce((s, u) => s + u.energiaFinalTotal, 0);
    const receita = filtradas.reduce((s, u) => s + u.receitaEngine, 0);
    const budget = filtradas.reduce((s, u) => s + u.budget, 0);
    const difPct = budget ? (receita / budget - 1) * 100 : 0;
    const rMwh = ef > 0 ? receita / ef : 0;
    const forecast = filtradas.reduce((s, u) => s + u.receitaForecast, 0);
    const custoOperacao = filtradas.reduce((s, u) => s + u.custoOperacao, 0);
    const margem = filtradas.reduce((s, u) => s + u.margem, 0);
    return { mwac, ef, receita, budget, difPct, rMwh, forecast, custoOperacao, margem };
  }, [filtradas]);

  const gruposRollup = useMemo(() => (agrupar === 'usina' ? [] : rollup(filtradas, agrupar)), [filtradas, agrupar]);

  const ordenadas = useMemo(() => {
    const val = (u: UsinaResumo): number | string => {
      switch (sort.key) {
        case 'projeto': return u.projeto.toLowerCase();
        case 'disco': return u.disco.toLowerCase();
        case 'cliente': return (u.cliente || '').toLowerCase();
        case 'potMWac': return u.potMWac;
        case 'energiaFinalTotal': return u.energiaFinalTotal;
        case 'perfCompMedia': return u.perfCompMedia;
        case 'receitaEngine': return u.receitaEngine;
        case 'margem': return u.margem;
        case 'rMwh': return u.energiaFinalTotal >= 1 ? u.receitaEngine / u.energiaFinalTotal : Number.NEGATIVE_INFINITY;
        case 'vsBudget': return u.budget ? u.receitaEngine / u.budget - 1 : Number.NEGATIVE_INFINITY;
      }
    };
    return [...filtradas].sort((a, b) => {
      const va = val(a), vb = val(b);
      const cmp = typeof va === 'string' && typeof vb === 'string' ? va.localeCompare(vb, 'pt-BR') : (va as number) - (vb as number);
      return cmp * sort.dir;
    });
  }, [filtradas, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: (s.dir === 1 ? -1 : 1) as 1 | -1 } : { key, dir: (key === 'projeto' || key === 'disco' || key === 'cliente' ? 1 : -1) as 1 | -1 }));
  const seta = (key: SortKey) => (sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : '');

  // curva mensal de receita (nível engine) — soma AlocacaoMes.receitaTotal por mês, respeitando os filtros
  const serieMensal = useMemo(() => {
    const acc = new Map<string, { receita: number; energia: number; nCOD: number }>();
    for (const u of filtradas) {
      const cc = contratos.get(u.projeto);
      if (!cc) continue;
      for (const m of rodaContrato(cc.contrato, cc.entradas).meses) {
        const cur = acc.get(m.mes) ?? { receita: 0, energia: 0, nCOD: 0 };
        cur.receita += m.receitaTotal;
        cur.energia += m.energiaFinal;
        if (m.status === 'COD') cur.nCOD += 1;
        acc.set(m.mes, cur);
      }
    }
    return [...acc.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([mes, v]) => ({ mes, ...v }));
  }, [filtradas, contratos]);

  return (
    <div className="app">
      <div className="topband">
        <img className="topband-logo" src={`${import.meta.env.BASE_URL}assetperf_logo.svg`} alt="AssetPerf" />
        <div className="topband-actions">
          <FormulasHelp />
          {podeAdmin && (
            <button className={`topband-link${aba === 'admin' ? ' topband-link--on' : ''}`} onClick={() => setAba('admin')}>
              👤 Users & Admin
            </button>
          )}
          <AuthButton />
        </div>
      </div>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" />
          <div>
            <h1>Revenue Module</h1>
            <p>Portfolio revenue forecast · Asset</p>
          </div>
        </div>
        <span className="tag">prototype · Forecast 6+6 data</span>
      </header>

      <nav className="tabs">
        <button className={aba === 'receita' ? 'tab on' : 'tab'} onClick={() => setAba('receita')}>Revenue</button>
        <button className={aba === 'pvsyst' ? 'tab on' : 'tab'} onClick={() => setAba('pvsyst')}>Generation (PVsyst)</button>
        <button className={aba === 'tarifas' ? 'tab on' : 'tab'} onClick={() => setAba('tarifas')}>Tariffs & Adjustments</button>
        <button className={aba === 'metodos' ? 'tab on' : 'tab'} onClick={() => setAba('metodos')}>Methods by client</button>
        <button className={aba === 'alertas' ? 'tab on' : 'tab'} onClick={() => setAba('alertas')}>Alerts</button>
        <button className={aba === 'compensacao' ? 'tab on' : 'tab'} onClick={() => setAba('compensacao')}>Compensation (MeterHub)</button>
        <button className={aba === 'auditoria' ? 'tab on' : 'tab'} onClick={() => setAba('auditoria')}>UC Audit</button>
        <button className={aba === 'reconciliacao' ? 'tab on' : 'tab'} onClick={() => setAba('reconciliacao')}>Forecast × Actual</button>
        <button className={aba === 'geracao' ? 'tab on' : 'tab'} onClick={() => setAba('geracao')}>Generation (P50 × Inj)</button>
      </nav>

      {loading && <div className="state">Loading portfolio…</div>}
      {error && <div className="state err">Error: {error}</div>}

      {!loading && !error && aba === 'pvsyst' && <PVsystTable />}
      {!loading && !error && aba === 'tarifas' && <TarifasTable />}
      {aba === 'metodos' && <MetodosPanel />}
      {aba === 'admin' && <AdminPanel />}
      {!loading && !error && aba === 'alertas' && <AlertasPanel />}
      {aba === 'compensacao' && (
        <CompensacaoPanel
          irParaUsina={(usina) => { setAba('receita'); setBusca(usina); setExpandida(usina); }}
          alvo={compAlvo}
        />
      )}
      {aba === 'auditoria' && <AuditoriaPanel onAbrir={(usina, uc) => { setCompAlvo({ usina, uc }); setAba('compensacao'); }} />}
      {aba === 'reconciliacao' && <ReconciliacaoPanel />}
      {aba === 'geracao' && <GeracaoPanel />}

      {novaUsina && <CadastroUsina onClose={() => setNovaUsina(false)} onCriada={(u) => { setBusca(u); setExpandida(u); }} />}
      {!loading && !error && aba === 'receita' && (
        <>
          <ValidacaoBar />
          <div className="receita-toolbar">
            <button className="btn-nova-usina" onClick={() => setNovaUsina(true)}>＋ New plant</button>
          </div>
          <section className="kpis">
            <Kpi label="Plants" value={String(kpi.nUsinas)} sub={`${kpi.nLinhas} rows · ${kpi.mwac.toFixed(0)} MWac`} />
            <Kpi label="Engine revenue / year" value={brl(kpi.receita)} sub="engine · Final Energy level" accent />
            <Kpi label="vs Budget" value={`${kpi.budget ? ((kpi.receita / kpi.budget - 1) * 100).toFixed(1) : '0'}%`} sub={`budgeted ${brl(kpi.budget)}`} warn={kpi.receita < kpi.budget} />
            <Kpi label="P50 Generation / year" value={mwh(kpi.p50)} sub="before haircuts" />
          </section>

          <div className="data-stamp" title="Provenance of the data on this tab. Update in src/lib/dataInfo.ts when refreshing.">
            📅 <b>Forecast 6+6</b> · {carimboForecast()} &nbsp;·&nbsp; compensation from Excel assumption (real metering on the Compensation tab)
          </div>

          <div className="toolbar">
            <input
              className="search"
              placeholder="Search plant, utility or client…"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
            />
            <span className="count">{filtradas.length} plants</span>
            <div className="agrupar-toggle" role="group" aria-label="Group by">
              <button className={agrupar === 'usina' ? 'on' : ''} onClick={() => setAgrupar('usina')}>by plant</button>
              <button className={agrupar === 'cliente' ? 'on' : ''} onClick={() => setAgrupar('cliente')}>by client</button>
              <button className={agrupar === 'disco' ? 'on' : ''} onClick={() => setAgrupar('disco')}>by utility</button>
            </div>
            <button className="btn-export" onClick={() => exportarCSV(filtradas)}>⤓ Export CSV</button>
          </div>

          <div className="filtros">
            <div className="filtro-slider">
              <div className="filtro-slider-top">
                <span>Compensation ≤ <b>{compMax}%</b></span>
                <span className="filtro-slider-count">{filtradas.length} plants</span>
              </div>
              <input className="slider" type="range" min={0} max={100} step={1} style={{ ['--val' as string]: `${compMax}%` }} value={compMax} onChange={(e) => setCompMax(+e.target.value)} />
            </div>
            <label>Utility
              <select value={fDisco} onChange={(e) => setFDisco(e.target.value)}>
                <option value="todas">all</option>
                {discos.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
            <label>Status
              <select value={fStatus} onChange={(e) => setFStatus(e.target.value as typeof fStatus)}>
                <option value="todos">all</option>
                <option value="negativa">negative revenue</option>
                <option value="abaixo">below budget</option>
                <option value="pipeline">in pipeline</option>
                <option value="fora">off-Forecast</option>
              </select>
            </label>
            {(compMax !== 100 || fDisco !== 'todas' || fStatus !== 'todos' || busca) && (
              <button className="reset-link" onClick={() => { setCompMax(100); setFDisco('todas'); setFStatus('todos'); setBusca(''); }}>↺ clear filters</button>
            )}
          </div>

          <ReceitaMensalChart serie={serieMensal} />

          {agrupar !== 'usina' ? (
            <div className="tablewrap">
              <table className="rollup-t">
                <thead>
                  <tr>
                    <th>{agrupar === 'cliente' ? 'Client (offtaker)' : 'Utility'}</th>
                    <th className="r">Plants</th>
                    <th className="r">MWac</th>
                    <th className="r">Final Energy</th>
                    <th className="r">Engine revenue</th>
                    <th className="r" title="Engine revenue ÷ official Forecast (weighted). 100% = reproduces the Excel.">Match Excel</th>
                    <th className="r" title="Engine revenue ÷ Budget − 1">vs Budget</th>
                  </tr>
                </thead>
                <tbody>
                  {gruposRollup.map((g) => {
                    const match = g.forecast ? g.receita / g.forecast : null;
                    const vsB = g.budget ? g.receita / g.budget - 1 : null;
                    return (
                      <tr key={g.chave} className="clickable" onClick={() => { setAgrupar('usina'); if (agrupar === 'cliente') setBusca(g.chave.startsWith('—') ? '' : g.chave); else setFDisco(g.chave.startsWith('—') ? 'todas' : g.chave); }}>
                        <td className="strong">{g.chave}</td>
                        <td className="r">{g.n}</td>
                        <td className="r">{g.mwac.toFixed(1)}</td>
                        <td className="r muted">{mwh(g.ef)}</td>
                        <td className="r strong">{brl(g.receita)}</td>
                        <td className={`r ${match == null ? 'muted' : Math.abs(match - 1) < 0.01 ? 'match-ok' : 'match-near'}`}>{match == null ? '—' : `${(match * 100).toFixed(1)}%`}</td>
                        <td className={`r ${vsB != null && vsB < 0 ? 'diff' : 'muted'}`}>{vsB == null ? '—' : `${vsB >= 0 ? '+' : ''}${(vsB * 100).toFixed(1)}%`}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="totais">
                    <td>Total · {gruposRollup.length} {agrupar === 'cliente' ? 'clients' : 'utilities'}</td>
                    <td className="r">{filtradas.length}</td>
                    <td className="r">{totais.mwac.toFixed(1)}</td>
                    <td className="r">{mwh(totais.ef)}</td>
                    <td className="r strong">{brl(totais.receita)}</td>
                    <td className="r strong">{totais.forecast ? `${((totais.receita / totais.forecast) * 100).toFixed(1)}%` : '—'}</td>
                    <td className="r">{totais.budget ? `${totais.difPct >= 0 ? '+' : ''}${totais.difPct.toFixed(1)}%` : '—'}</td>
                  </tr>
                </tfoot>
              </table>
              <p className="hint">Click a row to go back to the by-plant view filtered by {agrupar === 'cliente' ? 'that client' : 'that utility'}.</p>
            </div>
          ) : (
          <div className="tablewrap" ref={tabelaRef}>
            <table>
              <thead>
                <tr>
                  <th className="chev-col"></th>
                  <th className="sortable" onClick={() => toggleSort('projeto')}>Plant{seta('projeto')}</th>
                  <th className="sortable" onClick={() => toggleSort('disco')}>Utility{seta('disco')}</th>
                  <th className="sortable" onClick={() => toggleSort('cliente')}>Client{seta('cliente')}</th>
                  <th className="r sortable" onClick={() => toggleSort('potMWac')}>
                    <ColHint label="MWac" titulo="Installed capacity (MWac)" oque="The size of the plant, in megawatts of alternating current — the capacity that actually delivers energy to the grid." comoLer="Larger = bigger plant. It is the size reference used throughout the platform." />{seta('potMWac')}
                  </th>
                  <th className="r sortable" onClick={() => toggleSort('energiaFinalTotal')}>
                    <ColHint label="Final Energy" titulo="Final Energy (MWh/year)" oque={<>The energy that actually becomes revenue in the year. <span className="mono">P50 × Operational Perf. × Compensation Perf.</span>, counted only in the months when the plant is in COD (commercial operation).</>} comoLer="It is the billing base — the share of P50 (gross generation) left after losses and compensation." />{seta('energiaFinalTotal')}
                  </th>
                  <th className="r sortable" onClick={() => toggleSort('perfCompMedia')}>
                    <ColHint
                      label={<>Comp. <small>(assumption)</small></>}
                      titulo="Compensation Perf. — ASSUMPTION"
                      oque={<>Fraction of the net energy that becomes offset credit. Here it is the <b>Forecast assumption</b> (Excel / contract ramp curve), <b>not</b> metering.</>}
                      comoLer={<>The chip states the source: <span className="colhint-chip medivel">measurable</span> = Remote Self-Consumption client, can be validated on the Compensation tab (MeterHub). <span className="colhint-chip premissa">assumption</span> = Shared Generation client, comes from the contract — not measured.</>}
                    />{seta('perfCompMedia')}
                  </th>
                  <th className="r sortable" onClick={() => toggleSort('receitaEngine')}>
                    <ColHint label="Engine revenue" titulo="Engine revenue (R$/year)" oque={<>The revenue the platform <b>calculates</b>: <span className="mono">Calculation Base × Final Energy − Demand</span>.</>} comoLer="It is the platform's number. To check whether it matches the official Excel, look at the Match Excel column." />{seta('receitaEngine')}
                  </th>
                  <th className="r sortable" onClick={() => toggleSort('margem')}>
                    <ColHint label="Margin" titulo="Margin (R$/year)" oque={<>Engine revenue <b>minus operating costs</b>: <span className="mono">Revenue − GC operation fee</span>. Today only <b>OPERON</b> (Buriti) has a fee (R$ 85/MWh). First step of the Result module.</>} comoLer="Equal to Revenue when there is no cost. Where there is a fee, the discount appears in red." />{seta('margem')}
                  </th>
                  <th className="r sortable" onClick={() => toggleSort('rMwh')}>
                    <ColHint label="R$/MWh" titulo="Realized average price" oque={<>Revenue ÷ Final Energy — how much the plant bills per MWh delivered.</>} comoLer="Lets you compare plants of different sizes on the same scale. '—' when the energy is ~0." />{seta('rMwh')}
                  </th>
                  <th className="r sortable" onClick={() => toggleSort('vsBudget')}>
                    <ColHint label="vs Budget" titulo="vs Budget" oque={<>Engine revenue compared to the locked budget: <span className="mono">Revenue ÷ Budget − 1</span>.</>} comoLer="Green = above budget; red = below." />{seta('vsBudget')}
                  </th>
                  <th className="r">
                    <ColHint
                      label={<>Match Excel <span aria-hidden>🔎</span></>}
                      titulo="Match Excel"
                      oque={<>Engine revenue ÷ <b>official Forecast</b> revenue (the 6+6 Excel). <b>100% = the platform reproduces the Excel exactly.</b></>}
                      comoLer={<>The tag beside it says why when it diverges (<i>Excel adjustment</i>, <i>fixed base</i>, <i>≈ ok</i>, <i>no forecast</i>). Click the cell to open the divergence detail.</>}
                    />
                  </th>
                  <th>
                    <ColHint
                      label="Contract end"
                      titulo="Contract end"
                      oque={<>Contract end derived from the <span className="mono">Contract term</span> field (Commercial tab).</>}
                      comoLer={<>Full year for <span className="mono">"Until YYYY"</span>; with <b>*</b> = estimated (start of compensation + N years); <b>—</b> = no data in the spreadsheet (to be filled in).</>}
                    />
                  </th>
                  <th>
                    <ColHint
                      label="Pipeline"
                      titulo="Commercial status"
                      oque={<><b>in pipeline</b> = has a commercial deal under negotiation (Commercial tab). <b>off-Forecast</b> = is in Contracts but not in the official Forecast tab.</>}
                      comoLer="'—' = stable plant, already operating with a defined client." />
                  </th>
                </tr>
              </thead>
              <tbody>
                {ordenadas.map((u) => {
                  const dif = u.receitaEngine - u.budget;
                  const difPct = u.budget ? (dif / u.budget) * 100 : 0;
                  const aberta = expandida === u.projeto;
                  return (
                    <Fragment key={u.projeto}>
                      <tr className={`clickable ${aberta ? 'open' : ''}`}
                        onClick={() => setExpandida(aberta ? null : u.projeto)}>
                        <td className="chev-col">{aberta ? '▾' : '▸'}</td>
                        <td className="strong">{u.projeto}</td>
                        <td>{u.disco}</td>
                        <td>{u.cliente ? u.cliente : <span className="sem-cliente" title="plant with no client assigned">⚠ no client</span>}</td>
                        <td className="r">{u.potMWac.toFixed(1)}</td>
                        <td className="r muted">{mwh(u.energiaFinalTotal)}</td>
                        <td className="r">
                          <span className={`comp-chip ${compBucket(u.perfCompMedia)}`}>{(u.perfCompMedia * 100).toFixed(0)}%</span>
                          {u.modelo === 'AR'
                            ? <span className="comp-src medido" title="Remote Self-Consumption — MEASURABLE compensation in MeterHub (see Compensation tab). The value here is still the Forecast assumption.">measurable</span>
                            : <span className="comp-src premissa" title="Shared Generation — compensation comes from the contract/Forecast assumption; not measured by MeterHub.">assumption</span>}
                        </td>
                        <td className="r strong">{brl(u.receitaEngine)}</td>
                        <td className={`r ${u.custoOperacao > 0 ? 'strong' : 'muted'}`}>
                          {brl(u.margem)}
                          {u.custoOperacao > 0 && <span className="custo-op" title={`GC operation fee paid to OPERON: −${brl(u.custoOperacao)}/year (R$ 85/MWh offset)`}> −{brl(u.custoOperacao)}</span>}
                        </td>
                        <td className="r muted">{u.energiaFinalTotal >= 1 ? Math.round(u.receitaEngine / u.energiaFinalTotal).toLocaleString('pt-BR') : '—'}</td>
                        <td className={`r ${u.budget && difPct < 0 ? 'diff' : 'muted'}`}>
                          {u.budget ? `${difPct >= 0 ? '+' : ''}${difPct.toFixed(1)}%` : '—'}
                        </td>
                        {(() => {
                          const d = divergencia(u, contratos.get(u.projeto)?.contrato.baseFixa);
                          return (
                            <td
                              className={`r match-cell ${d.cls}`}
                              title={d.motivo}
                              onClick={(e) => { e.stopPropagation(); setExpandida(aberta ? null : u.projeto); }}
                            >
                              {d.m == null ? '—' : `${(d.m * 100).toFixed(1)}%`}
                              {d.tag && <span className="match-tag">{d.tag}</span>}
                            </td>
                          );
                        })()}
                        {(() => {
                          const deal = contratos.get(u.projeto)?.contrato.comercial;
                          const f = fimContrato(deal ?? { prazoContrato: '', signingDate: '', inicioCompensacao: '' });
                          return (
                            <td className="r" title={f.detalhe}>
                              {f.fim ? (
                                <span className={`fimtag ${f.tipo}`}>{new Date(f.fim + 'T00:00:00').getFullYear()}{f.tipo === 'estimada' ? '*' : ''}</span>
                              ) : (
                                <span className="muted">—</span>
                              )}
                            </td>
                          );
                        })()}
                        <td>
                          {u.semForecast ? (
                            <span className="badge warn">off-Forecast</span>
                          ) : u.noPipeline ? (
                            <span className="badge ok">in pipeline</span>
                          ) : (
                            <span className="badge">—</span>
                          )}
                        </td>
                      </tr>
                      {aberta && (
                        <tr className="panel-row">
                          <td colSpan={14}><ContratoPanel usina={u.projeto} /></td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="totais">
                  <td className="chev-col"></td>
                  <td>Total · {filtradas.length} plants</td>
                  <td></td>
                  <td></td>
                  <td className="r">{totais.mwac.toFixed(1)}</td>
                  <td className="r">{mwh(totais.ef)}</td>
                  <td></td>
                  <td className="r">{brl(totais.receita)}</td>
                  <td className="r strong" title={totais.custoOperacao > 0 ? `Total operating cost: −${brl(totais.custoOperacao)}/year` : ''}>{brl(totais.margem)}</td>
                  <td className="r">{totais.rMwh.toFixed(0)}</td>
                  <td className="r">{totais.budget ? `${totais.difPct >= 0 ? '+' : ''}${totais.difPct.toFixed(1)}%` : '—'}</td>
                  <td className="r strong">{totais.forecast ? `${((totais.receita / totais.forecast) * 100).toFixed(1)}%` : '—'}</td>
                  <td></td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
          )}
          {agrupar === 'usina' && <StickyScrollbar targetRef={tabelaRef} />}

          <footer className="foot">
            Revenue at the <b>official Forecast</b> level: <b>Final Energy = P50 × Operational Perf. × Compensation
            Perf.</b>, billed only in the COD months. Operational Perf. = 1 − Σlosses (editable);
            Compensation Perf. = MeterHub input. Click a plant to edit the contract and the energy
            chain, and compare against the locked budget.
          </footer>
        </>
      )}
    </div>
  );
}

/** "2026-01" → "01/26" */
const mmYY = fmtMes;

function ReceitaMensalChart({ serie }: { serie: { mes: string; receita: number; energia: number; nCOD: number }[] }) {
  const [sel, setSel] = useState<number | null>(null);
  if (serie.length === 0) return null;
  const W = 900, H = 180, padL = 46, padR = 12, padB = 22, padT = 10;
  const maxR = Math.max(...serie.map((s) => s.receita), 1);
  const bw = (W - padL - padR) / serie.length;
  const y = (v: number) => padT + (1 - v / maxR) * (H - padT - padB);
  const mi = (v: number) => (v / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  const total = serie.reduce((s, m) => s + m.receita, 0);
  const d = sel != null ? serie[sel] : null;
  return (
    <section className="mensal">
      <div className="mensal-head">
        <div>
          <h3>Monthly revenue · Forecast</h3>
          <p>{serie.length} months · total {brl(total)}</p>
        </div>
        {d && (
          <div className="mensal-detalhe">
            <b>{fmtMes(d.mes)}</b>
            <span>Revenue <b>{brl(d.receita)}</b></span>
            <span>Energy <b>{mwh(d.energia)}</b></span>
            <span>Plants in COD <b>{d.nCOD}</b></span>
          </div>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }}>
        {[0, 0.25, 0.5, 0.75, 1].map((g) => (
          <g key={g}>
            <line x1={padL} x2={W - padR} y1={y(maxR * g)} y2={y(maxR * g)} stroke="#eef2f4" />
            <text x={padL - 6} y={y(maxR * g) + 4} fontSize="10" fill="#8496a0" textAnchor="end">{mi(maxR * g)}M</text>
          </g>
        ))}
        {serie.map((m, i) => {
          const h = Math.max(0, (H - padT - padB) - (y(m.receita) - padT));
          const cor = m.nCOD === 0 ? '#c3d0d8' : sel === i ? '#c6da38' : '#004b70';
          return (
            <g key={m.mes} style={{ cursor: 'pointer' }} onClick={() => setSel(sel === i ? null : i)}>
              <rect x={padL + i * bw + bw * 0.15} y={y(m.receita)} width={bw * 0.7} height={h} fill={cor} rx="1.5" />
              <rect x={padL + i * bw} y={padT} width={bw} height={H - padT - padB} fill="transparent" />
              {i % 2 === 0 && <text x={padL + i * bw + bw / 2} y={H - 7} fontSize="8.5" fill="#8496a0" textAnchor="middle">{mmYY(m.mes)}</text>}
            </g>
          );
        })}
      </svg>
      <p className="mensal-foot">gray bars = months still under construction (no plant in COD) · click a month for details</p>
    </section>
  );
}

function Kpi({ label, value, sub, accent, warn }: { label: string; value: string; sub?: string; accent?: boolean; warn?: boolean }) {
  return (
    <div className={`kpi ${accent ? 'accent' : ''} ${warn ? 'warn' : ''}`}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {sub && <span className="kpi-sub">{sub}</span>}
    </div>
  );
}
