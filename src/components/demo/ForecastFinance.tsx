import { Fragment, useMemo, useState } from 'react';
import { extras } from '../../data/extras';
import { brl, brlM, CHART, DivergingBars, downloadCsv, Kpi, LineChart, monthLabel, n0, n1, pct, ScreenHead, signed, Spark } from './ui';

export function EvolutionPanel() {
  const { evolution: ev } = extras();
  const [selected, setSelected] = useState('9+3');
  const budget = ev.revisions[0];
  const rev = ev.revisions.find((r) => r.label === selected) ?? ev.revisions[ev.revisions.length - 1];
  const total = (r: typeof rev) => ev.months.reduce((s, m) => s + r.byMonth[m], 0);
  const bridge = ev.bridges.find((b) => b.to === rev.label);
  const closedAcc = ev.accuracy.filter((a) => a.oneAhead != null);
  const meanOne = closedAcc.reduce((s, a) => s + (a.oneAhead ?? 0), 0) / closedAcc.length;
  return (
    <div className="sc">
      <ScreenHead title="Forecast evolution" level="live">
        Every monthly revision next to the budget. The change between two revisions is split by cause, and each revision is scored against what actually happened.
      </ScreenHead>
      <section className="kpis">
        <Kpi label="Budget 2026" value={brlM(total(budget))} />
        <Kpi label={`Forecast ${rev.label}`} value={brlM(total(rev))} sub={`${signed(total(rev) - total(budget))} vs budget`} accent />
        <Kpi label="Average error, next month" value={pct(meanOne)} sub={`${closedAcc.length} revisions, invented data`} />
        <Kpi label="Revisions tracked" value={String(ev.revisions.length - 1)} sub="plus the locked budget" />
      </section>
      <div className="sc-tools">
        <span>Revision</span>
        {ev.revisions.slice(1).map((r) => <button key={r.id} className={`chip-btn${r.label === selected ? ' on' : ''}`} onClick={() => setSelected(r.label)}>{r.label}</button>)}
      </div>
      <div className="sc-card">
        <h3>Monthly revenue: budget, selected revision and actuals</h3>
        <LineChart
          labels={ev.months.map(monthLabel)}
          format={brlM}
          series={[
            { name: 'Budget', color: CHART.violet, values: ev.months.map((m) => budget.byMonth[m]), dash: true },
            { name: `Forecast ${rev.label}`, color: CHART.blue, values: ev.months.map((m) => rev.byMonth[m]) },
            { name: 'Actual', color: CHART.orange, values: ev.months.map((m) => ev.actual[m] ?? null) },
          ]}
        />
      </div>
      <div className="sc-grid">
        <div className="sc-card">
          <h3>What moved {bridge ? `from ${bridge.from} to ${bridge.to}` : ''}</h3>
          {bridge && <DivergingBars format={signed} rows={ev.causes.map((c) => ({ label: c, value: bridge.causes[c] }))} />}
          {bridge && <p className="sc-foot">Net change {signed(bridge.delta)}.</p>}
        </div>
        <div className="sc-card">
          <h3>Accuracy of each revision</h3>
          <div className="tablewrap"><table>
            <thead><tr><th>Revision</th><th className="r">1 month ahead</th><th className="r">3 months ahead</th></tr></thead>
            <tbody>{ev.accuracy.map((a) => <tr key={a.label}><td>{a.label}</td><td className="r">{a.oneAhead == null ? 'open' : pct(a.oneAhead)}</td><td className="r">{a.threeAhead == null ? 'open' : pct(a.threeAhead)}</td></tr>)}</tbody>
          </table></div>
          <p className="sc-foot">Scores are calculated on invented data and show the method, not real accuracy.</p>
        </div>
      </div>
      <div className="sc-card">
        <h3>Largest plant movements</h3>
        <div className="tablewrap"><table>
          <thead><tr><th>Plant</th><th>Client</th><th>Main cause</th><th className="r">Change vs budget</th></tr></thead>
          <tbody>{ev.movers.map((m) => <tr key={m.plant}><td className="strong">{m.plant}</td><td>{m.client}</td><td>{m.cause}</td><td className="r">{signed(m.delta)}</td></tr>)}</tbody>
        </table></div>
      </div>
    </div>
  );
}

