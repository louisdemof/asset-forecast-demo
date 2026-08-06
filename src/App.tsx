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
  if (u.semForecast || !u.receitaForecast) return { m: null, tag: 's/ forecast', motivo: 'usina não está na aba Forecast oficial', cls: 'muted' };
  const m = u.receitaEngine / u.receitaForecast;
  const dif = u.receitaEngine - u.receitaForecast;
  if (Math.abs(m - 1) < 0.001) return { m, tag: '', motivo: 'reproduz o Excel exatamente', cls: 'match-ok' };
  const base = `motor ${brl(u.receitaEngine)} · oficial ${brl(u.receitaForecast)} · dif ${brl(dif)} (${((m - 1) * 100).toFixed(1)}%)`;
  if (Math.abs(m - 1) < 0.02) return { m, tag: '≈ ok', motivo: `≈ dentro de 2% · ${base}`, cls: 'match-near' };
  if (baseFixa && baseFixa > 0) return { m, tag: 'base fixa', motivo: `base de cálculo hardcoded no Excel · ${base}`, cls: 'match-bad' };
  return { m, tag: 'ajuste Excel', motivo: `diferença absorvida por ajuste manual/cap no Excel · ${base}`, cls: 'match-bad' };
}

type Agrupar = 'usina' | 'cliente' | 'disco';
interface GrupoRollup { chave: string; n: number; mwac: number; ef: number; receita: number; forecast: number; budget: number }
/** Agrega as usinas por cliente ou distribuidora p/ a visão de rollup. */
function rollup(usinas: UsinaResumo[], por: Exclude<Agrupar, 'usina'>): GrupoRollup[] {
  const acc = new Map<string, GrupoRollup>();
  for (const u of usinas) {
    const chave = (por === 'cliente' ? u.cliente : u.disco) || '— sem ' + (por === 'cliente' ? 'cliente' : 'distribuidora');
    const g = acc.get(chave) ?? { chave, n: 0, mwac: 0, ef: 0, receita: 0, forecast: 0, budget: 0 };
    g.n += 1; g.mwac += u.potMWac; g.ef += u.energiaFinalTotal;
    g.receita += u.receitaEngine; g.forecast += u.receitaForecast; g.budget += u.budget;
    acc.set(chave, g);
  }
  return [...acc.values()].sort((a, b) => b.receita - a.receita);
}

