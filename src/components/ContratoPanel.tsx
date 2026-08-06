import { useMemo, useState } from 'react';
import { useForecastStore } from '../store/forecastStore';
import { rodaContrato, type Contrato, type ClienteTipo, type LinhaCusto, type ModoCusto, type AlocacaoMes } from '../engine/contrato';
import { REGRAS_CLIENTE } from '../engine/clientes';
import { fmtMes as mmYY } from '../lib/date';
import type { TarifaDisco } from '../engine/receita';
import { fimContrato, type DealComercial } from '../engine/comercial';
import { reajusteDoDisco, tarifasAneelMWh } from '../data/aneel';

const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const mwh = (v: number) => `${v.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} MWh`;
/** Soma n meses a uma data ISO (yyyy-mm[-dd]) → 'yyyy-mm'. */
function addMeses(iso: string | undefined, n: number): string {
  if (!iso) return '';
  const [y, m] = iso.slice(0, 7).split('-').map(Number);
  if (!y || !m) return '';
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Visão mensal da usina: 12 meses de forecast; clique num mês abre o detalhe. */
function ReceitaMensalUsina({ meses }: { meses: AlocacaoMes[] }) {
  const [sel, setSel] = useState<number | null>(null);
  const d = sel != null ? meses[sel] : null;
  return (
    <section className="cbloco mensal-usina">
      <h5>Monthly revenue <span className="muted" style={{ fontWeight: 400 }}>· click a month to see details</span></h5>
      <table className="mes-table">
        <thead><tr><th>Month</th><th>Status</th><th className="r">Final Energy</th><th className="r">Comp.</th><th className="r">Revenue</th></tr></thead>
        <tbody>
          {meses.map((m, i) => (
            <tr key={m.mes} className={`clickable ${sel === i ? 'on' : ''}`} onClick={() => setSel(sel === i ? null : i)}>
              <td className="strong">{mmYY(m.mes)}</td>
              <td>{m.status === 'COD' ? <span className="badge ok">COD</span> : <span className="badge">const.</span>}</td>{/* 'const.' = construction, display abbrev */}
              <td className="r muted">{mwh(m.energiaFinal)}</td>
              <td className="r">{(m.perfComp * 100).toFixed(0)}%</td>
              <td className="r strong">{brl(m.receitaTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {d && (
        <div className="mes-detalhe">
          <div className="mes-detalhe-h"><b>{mmYY(d.mes)}</b> · {d.status}</div>
          <div className="mes-grid">
            <span>P50<b>{mwh(d.p50)}</b></span>
            <span>Oper. Perf<b>{(d.perfOper * 100).toFixed(0)}%</b></span>
            <span>Comp. Perf<b>{(d.perfComp * 100).toFixed(0)}%</b></span>
            <span>Final Energy<b>{mwh(d.energiaFinal)}</b></span>
            <span>Calculation Base<b>{d.base != null ? `${d.base.toFixed(0)} R$/MWh` : '—'}</b></span>
            <span>Gross Revenue<b>{brl(d.receitaBruta)}</b></span>
            <span>PV Demand<b>{brl(d.demanda)}</b></span>
            <span>Equipment Lease<b>{brl(d.equipamentos)}</b></span>
            <span>O&amp;M<b>{brl(d.om)}</b></span>
            <span>Property<b>{brl(d.imovel)}</b></span>
            <span>Umbrella<b>{brl(d.guardaChuva)}</b></span>
            <span className="rt">Total Revenue<b>{brl(d.receitaTotal)}</b></span>
          </div>
        </div>
      )}
    </section>
  );
}

const LINHAS: { key: 'equipamentos' | 'om' | 'imovel' | 'guardaChuva'; label: string; cor: string }[] = [
  { key: 'equipamentos', label: 'Equipment Lease', cor: '#004b70' },
  { key: 'om', label: 'O&M', cor: '#6692a8' },
  { key: 'imovel', label: 'Property', cor: '#9bb8c6' },
  { key: 'guardaChuva', label: 'Umbrella', cor: '#c6da38' },
];

const TIPOS: ClienteTipo[] = ['TELMO', 'TELCO', 'NEXUS', 'LOGIX', 'SOLARA', 'VERTA', 'BANCOR', 'HIDRUS', 'PETRAX', 'PADRAO'];

const dealVazio = (usina: string, disco: string): DealComercial => ({
  projeto: usina, status: '', disco, offtakerOriginal: '', pipelineStatus: '', novoOfftaker: '',
  prazoContrato: '', takeOrPay: 0, rampUp: '', desconto: 0, baseCalculo: '', signingDate: '',
  codDate: '', trocaTitularidade: '', inicioCompensacao: '', riscos: '',
});

export default function ContratoPanel({ usina }: { usina: string }) {
  const cc = useForecastStore((s) => s.contratos.get(usina));
  const editar = useForecastStore((s) => s.editaContrato);
  if (!cc) return null;
  const { contrato, entradas, receitaForecastAno, budgetAno } = cc;

  const resumo = useMemo(() => rodaContrato(contrato, entradas), [contrato, entradas]);
  const difForecast = resumo.receitaTotal - receitaForecastAno;
  const difBudget = resumo.receitaTotal - budgetAno;

  const efet = useMemo(() => {
    const p50 = resumo.meses.reduce((s, m) => s + m.p50, 0);
    const eLiq = resumo.meses.reduce((s, m) => s + m.p50 * m.perfOper, 0);
    const eFinal = resumo.meses.reduce((s, m) => s + m.energiaFinal, 0);
    return { p50, energiaFinal: eFinal, perfOper: p50 ? eLiq / p50 : 1, perfComp: eLiq ? eFinal / eLiq : 1 };
  }, [resumo]);
  const perfOperMostrado = contrato.perfOperOverride ?? efet.perfOper;
  const perfCompMostrado = contrato.perfCompOverride ?? efet.perfComp;
  const temOverride = contrato.perfOperOverride !== undefined || contrato.perfCompOverride !== undefined;

  const set = (patch: Partial<Contrato>) => editar(usina, patch);
  const setCom = (patch: Partial<DealComercial>) =>
    editar(usina, { comercial: { ...(contrato.comercial ?? dealVazio(usina, contrato.disco)), ...patch } });
  const tar = contrato.tarifa ?? { disco: contrato.disco, tusd: 0, te: 0, tusdC: 0, tusdG: 0, pisCofins: 0, icms: 0 };
  const setTar = (patch: Partial<TarifaDisco>) => editar(usina, { tarifa: { ...tar, ...patch } });
  const reajuste = reajusteDoDisco(contrato.disco);
  const aneelTar = tarifasAneelMWh(contrato.disco);

  // indicadores calculados (como no Excel)
  const demandaAno = resumo.meses.reduce((s, m) => s + m.demanda, 0);
  const energiaFinalAno = resumo.meses.reduce((s, m) => s + m.energiaFinal, 0);
  const p50Ano = resumo.meses.reduce((s, m) => s + m.p50, 0);
  const tarifaGD = energiaFinalAno ? resumo.receitaTotal / energiaFinalAno : 0;
  const custoCativo = tar.pisCofins < 1 ? ((tar.tusd + tar.te) / (1 - tar.pisCofins)) * p50Ano : 0;
  const setLinha = (key: (typeof LINHAS)[number]['key'], patch: Partial<LinhaCusto>) => {
    const next: Partial<Contrato> = { [key]: { ...contrato[key], ...patch } };
    if (patch.modo === 'residual') {
      for (const l of LINHAS) {
        if (l.key !== key && contrato[l.key].modo === 'residual') {
          (next as Record<string, LinhaCusto>)[l.key] = { ...contrato[l.key], modo: 'fixo' };
        }
      }
    }
    editar(usina, next);
  };

  const com = contrato.comercial;
  const temResidual = LINHAS.some((l) => contrato[l.key].modo === 'residual');

  return (
    <div className="cpanel">
      <div className="cpanel-header">
        <h3>{usina} <span className="ctipo">{contrato.clienteTipo}</span></h3>
        <span className="muted">{contrato.disco} · {contrato.cliente || 'no client'}</span>
      </div>

      <div className="cpanel-grid">
        {/* ==== ESQUERDA: o objeto Contrato (inputs) ==== */}
        <div className="cpanel-form">
          <section className="cbloco">
            <h5>Contract</h5>
            <Campo label="Client"><input value={contrato.cliente} onChange={(e) => set({ cliente: e.target.value })} /></Campo>
            <Campo label="Client type (Base formula)">
              <select value={contrato.clienteTipo} onChange={(e) => set({ clienteTipo: e.target.value as ClienteTipo })}>
                {TIPOS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Campo>
            {(() => {
              const r = REGRAS_CLIENTE[contrato.clienteTipo];
              return (
                <div className="regra-cliente" title="Rules that apply when switching clients (change of ownership)">
                  <span className={`metodo-chip modelo-${r.modelo}`}>{r.modelo === 'AR' ? 'Remote Self-Consumption' : 'Shared Generation'}</span>
                  <span className="regra-txt">base: <b className="mono">{r.descricaoBase}</b> · residual: <b>{r.residual === 'guardaChuva' ? 'Umbrella' : 'O&M'}</b></span>
                </div>
              );
            })()}
            <Campo label="Utility"><input value={contrato.disco} onChange={(e) => set({ disco: e.target.value })} /></Campo>
            <Campo label="Capacity (MWac)"><input type="number" step={0.1} value={contrato.potMWac} onChange={(e) => set({ potMWac: +e.target.value || 0 })} /></Campo>
            <Campo label="Capacity (MWp)"><input type="number" step={0.1} value={contrato.potMWp ?? 0} onChange={(e) => set({ potMWp: +e.target.value || 0 })} /></Campo>
            <Campo label="Discount (%)"><input type="number" step={0.1} value={+(contrato.desconto * 100).toFixed(2)} onChange={(e) => set({ desconto: (+e.target.value || 0) / 100 })} /></Campo>
            <Campo label="Calculation base"><input value={com?.baseCalculo ?? ''} placeholder="TE+TUSD" onChange={(e) => setCom({ baseCalculo: e.target.value })} /></Campo>
            <Campo label="Risk Level (1–3)"><input type="number" step={1} min={1} max={3} value={contrato.nivelRisco ?? ''} onChange={(e) => set({ nivelRisco: +e.target.value || 0 })} /></Campo>
          </section>

          <section className="cbloco">
            <h5>Tariffs <small>(R$/MWh)</small></h5>
            <div className="aneel-bar">
              {reajuste ? (
                <>
                  <span className="aneel-badge">🔗 ANEEL</span>
                  <span className="aneel-info">
                    Next adjustment: <b>{reajuste.proximo}</b> · in effect since {reajuste.vigente}
                    <small title={reajuste.resolucao}> · {reajuste.resolucao.replace('RESOLUÇÃO HOMOLOGATÓRIA', 'Res.').slice(0, 22)}…</small>
                  </span>
                  {aneelTar && (
                    <button className="reset-link" onClick={() => setTar({ tusd: +aneelTar.tusd.toFixed(2), te: +aneelTar.te.toFixed(2) })}>
                      ⤵ sync TUSD/TE from ANEEL ({aneelTar.tusd.toFixed(0)}/{aneelTar.te.toFixed(0)})
                    </button>
                  )}
                </>
              ) : (
                <span className="aneel-info muted">Utility with no match in ANEEL database</span>
              )}
            </div>
            <Campo label="TUSD"><input type="number" step={1} value={+tar.tusd.toFixed(2)} onChange={(e) => setTar({ tusd: +e.target.value || 0 })} /></Campo>
            <Campo label="TE"><input type="number" step={1} value={+tar.te.toFixed(2)} onChange={(e) => setTar({ te: +e.target.value || 0 })} /></Campo>
            <Campo label="TUSD C"><input type="number" step={0.1} value={+tar.tusdC.toFixed(2)} onChange={(e) => setTar({ tusdC: +e.target.value || 0 })} /></Campo>
            <Campo label="TUSD G"><input type="number" step={0.1} value={+tar.tusdG.toFixed(2)} onChange={(e) => setTar({ tusdG: +e.target.value || 0 })} /></Campo>
            <Campo label="PIS/COFINS (%)"><input type="number" step={0.1} value={+(tar.pisCofins * 100).toFixed(2)} onChange={(e) => setTar({ pisCofins: (+e.target.value || 0) / 100 })} /></Campo>
            <Campo label="ICMS (%)"><input type="number" step={0.1} value={+(tar.icms * 100).toFixed(2)} onChange={(e) => setTar({ icms: (+e.target.value || 0) / 100 })} /></Campo>
          </section>

          <section className="cbloco">
            <h5>Commercial</h5>
            <Campo label="Status">
              <select value={com?.status ?? ''} onChange={(e) => setCom({ status: e.target.value })}>
                <option value="">—</option><option value="Quente">Hot</option><option value="Frio">Cold</option>
              </select>
            </Campo>
            <Campo label="Pipeline status"><input value={com?.pipelineStatus ?? ''} onChange={(e) => setCom({ pipelineStatus: e.target.value })} /></Campo>
            <Campo label="Offtaker (original)"><input value={com?.offtakerOriginal ?? ''} onChange={(e) => setCom({ offtakerOriginal: e.target.value })} /></Campo>
            <Campo label="Offtaker (new)"><input value={com?.novoOfftaker ?? ''} onChange={(e) => setCom({ novoOfftaker: e.target.value })} /></Campo>
            <Campo label="Contract term"><input value={com?.prazoContrato ?? ''} placeholder="Until 2045" onChange={(e) => setCom({ prazoContrato: e.target.value })} /></Campo>
            {(() => {
              const f = fimContrato(com ?? { prazoContrato: '', signingDate: '', inicioCompensacao: '' });
              const rot = f.tipo === 'explícito' ? 'exact' : f.tipo === 'estimada' ? 'estimated' : 'no date';
              return (
                <Campo label="Contract end (derived)">
                  <div className="derivado" title={`${f.detalhe} · basis: "Contract term" column of the Commercial tab. Estimated = Compensation start + N years (confirm milestone with the team).`}>
                    <b>{f.fim ? new Date(f.fim + 'T00:00:00').toLocaleDateString('pt-BR') : '—'}</b>
                    <span className={`fimtag ${f.tipo}`}>{rot}</span>
                  </div>
                </Campo>
              );
            })()}
            <Campo label="Take or Pay (%)"><input type="number" step={1} value={+((com?.takeOrPay ?? 0) * 100).toFixed(0)} onChange={(e) => setCom({ takeOrPay: (+e.target.value || 0) / 100 })} /></Campo>
            <Campo label="Ramp up"><input value={com?.rampUp ?? ''} placeholder="3 months" onChange={(e) => setCom({ rampUp: e.target.value })} /></Campo>{/* Take or Pay label already English */}
          </section>

          <section className="cbloco">
            <h5>Dates</h5>
            <Campo label="Energization"><input type="date" value={contrato.energizacao ?? ''} onChange={(e) => set({ energizacao: e.target.value })} /></Campo>
            <Campo label="COD (COD tab)"><input type="date" value={contrato.cod ?? ''} onChange={(e) => set({ cod: e.target.value })} /></Campo>
            <Campo label={`COD (commercial)${com?.codDate && contrato.cod && com.codDate.slice(0, 10) !== contrato.cod.slice(0, 10) ? ' ⚠ mismatch' : ''}`}>
              <input type="date" value={com?.codDate ?? ''} onChange={(e) => setCom({ codDate: e.target.value })} />
            </Campo>
            <Campo label="1st Invoicing"><input type="date" value={contrato.faturamento ?? ''} onChange={(e) => set({ faturamento: e.target.value })} /></Campo>
            <Campo label="Signing date"><input type="date" value={com?.signingDate ?? ''} onChange={(e) => setCom({ signingDate: e.target.value })} /></Campo>
            <Campo label="Change of ownership"><input type="date" value={com?.trocaTitularidade ?? ''} onChange={(e) => setCom({ trocaTitularidade: e.target.value })} /></Campo>
            <Campo label="Compensation start"><input type="date" value={com?.inicioCompensacao ?? ''} onChange={(e) => setCom({ inicioCompensacao: e.target.value })} /></Campo>
          </section>

          <section className="cbloco">
            <h5>Energy chain</h5>
            <Campo label="Operational Perf. (%) — 1−Σlosses">
              <input type="number" step={1} value={+(perfOperMostrado * 100).toFixed(1)} onChange={(e) => set({ perfOperOverride: (+e.target.value || 0) / 100 })} />
            </Campo>
            <Campo label={contrato.rampaAuto ? 'Compensation Perf. (%) — auto ramp' : 'Compensation Perf. (%) — MeterHub'}>
              <input type="number" step={1} disabled={!!contrato.rampaAuto} value={+(perfCompMostrado * 100).toFixed(1)} onChange={(e) => set({ perfCompOverride: (+e.target.value || 0) / 100 })} />
            </Campo>
            {temOverride && (
              <button className="reset-link" onClick={() => set({ perfOperOverride: undefined, perfCompOverride: undefined })}>↺ back to monthly Forecast values</button>
            )}
            <div className="energia-chain">
              <span className="ec-step"><b>{mwh(efet.p50)}</b><small>P50</small></span>
              <span className="ec-op">×{(perfOperMostrado * 100).toFixed(0)}%</span>
              <span className="ec-op">×{(perfCompMostrado * 100).toFixed(0)}%</span>
              <span className="ec-step accent"><b>{mwh(efet.energiaFinal)}</b><small>Final Energy</small></span>
            </div>
          </section>

          {contrato.rampa && contrato.rampa.length > 0 && (
            <section className="cbloco">
              <h5>Ramp & Take-or-Pay <small>(on injection, contract-specific)</small></h5>
              <p className="hint" style={{ marginTop: 0 }}>
                ✓ <b>Already filled from the Commercial tab</b> (row 37+) — curve of offtaker <b>{com?.novoOfftaker || '—'}</b>. month 1 = <b>Compensation Start</b> ({com?.inicioCompensacao || '—'}).
                The ramp applies to <b>injection</b> (not compensation). <b>Only edit</b> if this contract has a different ramp (it is contract-specific).
              </p>
              <div className="rampa-bars">
                {contrato.rampa.map((f, i) => (
                  <div className="rampa-col" key={i} title={`Month ${i + 1}: ${(f * 100).toFixed(0)}%`}>
                    <div className="rampa-fill" style={{ height: `${Math.max(2, f * 100)}%` }} />
                    <span className="rampa-m">{i + 1}</span>
                  </div>
                ))}
              </div>
              <Campo label="Take-or-pay mode">
                <select value={contrato.topModo ?? 'off'} onChange={(e) => set({ topModo: e.target.value === 'off' ? undefined : (e.target.value as 'substitui' | 'max') })}>
                  <option value="off">off (energy = compensation)</option>
                  <option value="substitui">replace — during the ramp, energy = ramp% × injection</option>
                  <option value="max">max — energy = max(compensation, ramp% × injection)</option>
                </select>
              </Campo>
              <p className="hint" style={{ margin: '2px 0 6px' }}>
                Injection is <b>manual</b> (Shared Generation): fill in each month's injected MWh from the <b>utility invoice</b> received by the client. Blank = uses P50 × perfOper as an estimate.
              </p>
              <table className="rampa-t">
                <thead><tr><th>Month</th><th className="r">Ramp %</th><th className="r">Injection MWh <small>(invoice)</small></th><th className="r">Billable</th></tr></thead>
                <tbody>
                  {contrato.rampa.map((f, i) => {
                    const mesCal = addMeses(com?.inicioCompensacao, i); // yyyy-mm
                    const injMan = mesCal ? contrato.injecaoTop?.[mesCal] : undefined;
                    const injEstim = resumo.meses.find((m) => m.mes.slice(0, 7) === mesCal)?.injecao ?? 0;
                    const injUsada = injMan ?? injEstim;
                    const faturavel = f * injUsada;
                    return (
                      <tr key={i}>
                        <td>{mesCal ? mmYY(mesCal) : `month ${i + 1}`}</td>
                        <td className="r">
                          <input className="rampa-in" type="number" step={5} min={0} max={100} value={+(f * 100).toFixed(0)}
                            onChange={(e) => { const nova = [...contrato.rampa!]; nova[i] = Math.max(0, Math.min(100, +e.target.value || 0)) / 100; set({ rampa: nova }); }} />
                        </td>
                        <td className="r">
                          <input className="rampa-in" type="number" step={1} min={0} placeholder={injEstim ? injEstim.toFixed(0) : '—'}
                            value={injMan ?? ''}
                            onChange={(e) => {
                              if (!mesCal) return;
                              const next = { ...(contrato.injecaoTop ?? {}) };
                              if (e.target.value === '') delete next[mesCal]; else next[mesCal] = +e.target.value || 0;
                              set({ injecaoTop: next });
                            }} />
                        </td>
                        <td className="r muted">{f < 1 && contrato.topModo ? `${faturavel.toFixed(0)} MWh` : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="rampa-actions">
                <button className="rampa-add" onClick={() => set({ rampa: [...contrato.rampa!, 1] })}>+ month</button>
                {contrato.rampa.length > 1 && <button className="rampa-add" onClick={() => set({ rampa: contrato.rampa!.slice(0, -1) })}>− month</button>}
                <span className="hint" style={{ margin: 0 }}>{contrato.rampa.length} months to 100% · "Billable" column = ramp% × injection (only in ramp months, with take-or-pay on)</span>
              </div>
            </section>
          )}

          <section className="cbloco">
            <h5>Cost split <small>(1 line = residual)</small></h5>
            <div className="cost-lines">
              <div className="cost-head"><span>Line</span><span>Mode</span><span>Fixed value</span></div>
              {LINHAS.map((l) => {
                const linha = contrato[l.key];
                return (
                  <div className="cost-row" key={l.key}>
                    <span className="cost-name"><i style={{ background: l.cor }} />{l.label}</span>
                    <select value={linha.modo} onChange={(e) => setLinha(l.key, { modo: e.target.value as ModoCusto })}>
                      <option value="fixo">fixed</option><option value="residual">residual</option><option value="zero">zero</option>
                    </select>
                    <input type="number" disabled={linha.modo !== 'fixo'} value={linha.modo === 'fixo' ? Math.round(linha.valorFixo) : ''} onChange={(e) => setLinha(l.key, { valorFixo: +e.target.value || 0 })} />
                  </div>
                );
              })}
            </div>
            {!temResidual && <p className="hint warn-text">⚠ Set one line as "residual".</p>}
          </section>

          <section className="cbloco">
            <h5>Risks</h5>
            <textarea className="riscos-input" value={com?.riscos ?? ''} placeholder="Contract risks…" onChange={(e) => setCom({ riscos: e.target.value })} />
          </section>

          <section className="cbloco">
            <h5>Notes (COD)</h5>
            <textarea className="riscos-input" value={contrato.observacoes ?? ''} placeholder="Operational notes…" onChange={(e) => set({ observacoes: e.target.value })} />
          </section>
        </div>

        {/* ==== DIREITA: resultado ==== */}
        <div className="cpanel-result">
          <h4>Revenue allocation (year)</h4>
          <div className="alloc-bar">
            {LINHAS.map((l) => {
              const v = resumo[l.key];
              const pct = resumo.receitaTotal ? (v / resumo.receitaTotal) * 100 : 0;
              if (pct <= 0) return null;
              return <span key={l.key} style={{ width: `${pct}%`, background: l.cor }} title={`${l.label}: ${pct.toFixed(1)}%`} />;
            })}
          </div>
          <table className="alloc-table">
            <tbody>
              {LINHAS.map((l) => {
                const v = resumo[l.key];
                const pct = resumo.receitaTotal ? (v / resumo.receitaTotal) * 100 : 0;
                return (
                  <tr key={l.key}>
                    <td><i className="dot" style={{ background: l.cor }} />{l.label}</td>
                    <td className="r">{brl(v)}</td>
                    <td className="r muted">{pct.toFixed(1)}%</td>
                  </tr>
                );
              })}
              <tr className="total"><td>Total Revenue</td><td className="r">{brl(resumo.receitaTotal)}</td><td className="r muted">100%</td></tr>
            </tbody>
          </table>
          <div className="recon">
            <span>vs official Forecast ({brl(receitaForecastAno)})</span>
            <b className={Math.abs(difForecast) < Math.max(1, Math.abs(receitaForecastAno)) * 0.005 ? 'ok-text' : 'warn-text'}>{difForecast >= 0 ? '+' : ''}{brl(difForecast)}</b>
          </div>
          <div className="recon">
            <span>vs Budget ({brl(budgetAno)})</span>
            <b className={difBudget >= 0 ? 'ok-text' : 'warn-text'}>{difBudget >= 0 ? '+' : ''}{brl(difBudget)}</b>
          </div>

          {receitaForecastAno !== 0 && Math.abs(difForecast) > Math.max(1, Math.abs(receitaForecastAno) * 0.005) && (() => {
            const baseEng = resumo.meses.find((m) => m.base != null)?.base ?? 0;
            const baseXls = contrato.baseExcelMwh ?? 0;
            const demXls = contrato.demandaExcelAno ?? 0;
            const dBase = (baseEng - baseXls) * energiaFinalAno;
            const dDem = -(demandaAno - demXls); // motor cobra mais demanda ⇒ receita menor
            const resid = difForecast - dBase - dDem;
            const linha = (lbl: string, eng: string, xls: string, impacto: number) => (
              <tr><td>{lbl}</td><td className="r">{eng}</td><td className="r">{xls}</td><td className={`r ${Math.abs(impacto) < 1 ? 'muted' : impacto >= 0 ? 'ok-text' : 'warn-text'}`}>{Math.abs(impacto) < 1 ? '—' : `${impacto >= 0 ? '+' : ''}${brl(impacto)}`}</td></tr>
            );
            return (
              <div className="diverge">
                <div className="diverge-h">Why does it diverge from the Forecast? <span className="muted">— engine vs Excel</span></div>
                <table className="diverge-t"><tbody>
                  <tr className="diverge-head"><td>component</td><td className="r">engine</td><td className="r">Excel</td><td className="r">impact</td></tr>
                  {linha('Calculation Base (R$/MWh)', baseEng.toFixed(0), baseXls ? baseXls.toFixed(0) : '—', dBase)}
                  {linha('PV Demand (year)', brl(demandaAno), demXls ? brl(demXls) : '—', dDem)}
                  <tr className="diverge-resid"><td>Manual adjustment / cap in Excel</td><td /><td /><td className={`r ${Math.abs(resid) < 1 ? 'muted' : resid >= 0 ? 'ok-text' : 'warn-text'}`}>{Math.abs(resid) < 1 ? '—' : `${resid >= 0 ? '+' : ''}${brl(resid)}`}</td></tr>
                </tbody></table>
                <p className="diverge-nota">Summing the impacts = the total difference. "Manual adjustment/cap" = overrides that Excel has and the (canonical) engine does not replicate.</p>
              </div>
            );
          })()}

          <h4 style={{ marginTop: 18 }}>Indicators (calculated)</h4>
          <table className="alloc-table">
            <tbody>
              <tr><td>GD Tariff</td><td className="r">{tarifaGD.toFixed(2)} R$/MWh</td></tr>
              <tr><td>PV Demand (year)</td><td className="r">{brl(demandaAno)}</td></tr>
              <tr><td>Captive Cost (ref.)</td><td className="r">{brl(custoCativo)}</td></tr>
              <tr><td>Final Energy (year)</td><td className="r">{mwh(energiaFinalAno)}</td></tr>
            </tbody>
          </table>

          <ReceitaMensalUsina meses={resumo.meses} />
        </div>
      </div>
    </div>
  );
}

function Campo({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="campo">
      <span className="campo-label">{label}</span>
      {children}
    </label>
  );
}
