import { useMemo, useState } from 'react';
import { extras, type ReconRow } from '../../data/extras';
import { brl, brlM, CHART, Kpi, LineChart, monthLabel, n0, n1, pct, ScreenHead } from './ui';

const EXPECTED_LOSS = 0.0125;
const REASON_BY_STEP: Record<string, string> = {
  'Inverter to meter': 'Meter is further below the inverters than normal losses explain',
  'Meter to invoice': 'Distributor invoice differs from the site meter',
  'Credited to billed': 'Billed volume does not match credited volume',
};

function variances(r: ReconRow) {
  return {
    'Inverter to meter': Math.abs(r.meter / r.inverter - (1 - EXPECTED_LOSS)),
    'Meter to invoice': Math.abs(r.invoice / r.meter - 1),
    'Credited to billed': Math.abs(r.billed / r.credited - 1),
  };
}

export function PipelinePanel() {
  const { pipeline } = extras();
  const [tolerance, setTolerance] = useState(1.5);
  const exceptions = useMemo(() => pipeline.recon.flatMap((r) => {
    const v = Object.entries(variances(r)).sort((a, b) => b[1] - a[1])[0];
    if (v[1] * 100 <= tolerance) return [];
    return [{ ...r, step: v[0], gap: v[1], value: v[1] * r.meter * r.base }];
  }).sort((a, b) => b.value - a.value), [pipeline.recon, tolerance]);
  const atRisk = exceptions.reduce((s, e) => s + e.value, 0);
  const received = pipeline.feeds.reduce((s, f) => s + f.received, 0), expected = pipeline.feeds.reduce((s, f) => s + f.expected, 0);
  const totals = (['inverter', 'meter', 'invoice', 'credited', 'billed'] as const).map((k) => ({ k, v: pipeline.recon.reduce((s, r) => s + r[k], 0) }));
  const lastRun = pipeline.runs[0];
  return (
    <div className="sc">
      <ScreenHead title="Data pipeline and reconciliation" level="partial">
        One view of what arrived, what is missing and where the numbers stop agreeing, from the inverter through to the bill. Scheduled loads, retry queues, missing-data alerts and meter to invoice checks run in production. The direct inverter feed is a concept here.
      </ScreenHead>
      <section className="kpis">
        <Kpi label="Records received" value={pct(received / expected)} sub="of expected, this month" accent />
        <Kpi label="Last run" value={`${n0(lastRun.loaded)} rows`} sub={`${lastRun.rejected} rejected, ${lastRun.minutes} min`} />
        <Kpi label="Open exceptions" value={String(exceptions.length)} sub={`of ${pipeline.recon.length} plants`} />
        <Kpi label="Value under review" value={brlM(atRisk)} />
      </section>
      <div className="sc-card">
        <h3>Source health</h3>
        <div className="tablewrap"><table>
          <thead><tr><th>Source</th><th>Method</th><th className="r">Received</th><th className="r">Expected</th><th className="r">Complete</th><th className="r">Age of latest data</th><th>Status</th></tr></thead>
          <tbody>{pipeline.feeds.map((f) => (
            <tr key={f.name}>
              <td className="strong">{f.name}</td><td>{f.kind}</td><td className="r">{n0(f.received)}</td><td className="r">{n0(f.expected)}</td><td className="r">{pct(f.received / f.expected)}</td>
              <td className="r">{f.lag < 120 ? `${f.lag} min` : f.lag < 2880 ? `${Math.round(f.lag / 60)} h` : `${Math.round(f.lag / 1440)} days`}</td>
              <td><span className={`st st-${f.status === 'Healthy' ? 'ok' : 'warn'}`}>{f.status === 'Healthy' ? '● ' : '▲ '}{f.status}</span></td>
            </tr>
          ))}</tbody>
        </table></div>
      </div>
      <div className="sc-card">
        <h3>Energy from inverter to bill, {monthLabel(extras().closed)}</h3>
        <div className="flow">
          {totals.map((t, i) => (
            <div className="flow-step" key={t.k}>
              <span>{['Inverter', 'Meter', 'Invoice', 'Credited', 'Billed'][i]}</span>
              <b>{n0(t.v)}</b><small>MWh</small>
              {i > 0 && <em>{pct(t.v / totals[i - 1].v - 1)} from previous step</em>}
            </div>
          ))}
        </div>
      </div>
      <div className="sc-card">
        <div className="sc-cardhead">
          <h3>Exceptions to review</h3>
          <label className="sc-slider">Tolerance {tolerance.toFixed(1)}%
            <input type="range" min={0.5} max={5} step={0.1} value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))} />
          </label>
        </div>
        <div className="tablewrap sc-scroll"><table>
          <thead><tr><th>Plant</th><th>Client</th><th>Step</th><th className="r">Gap</th><th className="r">Value</th><th>Likely reason</th></tr></thead>
          <tbody>{exceptions.map((e) => <tr key={e.plant}><td className="strong">{e.plant}</td><td>{e.client}</td><td>{e.step}</td><td className="r">{pct(e.gap)}</td><td className="r">{brl(e.value)}</td><td>{REASON_BY_STEP[e.step]}</td></tr>)}</tbody>
        </table></div>
      </div>
      <div className="sc-card">
        <h3>Daily data completeness by site, last 21 days</h3>
        <div className="heat" role="table">
          {pipeline.heat.map((s) => (
            <div className="heat-row" role="row" key={s.plant}>
              <span>{s.plant}</span>
              {s.days.map((d, i) => <i key={i} title={`${s.plant}, day ${i + 1}: ${d}% complete`} style={{ background: d === 100 ? '#dbe7ee' : d >= 70 ? '#e9b48f' : '#c2571a' }}>{d < 70 ? '!' : ''}</i>)}
            </div>
          ))}
        </div>
        <p className="sc-foot">Light: complete. Orange: partial. Dark with a mark: below 70% complete.</p>
      </div>
    </div>
  );
}

