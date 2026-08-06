import { useEffect, useMemo, useState } from 'react';
import { secureText } from '../secure';

interface UCmes { uc: string; dist: string; rateio: number; consumo: number; compensado: number; injetado: number; saldo: number }
interface UsinaComp { usina: string; meses: Record<string, { ucs: UCmes[] }> }

type Problema = 'geradora' | 'glitch' | 'semRateio' | 'contingencia' | 'recuperacao';
interface UCFlag {
  uc: string; usina: string; dist: string; rateio: number;
  consumo: number; compensado: number; injetado: number;
  geradora: boolean; glitch: boolean; semRateio: boolean; contingencia: boolean; recuperacao: boolean;
}

const n0 = (v: number) => Math.round(v).toLocaleString('pt-BR');

/** Analisa a série mensal de uma UC e classifica os "picos" de compensação.
 *  Um pico (compensado >> consumo/injeção) só é GLITCH se NÃO puder ser
 *  explicado como recuperação de meses anteriores zerados (fatura represada):
 *  se os meses zerados imediatamente antes consumiram energia suficiente para
 *  cobrir o pico, é RECUPERAÇÃO — e esses meses zerados viram CONTINGÊNCIA
 *  (fatura pendente), mesmo no início da série. */
function analisaSerie(meses: { comp: number; cons: number; inj: number; saldo: number }[]) {
  const glitch = new Set<number>();
  const recuperacao = new Set<number>();
  const conting = new Set<number>();
  for (let i = 0; i < meses.length; i++) {
    const m = meses[i];
    if (m.comp <= Math.max(m.cons, m.inj, 1) * 1.5) continue; // mês normal
    // pico: tenta explicar como recuperação de meses zerados anteriores
    let z = 0, consAcum = m.cons;
    for (let j = i - 1; j >= 0 && meses[j].comp === 0 && meses[j].cons > 0; j--) { z++; consAcum += meses[j].cons; }
    if (z >= 1 && m.comp <= consAcum * 1.5) {
      recuperacao.add(i);
      for (let j = i - 1; j > i - 1 - z; j--) conting.add(j);
    } else {
      glitch.add(i);
    }
  }
  // contingência clássica: mês zerado entre dois meses que compensam
  const compIdx = meses.map((m, i) => (m.comp > 0 ? i : -1)).filter((i) => i >= 0);
  if (compIdx.length) {
    const first = compIdx[0], last = compIdx[compIdx.length - 1];
    meses.forEach((m, i) => { if (i > first && i < last && m.cons > 0 && m.comp === 0 && m.saldo === 0) conting.add(i); });
  }
  return { glitch, recuperacao, conting };
}

const PROBLEMAS: { key: Problema; label: string; cor: string; desc: string }[] = [
  { key: 'semRateio', label: 'No allocation', cor: 'r', desc: 'Compensates but declared allocation = 0% (BV missing in the MeterHub Base) — investigate with MeterHub.' },
  { key: 'geradora', label: 'Generator', cor: 'y', desc: 'Injection dominates — it is the plant meter, not a consuming UC. Kept out of the total.' },
  { key: 'glitch', label: 'Glitch', cor: 'r', desc: 'Impossible compensation (above consumption/injection and NOT explained by recovery of backlogged months) — scanned-invoice error.' },
  { key: 'contingencia', label: 'Contingency', cor: 'y', desc: 'Month in which the UC consumed but did not compensate (balance 0) — invoice not issued/scanned. Includes the month before a recovery.' },
  { key: 'recuperacao', label: 'Recovery', cor: 'b', desc: 'Month with double/triple compensation covering earlier backlogged months — real energy, not an error. Flags the pending invoice from the previous month.' },
];

