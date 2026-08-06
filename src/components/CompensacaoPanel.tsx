import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useForecastStore } from '../store/forecastStore';
import { secureText } from '../secure';
import { tipoDeCliente, REGRAS_CLIENTE } from '../engine/clientes';
import { fmtMes } from '../lib/date';
import { DATA_INFO, ehParcial, carimboMeterHub } from '../lib/dataInfo';

/** normaliza nome de usina p/ casar Compensação (Base MeterHub) × Receita (Forecast). */
const ROM: Record<string, string> = { i: '1', ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10' };
const normU = (s: string): string => {
  let t = (s || '').normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  t = t.replace(/\([^)]*\)/g, '').replace(/,.*/, '').replace(/-/g, ' ');
  t = t.split(/\s+/).map((w) => ROM[w] ?? w).join('');
  t = t.replace(/0+(\d)/g, '$1');
  return t.replace(/[^a-z0-9]/g, '');
};

type CompSortKey = 'usina' | 'cliente' | 'ucs' | 'consumo' | 'compensado' | 'injecao' | 'aproveit' | 'saldo' | 'otim';
const COMP_TEXT_KEYS = new Set<CompSortKey>(['usina', 'cliente']);

interface UC { uc: string; dist: string; rateio: number; consumo: number; compensado: number; injetado: number; saldo: number }
interface MesData { nUCs: number; consumo: number; compensado: number; injecao: number; perfComp: number | null; aproveit: number | null; rateioPct?: number; ucs: UC[] }
interface UsinaComp { usina: string; meses: Record<string, MesData> }
interface SerieMes { mes: string; injetado: number; compensado: number; saldo: number; perfMes: number | null; perfMovel: number | null }
interface Exemplo { usina: string; serie: SerieMes[] }
interface UCSerieMes { mes: string; comp: number; cons: number; saldo: number }
interface InjExcel { excelNome: string; serie: Record<string, { injetadoMWh: number | null; pvsystMWh: number | null }> }
interface UCSerie { uc: string; serie: UCSerieMes[]; aproveitAno: number | null }
interface RateioUC { uc: string; rateio: number; rateioSug: number; delta: number; cons: number; saldo: number; status: string }
interface RateioScore { score: number; excesso: number; deficit: number; aproveit: number; bancoMeses: number; nUC: number; ucs: RateioUC[] }

/** UC geradora = a INJEÇÃO domina (medidor da usina). Não basta injeção > 0:
 *  UCs consumidoras têm leituras mínimas de energia reversa (dezenas de kWh) que
 *  NÃO as tornam geradoras. Exige injeção relevante E maior que o consumo. */
const ehGeradora = (u: UC) => (u.injetado ?? 0) > 5000 && (u.injetado ?? 0) > u.consumo;
/** Compensação IMPOSSÍVEL: compensado muito acima do consumo E da injeção — ex. o glitch
 *  da fatura Ambar (876.447 kWh sem o banco cair). Não é energia real compensada. */
const ehGlitchUC = (u: UC) => u.compensado > Math.max(u.consumo, u.injetado ?? 0, 1) * 1.5;
/** Compensação da usina = Σ das UCs CONSUMIDORAS não-glitch (exclui a geradora e outliers). */
function aggLimpo(ucs: UC[]) {
  let consumo = 0, compensado = 0, saldo = 0, excl = 0, exclComp = 0;
  for (const u of ucs) {
    if (ehGeradora(u) || ehGlitchUC(u)) { excl += 1; exclComp += u.compensado; continue; }
    consumo += u.consumo;
    compensado += u.compensado;
    saldo += u.saldo ?? 0;
  }
  return { consumo, compensado, saldo, aproveit: consumo > 0 ? compensado / consumo : 0, excl, exclComp };
}

/** Sparkline compacto (tendência 12 meses) — verde se subindo, âmbar se caindo. */
function Sparkline({ values }: { values: number[] }) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 2) return <span className="muted">—</span>;
  const W = 74, H = 20, pad = 2;
  const max = Math.max(...v), min = Math.min(...v, 0);
  const x = (i: number) => pad + (i * (W - 2 * pad)) / (v.length - 1);
  const y = (val: number) => H - pad - ((val - min) / (max - min || 1)) * (H - 2 * pad);
  const pts = v.map((val, i) => `${x(i)},${y(val)}`).join(' ');
  const up = v[v.length - 1] >= v[v.length - 2];
  const cor = up ? '#4d6b1f' : '#c98a1a';
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true">
      <polyline points={pts} fill="none" stroke={cor} strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx={x(v.length - 1)} cy={y(v[v.length - 1])} r="2.2" fill={cor} />
    </svg>
  );
}

/** mini-gráfico por UC: compensado (barras) + saldo do banco (linha). */
function UCMiniChart({ serie, inj }: { serie: UCSerieMes[]; inj?: number[] }) {
  const W = 660, H = 138, pad = 40;
  // energia (kWh) — eixo DIREITO: compensado (barra), consumo e injeção (linhas)
  const maxE = Math.max(...serie.map((s) => Math.max(s.comp, s.cons)), ...(inj ?? [0]), 1);
  // saldo do banco (kWh) — eixo ESQUERDO (escala própria, bem maior)
  const maxS = Math.max(...serie.map((s) => s.saldo), 1);
  const bw = (W - 2 * pad) / serie.length;
  const x = (i: number) => pad + i * bw + bw / 2;
  const yE = (v: number) => H - pad - (v / maxE) * (H - 2 * pad); // energia (kWh)
  const ys = (v: number) => H - pad - (v / maxS) * (H - 2 * pad); // saldo (kWh)
  const fk = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : String(Math.round(v)));
  const lineS = serie.map((s, i) => `${x(i)},${ys(s.saldo)}`).join(' ');
  const lineCons = serie.map((s, i) => `${x(i)},${yE(s.cons)}`).join(' ');
  const lineInj = inj ? serie.map((_s, i) => `${x(i)},${yE(inj[i] ?? 0)}`).join(' ') : '';
  return (
    <>
    <div className="chart-legend">
      <span><i className="lg-bar" style={{ background: '#c6da38' }} /> offset <em>(kWh · right)</em></span>
      <span><i className="lg-line" style={{ background: '#7a4fa3' }} /> consumption <em>(kWh · right)</em></span>
      {inj && <span><i className="lg-line" style={{ background: '#c98a1a' }} /> injection <em>(kWh · right)</em></span>}
      <span><i className="lg-line" style={{ background: '#004b70' }} /> bank balance <em>(kWh · left)</em></span>
    </div>
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: 660, height: 'auto' }}>
      {/* eixo ESQUERDO — saldo do banco (kWh) */}
      {[0, 0.5, 1].map((t) => { const v = t * maxS; return (
        <g key={`ls${t}`}>
          <line x1={pad - 3} x2={pad} y1={ys(v)} y2={ys(v)} stroke="#c3d2db" />
          <text x={2} y={ys(v) + 3} fontSize="8.5" fill="#5c7c90">{fk(v)}</text>
        </g>
      ); })}
      <text x={2} y={pad - 8} fontSize="8" fill="#004b70" fontWeight={600}>← bank</text>
      {/* eixo DIREITO — energia do mês (kWh): compensado / consumo / injeção */}
      {[0, 1 / 3, 2 / 3, 1].map((t) => { const v = t * maxE; return (
        <g key={`re${t}`}>
          <line x1={W - pad} x2={W - pad + 3} y1={yE(v)} y2={yE(v)} stroke="#c6da38" />
          <text x={W - pad + 5} y={yE(v) + 3} fontSize="8.5" fill="#8ba32a">{fk(v)}</text>
        </g>
      ); })}
      <text x={W - pad + 3} y={pad - 8} fontSize="8" fill="#8ba32a" fontWeight={600}>kWh →</text>
      {serie.map((s, i) => {
        const h = (s.comp / maxE) * (H - 2 * pad);
        return <rect key={i} x={pad + i * bw + bw * 0.2} y={H - pad - h} width={bw * 0.6} height={h} fill="#c6da38" rx="1" />;
      })}
      {inj && <polyline points={lineInj} fill="none" stroke="#c98a1a" strokeWidth="1.6" strokeDasharray="4 2" />}
      <polyline points={lineCons} fill="none" stroke="#7a4fa3" strokeWidth="1.6" strokeDasharray="5 3" />
      <polyline points={lineS} fill="none" stroke="#004b70" strokeWidth="2" />
      {serie.map((s, i) => <circle key={i} cx={x(i)} cy={ys(s.saldo)} r="2" fill="#004b70" />)}
      {serie.map((s, i) => i % 2 === 0 && <text key={i} x={x(i)} y={H - 6} fontSize="8" fill="#8496a0" textAnchor="middle">{fmtMes(s.mes)}</text>)}
    </svg>
    </>
  );
}