export function PerformancePanel() {
  const { performance: pf } = extras();
  const [group, setGroup] = useState<'plant' | 'client' | 'disco'>('plant');
  const rows = useMemo(() => {
    if (group === 'plant') return [...pf.plants].sort((a, b) => a.ratio - b.ratio).map((p) => ({ key: p.plant, sub: p.client, p50: p.p50, injected: p.injected, lost: p.lostMWh, irr: p.irrDelta as number | null }));
    const m = new Map<string, { p50: number; injected: number; lost: number; n: number }>();
    for (const p of pf.plants) {
      const k = group === 'client' ? p.client : p.disco;
      const c = m.get(k) ?? { p50: 0, injected: 0, lost: 0, n: 0 };
      c.p50 += p.p50; c.injected += p.injected; c.lost += p.lostMWh; c.n++;
      m.set(k, c);
    }
    return [...m].map(([key, c]) => ({ key, sub: `${c.n} plants`, p50: c.p50, injected: c.injected, lost: c.lost, irr: null as number | null })).sort((a, b) => a.injected / a.p50 - b.injected / b.p50);
  }, [pf.plants, group]);
  const last = pf.series[pf.series.length - 1];
  const lostValue = pf.incidents.reduce((s, i) => s + i.lostValue, 0);
  return (
    <div className="sc">
      <ScreenHead title="Performance and O&M losses" level="live">
        Board-level view of how plants ran against their expected yield, with incidents converted into lost energy and lost revenue.
      </ScreenHead>
      <section className="kpis">
        <Kpi label="Generation vs P50" value={pct(last.ratio)} sub={monthLabel(last.month)} accent />
        <Kpi label="Availability" value={pct(last.availability)} />
        <Kpi label="Revenue lost to incidents" value={brlM(lostValue)} sub={`${pf.incidents.length} incidents since June`} />
        <Kpi label="Incidents still open" value={String(pf.incidents.filter((i) => i.open).length)} />
      </section>
      <div className="sc-card">
        <h3>Portfolio generation as a share of P50</h3>
        <LineChart labels={pf.series.map((s) => monthLabel(s.month))} format={(v) => pct(v, 0)} series={[{ name: 'Generation vs P50', color: CHART.blue, values: pf.series.map((s) => s.ratio) }]} />
      </div>
      <div className="sc-tools">
        <span>Group by</span>
        {([['plant', 'Plant'], ['client', 'Client'], ['disco', 'Distributor']] as const).map(([k, l]) => <button key={k} className={`chip-btn${group === k ? ' on' : ''}`} onClick={() => setGroup(k)}>{l}</button>)}
      </div>
      <div className="tablewrap sc-scroll"><table>
        <thead><tr><th>{group === 'plant' ? 'Plant' : group === 'client' ? 'Client' : 'Distributor'}</th><th /><th className="r">P50 (MWh)</th><th className="r">Injected (MWh)</th><th className="r">vs P50</th><th className="r">Irradiance vs last year</th><th className="r">Incident loss (MWh)</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.key}><td className="strong">{r.key}</td><td className="muted">{r.sub}</td><td className="r">{n1(r.p50)}</td><td className="r">{n1(r.injected)}</td><td className="r">{pct(r.injected / r.p50)}</td><td className="r">{r.irr == null ? '' : pct(r.irr)}</td><td className="r">{n1(r.lost)}</td></tr>)}</tbody>
      </table></div>
      <div className="sc-card">
        <h3>Largest incidents</h3>
        <div className="tablewrap sc-scroll"><table>
          <thead><tr><th>Incident</th><th>Plant</th><th>Cause</th><th>Start</th><th className="r">Days</th><th className="r">Lost (MWh)</th><th className="r">Lost revenue</th><th>Status</th></tr></thead>
          <tbody>{pf.incidents.slice(0, 15).map((i) => <tr key={i.id}><td className="strong">{i.id}</td><td>{i.plant}</td><td>{i.cause}</td><td>{i.start}</td><td className="r">{i.days}</td><td className="r">{n1(i.lostMWh)}</td><td className="r">{brl(i.lostValue)}</td><td>{i.open ? 'Open' : 'Closed'}</td></tr>)}</tbody>
        </table></div>
      </div>
    </div>
  );
}