export default function AuditoriaPanel({ onAbrir }: { onAbrir?: (usina: string, uc: string) => void }) {
  const [dados, setDados] = useState<UsinaComp[] | null>(null);
  const [filtro, setFiltro] = useState<Problema | 'todos'>('todos');
  const [usinaF, setUsinaF] = useState('todas');
  const [busca, setBusca] = useState('');
  const [ajuda, setAjuda] = useState(false);

  useEffect(() => {
    try { setDados(JSON.parse(secureText('comp_portfolio.json'))); } catch { setDados([]); }
  }, []);

  const flags = useMemo<UCFlag[]>(() => {
    if (!dados) return [];
    const acc = new Map<string, { usina: string; uc: string; dist: string; rateio: number; consumo: number; compensado: number; injetado: number; meses: { mes: string; comp: number; cons: number; inj: number; saldo: number }[] }>();
    for (const u of dados) {
      for (const [mes, m] of Object.entries(u.meses)) {
        for (const x of m.ucs) {
          const k = `${u.usina}|${x.uc}`;
          let a = acc.get(k);
          if (!a) { a = { usina: u.usina, uc: x.uc, dist: x.dist || '', rateio: 0, consumo: 0, compensado: 0, injetado: 0, meses: [] }; acc.set(k, a); }
          a.consumo += x.consumo; a.compensado += x.compensado; a.injetado += x.injetado ?? 0;
          a.rateio = Math.max(a.rateio, x.rateio ?? 0);
          if (!a.dist && x.dist) a.dist = x.dist;
          a.meses.push({ mes, comp: x.compensado, cons: x.consumo, inj: x.injetado ?? 0, saldo: x.saldo ?? 0 });
        }
      }
    }
    const out: UCFlag[] = [];
    for (const a of acc.values()) {
      a.meses.sort((x, y) => x.mes.localeCompare(y.mes));
      const geradora = a.injetado > 5000 && a.injetado > a.consumo;
      const { glitch: gSet, recuperacao: rSet, conting: cSet } = analisaSerie(a.meses);
      const glitch = gSet.size > 0;
      const recuperacao = rSet.size > 0;
      const contingencia = cSet.size > 0;
      const semRateio = a.compensado > 1000 && a.rateio === 0 && !geradora;
      if (geradora || glitch || semRateio || contingencia || recuperacao) {
        out.push({ uc: a.uc, usina: a.usina, dist: a.dist, rateio: a.rateio, consumo: a.consumo, compensado: a.compensado, injetado: a.injetado, geradora, glitch, semRateio, contingencia, recuperacao });
      }
    }
    return out.sort((x, y) => y.compensado - x.compensado);
  }, [dados]);

  const cont = useMemo(() => {
    const c = { total: flags.length, geradora: 0, glitch: 0, semRateio: 0, contingencia: 0, recuperacao: 0 };
    for (const f of flags) { if (f.geradora) c.geradora++; if (f.glitch) c.glitch++; if (f.semRateio) c.semRateio++; if (f.contingencia) c.contingencia++; if (f.recuperacao) c.recuperacao++; }
    return c;
  }, [flags]);

  const usinas = useMemo(() => [...new Set(flags.map((f) => f.usina))].sort(), [flags]);

  const lista = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return flags.filter((f) => {
      if (filtro !== 'todos' && !f[filtro]) return false;
      if (usinaF !== 'todas' && f.usina !== usinaF) return false;
      if (q && !(f.uc.toLowerCase().includes(q) || f.usina.toLowerCase().includes(q) || f.dist.toLowerCase().includes(q))) return false;
      return true;
    }).slice(0, 800);
  }, [flags, filtro, usinaF, busca]);

  const exportCSV = () => {
    const head = ['UC', 'Plant', 'Utility', 'Allocation %', 'Consumption (year)', 'Compensated (year)', 'Injection (year)', 'Problems'];
    const rows = flags.filter((f) => filtro === 'todos' || f[filtro]).map((f) => [
      f.uc, f.usina, f.dist, (f.rateio * 100).toFixed(2), f.consumo.toFixed(0), f.compensado.toFixed(0), f.injetado.toFixed(0),
      [f.semRateio && 'no allocation', f.geradora && 'generator', f.glitch && 'glitch', f.contingencia && 'contingency', f.recuperacao && 'recovery'].filter(Boolean).join(' + '),
    ]);
    const csv = [head, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'auditoria-ucs.csv'; a.click(); URL.revokeObjectURL(a.href);
  };

  if (!dados) return <div className="state">Loading…</div>;

  return (
    <>
      <section className="kpis">
        <Kpi label="Flagged UCs" value={n0(cont.total)} sub="with some inconsistency" accent />
        <Kpi label="No allocation" value={n0(cont.semRateio)} sub="compensate, BV missing" />
        <Kpi label="Generators" value={n0(cont.geradora)} sub="plant meter" />
        <Kpi label="Glitch / contingency" value={`${cont.glitch} / ${cont.contingencia}`} sub="invoice with error / pending" />
      </section>

      <div className="audit-head">
        <p>
          Quality sweep of the metered UCs (MeterHub, 12 months). Click a type to filter; export the list to work through it with the team.
          <button className="ajuda-toggle" onClick={() => setAjuda((v) => !v)}>{ajuda ? '▾ hide' : '❔ how it works'}</button>
        </p>

        {ajuda && (
          <div className="ajuda-box">
            <h4>Why this audit exists</h4>
            <p>
              The revenue forecast depends on <b>how much each plant compensates</b> in the consuming UCs. That data comes from <b>MeterHub</b>, which
              scans the utility invoices of <b>~6,800 UCs</b>. In any base this size there is noise: poorly scanned invoices,
              allocation (BV) not registered, the plant's own meter mixed in with consumers, invoices that did not come out in a given month. If no one
              sweeps this, the error slips <b>silently into the forecasted revenue</b>. This tab runs the sweep and classifies each anomaly — so
              you know <b>what to investigate, why, and with whom to resolve it</b>.
            </p>

            <h4>How each signal is calculated</h4>
            <ul className="ajuda-list">
              <li>
                <span className="audit-tag r">no allocation</span>
                <b>Rule:</b> the UC compensates &gt; 1 MWh/year but the declared allocation is <b>0%</b>.
                <b>Why:</b> energy being compensated without being tied to any plant in the registration → risk of wrong attribution/billing.
                <b>Action:</b> ask MeterHub for the correct BV of that UC.
              </li>
              <li>
                <span className="audit-tag y">⚡ generator</span>
                <b>Rule:</b> injection &gt; 5,000 kWh <b>and</b> greater than consumption.
                <b>Why:</b> it is the <b>plant meter</b>, not a consuming UC — if counted as consumption, it inflates compensation and revenue.
                <b>Action:</b> none; the tab already excludes it from the clean total. Serves as a cross-check.
              </li>
              <li>
                <span className="audit-tag r">⚠ glitch</span>
                <b>Rule:</b> a month compensates &gt; max(consumption, injection) × 1.5 <b>and this is not explained by recovery</b> (see below).
                <b>Why:</b> compensating far more than was consumed, with no bank to draw from, is physically impossible → invoice OCR error.
                <b>Action:</b> ask MeterHub to recheck that month against the PDF; candidate for manual correction.
              </li>
              <li>
                <span className="audit-tag y">contingency</span>
                <b>Rule:</b> a month in which the UC <b>consumed but compensated 0</b> (balance 0) — between months that compensate, or just before a recovery.
                <b>Why:</b> that month's invoice <b>was not issued/scanned</b> → gap in the history.
                <b>Action:</b> chase the missing invoice from the utility/MeterHub.
              </li>
              <li>
                <span className="audit-tag b">recovery</span>
                <b>Rule:</b> a compensation spike that <b>covers earlier backlogged months</b> — compensated ≤ (accumulated consumption of the prior zeroed months + that of the month) × 1.5.
                <b>Why:</b> when an invoice is late, the backlogged compensation all lands in the following month. It is <b>real energy, not an error</b> — that's why it is <b>not</b> a glitch. The year total stays correct; only the phasing "merges" two months.
                <b>Action:</b> none on the value; the real item is the <b>pending invoice</b> from the previous month (flagged as contingency).
              </li>
            </ul>

            <h4>The case that motivated the "recovery" rule</h4>
            <p>
              UC 2124500-2 (Manaus): October/2025 consumed 1,894 kWh and compensated 0 (invoice not scanned); November compensated <b>3,316</b> ≈
              October + November combined. The naive reading would call November a "glitch" (180% of consumption). But 3,316 ≤ (1,894 + 1,841) × 1.5,
              so it is <b>recovery</b> — and the real problem is the <b>October invoice</b>. The rule now separates the two automatically.
            </p>

            <p className="ajuda-caveat">
              ⚠ <b>These are heuristics, not verdicts.</b> The thresholds (injection &gt; 5,000 kWh, spike &gt; 1.5× consumption) were calibrated on the cases we
              investigated. They <b>point out candidates</b> for error — each signal still needs human review. That's why every row is clickable:
              it goes straight to the <b>Compensation</b> tab, to the real bank/allocation history of that UC.
            </p>
          </div>
        )}

        <div className="audit-filtros">
          <button className={`chip-btn ${filtro === 'todos' ? 'on' : ''}`} onClick={() => setFiltro('todos')}>All ({cont.total})</button>
          {PROBLEMAS.map((p) => (
            <button key={p.key} className={`chip-btn sev-${p.cor} ${filtro === p.key ? 'on' : ''}`} title={p.desc} onClick={() => setFiltro(p.key)}>
              {p.label} ({cont[p.key]})
            </button>
          ))}
          <input className="search" placeholder="Search UC, plant, utility…" value={busca} onChange={(e) => setBusca(e.target.value)} />
          <select value={usinaF} onChange={(e) => setUsinaF(e.target.value)}>
            <option value="todas">all plants</option>
            {usinas.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
          <button className="btn-export" onClick={exportCSV}>⤓ Export CSV</button>
        </div>
      </div>

      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>UC</th><th>Plant</th><th>Utility</th><th className="r">Allocation</th>
              <th className="r">Consumption (year)</th><th className="r">Compensated (year)</th><th>Problem(s)</th>
            </tr>
          </thead>
          <tbody>
            {lista.map((f) => (
              <tr key={f.usina + f.uc} className={onAbrir ? 'clickable' : ''} onClick={onAbrir ? () => onAbrir(f.usina, f.uc) : undefined} title={onAbrir ? 'Open in Compensation tab' : ''}>
                <td className="mono"><span className="audit-uc-link">{f.uc} ↗</span></td>
                <td>{f.usina}</td>
                <td className="muted">{f.dist || '—'}</td>
                <td className="r">{(f.rateio * 100).toFixed(2)}%</td>
                <td className="r muted">{n0(f.consumo)}</td>
                <td className="r strong">{n0(f.compensado)}</td>
                <td>
                  {f.semRateio && <span className="audit-tag r">no allocation</span>}
                  {f.geradora && <span className="audit-tag y">⚡ generator</span>}
                  {f.glitch && <span className="audit-tag r">⚠ glitch</span>}
                  {f.contingencia && <span className="audit-tag y">contingency</span>}
                  {f.recuperacao && <span className="audit-tag b">recovery</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {flags.length > lista.length && filtro === 'todos' && !busca && usinaF === 'todas' && (
          <p className="hint">Showing the {lista.length} largest by compensation. Use the filters or export the CSV to see all ({cont.total}).</p>
        )}
      </div>
      <footer className="foot">
        Source: <b>MeterHub</b> (comp_portfolio, 12 months). Rules: <b>generator</b> = injection &gt; 5,000 kWh and &gt; consumption · <b>glitch</b> = compensated spike &gt; max(consumption, injection)×1.5 <i>not</i> explained by recovery · <b>recovery</b> = spike covering earlier backlogged months (≤ accumulated consumption×1.5) · <b>no allocation</b> = compensates &gt; 1 MWh/year with BV 0% · <b>contingency</b> = month consuming without compensating (includes the month before a recovery).
      </footer>
    </>
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