function PerfCompChart({ ex, consumo, compensado }: { ex: Exemplo; consumo?: Record<string, number>; compensado?: Record<string, number> }) {
  const [sel, setSel] = useState<number | null>(null);
  const [ajuda, setAjuda] = useState(false);
  const [oculto, setOculto] = useState<Set<string>>(new Set());
  const vis = (k: string) => !oculto.has(k);
  const toggle = (k: string) => setOculto((prev) => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const W = 900, H = 210, pad = 34;
  const s = ex.serie.filter((m) => m.perfMovel != null);
  const maxY = 170;
  const x = (i: number) => pad + (i * (W - 2 * pad)) / (s.length - 1);
  const y = (v: number) => H - pad - (Math.min(v, maxY) / maxY) * (H - 2 * pad);
  const lineMovel = s.map((m, i) => `${x(i)},${y(m.perfMovel!)}`).join(' ');
  const ptsMes = s.map((m, i) => (m.perfMes != null ? `${x(i)},${y(m.perfMes)}` : null)).filter(Boolean).join(' ');
  const kwh = (v: number) => Math.round(v).toLocaleString('pt-BR');
  const consAt = (mes: string) => consumo?.[mes];
  // compensado LIMPO da API (comp_portfolio, mesma fonte do consumo) quando disponível; senão o bruto da série.
  const compVal = (m: SerieMes) => compensado?.[m.mes] ?? m.compensado;
  const maxKwh = Math.max(...s.map((m) => Math.max(m.injetado, compVal(m))), ...(consumo ? s.map((m) => consAt(m.mes) ?? 0) : []), 1);
  const yK = (v: number) => H - pad - (v / maxKwh) * (H - 2 * pad); // eixo kWh (injeção, compensado, consumo)
  const bw = ((W - 2 * pad) / Math.max(s.length - 1, 1)) * 0.5;
  const lineCons = consumo ? s.map((m, i) => (consAt(m.mes) != null ? `${x(i)},${yK(consAt(m.mes)!)}` : null)).filter(Boolean).join(' ') : '';
  const lineComp = s.map((m, i) => `${x(i)},${yK(compVal(m))}`).join(' ');
  const d = sel != null ? s[sel] : null;
  const LegItem = ({ k, cor, tipo, label, sub }: { k: string; cor: string; tipo: 'bar' | 'line' | 'dash' | 'dot'; label: string; sub: string }) => (
    <button className={`lg-item ${vis(k) ? '' : 'off'}`} onClick={() => toggle(k)} title="Show/hide">
      <i className={tipo === 'bar' ? '' : tipo === 'dot' ? 'lg-dot' : 'lg-line'}
         style={tipo === 'bar' ? { display: 'inline-block', width: 11, height: 11, background: cor, opacity: 0.6, borderRadius: 2, verticalAlign: 'middle' } : { background: cor }} />
      {' '}{label} <em>{sub}</em>
    </button>
  );
  return (
    <>
      <div className="chart-legend selectable">
        <LegItem k="inj" cor="#c6da38" tipo="bar" label="injection" sub="kWh · right axis →" />
        <LegItem k="comp" cor="#1f9e89" tipo="line" label="offset" sub="kWh · right axis →" />
        {consumo && <LegItem k="cons" cor="#7a4fa3" tipo="dash" label="consumption" sub="kWh · right axis →" />}
        <LegItem k="movel" cor="#004b70" tipo="line" label="perfComp rolling" sub="% · left axis ←" />
        <LegItem k="mes" cor="#9bb8c6" tipo="dot" label="perfComp monthly" sub="% · left axis ←" />
        <span className="lg-static"><i className="lg-dash" /> 100% <em>(above = drew from the bank)</em></span>
        <button className="ajuda-toggle" onClick={() => setAjuda((v) => !v)}>{ajuda ? '▾ hide' : '❔ monthly × rolling'}</button>
      </div>
      {ajuda && (
        <div className="ajuda-box" style={{ margin: '2px 0 10px' }}>
          <h4>perfComp monthly × perfComp rolling</h4>
          <p>
            Both measure the same thing — <b>how much of the injected energy became offset</b> (offset ÷ injection) — but over different windows.
          </p>
          <ul className="ajuda-list">
            <li>
              <b>perfComp monthly</b> = offset <b>for the month</b> ÷ injection <b>for the month</b>.
              <b>Swings a lot</b> (e.g. 30%→160%): a month's offset may come from <i>another</i> month's injection (credit bank), and a month with low/zero injection spikes the %. <b>Useful to see volatility</b>, not to decide.
            </li>
            <li>
              <b>perfComp rolling</b> = <b>Σ</b>offset ÷ <b>Σ</b>injection <b>cumulative</b> (12-month window).
              <b>Stable and reliable</b>: filters out the temporal mismatch and converges to the real long-term ratio. <b>It is the number that replaces the manual Billing input</b> in the forecast.
            </li>
          </ul>
          <p className="ajuda-caveat">
            Above <b>100%</b> = offset more than was injected in that period → <b>drew from the credit bank</b> (not an error). A sustained rolling value &gt; 100% indicates the bank is being consumed; &lt; 100% indicates the bank is accumulating.
          </p>
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }}>
        {[0, 50, 100, 150].map((g) => (
          <g key={g}>
            <line x1={pad} x2={W - pad} y1={y(g)} y2={y(g)} stroke="#e3e9ed" />
            <text x={4} y={y(g) + 4} fontSize="10" fill="#5c7c90">{g}%</text>
          </g>
        ))}
        {/* título do eixo ESQUERDO (%) — perfComp */}
        <text x={4} y={pad - 8} fontSize="9" fill="#004b70" fontWeight={600}>← % perfComp</text>{/* left axis title (%) — perfComp */}
        {/* barras de injeção (eixo kWh) — atrás das linhas */}
        {vis('inj') && s.map((m, i) => {
          const hInj = (m.injetado / maxKwh) * (H - 2 * pad);
          return <rect key={`inj${i}`} x={x(i) - bw / 2} y={H - pad - hInj} width={bw} height={hInj} fill="#c6da38" opacity={sel === i ? 0.55 : 0.28} rx="1.5" />;
        })}
        {/* compensado (linha, eixo kWh) */}
        {vis('comp') && <polyline points={lineComp} fill="none" stroke="#1f9e89" strokeWidth="2.4" />}
        {vis('comp') && s.map((m, i) => <circle key={`cp${i}`} cx={x(i)} cy={yK(compVal(m))} r={sel === i ? 4 : 2.5} fill="#1f9e89" />)}
        {/* consumo (linha, eixo kWh) */}
        {consumo && vis('cons') && <polyline points={lineCons} fill="none" stroke="#7a4fa3" strokeWidth="2" strokeDasharray="5 3" />}
        {consumo && vis('cons') && s.map((m, i) => (consAt(m.mes) != null ? <circle key={`c${i}`} cx={x(i)} cy={yK(consAt(m.mes)!)} r={sel === i ? 4 : 2.5} fill="#7a4fa3" /> : null))}
        {/* eixo DIREITO em kWh (injeção + compensado + consumo) — 5 marcas */}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const v = t * maxKwh;
          return (
            <g key={`rk${t}`}>
              <line x1={W - pad} x2={W - pad + 3} y1={yK(v)} y2={yK(v)} stroke="#c6da38" />
              <text x={W - pad + 6} y={yK(v) + 3} fontSize="9.5" fill="#8ba32a">{v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : Math.round(v)}</text>
            </g>
          );
        })}
        <text x={W - pad + 4} y={pad - 8} fontSize="9" fill="#8ba32a" fontWeight={600}>kWh →</text>
        <line x1={pad} x2={W - pad} y1={y(100)} y2={y(100)} stroke="#c98a1a" strokeDasharray="4 4" opacity="0.5" />
        {vis('mes') && <polyline points={ptsMes} fill="none" stroke="#9bb8c6" strokeWidth="2" />}
        {vis('movel') && <polyline points={lineMovel} fill="none" stroke="#004b70" strokeWidth="3.5" />}
        {s.map((m, i) => (
          <g key={i} style={{ cursor: 'pointer' }} onClick={() => setSel(sel === i ? null : i)}>
            {sel === i && <line x1={x(i)} x2={x(i)} y1={pad - 6} y2={H - pad} stroke="#004b70" strokeDasharray="3 3" opacity="0.4" />}
            {vis('mes') && m.perfMes != null && <circle cx={x(i)} cy={y(m.perfMes)} r={sel === i ? 5 : 3} fill="#6692a8" />}
            {vis('movel') && <circle cx={x(i)} cy={y(m.perfMovel!)} r={sel === i ? 5 : 3} fill="#004b70" />}
            <rect x={x(i) - 14} y={pad - 6} width={28} height={H - 2 * pad} fill="transparent" />
            <text x={x(i)} y={H - 8} fontSize="9" fill={sel === i ? '#004b70' : '#8496a0'} fontWeight={sel === i ? 700 : 400} textAnchor="middle">{fmtMes(m.mes)}</text>
          </g>
        ))}
      </svg>
      {d && (
        <div className="perfcomp-detalhe">
          <b>{fmtMes(d.mes)}</b>
          {consAt(d.mes) != null && <span>Consumption: <b>{kwh(consAt(d.mes)!)} kWh</b></span>}
          <span>Injected: <b>{kwh(d.injetado)} kWh</b></span>
          <span>Offset: <b>{kwh(compVal(d))} kWh</b></span>
          {consAt(d.mes) ? <span>Utiliz.: <b>{Math.round((compVal(d) / consAt(d.mes)!) * 100)}%</b></span> : null}
          <span>Bank balance: <b>{kwh(d.saldo)} kWh</b></span>
          <span>perfComp month: <b className="grey-t">{d.perfMes ?? '—'}%</b></span>
          <span>perfComp rolling: <b className="navy-t">{d.perfMovel}%</b></span>
        </div>
      )}
      {!d && <p className="foot" style={{ margin: '4px 0 0', textAlign: 'center' }}>click a month to see injected, offset and bank balance</p>}
    </>
  );
}