export function CreditBankPanel() {
  const { bank } = extras();
  const [onlyAccumulating, setOnlyAccumulating] = useState(false);
  const rows = bank.plants.filter((p) => !onlyAccumulating || p.status === 'Accumulating');
  const sum = (f: (p: (typeof bank.plants)[number]) => number) => bank.plants.reduce((s, p) => s + f(p), 0);
  const err = (k: 'flat' | 'simulated') => bank.backtest.reduce((s, b) => s + Math.abs(b[k] - b.real) / b.real, 0) / bank.backtest.length;
  return (
    <div className="sc">
      <ScreenHead title="Credit bank" level="live">
        Energy credits sitting unused under net metering, by plant and consumer unit. A balance that keeps rising is injected energy that is not turning into revenue, and credits expire after 60 months.
      </ScreenHead>
      <section className="kpis">
        <Kpi label="Credit balance" value={`${n0(sum((p) => p.saldoMWh))} MWh`} />
        <Kpi label="Estimated value" value={brlM(sum((p) => p.value))} accent />
        <Kpi label="Plants accumulating" value={String(bank.plants.filter((p) => p.status === 'Accumulating').length)} sub={`of ${bank.plants.length} metered`} />
        <Kpi label="Expiring in 12 months" value={`${n0(sum((p) => p.expiring12m))} MWh`} />
      </section>
      <div className="sc-card">
        <h3>Compensated energy: simulating each unit against a flat assumption</h3>
        <LineChart
          labels={bank.backtest.map((b) => monthLabel(b.month))}
          format={(v) => `${n0(v)} MWh`}
          series={[
            { name: 'Actual', color: CHART.orange, values: bank.backtest.map((b) => b.real) },
            { name: 'Credit bank simulation', color: CHART.blue, values: bank.backtest.map((b) => b.simulated) },
            { name: 'Flat assumption', color: CHART.violet, values: bank.backtest.map((b) => b.flat), dash: true },
          ]}
        />
        <p className="sc-foot">Average error on these synthetic months: simulation {pct(err('simulated'))}, flat assumption {pct(err('flat'))}.</p>
      </div>
      <div className="sc-tools"><button className={`chip-btn${onlyAccumulating ? ' on' : ''}`} onClick={() => setOnlyAccumulating((v) => !v)}>Only accumulating</button></div>
      <div className="tablewrap"><table>
        <thead><tr><th>Plant</th><th>Client</th><th>Distributor</th><th className="r">Balance (MWh)</th><th className="r">Value</th><th className="r">3-month change</th><th className="r">Utilisation</th><th>12-month trend</th><th>Status</th></tr></thead>
        <tbody>{rows.map((p) => (
          <tr key={p.plant}>
            <td className="strong">{p.plant}</td><td>{p.client}</td><td>{p.disco}</td><td className="r">{n1(p.saldoMWh)}</td><td className="r">{brl(p.value)}</td>
            <td className="r">{p.delta3m > 0 ? '+' : ''}{n1(p.delta3m)}</td><td className="r">{p.utilisation}%</td><td><Spark values={p.series} /></td>
            <td><span className={`st st-${p.status === 'Accumulating' ? 'warn' : 'ok'}`}>{p.status === 'Accumulating' ? '▲ ' : ''}{p.status}</span></td>
          </tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}

export function ProvisionPanel() {
  const { provision } = extras();
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [source, setSource] = useState('All');
  const rows = useMemo(() => provision.rows.map((r) => {
    const mwh = overrides[r.plant] ?? r.mwh;
    return { ...r, mwh, revenue: r.base * mwh - r.grid, edited: overrides[r.plant] != null };
  }), [provision.rows, overrides]);
  const sources = ['All', ...new Set(provision.rows.map((r) => r.source))];
  const shown = rows.filter((r) => source === 'All' || r.source === source);
  const total = rows.reduce((s, r) => s + r.revenue, 0);
  const forecast = rows.reduce((s, r) => s + r.forecast, 0);
  const measured = rows.filter((r) => r.source === 'Measured').reduce((s, r) => s + r.revenue, 0);
  const exportCsv = () => downloadCsv(`provision-${provision.month}.csv`, [
    ['Plant', 'Client', 'Model', 'Energy MWh', 'Energy source', 'Base R$/MWh', 'Grid cost R$', 'Grid cost source', 'Revenue R$', 'Forecast R$'],
    ...rows.map((r) => [r.plant, r.client, r.model, r.mwh, r.source, r.base, r.grid, r.gridSource, Math.round(r.revenue), r.forecast]),
  ]);
  return (
    <div className="sc">
      <ScreenHead title={`Revenue provisioning, ${monthLabel(provision.month)}`} level="live">
        The month-end figure for finance, before all invoices have arrived. Each line shows where its energy and grid cost came from, and any value can be overridden with the total updating straight away.
      </ScreenHead>
      <section className="kpis">
        <Kpi label="Provision" value={brlM(total)} accent />
        <Kpi label="Forecast for the month" value={brlM(forecast)} sub={`${signed(total - forecast)} difference`} />
        <Kpi label="Backed by measured data" value={pct(measured / total, 0)} />
        <Kpi label="Plants provisioned" value={String(rows.length)} sub={`${Object.keys(overrides).length} edited`} />
      </section>
      <div className="sc-tools">
        <span>Energy source</span>
        {sources.map((s) => <button key={s} className={`chip-btn${s === source ? ' on' : ''}`} onClick={() => setSource(s)}>{s}</button>)}
        <button className="chip-btn sc-right" onClick={exportCsv}>Export for finance</button>
      </div>
      <div className="tablewrap"><table>
        <thead><tr><th>Plant</th><th>Client</th><th className="r">Energy (MWh)</th><th>Energy source</th><th className="r">Grid cost</th><th>Cost source</th><th className="r">Provision</th><th className="r">Forecast</th></tr></thead>
        <tbody>{shown.map((r) => (
          <Fragment key={r.plant}>
            <tr>
              <td className="strong">{r.plant}</td><td>{r.client}</td>
              <td className="r"><input className="sc-num" type="number" aria-label={`Energy for ${r.plant}`} value={r.mwh} onChange={(e) => setOverrides((o) => ({ ...o, [r.plant]: Number(e.target.value) }))} /></td>
              <td><button className="sc-link" onClick={() => setOpen(open === r.plant ? null : r.plant)}>{r.edited ? 'Manual' : r.source}</button></td>
              <td className="r">{brl(r.grid)}</td><td>{r.gridSource}</td><td className="r strong">{brl(r.revenue)}</td><td className="r muted">{brl(r.forecast)}</td>
            </tr>
            {open === r.plant && <tr className="panel-row"><td colSpan={8}><ol className="sc-steps">{r.steps.map((s) => <li key={s}>{s}</li>)}</ol></td></tr>}
          </Fragment>
        ))}</tbody>
      </table></div>
    </div>
  );
}

export function BillingFinancePanel() {
  const { billing } = extras();
  const [stages, setStages] = useState<Record<string, string>>({});
  const rows = billing.rows.map((r) => ({ ...r, stage: stages[r.id] ?? r.stage }));
  const advance = (id: string, stage: string) => {
    const i = billing.stages.indexOf(stage);
    if (i < billing.stages.length - 1) setStages((s) => ({ ...s, [id]: billing.stages[i + 1] }));
  };
  const count = (stage: string) => rows.filter((r) => r.stage === stage).length;
  const gross = rows.reduce((s, r) => s + r.gross, 0);
  const accrual = rows.reduce((s, r) => s + r.accrual, 0);
  const journal = () => downloadCsv(`journal-${billing.month}.csv`, [
    ['Document', 'Client', 'Cost centre', 'Account', 'Debit', 'Credit'],
    ...rows.filter((r) => r.stage === 'Posted' || r.stage === 'Paid').flatMap((r) => [
      [r.id, r.client, r.costCentre, 'Accounts receivable', r.gross, 0],
      [r.id, r.client, r.costCentre, 'Energy revenue', 0, r.gross - r.taxes],
      [r.id, r.client, r.costCentre, 'Taxes payable', 0, r.taxes],
    ]),
  ]);
  return (
    <div className="sc">
      <ScreenHead title={`Billing to finance, ${monthLabel(billing.month)}`} level="partial">
        From validated volumes to a posted entry in the finance system. Statements, provisioning and billed against measured checks run in production today. Posting to an accounting system is shown here as a concept, using a journal file.
      </ScreenHead>
      <section className="kpis">
        <Kpi label="Billed this month" value={brlM(gross)} accent />
        <Kpi label="Accrued at month end" value={brlM(accrual)} sub={`${signed(gross - accrual)} true-up`} />
        <Kpi label="Waiting to post" value={String(count('Draft') + count('Validated') + count('Issued'))} />
        <Kpi label="Posted or paid" value={String(count('Posted') + count('Paid'))} sub={`of ${rows.length} statements`} />
      </section>
      <div className="sc-tools">
        {billing.stages.map((s) => <span key={s} className="sc-stage">{s} <b>{count(s)}</b></span>)}
        <button className="chip-btn sc-right" onClick={journal}>Download journal</button>
      </div>
      <div className="tablewrap"><table>
        <thead><tr><th>Statement</th><th>Client</th><th className="r">Plants</th><th className="r">Energy (MWh)</th><th className="r">Billed</th><th className="r">Accrual</th><th className="r">True-up</th><th>Finance doc</th><th>Stage</th><th /></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}>
            <td className="strong">{r.id}</td><td>{r.client}</td><td className="r">{r.plants}</td><td className="r">{n1(r.mwh)}</td><td className="r">{brl(r.gross)}</td><td className="r">{brl(r.accrual)}</td><td className="r">{brl(r.gross - r.accrual)}</td>
            <td>{r.doc || (r.stage === 'Posted' || r.stage === 'Paid' ? 'Pending number' : '')}</td><td>{r.stage}</td>
            <td>{r.stage !== 'Paid' && <button className="chip-btn" onClick={() => advance(r.id, r.stage)}>Advance</button>}</td>
          </tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}
