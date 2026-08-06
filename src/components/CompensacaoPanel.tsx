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
      <span><i className="lg-bar" style={{ background: '#c6da38' }} /> compensado <em>(kWh · dir.)</em></span>
      <span><i className="lg-line" style={{ background: '#7a4fa3' }} /> consumo <em>(kWh · dir.)</em></span>
      {inj && <span><i className="lg-line" style={{ background: '#c98a1a' }} /> injeção <em>(kWh · dir.)</em></span>}
      <span><i className="lg-line" style={{ background: '#004b70' }} /> saldo do banco <em>(kWh · esq.)</em></span>
    </div>
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: 660, height: 'auto' }}>
      {/* eixo ESQUERDO — saldo do banco (kWh) */}
      {[0, 0.5, 1].map((t) => { const v = t * maxS; return (
        <g key={`ls${t}`}>
          <line x1={pad - 3} x2={pad} y1={ys(v)} y2={ys(v)} stroke="#c3d2db" />
          <text x={2} y={ys(v) + 3} fontSize="8.5" fill="#5c7c90">{fk(v)}</text>
        </g>
      ); })}
      <text x={2} y={pad - 8} fontSize="8" fill="#004b70" fontWeight={600}>← banco</text>
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
    <button className={`lg-item ${vis(k) ? '' : 'off'}`} onClick={() => toggle(k)} title="Mostrar/ocultar">
      <i className={tipo === 'bar' ? '' : tipo === 'dot' ? 'lg-dot' : 'lg-line'}
         style={tipo === 'bar' ? { display: 'inline-block', width: 11, height: 11, background: cor, opacity: 0.6, borderRadius: 2, verticalAlign: 'middle' } : { background: cor }} />
      {' '}{label} <em>{sub}</em>
    </button>
  );
  return (
    <>
      <div className="chart-legend selectable">
        <LegItem k="inj" cor="#c6da38" tipo="bar" label="injeção" sub="kWh · eixo dir. →" />
        <LegItem k="comp" cor="#1f9e89" tipo="line" label="compensado" sub="kWh · eixo dir. →" />
        {consumo && <LegItem k="cons" cor="#7a4fa3" tipo="dash" label="consumo" sub="kWh · eixo dir. →" />}
        <LegItem k="movel" cor="#004b70" tipo="line" label="perfComp móvel" sub="% · eixo esq. ←" />
        <LegItem k="mes" cor="#9bb8c6" tipo="dot" label="perfComp mensal" sub="% · eixo esq. ←" />
        <span className="lg-static"><i className="lg-dash" /> 100% <em>(acima = sacou do banco)</em></span>
        <button className="ajuda-toggle" onClick={() => setAjuda((v) => !v)}>{ajuda ? '▾ ocultar' : '❔ mensal × móvel'}</button>
      </div>
      {ajuda && (
        <div className="ajuda-box" style={{ margin: '2px 0 10px' }}>
          <h4>perfComp mensal × perfComp móvel</h4>
          <p>
            Os dois medem a mesma coisa — <b>quanto da energia injetada virou compensação</b> (compensado ÷ injeção) — mas em janelas diferentes.
          </p>
          <ul className="ajuda-list">
            <li>
              <b>perfComp mensal</b> = compensado <b>do mês</b> ÷ injeção <b>do mês</b>.
              <b>Balança muito</b> (ex. 30%→160%): a compensação de um mês pode vir da injeção de <i>outro</i> mês (banco de créditos), e mês com injeção baixa/zero dispara o %. <b>Serve para ver a volatilidade</b>, não para decidir.
            </li>
            <li>
              <b>perfComp móvel</b> = <b>Σ</b>compensado ÷ <b>Σ</b>injeção <b>acumulado</b> (janela 12 meses).
              <b>Estável e confiável</b>: filtra o descasamento temporal e converge para a razão real de longo prazo. <b>É o número que substitui o input manual da Billing</b> no forecast.
            </li>
          </ul>
          <p className="ajuda-caveat">
            Acima de <b>100%</b> = compensou mais do que injetou naquele período → <b>sacou do banco de créditos</b> (não é erro). O móvel &gt; 100% sustentado indica banco sendo consumido; &lt; 100% indica banco acumulando.
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
        <text x={4} y={pad - 8} fontSize="9" fill="#004b70" fontWeight={600}>← % perfComp</text>
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
          {consAt(d.mes) != null && <span>Consumo: <b>{kwh(consAt(d.mes)!)} kWh</b></span>}
          <span>Injetado: <b>{kwh(d.injetado)} kWh</b></span>
          <span>Compensado: <b>{kwh(compVal(d))} kWh</b></span>
          {consAt(d.mes) ? <span>Aproveit.: <b>{Math.round((compVal(d) / consAt(d.mes)!) * 100)}%</b></span> : null}
          <span>Saldo banco: <b>{kwh(d.saldo)} kWh</b></span>
          <span>perfComp mês: <b className="grey-t">{d.perfMes ?? '—'}%</b></span>
          <span>perfComp móvel: <b className="navy-t">{d.perfMovel}%</b></span>
        </div>
      )}
      {!d && <p className="foot" style={{ margin: '4px 0 0', textAlign: 'center' }}>clique num mês pra ver injetado, compensado e saldo do banco</p>}
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
        Injeção: Excel (Performance) × MeterHub (API) — MWh
        {maxDelta != null && (
          <span className={`inj-status ${maxDelta <= 0.02 ? 'ok' : 'warn'}`} style={{ marginLeft: 8 }}>
            {maxDelta <= 0.02 ? `✓ bate (máx ${(maxDelta * 100).toFixed(1)}%)` : `⚠ diverge (máx ${(maxDelta * 100).toFixed(1)}%)`}
          </span>
        )}
      </div>
      <table className="uc-table inj-table">
        <thead><tr><th>Mês</th><th className="r">Excel</th><th className="r">MeterHub</th><th className="r">Δ</th><th className="r">PVsyst (esperado)</th><th>Situação</th></tr></thead>
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
                  {l.status === 'bate' ? '✓ bate' : l.status === 'diverge' ? '⚠ diverge' : l.status === 'so-excel' ? 'só Excel' : 'só MeterHub'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint" style={{ marginTop: 4 }}>Excel (aba Performance) e MeterHub são a mesma fonte de medição — "bate" confirma o pull; "diverge/só Excel/só MeterHub" sinaliza mês não fechado, planilha desatualizada ou lacuna de mapeamento.</p>
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

  if (!dados) return <div className="state">Carregando…</div>;

  const totUC = linhas.reduce((s, x) => s + x.d.nUCs, 0);
  // totais LIMPOS: excluem UC geradora e meses-glitch (compensação impossível)
  const totComp = linhas.reduce((s, x) => s + aggLimpo(x.d.ucs ?? []).compensado, 0);
  const totCons = linhas.reduce((s, x) => s + aggLimpo(x.d.ucs ?? []).consumo, 0);

  return (
    <>
      <section className="kpis">
        <Kpi label="Usinas" value={String(linhas.length)} sub="da Base MeterHub" accent />
        <Kpi label="UCs mapeadas" value={n0(totUC)} sub={`no mês ${fmtMes(mes)}`} />
        <Kpi label="Compensado (mês)" value={`${n0(totComp / 1000)} MWh`} sub="energia compensada" />
        <Kpi label="Aproveitamento médio" value={pctv(totCons ? totComp / totCons : null)} sub="compensado ÷ consumo" />
      </section>

      {exemplo && (
        <div className="perfcomp-card">
          <div className="perfcomp-head">
            <div>
              <h4>perfComp calculado do jeito certo — {exemplo.usina}</h4>
              <p>Σ compensado ÷ Σ injetado, da API (12 meses reais). O mensal balança; a <b>razão móvel</b> converge.</p>
            </div>
          </div>
          <PerfCompChart ex={exemplo} consumo={serieLimpaDe(exemplo.usina, 'consumo')} compensado={serieLimpaDe(exemplo.usina, 'compensado')} />
          <p className="foot" style={{ marginTop: 4 }}>
            Real, da API MeterHub: injeção da UC geradora + compensação de 26 UCs consumidoras. O mensal vai de ~30% a ~160% (com meses de injeção 0);
            o móvel estabiliza em ~{exemplo.serie.at(-1)?.perfMovel}%. É o número que substitui o input manual da Billing.
          </p>
        </div>
      )}

      <div className="ok" style={{ marginBottom: 16, padding: '12px 16px', borderRadius: 12, border: '1px solid #cfe0ad', background: '#eaf3e0', color: '#3c5417', fontSize: 13.5 }}>
        <b>Dado real da MeterHub</b> (Base MeterHub): {dados.length} usinas · rateio + consumo + compensação por UC. <b>Aproveitamento</b> = compensado ÷ consumo (métrica sólida). O <b>perfComp móvel</b> (acima) usa injeção da UC geradora ÷ compensação, em janela de 12 meses.
      </div>

      <div className="data-stamp" title="Procedência dos dados da MeterHub. Atualizar em src/lib/dataInfo.ts ao repuxar.">
        📅 <b>MeterHub</b> · {carimboMeterHub()} &nbsp;·&nbsp; snapshot {fmtMes(DATA_INFO.MeterHub.snapshot)}. Dados de UC vêm de faturas escaneadas (defasagem de 1–2 meses).
      </div>

      <div className="toolbar">
        <input className="search" placeholder="Buscar usina…" value={busca} onChange={(e) => setBusca(e.target.value)} />
        <div className="filtros" style={{ margin: 0 }}>
          <label>Mês
            <select value={mes} onChange={(e) => setMes(e.target.value)}>
              {meses.map((m) => <option key={m} value={m}>{fmtMes(m)}{ehParcial(m) ? ' (parcial)' : ''}</option>)}
            </select>
          </label>
          {ehParcial(mes) && <span className="parcial-tag" title="Mês ainda em fechamento — faturas não totalmente emitidas/escaneadas. Não confiar no total.">⚠ mês parcial</span>}
        </div>
        <button className="ajuda-toggle" onClick={() => setAjudaTab((v) => !v)}>{ajudaTab ? '▾ ocultar' : '❔ como ler esta aba'}</button>
        <span className="count">{linhas.length} usinas</span>
      </div>

      {ajudaTab && (
        <div className="ajuda-box">
          <h4>Como ler esta aba</h4>
          <p>
            Compensação real medida pela <b>MeterHub</b>, por usina e por UC. Cada linha é uma usina; <b>clique</b> para abrir as UCs, o
            gráfico de perfComp e o seletor de mês. <b>Clique nos cabeçalhos</b> para ordenar. Os totais são <b>limpos</b> (Σ das UCs
            consumidoras, sem a geradora nem glitches de fatura).
          </p>
          <ul className="ajuda-list">
            <li><b>Usina</b> — badge <span className="rateio-badge ok">rateio ✓</span> = ΣBV entre 95–105% (rateio completo na MeterHub); <span className="rateio-badge inc">rateio N%</span> = incompleto (dado faltando).</li>
            <li><b>Cliente</b> — link ↗ abre o contrato. Chip <span className="metodo-chip modelo-AR" style={{ fontSize: 10 }}>AR</span> = Autoconsumo Remoto (compensação medida) · <span className="metodo-chip modelo-GC" style={{ fontSize: 10 }}>GC</span> = Geração Compartilhada.</li>
            <li><b>UCs</b> — nº de unidades. <b className="uc-excl">−N</b> = N UCs <b>excluídas do total</b> (geradora e/ou glitch de fatura). <b className="uc-semrateio">N s/rateio</b> = N UCs compensam <b>sem rateio declarado</b> (BV faltando → investigar com a MeterHub).</li>
            <li><b>Consumo / Compensado</b> — valores <b>limpos</b> (kWh). O <b>✓</b> no compensado indica que houve exclusão de geradora/glitch (passe o mouse pra ver o bruto).</li>
            <li><b>Compensado 12m</b> — mini-gráfico (sparkline) da tendência do <b>compensado limpo</b> nos 12 meses disponíveis; cada ponto é um mês.</li>
            <li><b>Injeção</b> — injeção medida na MeterHub (valor da <b>fatura</b> da geradora, não telemetria).</li>
            <li><b>Aproveitamento</b> — compensado ÷ consumo (≤100% é saudável; acima sugere sacar do banco ou dado inflado).</li>
            <li><b>Saldo banco</b> — créditos acumulados da usina (Σ das UCs consumidoras) no mês. Sobe quando injeta mais do que compensa; desce quando compensa mais do que injeta.</li>
            <li><b>Otim. rateio</b> — score 0–100 de <b>quão bem a injeção está alocada ao consumo</b> (é otimização — diferente do "rateio ✓", que é completude do dado).</li>
          </ul>
          <p className="ajuda-caveat">
            ⚠ <b>Mês parcial</b>: em fechamento, faturas não totalmente escaneadas — não confie no total. As faturas de UC têm <b>defasagem de 1–2 meses</b>. Ao expandir uma UC, o <b>❔ mensal × móvel</b> explica o gráfico de perfComp.
          </p>
        </div>
      )}

      <div className="tablewrap">
        <table className="comp-t">
          <thead>
            <tr>
              <th className="chev-col"></th>
              <CompTh k="usina" sort={sort} on={ordenar}>Usina</CompTh>
              <CompTh k="cliente" sort={sort} on={ordenar}>Cliente</CompTh>
              <CompTh k="ucs" sort={sort} on={ordenar} r>UCs</CompTh>
              <CompTh k="consumo" sort={sort} on={ordenar} r>Consumo</CompTh>
              <CompTh k="compensado" sort={sort} on={ordenar} r>Compensado</CompTh>
              <th className="r" title="Tendência do compensado (limpo) nos 12 meses disponíveis — cada ponto é um mês">Compensado 12m</th>
              <CompTh k="injecao" sort={sort} on={ordenar} r>Injeção</CompTh>
              <CompTh k="aproveit" sort={sort} on={ordenar} r title="Compensado ÷ Consumo (≤100%)">Aproveit.</CompTh>
              <CompTh k="saldo" sort={sort} on={ordenar} r title="Saldo do banco de créditos da usina (Σ das UCs consumidoras), no mês selecionado">Saldo banco</CompTh>
              <CompTh k="otim" sort={sort} on={ordenar} r title="Score de otimização de rateio: quão bem a injeção está alocada ao consumo">Otim. rateio</CompTh>
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
                          ? <span className="rateio-badge ok" title={`rateio completo (ΣBV ${(d.rateioPct * 100).toFixed(0)}%)`}>rateio ✓</span>
                          : <span className="rateio-badge inc" title="rateio incompleto na MeterHub — usar Modelo de Medição">rateio {(d.rateioPct * 100).toFixed(0)}%</span>
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
                              {c.cliente || 'ver contrato'} ↗
                            </a>
                            <span className={`metodo-chip modelo-${modelo}`} style={{ marginLeft: 6, fontSize: 10 }} title={modelo === 'AR' ? 'Autoconsumo Remoto — compensação medida (Faturas/API)' : 'Geração Compartilhada — compensação por contrato'}>
                              {modelo}
                            </span>
                          </>
                        );
                      })()}
                    </td>
                    <td className="r muted">
                      {d.nUCs}
                      {lim.excl > 0 && <span className="uc-excl" title={`${lim.excl} UC(s) fora do total — geradora e/ou meses com compensação impossível (glitch de fatura). Excluídos: ${n0(lim.exclComp)} kWh de 'compensado'.`}> −{lim.excl}</span>}
                      {semRateio > 0 && <span className="uc-semrateio" title={`${semRateio} UC(s) compensam sem rateio declarado — investigar com a MeterHub (BV faltando).`}> {semRateio} s/rateio</span>}
                    </td>
                    <td className="r muted">{n0(lim.consumo)}</td>
                    <td className="r strong" title={lim.excl > 0 ? `Compensado LIMPO (Σ UCs consumidoras). Bruto na fonte: ${n0(d.compensado)} kWh — inflado por geradora/glitch.` : ''}>{n0(lim.compensado)}{lim.excl > 0 ? ' ✓' : ''}</td>
                    <td className="r"><Sparkline values={serie12} /></td>
                    <td className="r muted">{(() => {
                      if (d.injecao > 0) return n0(d.injecao);
                      const s = perfUsinas.get(usina)?.find((x) => x.mes === mes);
                      return s?.injetado ? n0(s.injetado) : '—';
                    })()}</td>
                    <td className="r">
                      <span className={`comp-chip ${lim.aproveit >= 0.9 ? 'ok' : lim.aproveit >= 0.6 ? 'ramp' : 'nao'}`}>{pctv(lim.aproveit)}</span>
                    </td>
                    <td className="r muted" title="Saldo do banco de créditos (Σ UCs consumidoras) no mês">{n0(lim.saldo)}</td>
                    <td className="r">
                      {rateioScore.has(usina)
                        ? (() => { const sc = rateioScore.get(usina)!.score; return <span className={`score-badge ${sc >= 90 ? 'ok' : sc >= 75 ? 'mid' : 'low'}`} title="Score de OTIMIZAÇÃO de rateio (0–100): quão bem a injeção está alocada ao consumo. Diferente do 'rateio ✓' (completude dos dados).">{sc}%</span>; })()
                        : <span className="muted">—</span>}
                    </td>
                  </tr>
                  {open && (
                    <tr className="panel-row">
                      <td colSpan={11}>
                        <div className="uc-detail">
                          {perfUsinas.has(usina) && (
                            <div style={{ marginBottom: 14 }}>
                              <div style={{ fontSize: 13, fontWeight: 600, color: '#004b70', marginBottom: 4 }}>perfComp móvel (API, {perfUsinas.get(usina)!.length} {perfUsinas.get(usina)!.length === 1 ? 'mês' : 'meses'}) — <span style={{ color: '#6692a8' }}>mensal</span> · <span style={{ color: '#004b70' }}>móvel</span></div>
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
                                <div className="rateio-otim-h">Otimização de Rateio — <b className={`score-t ${rs.score >= 90 ? 'ok' : rs.score >= 75 ? 'mid' : 'low'}`}>score {rs.score}%</b></div>
                                <div className="rateio-kpis">
                                  <span>Excesso → banco<b>{n0(rs.excesso)} kWh</b></span>
                                  <span>Déficit (sub-servido)<b>{n0(rs.deficit)} kWh</b></span>
                                  <span>Aproveitamento<b>{rs.aproveit}%</b></span>
                                  <span>Banco acumulado<b>{rs.bancoMeses} meses</b></span>
                                </div>
                                <div className="rateio-otim-sub">UCs a reequilibrar — maior desvio (rateio atual → sugerido = proporcional ao consumo):</div>
                                <table className="uc-table">
                                  <thead><tr><th>UC</th><th className="r">Consumo</th><th className="r">Saldo créd.</th><th className="r">Rateio atual</th><th className="r">Sugerido</th><th className="r">Δ</th><th>Situação</th></tr></thead>
                                  <tbody>
                                    {rs.ucs.slice(0, 10).map((u) => (
                                      <tr key={u.uc}>
                                        <td className="mono">{u.uc}</td>
                                        <td className="r">{n0(u.cons)}</td>
                                        <td className="r muted">{n0(u.saldo)}</td>
                                        <td className="r">{(u.rateio * 100).toFixed(2)}%</td>
                                        <td className="r strong">{(u.rateioSug * 100).toFixed(2)}%</td>
                                        <td className={`r ${u.delta >= 0 ? 'ok-text' : 'warn-text'}`}>{u.delta >= 0 ? '+' : ''}{(u.delta * 100).toFixed(2)}pp</td>
                                        <td><span className={`comp-chip ${u.status === 'excesso' ? 'nao' : u.status === 'deficit' ? 'ramp' : 'ok'}`}>{u.status === 'excesso' ? '↓ reduzir' : u.status === 'deficit' ? '↑ aumentar' : 'ok'}</span></td>
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
                              Mês:&nbsp;
                              <select value={mesSel} onChange={(e) => setMesDet(e.target.value)}>
                                {mesesDisp.map((m) => <option key={m} value={m}>{fmtMes(m)}{ehParcial(m) ? ' (parcial)' : ''}</option>)}
                              </select>
                            </label>
                          </div>
                          <div className="uc-tablewrap">
                            <table className="uc-table">
                              <thead>
                                <tr><th>UC</th><th>Distribuidora</th><th className="r">Rateio</th><th className="r">Consumo</th><th className="r" title="Injeção medida na MeterHub (kWh) — o medidor da geradora injeta; UCs consumidoras ficam ~0">Injeção</th><th className="r">Compensado</th><th className="r">Saldo créd.</th></tr>
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
                                          {geradora && <span className="uc-flag ger" title={`Medidor da GERADORA (injeta ${n0(uc.injetado)} kWh) — não é UC consumidora. Fora do total da usina.`}>⚡ geradora</span>}
                                          {glitch && <span className="uc-flag ger" title="Compensado impossível (muito acima do consumo e da injeção) — glitch da fatura da distribuidora. Fora do total.">⚠ glitch</span>}
                                        </td>
                                        <td className="muted">{uc.dist || '—'}</td>
                                        <td className="r">{uc.rateio != null ? `${(uc.rateio * 100).toFixed(2)}%` : '—'}</td>
                                        <td className="r">{n0(uc.consumo)}</td>
                                        <td className={`r ${geradora ? 'strong' : 'muted'}`} title={geradora ? 'Injeção do medidor da geradora (MeterHub)' : ''}>{(uc.injetado ?? 0) > 0 ? n0(uc.injetado) : '—'}{geradora ? ' ⚡' : ''}</td>
                                        <td className={`r ${fora ? 'warn-text' : 'strong'}`} title={fora ? '⚠ fora do total da usina (geradora ou glitch de fatura)' : ''}>{n0(uc.compensado)}{fora ? ' ⚠' : ''}</td>
                                        <td className="r muted">{n0(uc.saldo)}</td>
                                      </tr>
                                      {ucOpen && serie && (
                                        <tr>
                                          <td colSpan={7} style={{ background: '#f7fafb' }}>
                                            <div style={{ padding: '10px 14px' }}>
                                              <div style={{ fontSize: 12, color: '#004b70', fontWeight: 600, marginBottom: 4 }}>
                                                UC {uc.uc} · {serie.serie.length} {serie.serie.length === 1 ? 'mês' : 'meses'} (API) — <span style={{ color: '#8ba32a' }}>■ compensado</span> · <span style={{ color: '#004b70' }}>— saldo do banco</span>
                                              </div>
                                              {geradora && <p className="hint warn-text" style={{ margin: '0 0 6px' }}>⚡ Esta é a UC <b>geradora</b> (injeta {n0(uc.injetado)} kWh/mês) — o "compensado" vem da fatura e pode conter a injeção ou erros de escaneamento. Não é consumo real.</p>}
                                              <UCMiniChart serie={serie.serie} inj={rateioUcMes ? serie.serie.map((s) => rateioUcMes.get(uc.uc)?.get(s.mes)?.inj ?? 0) : undefined} />
                                              <table className="uc-mes-table">
                                                <thead><tr><th>Mês</th><th className="r" title="Rateio (BV) declarado à MeterHub naquele mês — pode mudar mês a mês">Rateio</th><th className="r" title="Créditos alocados a esta UC = rateio × injeção total da usina naquele mês. É quanto a usina 'entrega' de energia pra esta UC.">Créditos aloc.</th><th className="r">Consumo</th><th className="r">Compensado</th><th className="r">Saldo banco</th><th className="r">Δ banco</th><th className="r">Aproveit.</th></tr></thead>
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
                                                        <td className={`r ${semR ? 'warn-text' : 'muted'}`} title={semR ? '⚠ compensou com rateio 0% neste mês — BV faltando na MeterHub' : ''}>{rMes == null ? '—' : `${(rMes * 100).toFixed(2)}%${semR ? ' ⚠' : ''}`}</td>
                                                        <td className="r" title={creditos != null ? `${(rMes! * 100).toFixed(2)}% × ${n0(injPlanta)} kWh injetados pela usina` : ''}>{creditos == null ? '—' : n0(creditos)}</td>
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
                                                          return <td className={`r ${susp ? 'warn-text' : ''}`} title={susp ? '⚠ valor suspeito — glitch da fatura escaneada ou UC geradora' : recup ? `↩ recuperação: cobre ${z} mês(es) anterior(es) sem fatura` : ''}>{`${(ap * 100).toFixed(0)}%${susp ? ' ⚠' : recup ? ' ↩' : ''}`}</td>;
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
                                  <td className="r strong" title="Injeção total medida na MeterHub (medidor da geradora)">{n0(dDet.ucs.reduce((s, u) => s + (u.injetado ?? 0), 0))} ⚡</td>
                                  <td className="r strong">{n0(dDet.compensado)}</td>
                                  <td></td>
                                </tr>
                                {limDet.excl > 0 && (
                                  <tr className="uc-total limpo">
                                    <td>Σ Limpo · sem {limDet.excl} UC (geradora/glitch)</td>
                                    <td></td><td></td>
                                    <td className="r">{n0(limDet.consumo)}</td>
                                    <td className="r muted">—</td>
                                    <td className="r strong">{n0(limDet.compensado)} ✓</td>
                                    <td className="r muted">aprov. {(limDet.aproveit * 100).toFixed(0)}%</td>
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
        Fonte: <b>Base MeterHub</b> (rateio + medição por UC). O aproveitamento &gt;100% indica uso do saldo de créditos acumulado no mês —
        por isso o perfComp confiável precisa da série mensal + injeção da UC geradora (via API). Próximo: puxar a injeção da API por usina e a série longa.
      </footer>
    </>
  );
}

function CompTh({ k, sort, on, r, title, children }: { k: CompSortKey; sort: { key: CompSortKey; dir: 'asc' | 'desc' }; on: (k: CompSortKey) => void; r?: boolean; title?: string; children: ReactNode }) {
  const ativo = sort.key === k;
  return (
    <th className={`${r ? 'r ' : ''}th-sort${ativo ? ' on' : ''}`} onClick={() => on(k)} title={title ?? 'Ordenar'}>
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