const n0 = (v: number | null | undefined) => (v == null ? '—' : Math.round(v).toLocaleString('pt-BR'));
const pctv = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`);
const mwh1 = (v: number | null | undefined) => (v == null ? '—' : `${v.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`);

/** Auditoria de injeção: Excel (aba Performance) × MeterHub (API), por mês, em MWh.
 *  A MeterHub vem em kWh (serie.injetado) → ÷1000. O Excel já é MWh. */
function InjecaoCompare({ eng, exc }: { eng: SerieMes[]; exc?: InjExcel }) {
  const meses = [...new Set([
    ...eng.map((s) => s.mes),
    ...(exc ? Object.keys(exc.serie) : []),
  ])].sort();
  const linhas = meses.map((m) => {
    const e = eng.find((s) => s.mes === m)?.injetado; // kWh
    const engMWh = e != null ? e / 1000 : null;
    const x = exc?.serie[m];
    const xl = x?.injetadoMWh ?? null;
    const pv = x?.pvsystMWh ?? null;
    const delta = engMWh != null && xl != null && xl !== 0 ? engMWh / xl - 1 : null;
    let status: 'bate' | 'diverge' | 'so-excel' | 'so-eng' = 'bate';
    if (engMWh == null && xl != null) status = 'so-excel';
    else if (engMWh != null && xl == null) status = 'so-eng';
    else if (delta != null && Math.abs(delta) > 0.02) status = 'diverge';
    return { m, engMWh, xl, pv, delta, status };
  });
  const comparaveis = linhas.filter((l) => l.delta != null);
  const maxDelta = comparaveis.length ? Math.max(...comparaveis.map((l) => Math.abs(l.delta!))) : null;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#004b70', marginBottom: 4 }}>
        Injection: Excel (Performance) × MeterHub (API) — MWh
        {maxDelta != null && (
          <span className={`inj-status ${maxDelta <= 0.02 ? 'ok' : 'warn'}`} style={{ marginLeft: 8 }}>
            {maxDelta <= 0.02 ? `✓ matches (max ${(maxDelta * 100).toFixed(1)}%)` : `⚠ diverges (max ${(maxDelta * 100).toFixed(1)}%)`}
          </span>
        )}
      </div>
      <table className="uc-table inj-table">
        <thead><tr><th>Month</th><th className="r">Excel</th><th className="r">MeterHub</th><th className="r">Δ</th><th className="r">PVsyst (expected)</th><th>Status</th></tr></thead>
        <tbody>
          {linhas.map((l) => (
            <tr key={l.m}>
              <td>{fmtMes(l.m)}</td>
              <td className="r">{mwh1(l.xl)}</td>
              <td className="r">{mwh1(l.engMWh)}</td>
              <td className={`r ${l.delta == null ? 'muted' : Math.abs(l.delta) <= 0.02 ? 'ok-text' : 'warn-text'}`}>
                {l.delta == null ? '—' : `${l.delta >= 0 ? '+' : ''}${(l.delta * 100).toFixed(1)}%`}
              </td>
              <td className="r muted">{mwh1(l.pv)}</td>
              <td>
                <span className={`comp-chip ${l.status === 'bate' ? 'ok' : l.status === 'diverge' ? 'nao' : 'ramp'}`}>
                  {l.status === 'bate' ? '✓ matches' : l.status === 'diverge' ? '⚠ diverges' : l.status === 'so-excel' ? 'Excel only' : 'MeterHub only'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint" style={{ marginTop: 4 }}>Excel (Performance tab) and MeterHub are the same measurement source — "matches" confirms the pull; "diverges/Excel only/MeterHub only" flags an unclosed month, an outdated spreadsheet or a mapping gap.</p>
    </div>
  );
}

export default function CompensacaoPanel({ irParaUsina, alvo }: { irParaUsina?: (usina: string) => void; alvo?: { usina: string; uc?: string } | null }) {
  const receitaUsinas = useForecastStore((s) => s.usinas);
  const [dados, setDados] = useState<UsinaComp[] | null>(null);
  const [exemplo, setExemplo] = useState<Exemplo | null>(null);
  const [ucsSerie, setUcsSerie] = useState<Map<string, UCSerie>>(new Map());
  const [perfUsinas, setPerfUsinas] = useState<Map<string, SerieMes[]>>(new Map());
  const [rateioScore, setRateioScore] = useState<Map<string, RateioScore>>(new Map());
  const [injExcel, setInjExcel] = useState<Map<string, InjExcel>>(new Map());
  const [mes, setMes] = useState<string>(DATA_INFO.MeterHub.fechadoAte);
  const [aberta, setAberta] = useState<string | null>(null);
  const [mesDet, setMesDet] = useState<string | null>(null); // mês selecionado no detalhe da usina aberta
  const [ucAberta, setUcAberta] = useState<string | null>(null);
  const [busca, setBusca] = useState('');
  const [ajudaTab, setAjudaTab] = useState(false);
  const [sort, setSort] = useState<{ key: CompSortKey; dir: 'asc' | 'desc' }>({ key: 'compensado', dir: 'desc' });
  const ordenar = (key: CompSortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: COMP_TEXT_KEYS.has(key) ? 'asc' : 'desc' }));

  // mapa: nome normalizado → { projeto (Receita), cliente }
  const clientePorUsina = useMemo(() => {
    const m = new Map<string, { projeto: string; cliente: string }>();
    for (const u of receitaUsinas) m.set(normU(u.projeto), { projeto: u.projeto, cliente: u.cliente });
    return m;
  }, [receitaUsinas]);
  // mapa manual p/ nomes que diferem demais entre as duas fontes
  const ALIAS_USINA: Record<string, string> = {
    'Buriti - OPERON': 'Buriti',
    'Peroba 2 (TELCO)': 'Peroba 2',
    'Peroba 3 (TELCO)': 'Peroba 3',
    'Guará 1': 'Guará I',
    'Guará 2': 'Guará II',
    'Bandeirante': 'Bandeirante 1',
  };
  const achaCliente = (usina: string) => clientePorUsina.get(normU(ALIAS_USINA[usina] ?? usina));
  // consumo/compensado LIMPOS por mês de uma usina (comp_portfolio) — p/ as tendências no gráfico
  const serieLimpaDe = (nome: string, campo: 'consumo' | 'compensado'): Record<string, number> | undefined => {
    const u = dados?.find((x) => x.usina === nome);
    if (!u) return undefined;
    const out: Record<string, number> = {};
    for (const [m, md] of Object.entries(u.meses)) out[m] = aggLimpo(md.ucs ?? [])[campo];
    return out;
  };

  useEffect(() => {
    try { setDados(JSON.parse(secureText('comp_portfolio.json'))); } catch { setDados([]); }
    try { setExemplo(JSON.parse(secureText('perfcomp_exemplo.json'))); } catch { setExemplo(null); }
    try {
      const d: { ucs: UCSerie[] } = JSON.parse(secureText('perfcomp_ucs.json'));
      setUcsSerie(new Map(d.ucs.map((u) => [u.uc, u])));
    } catch { /* ignore */ }
    try {
      const d: Record<string, { serie: SerieMes[] }> = JSON.parse(secureText('perfcomp_usinas.json'));
      setPerfUsinas(new Map(Object.entries(d).map(([k, v]) => [k, v.serie])));
    } catch { /* ignore */ }
    try {
      const d: Record<string, RateioScore> = JSON.parse(secureText('rateio_score.json'));
      setRateioScore(new Map(Object.entries(d)));
    } catch { /* ignore */ }
    try {
      const d: Record<string, InjExcel> = JSON.parse(secureText('injecao_excel.json'));
      setInjExcel(new Map(Object.entries(d)));
    } catch { /* ignore */ }
  }, []);

  // Vindo da aba Auditoria: filtra p/ a usina, abre-a e expande a UC alvo.
  useEffect(() => {
    if (!alvo?.usina) return;
    setBusca(alvo.usina);
    setAberta(alvo.usina);
    setMesDet(null);
    setUcAberta(alvo.uc ?? null);
  }, [alvo]);

  // Rola a UC aberta para o centro da lista (útil vinda da Auditoria, com 450+ UCs).
  const ucRowRef = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    if (ucAberta) ucRowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [ucAberta, aberta]);

  const meses = useMemo(() => {
    const s = new Set<string>();
    dados?.forEach((u) => Object.keys(u.meses).forEach((m) => s.add(m)));
    return [...s].sort();
  }, [dados]);

  const linhas = useMemo(() => {
    if (!dados) return [];
    const q = busca.trim().toLowerCase();
    const cli = (usina: string) => clientePorUsina.get(normU(ALIAS_USINA[usina] ?? usina))?.cliente ?? '';
    const val = (x: { usina: string; d: MesData }): number | string => {
      const lim = aggLimpo(x.d.ucs ?? []);
      switch (sort.key) {
        case 'usina': return x.usina.toLowerCase();
        case 'cliente': return cli(x.usina).toLowerCase();
        case 'ucs': return x.d.nUCs;
        case 'consumo': return lim.consumo;
        case 'compensado': return lim.compensado;
        case 'injecao': return (x.d.ucs ?? []).reduce((s, u) => s + (u.injetado ?? 0), 0);
        case 'aproveit': return lim.consumo ? lim.compensado / lim.consumo : 0;
        case 'saldo': return lim.saldo;
        case 'otim': return rateioScore.get(x.usina)?.score ?? -1;
      }
    };
    const dir = sort.dir === 'asc' ? 1 : -1;
    return dados
      .map((u) => ({ usina: u.usina, d: u.meses[mes], meses: u.meses }))
      .filter((x) => x.d && (!q || x.usina.toLowerCase().includes(q) || cli(x.usina).toLowerCase().includes(q)))
      .sort((a, b) => {
        const va = val(a), vb = val(b);
        return typeof va === 'string' ? dir * va.localeCompare(vb as string) : dir * (va - (vb as number));
      });
  }, [dados, mes, busca, sort, clientePorUsina, rateioScore]);

  if (!dados) return <div className="state">Loading…</div>;

  const totUC = linhas.reduce((s, x) => s + x.d.nUCs, 0);
  // totais LIMPOS: excluem UC geradora e meses-glitch (compensação impossível)
  const totComp = linhas.reduce((s, x) => s + aggLimpo(x.d.ucs ?? []).compensado, 0);
  const totCons = linhas.reduce((s, x) => s + aggLimpo(x.d.ucs ?? []).consumo, 0);

  return (
    <>
      <section className="kpis">
        <Kpi label="Plants" value={String(linhas.length)} sub="from the MeterHub Base" accent />
        <Kpi label="UCs mapped" value={n0(totUC)} sub={`in ${fmtMes(mes)}`} />
        <Kpi label="Offset (month)" value={`${n0(totComp / 1000)} MWh`} sub="energy offset" />
        <Kpi label="Average utilization" value={pctv(totCons ? totComp / totCons : null)} sub="offset ÷ consumption" />
      </section>

      {exemplo && (
        <div className="perfcomp-card">
          <div className="perfcomp-head">
            <div>
              <h4>perfComp computed the right way — {exemplo.usina}</h4>
              <p>Σ offset ÷ Σ injected, from the API (12 real months). The monthly value swings; the <b>rolling ratio</b> converges.</p>
            </div>
          </div>
          <PerfCompChart ex={exemplo} consumo={serieLimpaDe(exemplo.usina, 'consumo')} compensado={serieLimpaDe(exemplo.usina, 'compensado')} />
          <p className="foot" style={{ marginTop: 4 }}>
            Real, from the MeterHub API: injection from the generating UC + offset from 26 consuming UCs. The monthly value ranges from ~30% to ~160% (with months of 0 injection);
            the rolling value stabilizes at ~{exemplo.serie.at(-1)?.perfMovel}%. It is the number that replaces the manual Billing input.
          </p>
        </div>
      )}

      <div className="ok" style={{ marginBottom: 16, padding: '12px 16px', borderRadius: 12, border: '1px solid #cfe0ad', background: '#eaf3e0', color: '#3c5417', fontSize: 13.5 }}>
        <b>Real MeterHub data</b> (MeterHub Base): {dados.length} plants · allocation + consumption + offset per UC. <b>Utilization</b> = offset ÷ consumption (a solid metric). The <b>perfComp rolling</b> (above) uses generating-UC injection ÷ offset, over a 12-month window.
      </div>

      <div className="data-stamp" title="Provenance of the MeterHub data. Update in src/lib/dataInfo.ts when re-pulling.">
        📅 <b>MeterHub</b> · {carimboMeterHub()} &nbsp;·&nbsp; snapshot {fmtMes(DATA_INFO.MeterHub.snapshot)}. UC data comes from scanned invoices (1–2 month lag).
      </div>

      <div className="toolbar">
        <input className="search" placeholder="Search plant…" value={busca} onChange={(e) => setBusca(e.target.value)} />
        <div className="filtros" style={{ margin: 0 }}>
          <label>Month
            <select value={mes} onChange={(e) => setMes(e.target.value)}>
              {meses.map((m) => <option key={m} value={m}>{fmtMes(m)}{ehParcial(m) ? ' (partial)' : ''}</option>)}
            </select>
          </label>
          {ehParcial(mes) && <span className="parcial-tag" title="Month still closing — invoices not fully issued/scanned. Do not trust the total.">⚠ partial month</span>}
        </div>
        <button className="ajuda-toggle" onClick={() => setAjudaTab((v) => !v)}>{ajudaTab ? '▾ hide' : '❔ how to read this tab'}</button>
        <span className="count">{linhas.length} plants</span>
      </div>

      {ajudaTab && (
        <div className="ajuda-box">
          <h4>How to read this tab</h4>
          <p>
            Real offset measured by <b>MeterHub</b>, per plant and per UC. Each row is a plant; <b>click</b> to open the UCs, the
            perfComp chart and the month selector. <b>Click the headers</b> to sort. The totals are <b>clean</b> (Σ of the consuming
            UCs, without the generator or invoice glitches).
          </p>
          <ul className="ajuda-list">
            <li><b>Plant</b> — badge <span className="rateio-badge ok">allocation ✓</span> = ΣBV between 95–105% (complete allocation in MeterHub); <span className="rateio-badge inc">allocation N%</span> = incomplete (missing data).</li>
            <li><b>Client</b> — the ↗ link opens the contract. Chip <span className="metodo-chip modelo-AR" style={{ fontSize: 10 }}>AR</span> = Remote Self-Consumption (measured offset) · <span className="metodo-chip modelo-GC" style={{ fontSize: 10 }}>GC</span> = Shared Generation.</li>
            <li><b>UCs</b> — number of units. <b className="uc-excl">−N</b> = N UCs <b>excluded from the total</b> (generator and/or invoice glitch). <b className="uc-semrateio">N no allocation</b> = N UCs offset <b>with no declared allocation</b> (missing BV → investigate with MeterHub).</li>
            <li><b>Consumption / Offset</b> — <b>clean</b> values (kWh). The <b>✓</b> on the offset indicates a generator/glitch was excluded (hover to see the gross value).</li>
            <li><b>Offset 12m</b> — mini-chart (sparkline) of the <b>clean offset</b> trend over the 12 available months; each point is a month.</li>
            <li><b>Injection</b> — injection measured in MeterHub (value from the generator's <b>invoice</b>, not telemetry).</li>
            <li><b>Utilization</b> — offset ÷ consumption (≤100% is healthy; above suggests drawing from the bank or inflated data).</li>
            <li><b>Bank balance</b> — the plant's accumulated credits (Σ of the consuming UCs) in the month. Rises when it injects more than it offsets; falls when it offsets more than it injects.</li>
            <li><b>Alloc. optim.</b> — 0–100 score of <b>how well injection is allocated to consumption</b> (this is optimization — different from "allocation ✓", which is data completeness).</li>
          </ul>
          <p className="ajuda-caveat">
            ⚠ <b>Partial month</b>: still closing, invoices not fully scanned — do not trust the total. UC invoices have a <b>1–2 month lag</b>. When you expand a UC, the <b>❔ monthly × rolling</b> explains the perfComp chart.
          </p>
        </div>
      )}

      <div className="tablewrap">
        <table className="comp-t">
          <thead>
            <tr>
              <th className="chev-col"></th>
              <CompTh k="usina" sort={sort} on={ordenar}>Plant</CompTh>
              <CompTh k="cliente" sort={sort} on={ordenar}>Client</CompTh>
              <CompTh k="ucs" sort={sort} on={ordenar} r>UCs</CompTh>
              <CompTh k="consumo" sort={sort} on={ordenar} r>Consumption</CompTh>
              <CompTh k="compensado" sort={sort} on={ordenar} r>Offset</CompTh>
              <th className="r" title="Clean offset trend over the 12 available months — each point is a month">Offset 12m</th>
              <CompTh k="injecao" sort={sort} on={ordenar} r>Injection</CompTh>
              <CompTh k="aproveit" sort={sort} on={ordenar} r title="Offset ÷ Consumption (≤100%)">Utiliz.</CompTh>
              <CompTh k="saldo" sort={sort} on={ordenar} r title="Plant's credit bank balance (Σ of the consuming UCs), in the selected month">Bank balance</CompTh>
              <CompTh k="otim" sort={sort} on={ordenar} r title="Allocation optimization score: how well injection is allocated to consumption">Alloc. optim.</CompTh>
            </tr>
          </thead>
          <tbody>
            {linhas.map(({ usina, d, meses: mesesU }) => {
              const open = aberta === usina;
              const lim = aggLimpo(d.ucs ?? []); // compensação limpa (sem geradora nem glitch)
              // detalhe: mês escolhido para ESTA usina (default = mês global)
              const mesSel = (mesDet && mesesU[mesDet]) ? mesDet : mes;
              const dDet = mesesU[mesSel] ?? d;
              const mesesDisp = Object.keys(mesesU).sort();
              const limDet = aggLimpo(dDet.ucs ?? []);
              const serie12 = mesesDisp.map((m) => aggLimpo(mesesU[m].ucs ?? []).compensado); // tendência 12m (limpa)
              const semRateio = (d.ucs ?? []).filter((u) => (u.rateio ?? 0) === 0 && u.compensado > 0 && !ehGeradora(u)).length;
              // rateio + injeção mês a mês por UC (comp_portfolio) — usado no detalhe da UC
              const rateioUcMes = open ? (() => {
                const mp = new Map<string, Map<string, { rateio: number | null; inj: number }>>();
                for (const [mm, md] of Object.entries(mesesU)) {
                  for (const u of md.ucs ?? []) {
                    let g = mp.get(u.uc);
                    if (!g) { g = new Map(); mp.set(u.uc, g); }
                    g.set(mm, { rateio: u.rateio ?? null, inj: u.injetado ?? 0 });
                  }
                }
                return mp;
              })() : null;
              // injeção TOTAL da usina por mês (Σ das UCs) — base do rateio → créditos alocados
              const injPlantaMes = open ? (() => {
                const mp = new Map<string, number>();
                for (const [mm, md] of Object.entries(mesesU)) mp.set(mm, (md.ucs ?? []).reduce((sm, u) => sm + (u.injetado ?? 0), 0));
                return mp;
              })() : null;
              return (
                <Fragment key={usina}>
                  <tr className={`clickable ${open ? 'open' : ''}`} onClick={() => { setAberta(open ? null : usina); setMesDet(null); }}>
                    <td className="chev-col">{open ? '▾' : '▸'}</td>
                    <td className="strong">
                      {usina}
                      {d.rateioPct != null && (
                        d.rateioPct >= 0.95 && d.rateioPct <= 1.05
                          ? <span className="rateio-badge ok" title={`complete allocation (ΣBV ${(d.rateioPct * 100).toFixed(0)}%)`}>allocation ✓</span>
                          : <span className="rateio-badge inc" title="incomplete allocation in MeterHub — use the Metering Model">allocation {(d.rateioPct * 100).toFixed(0)}%</span>
                      )}
                    </td>
                    <td>
                      {(() => {
                        const c = achaCliente(usina);
                        if (!c) return <span className="muted">—</span>;
                        const modelo = REGRAS_CLIENTE[tipoDeCliente(c.cliente)].modelo;
                        return (
                          <>
                            <a className="cliente-link" onClick={(e) => { e.stopPropagation(); irParaUsina?.(c.projeto); }}>
                              {c.cliente || 'view contract'} ↗
                            </a>
                            <span className={`metodo-chip modelo-${modelo}`} style={{ marginLeft: 6, fontSize: 10 }} title={modelo === 'AR' ? 'Remote Self-Consumption — measured offset (Invoices/API)' : 'Shared Generation — offset by contract'}>
                              {modelo}
                            </span>
                          </>
                        );
                      })()}
                    </td>
                    <td className="r muted">
                      {d.nUCs}
                      {lim.excl > 0 && <span className="uc-excl" title={`${lim.excl} UC(s) outside the total — generator and/or months with impossible offset (invoice glitch). Excluded: ${n0(lim.exclComp)} kWh of 'offset'.`}> −{lim.excl}</span>}
                      {semRateio > 0 && <span className="uc-semrateio" title={`${semRateio} UC(s) offset with no declared allocation — investigate with MeterHub (missing BV).`}> {semRateio} no allocation</span>}
                    </td>
                    <td className="r muted">{n0(lim.consumo)}</td>
                    <td className="r strong" title={lim.excl > 0 ? `CLEAN offset (Σ consuming UCs). Gross at source: ${n0(d.compensado)} kWh — inflated by generator/glitch.` : ''}>{n0(lim.compensado)}{lim.excl > 0 ? ' ✓' : ''}</td>
                    <td className="r"><Sparkline values={serie12} /></td>
                    <td className="r muted">{(() => {
                      if (d.injecao > 0) return n0(d.injecao);
                      const s = perfUsinas.get(usina)?.find((x) => x.mes === mes);
                      return s?.injetado ? n0(s.injetado) : '—';
                    })()}</td>
                    <td className="r">
                      <span className={`comp-chip ${lim.aproveit >= 0.9 ? 'ok' : lim.aproveit >= 0.6 ? 'ramp' : 'nao'}`}>{pctv(lim.aproveit)}</span>
                    </td>
                    <td className="r muted" title="Credit bank balance (Σ consuming UCs) in the month">{n0(lim.saldo)}</td>
                    <td className="r">
                      {rateioScore.has(usina)
                        ? (() => { const sc = rateioScore.get(usina)!.score; return <span className={`score-badge ${sc >= 90 ? 'ok' : sc >= 75 ? 'mid' : 'low'}`} title="Allocation OPTIMIZATION score (0–100): how well injection is allocated to consumption. Different from 'allocation ✓' (data completeness).">{sc}%</span>; })()
                        : <span className="muted">—</span>}
                    </td>
                  </tr>
                  {open && (
                    <tr className="panel-row">
                      <td colSpan={11}>
                        <div className="uc-detail">
                          {perfUsinas.has(usina) && (
                            <div style={{ marginBottom: 14 }}>
                              <div style={{ fontSize: 13, fontWeight: 600, color: '#004b70', marginBottom: 4 }}>perfComp rolling (API, {perfUsinas.get(usina)!.length} {perfUsinas.get(usina)!.length === 1 ? 'month' : 'months'}) — <span style={{ color: '#6692a8' }}>monthly</span> · <span style={{ color: '#004b70' }}>rolling</span></div>
                              <PerfCompChart ex={{ usina, serie: perfUsinas.get(usina)! }} consumo={Object.fromEntries(mesesDisp.map((m) => [m, aggLimpo(mesesU[m].ucs ?? []).consumo]))} compensado={Object.fromEntries(mesesDisp.map((m) => [m, aggLimpo(mesesU[m].ucs ?? []).compensado]))} />
                            </div>
                          )}
                          {perfUsinas.has(usina) && (
                            <InjecaoCompare eng={perfUsinas.get(usina)!} exc={injExcel.get(usina)} />
                          )}
                          {rateioScore.has(usina) && (() => {
                            const rs = rateioScore.get(usina)!;
                            return (
                              <div className="rateio-otim">
                                <div className="rateio-otim-h">Allocation Optimization — <b className={`score-t ${rs.score >= 90 ? 'ok' : rs.score >= 75 ? 'mid' : 'low'}`}>score {rs.score}%</b></div>
                                <div className="rateio-kpis">
                                  <span>Excess → bank<b>{n0(rs.excesso)} kWh</b></span>
                                  <span>Deficit (under-served)<b>{n0(rs.deficit)} kWh</b></span>
                                  <span>Utilization<b>{rs.aproveit}%</b></span>
                                  <span>Accumulated bank<b>{rs.bancoMeses} months</b></span>
                                </div>
                                <div className="rateio-otim-sub">UCs to rebalance — largest deviation (current allocation → suggested = proportional to consumption):</div>
                                <table className="uc-table">
                                  <thead><tr><th>UC</th><th className="r">Consumption</th><th className="r">Credit bal.</th><th className="r">Current allocation</th><th className="r">Suggested</th><th className="r">Δ</th><th>Status</th></tr></thead>
                                  <tbody>
                                    {rs.ucs.slice(0, 10).map((u) => (
                                      <tr key={u.uc}>
                                        <td className="mono">{u.uc}</td>
                                        <td className="r">{n0(u.cons)}</td>
                                        <td className="r muted">{n0(u.saldo)}</td>
                                        <td className="r">{(u.rateio * 100).toFixed(2)}%</td>
                                        <td className="r strong">{(u.rateioSug * 100).toFixed(2)}%</td>
                                        <td className={`r ${u.delta >= 0 ? 'ok-text' : 'warn-text'}`}>{u.delta >= 0 ? '+' : ''}{(u.delta * 100).toFixed(2)}pp</td>
                                        <td><span className={`comp-chip ${u.status === 'excesso' ? 'nao' : u.status === 'deficit' ? 'ramp' : 'ok'}`}>{u.status === 'excesso' ? '↓ reduce' : u.status === 'deficit' ? '↑ increase' : 'ok'}</span></td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            );
                          })()}
                          <div className="uc-detail-head">
                            <span>{dDet.nUCs} UCs · {usina}</span>
                            <label className="uc-mes-sel" onClick={(e) => e.stopPropagation()}>
                              Month:&nbsp;
                              <select value={mesSel} onChange={(e) => setMesDet(e.target.value)}>
                                {mesesDisp.map((m) => <option key={m} value={m}>{fmtMes(m)}{ehParcial(m) ? ' (partial)' : ''}</option>)}
                              </select>
                            </label>
                          </div>
                          <div className="uc-tablewrap">
                            <table className="uc-table">
                              <thead>
                                <tr><th>UC</th><th>Utility</th><th className="r">Allocation</th><th className="r">Consumption</th><th className="r" title="Injection measured in MeterHub (kWh) — the generator's meter injects; consuming UCs stay ~0">Injection</th><th className="r">Offset</th><th className="r">Credit bal.</th></tr>
                              </thead>
                              <tbody>
                                {[...dDet.ucs].sort((a, b) => b.compensado - a.compensado).map((uc, i) => {
                                  // a API guarda a UC SEM o dígito verificador (ex. "0419143-9" → "0419143")
                                  const serie = ucsSerie.get(uc.uc) ?? ucsSerie.get(uc.uc.split('-')[0]);
                                  const ucOpen = ucAberta === uc.uc;
                                  const geradora = ehGeradora(uc); // UC com injeção = medidor da usina, não consumidora
                                  const glitch = !geradora && ehGlitchUC(uc); // compensação impossível (glitch de fatura)
                                  const fora = geradora || glitch; // fora do total da usina
                                  return (
                                    <Fragment key={uc.uc + i}>
                                      <tr ref={ucOpen ? ucRowRef : null} className={`${serie ? 'clickable' : ''} ${fora ? 'uc-geradora' : ''} ${ucOpen ? 'uc-alvo' : ''}`} onClick={serie ? () => setUcAberta(ucOpen ? null : uc.uc) : undefined}>
                                        <td className="mono">{serie ? (ucOpen ? '▾ ' : '▸ ') : ''}{uc.uc}
                                          {geradora && <span className="uc-flag ger" title={`GENERATOR meter (injects ${n0(uc.injetado)} kWh) — not a consuming UC. Outside the plant total.`}>⚡ generator</span>}
                                          {glitch && <span className="uc-flag ger" title="Impossible offset (well above consumption and injection) — utility invoice glitch. Outside the total.">⚠ glitch</span>}
                                        </td>
                                        <td className="muted">{uc.dist || '—'}</td>
                                        <td className="r">{uc.rateio != null ? `${(uc.rateio * 100).toFixed(2)}%` : '—'}</td>
                                        <td className="r">{n0(uc.consumo)}</td>
                                        <td className={`r ${geradora ? 'strong' : 'muted'}`} title={geradora ? 'Injection from the generator meter (MeterHub)' : ''}>{(uc.injetado ?? 0) > 0 ? n0(uc.injetado) : '—'}{geradora ? ' ⚡' : ''}</td>
                                        <td className={`r ${fora ? 'warn-text' : 'strong'}`} title={fora ? '⚠ outside the plant total (generator or invoice glitch)' : ''}>{n0(uc.compensado)}{fora ? ' ⚠' : ''}</td>
                                        <td className="r muted">{n0(uc.saldo)}</td>
                                      </tr>
                                      {ucOpen && serie && (
                                        <tr>
                                          <td colSpan={7} style={{ background: '#f7fafb' }}>
                                            <div style={{ padding: '10px 14px' }}>
                                              <div style={{ fontSize: 12, color: '#004b70', fontWeight: 600, marginBottom: 4 }}>
                                                UC {uc.uc} · {serie.serie.length} {serie.serie.length === 1 ? 'month' : 'months'} (API) — <span style={{ color: '#8ba32a' }}>■ offset</span> · <span style={{ color: '#004b70' }}>— bank balance</span>
                                              </div>
                                              {geradora && <p className="hint warn-text" style={{ margin: '0 0 6px' }}>⚡ This is the <b>generating</b> UC (injects {n0(uc.injetado)} kWh/month) — the "offset" comes from the invoice and may include the injection or scanning errors. It is not real consumption.</p>}
                                              <UCMiniChart serie={serie.serie} inj={rateioUcMes ? serie.serie.map((s) => rateioUcMes.get(uc.uc)?.get(s.mes)?.inj ?? 0) : undefined} />
                                              <table className="uc-mes-table">
                                                <thead><tr><th>Month</th><th className="r" title="Allocation (BV) declared to MeterHub that month — can change month to month">Allocation</th><th className="r" title="Credits allocated to this UC = allocation × total plant injection that month. It is how much energy the plant 'delivers' to this UC.">Credits alloc.</th><th className="r">Consumption</th><th className="r">Offset</th><th className="r">Bank balance</th><th className="r">Δ bank</th><th className="r">Utiliz.</th></tr></thead>
                                                <tbody>
                                                  {serie.serie.map((s, i) => {
                                                    const prev = i > 0 ? serie.serie[i - 1].saldo : null;
                                                    const delta = prev != null ? s.saldo - prev : null;
                                                    const port = rateioUcMes?.get(uc.uc)?.get(s.mes);
                                                    const rMes = port?.rateio ?? null;
                                                    const injPlanta = injPlantaMes?.get(s.mes) ?? 0;
                                                    const creditos = rMes != null ? rMes * injPlanta : null; // rateio × injeção da usina
                                                    const semR = (rMes == null || rMes === 0) && s.comp > 0;
                                                    return (
                                                      <tr key={s.mes}>
                                                        <td className="mono">{fmtMes(s.mes)}</td>
                                                        <td className={`r ${semR ? 'warn-text' : 'muted'}`} title={semR ? '⚠ offset with 0% allocation this month — missing BV in MeterHub' : ''}>{rMes == null ? '—' : `${(rMes * 100).toFixed(2)}%${semR ? ' ⚠' : ''}`}</td>
                                                        <td className="r" title={creditos != null ? `${(rMes! * 100).toFixed(2)}% × ${n0(injPlanta)} kWh injected by the plant` : ''}>{creditos == null ? '—' : n0(creditos)}</td>
                                                        <td className="r">{n0(s.cons)}</td>
                                                        <td className="r strong">{n0(s.comp)}</td>
                                                        <td className="r muted">{n0(s.saldo)}</td>
                                                        <td className={`r ${delta == null ? 'muted' : delta >= 0 ? 'ok-text' : 'warn-text'}`}>{delta == null ? '—' : `${delta >= 0 ? '+' : ''}${n0(delta)}`}</td>
                                                        {(() => {
                                                          const ap = s.cons ? s.comp / s.cons : null;
                                                          if (ap == null) return <td className="r muted">—</td>;
                                                          let z = 0, consAcum = s.cons;
                                                          for (let j = i - 1; j >= 0 && serie.serie[j].comp === 0 && serie.serie[j].cons > 0; j--) { z++; consAcum += serie.serie[j].cons; }
                                                          const recup = ap > 1.5 && z >= 1 && s.comp <= consAcum * 1.5;
                                                          const susp = ap > 1.5 && !recup;
                                                          return <td className={`r ${susp ? 'warn-text' : ''}`} title={susp ? '⚠ suspicious value — scanned invoice glitch or generating UC' : recup ? `↩ recovery: covers ${z} prior month(s) with no invoice` : ''}>{`${(ap * 100).toFixed(0)}%${susp ? ' ⚠' : recup ? ' ↩' : ''}`}</td>;
                                                        })()}
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
                              <tfoot>
                                <tr className="uc-total">
                                  <td>Σ Total · {dDet.ucs.length} UCs</td>
                                  <td></td>
                                  <td className="r muted">{(dDet.rateioPct != null ? `${(dDet.rateioPct * 100).toFixed(0)}%` : '')}</td>
                                  <td className="r">{n0(dDet.consumo)}</td>
                                  <td className="r strong" title="Total injection measured in MeterHub (generator meter)">{n0(dDet.ucs.reduce((s, u) => s + (u.injetado ?? 0), 0))} ⚡</td>
                                  <td className="r strong">{n0(dDet.compensado)}</td>
                                  <td></td>
                                </tr>
                                {limDet.excl > 0 && (
                                  <tr className="uc-total limpo">
                                    <td>Σ Clean · without {limDet.excl} UC (generator/glitch)</td>
                                    <td></td><td></td>
                                    <td className="r">{n0(limDet.consumo)}</td>
                                    <td className="r muted">—</td>
                                    <td className="r strong">{n0(limDet.compensado)} ✓</td>
                                    <td className="r muted">util. {(limDet.aproveit * 100).toFixed(0)}%</td>
                                  </tr>
                                )}
                              </tfoot>
                            </table>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <footer className="foot">
        Source: <b>MeterHub Base</b> (allocation + per-UC metering). Utilization &gt;100% indicates use of the credit balance accumulated in the month —
        that is why reliable perfComp needs the monthly series + generating-UC injection (via API). Next: pull injection from the API per plant and the long series.
      </footer>
    </>
  );
}

function CompTh({ k, sort, on, r, title, children }: { k: CompSortKey; sort: { key: CompSortKey; dir: 'asc' | 'desc' }; on: (k: CompSortKey) => void; r?: boolean; title?: string; children: ReactNode }) {
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