/** Exporta o forecast (linhas filtradas) em CSV — separador ';' e BOM p/ Excel pt-BR. */
function exportarCSV(usinas: UsinaResumo[]) {
  const header = ['Usina', 'Distribuidora', 'Cliente', 'MWac', 'Energia Final (MWh)', 'Receita Forecast (R$)', 'Budget (R$)', 'vs Budget %', 'Status'];
  const linhas = usinas.map((u) => [
    u.projeto, u.disco, u.cliente || '',
    u.potMWac.toFixed(1),
    u.energiaFinalTotal.toFixed(0),
    u.receitaEngine.toFixed(0),
    u.budget.toFixed(0),
    u.budget ? ((u.receitaEngine / u.budget - 1) * 100).toFixed(1) : '',
    u.semForecast ? 'fora do forecast' : u.noPipeline ? 'no pipeline' : '',
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
        <img className="topband-logo" src={`${import.meta.env.BASE_URL}SolarCo_logo.svg`} alt="SolarCo" />
        <div className="topband-actions">
          <FormulasHelp />
          <a className="topband-link" href={`${import.meta.env.BASE_URL}apresentacao.html`} target="_blank" rel="noreferrer">📊 Apresentação ↗</a>
          <a className="topband-link" href={`${import.meta.env.BASE_URL}governanca-dados.html`} target="_blank" rel="noreferrer">🗂 Governança ↗</a>
          <a className="topband-link" href={`${import.meta.env.BASE_URL}Contrato_de_Dados_Governanca.xlsx`}>⤓ Contrato de Dados (xlsx)</a>
          {podeAdmin && (
            <button className={`topband-link${aba === 'admin' ? ' topband-link--on' : ''}`} onClick={() => setAba('admin')}>
              👤 Usuários & Admin
            </button>
          )}
          <AuthButton />
        </div>
      </div>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" />
          <div>
            <h1>Módulo de Receita</h1>
            <p>Forecast de receita do portfólio · Asset</p>
          </div>
        </div>
        <span className="tag">protótipo · dados Forecast 6+6</span>
      </header>

      <nav className="tabs">
        <button className={aba === 'receita' ? 'tab on' : 'tab'} onClick={() => setAba('receita')}>Receita</button>
        <button className={aba === 'pvsyst' ? 'tab on' : 'tab'} onClick={() => setAba('pvsyst')}>Geração (PVsyst)</button>
        <button className={aba === 'tarifas' ? 'tab on' : 'tab'} onClick={() => setAba('tarifas')}>Tarifas & Reajustes</button>
        <button className={aba === 'metodos' ? 'tab on' : 'tab'} onClick={() => setAba('metodos')}>Métodos por cliente</button>
        <button className={aba === 'alertas' ? 'tab on' : 'tab'} onClick={() => setAba('alertas')}>Alertas</button>
        <button className={aba === 'compensacao' ? 'tab on' : 'tab'} onClick={() => setAba('compensacao')}>Compensação (MeterHub)</button>
        <button className={aba === 'auditoria' ? 'tab on' : 'tab'} onClick={() => setAba('auditoria')}>Auditoria UCs</button>
        <button className={aba === 'reconciliacao' ? 'tab on' : 'tab'} onClick={() => setAba('reconciliacao')}>Prev × Real</button>
        <button className={aba === 'geracao' ? 'tab on' : 'tab'} onClick={() => setAba('geracao')}>Geração (P50 × Inj)</button>
      </nav>

      {loading && <div className="state">Carregando portfólio…</div>}
      {error && <div className="state err">Erro: {error}</div>}

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
            <button className="btn-nova-usina" onClick={() => setNovaUsina(true)}>＋ Nova usina</button>
          </div>
          <section className="kpis">
            <Kpi label="Usinas" value={String(kpi.nUsinas)} sub={`${kpi.nLinhas} linhas · ${kpi.mwac.toFixed(0)} MWac`} />
            <Kpi label="Receita motor / ano" value={brl(kpi.receita)} sub="engine · nível Energia Final" accent />
            <Kpi label="vs Budget" value={`${kpi.budget ? ((kpi.receita / kpi.budget - 1) * 100).toFixed(1) : '0'}%`} sub={`orçado ${brl(kpi.budget)}`} warn={kpi.receita < kpi.budget} />
            <Kpi label="Geração P50 / ano" value={mwh(kpi.p50)} sub="antes dos haircuts" />
          </section>

          <div className="data-stamp" title="Procedência dos dados desta aba. Atualizar em src/lib/dataInfo.ts ao repuxar.">
            📅 <b>Forecast 6+6</b> · {carimboForecast()} &nbsp;·&nbsp; compensação por premissa do Excel (medição real na aba Compensação)
          </div>

          <div className="toolbar">
            <input
              className="search"
              placeholder="Buscar usina, distribuidora ou cliente…"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
            />
            <span className="count">{filtradas.length} usinas</span>
            <div className="agrupar-toggle" role="group" aria-label="Agrupar por">
              <button className={agrupar === 'usina' ? 'on' : ''} onClick={() => setAgrupar('usina')}>por usina</button>
              <button className={agrupar === 'cliente' ? 'on' : ''} onClick={() => setAgrupar('cliente')}>por cliente</button>
              <button className={agrupar === 'disco' ? 'on' : ''} onClick={() => setAgrupar('disco')}>por distribuidora</button>
            </div>
            <button className="btn-export" onClick={() => exportarCSV(filtradas)}>⤓ Exportar CSV</button>
          </div>

          <div className="filtros">
            <div className="filtro-slider">
              <div className="filtro-slider-top">
                <span>Compensação ≤ <b>{compMax}%</b></span>
                <span className="filtro-slider-count">{filtradas.length} usinas</span>
              </div>
              <input className="slider" type="range" min={0} max={100} step={1} style={{ ['--val' as string]: `${compMax}%` }} value={compMax} onChange={(e) => setCompMax(+e.target.value)} />
            </div>
            <label>Distribuidora
              <select value={fDisco} onChange={(e) => setFDisco(e.target.value)}>
                <option value="todas">todas</option>
                {discos.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
            <label>Status
              <select value={fStatus} onChange={(e) => setFStatus(e.target.value as typeof fStatus)}>
                <option value="todos">todos</option>
                <option value="negativa">receita negativa</option>
                <option value="abaixo">abaixo do budget</option>
                <option value="pipeline">no pipeline</option>
                <option value="fora">fora do Forecast</option>
              </select>
            </label>
            {(compMax !== 100 || fDisco !== 'todas' || fStatus !== 'todos' || busca) && (
              <button className="reset-link" onClick={() => { setCompMax(100); setFDisco('todas'); setFStatus('todos'); setBusca(''); }}>↺ limpar filtros</button>
            )}
          </div>

          <ReceitaMensalChart serie={serieMensal} />

          {agrupar !== 'usina' ? (
            <div className="tablewrap">
              <table className="rollup-t">
                <thead>
                  <tr>
                    <th>{agrupar === 'cliente' ? 'Cliente (offtaker)' : 'Distribuidora'}</th>
                    <th className="r">Usinas</th>
                    <th className="r">MWac</th>
                    <th className="r">Energia Final</th>
                    <th className="r">Receita motor</th>
                    <th className="r" title="Receita motor ÷ Forecast oficial (ponderado). 100% = reproduz o Excel.">Match Excel</th>
                    <th className="r" title="Receita motor ÷ Budget − 1">vs Budget</th>
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
                    <td>Total · {gruposRollup.length} {agrupar === 'cliente' ? 'clientes' : 'distribuidoras'}</td>
                    <td className="r">{filtradas.length}</td>
                    <td className="r">{totais.mwac.toFixed(1)}</td>
                    <td className="r">{mwh(totais.ef)}</td>
                    <td className="r strong">{brl(totais.receita)}</td>
                    <td className="r strong">{totais.forecast ? `${((totais.receita / totais.forecast) * 100).toFixed(1)}%` : '—'}</td>
                    <td className="r">{totais.budget ? `${totais.difPct >= 0 ? '+' : ''}${totais.difPct.toFixed(1)}%` : '—'}</td>
                  </tr>
                </tfoot>
              </table>
              <p className="hint">Clique numa linha p/ voltar à visão por usina filtrada por {agrupar === 'cliente' ? 'esse cliente' : 'essa distribuidora'}.</p>
            </div>
          ) : (
          <div className="tablewrap" ref={tabelaRef}>
            <table>
              <thead>
                <tr>
                  <th className="chev-col"></th>
                  <th className="sortable" onClick={() => toggleSort('projeto')}>Usina{seta('projeto')}</th>
                  <th className="sortable" onClick={() => toggleSort('disco')}>Distribuidora{seta('disco')}</th>
                  <th className="sortable" onClick={() => toggleSort('cliente')}>Cliente{seta('cliente')}</th>
                  <th className="r sortable" onClick={() => toggleSort('potMWac')}>
                    <ColHint label="MWac" titulo="Potência instalada (MWac)" oque="O tamanho da usina, em megawatts de corrente alternada — a capacidade que efetivamente entrega energia à rede." comoLer="Maior = usina maior. É a referência de porte usada em toda a plataforma." />{seta('potMWac')}
                  </th>
                  <th className="r sortable" onClick={() => toggleSort('energiaFinalTotal')}>
                    <ColHint label="Energia Final" titulo="Energia Final (MWh/ano)" oque={<>A energia que de fato vira receita no ano. <span className="mono">P50 × Perf. Operacional × Perf. Compensação</span>, contada só nos meses em que a usina está em COD (operação comercial).</>} comoLer="É a base de faturamento — parte do P50 (geração bruta) após as perdas e a compensação." />{seta('energiaFinalTotal')}
                  </th>
                  <th className="r sortable" onClick={() => toggleSort('perfCompMedia')}>
                    <ColHint
                      label={<>Comp. <small>(premissa)</small></>}
                      titulo="Perf. Compensação — PREMISSA"
                      oque={<>Fração da energia líquida que vira crédito compensado. Aqui é a <b>premissa do Forecast</b> (Excel / curva de rampa do contrato), <b>não</b> medição.</>}
                      comoLer={<>O chip diz a fonte: <span className="colhint-chip medivel">medível</span> = cliente Autoconsumo Remoto, dá pra validar na aba Compensação (MeterHub). <span className="colhint-chip premissa">premissa</span> = cliente Geração Compartilhada, vem do contrato — não é medido.</>}
                    />{seta('perfCompMedia')}
                  </th>
                  <th className="r sortable" onClick={() => toggleSort('receitaEngine')}>
                    <ColHint label="Receita motor" titulo="Receita motor (R$/ano)" oque={<>A receita que a plataforma <b>calcula</b>: <span className="mono">Base de Cálculo × Energia Final − Demanda</span>.</>} comoLer="É o número da plataforma. Para saber se bate com o Excel oficial, olhe a coluna Match Excel." />{seta('receitaEngine')}
                  </th>
                  <th className="r sortable" onClick={() => toggleSort('margem')}>
                    <ColHint label="Margem" titulo="Margem (R$/ano)" oque={<>Receita motor <b>menos custos de operação</b>: <span className="mono">Receita − Fee de operação de GC</span>. Hoje só a <b>OPERON</b> (Buriti) tem fee (R$ 85/MWh). Primeiro passo do módulo Resultado.</>} comoLer="Igual à Receita quando não há custo. Onde há fee, aparece o desconto em vermelho." />{seta('margem')}
                  </th>
                  <th className="r sortable" onClick={() => toggleSort('rMwh')}>
                    <ColHint label="R$/MWh" titulo="Preço médio realizado" oque={<>Receita ÷ Energia Final — quanto a usina fatura por MWh entregue.</>} comoLer="Permite comparar usinas de tamanhos diferentes na mesma régua. '—' quando a energia é ~0." />{seta('rMwh')}
                  </th>
                  <th className="r sortable" onClick={() => toggleSort('vsBudget')}>
                    <ColHint label="vs Budget" titulo="vs Budget" oque={<>Receita motor comparada ao orçamento travado: <span className="mono">Receita ÷ Budget − 1</span>.</>} comoLer="Verde = acima do orçado; vermelho = abaixo." />{seta('vsBudget')}
                  </th>
                  <th className="r">
                    <ColHint
                      label={<>Match Excel <span aria-hidden>🔎</span></>}
                      titulo="Match Excel"
                      oque={<>Receita do motor ÷ Receita do <b>Forecast oficial</b> (o Excel 6+6). <b>100% = a plataforma reproduz o Excel exatamente.</b></>}
                      comoLer={<>A tag ao lado diz o porquê quando diverge (<i>ajuste Excel</i>, <i>base fixa</i>, <i>≈ ok</i>, <i>s/ forecast</i>). Clique na célula para abrir o detalhe da divergência.</>}
                    />
                  </th>
                  <th>
                    <ColHint
                      label="Fim contrato"
                      titulo="Fim de contrato"
                      oque={<>Fim do contrato derivado do campo <span className="mono">Contract term</span> (aba Comercial).</>}
                      comoLer={<>Ano cheio p/ <span className="mono">"Until AAAA"</span>; com <b>*</b> = estimado (início da compensação + N anos); <b>—</b> = sem dado na planilha (a preencher).</>}
                    />
                  </th>
                  <th>
                    <ColHint
                      label="Pipeline"
                      titulo="Status comercial"
                      oque={<><b>no pipeline</b> = tem deal comercial em negociação (aba Comercial). <b>fora do Forecast</b> = está no Contratos mas não na aba Forecast oficial.</>}
                      comoLer="'—' = usina estável, já operando com cliente definido." />
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
                        <td>{u.cliente ? u.cliente : <span className="sem-cliente" title="usina sem cliente atribuído">⚠ sem cliente</span>}</td>
                        <td className="r">{u.potMWac.toFixed(1)}</td>
                        <td className="r muted">{mwh(u.energiaFinalTotal)}</td>
                        <td className="r">
                          <span className={`comp-chip ${compBucket(u.perfCompMedia)}`}>{(u.perfCompMedia * 100).toFixed(0)}%</span>
                          {u.modelo === 'AR'
                            ? <span className="comp-src medido" title="Autoconsumo Remoto — compensação MEDÍVEL na MeterHub (ver aba Compensação). O valor aqui ainda é a premissa do Forecast.">medível</span>
                            : <span className="comp-src premissa" title="Geração Compartilhada — compensação vem do contrato/premissa do Forecast; não é medida pela MeterHub.">premissa</span>}
                        </td>
                        <td className="r strong">{brl(u.receitaEngine)}</td>
                        <td className={`r ${u.custoOperacao > 0 ? 'strong' : 'muted'}`}>
                          {brl(u.margem)}
                          {u.custoOperacao > 0 && <span className="custo-op" title={`Fee de operação de GC pago à OPERON: −${brl(u.custoOperacao)}/ano (R$ 85/MWh compensado)`}> −{brl(u.custoOperacao)}</span>}
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
                            <span className="badge warn">fora do Forecast</span>
                          ) : u.noPipeline ? (
                            <span className="badge ok">no pipeline</span>
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
                  <td>Total · {filtradas.length} usinas</td>
                  <td></td>
                  <td></td>
                  <td className="r">{totais.mwac.toFixed(1)}</td>
                  <td className="r">{mwh(totais.ef)}</td>
                  <td></td>
                  <td className="r">{brl(totais.receita)}</td>
                  <td className="r strong" title={totais.custoOperacao > 0 ? `Custo de operação total: −${brl(totais.custoOperacao)}/ano` : ''}>{brl(totais.margem)}</td>
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
            Receita no nível <b>Forecast oficial</b>: <b>Energia Final = P50 × Perf. Operacional × Perf.
            Compensação</b>, faturada só nos meses em COD. Perf. Operacional = 1 − Σperdas (editável);
            Perf. Compensação = input da MeterHub. Clique numa usina pra editar o contrato e a cadeia de
            energia, e comparar com o budget travado.
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
          <h3>Receita mensal · Forecast</h3>
          <p>{serie.length} meses · total {brl(total)}</p>
        </div>
        {d && (
          <div className="mensal-detalhe">
            <b>{fmtMes(d.mes)}</b>
            <span>Receita <b>{brl(d.receita)}</b></span>
            <span>Energia <b>{mwh(d.energia)}</b></span>
            <span>Usinas em COD <b>{d.nCOD}</b></span>
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
      <p className="mensal-foot">barras cinza = meses ainda em construção (sem usina em COD) · clique num mês pra detalhar</p>
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
