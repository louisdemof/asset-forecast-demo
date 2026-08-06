import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { useForecastStore } from '../store/forecastStore';
import { comMedido, faturaPorCompensacao } from '../store/forecastStore';
import { rodaContrato } from '../engine/contrato';
import { medidoDaUsina, fechadoAte } from '../data/compReal';
import { fmtMes } from '../lib/date';

const rs = (v: number) => `R$ ${Math.round(v).toLocaleString('pt-BR')}`;
const pct = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);
const mwh = (v: number) => `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}`;

type SortKey = 'projeto' | 'cliente' | 'nMeses' | 'ePrev' | 'eReal' | 'rPrev' | 'rReal' | 'delta';
const TEXT_KEYS = new Set<SortKey>(['projeto', 'cliente']);

interface LinhaMes { mes: string; ePrev: number; eReal: number; rPrev: number; rReal: number }
interface LinhaUsina {
  projeto: string; cliente: string; nMeses: number;
  rPrev: number; rReal: number; ePrev: number; eReal: number; delta: number | null;
  meses: LinhaMes[];
}

export default function ReconciliacaoPanel() {
  const contratos = useForecastStore((s) => s.contratos);
  const compReal = useForecastStore((s) => s.compReal);
  const usarMedido = useForecastStore((s) => s.usarMedido);
  const setUsarMedido = useForecastStore((s) => s.setUsarMedido);
  const [aberta, setAberta] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'delta', dir: 'desc' });

  const ordenar = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: TEXT_KEYS.has(key) ? 'asc' : 'desc' }));

  const linhas = useMemo<LinhaUsina[]>(() => {
    const out: LinhaUsina[] = [];
    for (const [projeto, cc] of contratos) {
      // só contratos base-compensação (AR + NEXUS); os demais GC faturam injeção
      if (!faturaPorCompensacao(cc.contrato.clienteTipo)) continue;
      const med = medidoDaUsina(compReal, projeto);
      if (!med) continue;
      // meses fechados que têm compensação medida
      const mesesMed = new Set(Object.entries(med).filter(([m, v]) => m <= fechadoAte && v > 0).map(([m]) => m));
      if (!mesesMed.size) continue;
      const prev = rodaContrato(cc.contrato, cc.entradas);
      const real = rodaContrato(comMedido(cc.contrato, projeto, compReal), cc.entradas);
      const meses: LinhaMes[] = [];
      for (let i = 0; i < prev.meses.length; i++) {
        const p = prev.meses[i], r = real.meses[i];
        if (!mesesMed.has(p.mes)) continue;
        meses.push({ mes: p.mes, ePrev: p.energiaComp, eReal: r.energiaComp, rPrev: p.receitaTotal, rReal: r.receitaTotal });
      }
      if (!meses.length) continue;
      const rPrev = meses.reduce((s, m) => s + m.rPrev, 0);
      const rReal = meses.reduce((s, m) => s + m.rReal, 0);
      const ePrev = meses.reduce((s, m) => s + m.ePrev, 0);
      const eReal = meses.reduce((s, m) => s + m.eReal, 0);
      out.push({ projeto, cliente: cc.contrato.cliente, nMeses: meses.length, rPrev, rReal, ePrev, eReal, delta: rPrev ? (rReal - rPrev) / rPrev : null, meses });
    }
    const dir = sort.dir === 'asc' ? 1 : -1;
    out.sort((a, b) => {
      if (sort.key === 'projeto' || sort.key === 'cliente') return dir * a[sort.key].localeCompare(b[sort.key]);
      if (sort.key === 'delta') return dir * ((a.delta ?? 0) - (b.delta ?? 0)); // desvio: signed → ▼ mais positivo, ▲ mais negativo
      return dir * ((a[sort.key] as number) - (b[sort.key] as number));
    });
    return out;
  }, [contratos, compReal, sort]);

  const tot = useMemo(() => {
    const rPrev = linhas.reduce((s, l) => s + l.rPrev, 0);
    const rReal = linhas.reduce((s, l) => s + l.rReal, 0);
    const absErr = linhas.reduce((s, l) => s + Math.abs(l.rReal - l.rPrev), 0);
    return { rPrev, rReal, acur: rPrev ? 1 - absErr / rPrev : null, n: linhas.length };
  }, [linhas]);

  if (!contratos.size) return <div className="state">Loading…</div>;

  return (
    <>
      <section className="kpis">
        <Kpi label="Forecast revenue" value={rs(tot.rPrev)} sub={`assumption · ${tot.n} plants · closed months`} />
        <Kpi label="Actual revenue" value={rs(tot.rReal)} sub="actual compensation (MeterHub)" accent />
        <Kpi label="Total deviation" value={pct(tot.rPrev ? (tot.rReal - tot.rPrev) / tot.rPrev : null)} sub={`${rs(tot.rReal - tot.rPrev)} vs forecast`} />
        <Kpi label="Forecast accuracy" value={tot.acur == null ? '—' : `${(tot.acur * 100).toFixed(1)}%`} sub="1 − Σ|deviation| ÷ Σ forecast" />
      </section>

      <div className="audit-head">
        <p>
          Compares, over the <b>already-closed months</b>, the <b>assumption</b> revenue (perfComp × P50) with the revenue recalculated from the <b>actual
          measured compensation</b> (MeterHub, clean). Closes the forecast loop: shows where the model diverges from reality. Only contracts billed
          on the <b>compensation basis</b> — all <b>AR</b> (TELMO, LOGIX, HIDRUS, TELCO) + <b>NEXUS</b>; the other GC bill injection (take-or-pay).
        </p>
        <div className="audit-filtros">
          <label className="medido-toggle">
            <input type="checkbox" checked={usarMedido} onChange={(e) => setUsarMedido(e.target.checked)} />
            &nbsp;Use the measured value in closed months (affects Revenue)
          </label>
          <span className="hint" style={{ marginLeft: 4 }}>click the headers to sort</span>
        </div>
      </div>

      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th className="chev-col"></th>
              <Th k="projeto" sort={sort} on={ordenar}>Plant</Th>
              <Th k="cliente" sort={sort} on={ordenar}>Client</Th>
              <Th k="nMeses" sort={sort} on={ordenar} r>Months</Th>
              <Th k="ePrev" sort={sort} on={ordenar} r>Energy forecast (MWh)</Th>
              <Th k="eReal" sort={sort} on={ordenar} r>Energy actual (MWh)</Th>
              <Th k="rPrev" sort={sort} on={ordenar} r>Revenue forecast</Th>
              <Th k="rReal" sort={sort} on={ordenar} r>Revenue actual</Th>
              <Th k="delta" sort={sort} on={ordenar} r title="▼ largest positive impact (actual &gt; forecast) · ▲ largest negative impact">Deviation</Th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((l) => {
              const open = aberta === l.projeto;
              const alto = l.delta != null && Math.abs(l.delta) > 0.1;
              return (
                <Fragment key={l.projeto}>
                  <tr className={`clickable ${open ? 'open' : ''}`} onClick={() => setAberta(open ? null : l.projeto)}>
                    <td className="chev-col">{open ? '▾' : '▸'}</td>
                    <td className="strong">{l.projeto}</td>
                    <td className="muted">{l.cliente}</td>
                    <td className="r">{l.nMeses}</td>
                    <td className="r muted">{mwh(l.ePrev)}</td>
                    <td className="r">{mwh(l.eReal)}</td>
                    <td className="r muted">{rs(l.rPrev)}</td>
                    <td className="r strong">{rs(l.rReal)}</td>
                    <td className={`r ${alto ? (l.delta! < 0 ? 'warn-text' : 'ok-text') : 'muted'}`}>{pct(l.delta)}{alto ? (l.delta! < 0 ? ' ▼' : ' ▲') : ''}</td>
                  </tr>
                  {open && (
                    <tr>
                      <td colSpan={9} style={{ background: '#f7fafb' }}>
                        <div style={{ padding: '8px 14px' }}>
                          <table className="uc-mes-table">
                            <thead>
                              <tr><th>Month</th><th className="r">Energy forecast</th><th className="r">Energy actual</th><th className="r">Δ energy</th><th className="r">Revenue forecast</th><th className="r">Revenue actual</th><th className="r">Deviation</th></tr>
                            </thead>
                            <tbody>
                              {l.meses.map((m) => {
                                const dE = m.ePrev ? (m.eReal - m.ePrev) / m.ePrev : null;
                                const dR = m.rPrev ? (m.rReal - m.rPrev) / m.rPrev : null;
                                return (
                                  <tr key={m.mes}>
                                    <td className="mono">{fmtMes(m.mes)}</td>
                                    <td className="r muted">{mwh(m.ePrev)}</td>
                                    <td className="r">{mwh(m.eReal)}</td>
                                    <td className={`r ${dE == null ? 'muted' : Math.abs(dE) > 0.1 ? 'warn-text' : ''}`}>{pct(dE)}</td>
                                    <td className="r muted">{rs(m.rPrev)}</td>
                                    <td className="r strong">{rs(m.rReal)}</td>
                                    <td className={`r ${dR == null ? 'muted' : Math.abs(dR) > 0.1 ? 'warn-text' : 'ok-text'}`}>{pct(dR)}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {!linhas.length && <p className="hint">No plant with measured compensation in the closed months.</p>}
      </div>
      <footer className="foot">
        Forecast = assumption revenue (perfComp × P50 × perfOper). Actual = revenue recalculated with the <b>real clean compensation</b> (MeterHub,
        excludes generator/glitch), through {fmtMes(fechadoAte)}. Deviation &gt; 10% highlighted. The actual energy replaces the assumption month by month; the Calculation
        Base (R$/MWh) and the demand are the same — isolating the effect of compensation.
      </footer>
    </>
  );
}

function Th({ k, sort, on, r, title, children }: { k: SortKey; sort: { key: SortKey; dir: 'asc' | 'desc' }; on: (k: SortKey) => void; r?: boolean; title?: string; children: ReactNode }) {
  const ativo = sort.key === k;
  return (
    <th className={`${r ? 'r ' : ''}th-sort${ativo ? ' on' : ''}`} onClick={() => on(k)} title={title ?? 'Sort'}>
      {children}<span className="th-arrow">{ativo ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ' ⇅'}</span>
    </th>
  );
}

function Kpi({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`kpi ${accent ? 'accent' : ''}`}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {sub && <span className="kpi-sub">{sub}</span>}
    </div>
  );
}