export function TicketsPanel() {
  const { tickets } = extras();
  const [states, setStates] = useState<Record<string, string>>({});
  const [team, setTeam] = useState('All');
  const rows = tickets.rows.map((t) => ({ ...t, state: states[t.id] ?? t.state }));
  const visible = rows.filter((t) => team === 'All' || t.team === team);
  const open = rows.filter((t) => t.state !== 'Resolved');
  const breached = open.filter((t) => t.ageHours > t.slaHours);
  const advance = (id: string, state: string) => {
    const i = tickets.states.indexOf(state);
    if (i < tickets.states.length - 1) setStates((s) => ({ ...s, [id]: tickets.states[i + 1] }));
  };
  return (
    <div className="sc">
      <ScreenHead title="O&M ticketing" level="concept">
        Alerts and reconciliation breaks become tickets with an owner, a response deadline and the revenue lost per day, so field work can be ordered by money at stake. Incident and loss tracking already run in production, and so does the request desk this would build on (Customer portal, Service desk). Field work orders are a concept.
      </ScreenHead>
      <section className="kpis">
        <Kpi label="Open tickets" value={String(open.length)} accent />
        <Kpi label="Past response deadline" value={String(breached.length)} />
        <Kpi label="Revenue at stake per day" value={brl(open.reduce((s, t) => s + t.valuePerDay, 0))} />
        <Kpi label="Created automatically" value={pct(rows.filter((t) => t.source !== 'Manual').length / rows.length, 0)} />
      </section>
      <div className="sc-tools">
        <span>Team</span>
        {['All', ...new Set(tickets.rows.map((t) => t.team))].map((t) => <button key={t} className={`chip-btn${t === team ? ' on' : ''}`} onClick={() => setTeam(t)}>{t}</button>)}
      </div>
      <div className="board">
        {tickets.states.map((state) => (
          <div className="board-col" key={state}>
            <h3>{state} <b>{visible.filter((t) => t.state === state).length}</b></h3>
            {visible.filter((t) => t.state === state).sort((a, b) => b.valuePerDay - a.valuePerDay).map((t) => (
              <article className="ticket" key={t.id}>
                <header><span>{t.id}</span><span className={`prio prio-${t.priority}`}>{t.priority}</span></header>
                <b>{t.title}</b>
                <p>{t.plant} · {t.team}</p>
                <footer>
                  <span>{brl(t.valuePerDay)} per day</span>
                  {t.state !== 'Resolved' && t.ageHours > t.slaHours && <span className="st st-warn">▲ Late</span>}
                  {t.state !== 'Resolved' && <button className="chip-btn" onClick={() => advance(t.id, t.state)}>Move on</button>}
                </footer>
              </article>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
