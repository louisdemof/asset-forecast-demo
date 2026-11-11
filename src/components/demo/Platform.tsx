import { useState } from 'react';
import { extras } from '../../data/extras';
import { Kpi, MaturityTag, n0, ScreenHead, type Maturity } from './ui';

export function RegisterPanel() {
  const { register } = extras();
  const [search, setSearch] = useState('');
  const [done, setDone] = useState<Record<number, boolean>>({});
  const q = search.trim().toLowerCase();
  const rows = register.rows.filter((r) => !q || `${r.plant} ${r.client} ${r.disco}`.toLowerCase().includes(q));
  const docs = ['contract', 'commissioning', 'warranty', 'insurance', 'landTitle'];
  const docLabel: Record<string, string> = { contract: 'Contract', commissioning: 'Commissioning', warranty: 'Warranty', insurance: 'Insurance', landTitle: 'Land title' };
  const avg = register.rows.reduce((s, r) => s + r.completeness, 0) / register.rows.length;
  const pending = register.changes.filter((c, i) => c.action === 'Review' && !done[i]).length;
  return (
    <div className="sc">
      <ScreenHead title="Asset register" level="partial">
        One record per site, kept current by comparing it with monitoring, meter files and invoices. Differences are queued for review instead of being overwritten. The plant register and ownership history run in production. Automatic change detection and document tracking are a concept.
      </ScreenHead>
      <section className="kpis">
        <Kpi label="Sites" value={String(register.rows.length)} sub={`${register.rows.filter((r) => r.status === 'Operating').length} operating`} />
        <Kpi label="Capacity" value={`${n0(register.rows.reduce((s, r) => s + r.mwp, 0))} MWp`} accent />
        <Kpi label="Record completeness" value={`${Math.round(avg)}%`} />
        <Kpi label="Changes to review" value={String(pending)} />
      </section>
      <div className="sc-card">
        <h3>Detected differences</h3>
        <div className="tablewrap"><table>
          <thead><tr><th>Plant</th><th>Field</th><th>In register</th><th>In source</th><th>Source</th><th /></tr></thead>
          <tbody>{register.changes.map((c, i) => (
            <tr key={i}>
              <td className="strong">{c.plant}</td><td>{c.field}</td><td>{c.register}</td><td>{c.source}</td><td>{c.from}</td>
              <td>{c.action === 'Auto-applied' ? 'Applied automatically' : done[i] ? 'Reviewed' : <button className="chip-btn" onClick={() => setDone((d) => ({ ...d, [i]: true }))}>Mark reviewed</button>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </div>
      <div className="sc-tools"><input className="sc-search" placeholder="Search site, client or distributor" aria-label="Search the register" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      <div className="tablewrap sc-scroll"><table>
        <thead><tr><th>Site</th><th>Client</th><th>Distributor</th><th className="r">MWp</th><th className="r">Inverters</th><th>COD</th><th>Status</th>{docs.map((d) => <th key={d}>{docLabel[d]}</th>)}<th className="r">Complete</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.plant}>
            <td className="strong">{r.plant}</td><td>{r.client}</td><td>{r.disco}</td><td className="r">{r.mwp.toFixed(2)}</td><td className="r">{r.inverters}</td><td>{r.cod}</td><td>{r.status}</td>
            {docs.map((d) => <td key={d} className={r.docs[d] ? '' : 'muted'}>{r.docs[d] ? 'Yes' : 'Missing'}</td>)}
            <td className="r">{r.completeness}%</td>
          </tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}

const COVERAGE: { area: string; today: string; level: Maturity | 'planned'; tab?: string }[] = [
  { area: 'Site, meter and invoice ingestion', today: 'Scheduled loads with a retry queue, API limit handling and alerts when a month is incomplete. A direct inverter feed is not built yet.', level: 'partial', tab: 'dados' },
  { area: 'Reconciliation through to billing', today: 'Forecast, metered and invoiced values compared per plant and consumer unit, and billed values per plant and month.', level: 'live', tab: 'pipeline' },
  { area: 'Historical data quality', today: 'File quality checks, name-matching guards between sources and monthly history since 2023. Not yet load-tested at several hundred sites.', level: 'partial', tab: 'pipeline' },
  { area: 'Billing and finance', today: 'Billing statements, month-end provisioning and billed against measured checks. No direct link to an accounting system yet.', level: 'partial', tab: 'billing' },
  { area: 'O&M ticketing', today: 'Incidents and losses are tracked. A request desk with routing, deadlines and transfers runs in production for client requests. Using it for field work orders is a concept.', level: 'partial', tab: 'tickets' },
  { area: 'Asset register automation', today: 'Plant register and ownership history. Automatic change detection is a concept.', level: 'partial', tab: 'register' },
  { area: 'Customer portal', today: 'Launched in November 2026. Client accounts see only their own plants and requests. The team works one queue with routing, reply targets, paused clocks and transfers, plus a client 360 view and service-level reporting. Showing energy figures to clients is the next step.', level: 'partial', tab: 'portal' },
  { area: 'Security and access control', today: 'Personal logins, role-based permissions, row-level security in PostgreSQL, audit trail and access log.', level: 'live' },
  { area: 'Automated testing', today: 'Test suite runs in CI on every push. Golden tests compare results with validated spreadsheets, using data kept outside the repository.', level: 'live' },
  { area: 'Production monitoring', today: 'Data freshness and missing-data alerts, job status and error boundaries. No central metrics or on-call setup yet.', level: 'partial', tab: 'pipeline' },
  { area: 'Azure hosting', today: 'Runs on Vercel and Supabase today. A move to Azure App Service with Entra ID is designed but not done.', level: 'planned' },
  { area: 'Backup and recovery', today: 'No rehearsed restore procedure yet. This would be defined and tested first.', level: 'planned' },
];

export function ReadinessPanel({ go }: { go: (tab: string) => void }) {
  return (
    <div className="sc">
      <ScreenHead title="Platform overview" level="live">
        A solar asset management platform built and run in production on a Brazilian portfolio of about 90 plants, covering forecast, metering, reconciliation and revenue. This demo uses invented data. Each area below shows what runs today and what is still a concept.
      </ScreenHead>
      <div className="sc-card">
        <h3>What exists today</h3>
        <div className="tablewrap"><table>
          <thead><tr><th>Area</th><th>Current state</th><th>Status</th><th /></tr></thead>
          <tbody>{COVERAGE.map((c) => (
            <tr key={c.area}>
              <td className="strong">{c.area}</td><td className="wrap">{c.today}</td>
              <td>{c.level === 'planned' ? <span className="mat mat-planned">Planned</span> : <MaturityTag level={c.level} />}</td>
              <td>{c.tab && <button className="chip-btn" onClick={() => go(c.tab as string)}>Open</button>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </div>
    </div>
  );
}
