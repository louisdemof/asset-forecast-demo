import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { extras, type Client360, type ClientUnit, type ReqStatus, type Route, type ServiceRequest } from '../../data/extras';
import { DATA_INFO } from '../../lib/dataInfo';
import { compPortfolio, injections, useDataVersion } from './PlantMonthly';
import { brl, brlM, CHART, downloadCsv, Kpi, LineChart, MaturityTag, monthLabel, n0, n1, pct, ScreenHead, Spark } from './ui';

/* ------------------------------------------------------------------ clock */
// The data is frozen at a fixed moment; the demo clock runs on from there.
const LOADED = Date.now();
const nowMs = () => Date.parse(extras().service.now) + (Date.now() - LOADED);
const nowIso = () => new Date(nowMs()).toISOString();
const HOUR = 3_600_000, DAY = 24 * HOUR;
const PAUSED: ReqStatus[] = ['awaiting_client', 'awaiting_third_party', 'answered'];
const ME = 'Ana Ribeiro';
const OPEN_MONTH = DATA_INFO.MeterHub.parcial;

export const STATUS_LABEL: Record<ReqStatus, string> = {
  new: 'New', in_review: 'In review', awaiting_client: 'Awaiting client', awaiting_third_party: 'Awaiting third party', answered: 'Answered', closed: 'Closed',
};
const CLIENT_STATUS: Record<ReqStatus, string> = {
  new: 'In progress', in_review: 'In progress', awaiting_third_party: 'In progress', awaiting_client: 'Awaiting you', answered: 'Answered', closed: 'Closed',
};
const DIRECTION: Record<ServiceRequest['direction'], string> = { client_asked: 'Client asked', team_asked: 'We asked the client', internal: 'Internal follow-up' };
const ORIGIN: Record<ServiceRequest['origin'], string> = { portal: 'Opened in the portal', team: 'Registered by the team', imported: 'Imported from spreadsheet' };

/* -------------------------------------------------------------------- SLA */
/** Business hours (Mon to Fri, 24 h a day) between two instants. */
function businessHours(from: number, to: number) {
  let ms = 0, t = from;
  while (t < to) {
    const d = new Date(t);
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
    const end = Math.min(next, to);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) ms += end - t;
    t = end;
  }
  return ms / HOUR;
}
type Situation = 'on_time' | 'due_today' | 'late' | 'paused' | 'closed_on_time' | 'closed_late';
const SITUATION: Record<Situation, string> = { on_time: 'On time', due_today: 'Due today', late: 'Past deadline', paused: 'Clock paused', closed_on_time: 'Closed on time', closed_late: 'Closed late' };
interface Sla { replyH: number | null; replyOk: boolean | null; replyLate: boolean; activeDays: number; pausedDays: number; deadline: string; situation: Situation }

function sla(r: ServiceRequest, route: Route | undefined, now = nowMs()): Sla {
  const created = Date.parse(r.created);
  let replyH: number | null = null, replyOk: boolean | null = null, replyLate = false;
  if (r.origin !== 'imported' && r.direction === 'client_asked' && route) {
    if (r.firstReply) { replyH = businessHours(created, Date.parse(r.firstReply)); replyOk = replyH <= route.firstReplyHours; }
    else if (r.status !== 'closed') replyLate = businessHours(created, now) > route.firstReplyHours;
  }
  const running = r.pauseSince && PAUSED.includes(r.status) ? Math.max(0, now - Date.parse(r.pauseSince)) : 0;
  const pausedMs = r.pausedSec * 1000 + running;
  const end = r.closed ? Date.parse(r.closed) : now;
  const deadline = new Date(Date.parse(`${r.deadline}T12:00:00Z`) + Math.round(pausedMs / DAY) * DAY).toISOString().slice(0, 10);
  const today = new Date(now - 3 * HOUR).toISOString().slice(0, 10);
  let situation: Situation;
  if (r.status === 'closed') situation = r.closed && r.closed.slice(0, 10) > deadline ? 'closed_late' : 'closed_on_time';
  else if (PAUSED.includes(r.status)) situation = 'paused';
  else if (deadline < today) situation = 'late';
  else if (deadline === today) situation = 'due_today';
  else situation = 'on_time';
  return { replyH, replyOk, replyLate, activeDays: Math.max(0, (end - created - pausedMs) / DAY), pausedDays: pausedMs / DAY, deadline, situation };
}
const fmtH = (h: number | null) => (h == null ? '–' : h < 24 ? `${Math.max(1, Math.round(h))} h` : `${n1(h / 24)} working days`);
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '–');
const fmtWhen = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
const age = (iso: string) => { const d = (nowMs() - Date.parse(iso)) / DAY; return d < 1 ? `${Math.max(1, Math.round(d * 24))} h` : `${Math.round(d)} d`; };
const SlaBadge = ({ s }: { s: Sla }) => <span className={`sla sla-${s.situation}`} title={`Deadline ${fmtDate(s.deadline)} · ${n1(s.activeDays)} days with the team`}>{SITUATION[s.situation]}</span>;

/* ------------------------------------------------------------------ store */
interface Note { id: number; at: string; text: string; no?: number; read: boolean }
interface Store {
  requests: ServiceRequest[]; clients: Client360[]; routing: Route[]; notes: Note[]; selected: number | null;
  select: (no: number | null) => void;
  patch: (no: number, fn: (r: ServiceRequest) => Partial<ServiceRequest>) => void;
  setStatus: (no: number, s: ReqStatus) => void;
  transfer: (no: number, area: string, owner: string, reason: string) => void;
  message: (no: number, type: 'client' | 'reply' | 'internal', author: string, text: string, file?: { name: string; size: number }) => void;
  open: (r: Omit<ServiceRequest, 'no' | 'created' | 'deadline' | 'pausedSec' | 'pauseSince' | 'firstReply' | 'closed' | 'events' | 'files' | 'messages' | 'status' | 'area' | 'owner' | 'sensitivity' | 'visible'> & { text: string; author: string; file?: { name: string; size: number }; visible?: boolean; status?: ReqStatus }) => number;
  notify: (text: string, no?: number) => void;
  readAll: () => void;
  client: (name: string, fn: (c: Client360) => Partial<Client360>) => void;
  route: (id: string, p: Partial<Route>) => void;
}

function initialNotes(rs: ServiceRequest[]): Note[] {
  const recent = rs.filter((r) => r.status !== 'closed' && r.messages.length && r.messages[r.messages.length - 1].type === 'client'
    && nowMs() - Date.parse(r.messages[r.messages.length - 1].at) < 4 * DAY);
  return recent.slice(0, 6).map((r, i) => ({ id: i, at: r.messages[r.messages.length - 1].at, no: r.no, read: false, text: r.status === 'new' ? `New request #${r.no} from ${r.client}` : `${r.client} replied on #${r.no}` }));
}

let noteId = 100;
// Created on first use: the data files are only in memory after the app has loaded them.
const makeStore = () => create<Store>((set, get) => {
  const sv = extras().service;
  const requests: ServiceRequest[] = structuredClone(sv.requests);
  return {
    requests, clients: structuredClone(sv.clients), routing: structuredClone(sv.routing), notes: initialNotes(requests), selected: null,
    select: (no) => set({ selected: no }),
    patch: (no, fn) => set((s) => ({ requests: s.requests.map((r) => (r.no === no ? { ...r, ...fn(r) } : r)) })),
    setStatus: (no, status) => get().patch(no, (r) => {
      if (r.status === status) return {};
      const now = nowMs();
      let pausedSec = r.pausedSec, pauseSince = r.pauseSince;
      if (PAUSED.includes(r.status) && r.pauseSince) { pausedSec += Math.round((now - Date.parse(r.pauseSince)) / 1000); pauseSince = null; }
      if (PAUSED.includes(status)) pauseSince = new Date(now).toISOString();
      return { status, pausedSec, pauseSince, closed: status === 'closed' ? new Date(now).toISOString() : null, events: [...r.events, { at: nowIso(), text: `Status changed to ${STATUS_LABEL[status].toLowerCase()}` }] };
    }),
    transfer: (no, area, owner, reason) => get().patch(no, (r) => ({
      area, owner, events: [...r.events, { at: nowIso(), text: `Transferred from ${r.area}${r.owner ? ` (${r.owner})` : ''} to ${area} (${owner})${reason ? `: ${reason}` : ''}` }],
    })),
    message: (no, type, author, text, file) => {
      get().patch(no, (r) => ({
        messages: [...r.messages, { type, author, text, at: nowIso() }],
        files: file ? [...r.files, { ...file, by: author, visible: type !== 'internal' }] : r.files,
        firstReply: type === 'reply' && !r.firstReply ? nowIso() : r.firstReply,
        owner: type !== 'client' && !r.owner ? author : r.owner,
      }));
      const r = get().requests.find((x) => x.no === no)!;
      if (type === 'client') {
        if (r.status === 'awaiting_client' || r.status === 'answered') get().setStatus(no, 'in_review');
        get().notify(`${r.client} replied on #${no}`, no);
      } else if (r.status === 'new') get().setStatus(no, 'in_review');
    },
    open: (input) => {
      const route = get().routing.find((x) => x.id === input.category)!;
      const no = Math.max(...get().requests.map((r) => r.no)) + 1;
      const created = nowIso();
      const fromClient = input.direction === 'client_asked' && input.origin === 'portal';
      const r: ServiceRequest = {
        no, client: input.client, plant: input.plant, category: input.category, subject: input.subject, direction: input.direction, origin: input.origin,
        status: input.status ?? (input.direction === 'team_asked' ? 'awaiting_client' : fromClient ? 'new' : 'in_review'),
        area: route.area, owner: fromClient ? null : ME, created, firstReply: null, closed: null,
        deadline: new Date(nowMs() + route.deadlineDays * DAY).toISOString().slice(0, 10), pausedSec: 0,
        pauseSince: input.direction === 'team_asked' ? created : null, sensitivity: 'normal', visible: input.visible ?? input.direction !== 'internal',
        messages: [{ type: input.direction === 'client_asked' ? 'client' : input.direction === 'team_asked' ? 'reply' : 'internal', author: input.author, text: input.text, at: created }],
        files: input.file ? [{ ...input.file, by: input.author, visible: input.direction !== 'internal' }] : [],
        events: [{ at: created, text: `${ORIGIN[input.origin]}. Routed to ${route.area}${fromClient ? ` (default owner ${route.owner})` : ''}` }],
      };
      set((s) => ({ requests: [r, ...s.requests] }));
      if (fromClient) get().notify(`New request #${no} from ${input.client}`, no);
      return no;
    },
    notify: (text, no) => set((s) => ({ notes: [{ id: noteId++, at: nowIso(), text, no, read: false }, ...s.notes].slice(0, 20) })),
    readAll: () => set((s) => ({ notes: s.notes.map((n) => ({ ...n, read: true })) })),
    client: (name, fn) => set((s) => ({ clients: s.clients.map((c) => (c.client === name ? { ...c, ...fn(c) } : c)) })),
    route: (id, p) => set((s) => ({ routing: s.routing.map((r) => (r.id === id ? { ...r, ...p } : r)) })),
  };
});
let store: ReturnType<typeof makeStore> | null = null;
function useDesk(): Store;
function useDesk<T>(sel: (s: Store) => T): T;
function useDesk<T>(sel?: (s: Store) => T) {
  return (store ??= makeStore())(sel ?? ((s: Store) => s as unknown as T));
}
const useRoute = () => { const routing = useDesk((s) => s.routing); return (id: string) => routing.find((r) => r.id === id); };

function FilePick({ file, setFile }: { file: File | null; setFile: (f: File | null) => void }) {
  const [err, setErr] = useState('');
  return (
    <label className="pt-file">
      <input type="file" onChange={(e) => {
        const f = e.target.files?.[0] ?? null;
        if (f && f.size > 20 * 1024 * 1024) { setErr(`${f.name} is over 20 MB`); setFile(null); return; }
        setErr(''); setFile(f);
      }} />
      <small className="muted">{err || (file ? `${file.name} stays in this browser` : 'Attach a file (up to 20 MB)')}</small>
    </label>
  );
}

/* ============================================================ CLIENT VIEW */
export function ClientPortalPanel() {
  const { requests, clients } = useDesk();
  const open = useDesk((s) => s.open);
  const [clientName, setClientName] = useState(clients.find((c) => c.client === 'TELMO')?.client ?? clients[0].client);
  const [view, setView] = useState<'requests' | 'plants' | 'energy'>('requests');
  const [current, setCurrent] = useState<number | 'new' | null>(null);
  const [plantSel, setPlantSel] = useState<string | null>(null);
  const c = clients.find((x) => x.client === clientName)!;
  const user = c.accesses[0];
  const mine = requests.filter((r) => r.client === clientName && r.visible);
  const visiblePlants = c.plants.filter((p) => p.visible);
  const awaiting = mine.filter((r) => r.status === 'awaiting_client').length;
  return (
    <div className="sc">
      <ScreenHead title="Client view" level="partial">
        Launched in November 2026, with the first client accounts being set up. This is what a client sees after signing in with their own account: only their plants and the requests they can see. They open a request, attach files, follow the answers and close it. Internal notes, owners, sensitivity flags and hidden items never reach this view. Open a request here, then look for it in the Service desk.
      </ScreenHead>
      <div className="pt-signed">
        <span>Signed in as <b>{user.name}</b> · {c.client}</span>
        <label className="sc-field">Switch client (demo only)
          <select value={clientName} onChange={(e) => { setClientName(e.target.value); setCurrent(null); setPlantSel(null); }}>{clients.map((x) => <option key={x.client}>{x.client}</option>)}</select>
        </label>
      </div>
      <nav className="pt-tabs">
        <button className={view === 'requests' ? 'on' : ''} onClick={() => setView('requests')}>Requests{awaiting > 0 && <b className="pt-dot">{awaiting}</b>}</button>
        <button className={view === 'plants' ? 'on' : ''} onClick={() => setView('plants')}>My plants</button>
        <button className={view === 'energy' ? 'on' : ''} onClick={() => setView('energy')}>Energy and savings</button>
      </nav>

      {view === 'requests' && (
        <div className="pt-split">
          <div className="sc-card">
            <div className="sc-cardhead"><h3>Your requests</h3><button className="pc-btn" onClick={() => setCurrent('new')}>New request</button></div>
            {mine.length === 0 && <p className="muted">No requests yet.</p>}
            <ul className="pt-list">
              {mine.map((r) => (
                <li key={r.no} className={current === r.no ? 'on' : ''} onClick={() => setCurrent(r.no)}>
                  <div><b>#{r.no} {r.subject}</b><small>{r.plant ?? 'General'} · opened {fmtDate(r.created)}</small></div>
                  <span className={`pt-cst pt-cst-${r.status}`}>{CLIENT_STATUS[r.status]}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="sc-card">
            {current === 'new' && <NewClientRequest client={c} author={user.name} onDone={(no) => setCurrent(no)} open={open} />}
            {typeof current === 'number' && <ClientThread no={current} author={user.name} />}
            {current == null && <p className="muted">Select a request or open a new one.</p>}
          </div>
        </div>
      )}

      {view === 'plants' && (
        <div className="sc-card">
          <h3>Your plants</h3>
          <div className="tablewrap"><table>
            <thead><tr><th>Plant</th><th>Distributor</th><th className="r">MWac</th><th>Commercial operation</th><th>Contract start</th><th>Contract end</th><th className="r">Term</th><th>Status</th></tr></thead>
            <tbody>{visiblePlants.map((p) => (
              <tr key={p.plant} className={`pt-row${plantSel === p.plant ? ' on' : ''}`} onClick={() => setPlantSel(p.plant)}><td className="strong"><button className="sc-link">{p.plant}</button></td><td>{p.disco}</td><td className="r">{p.mwac.toFixed(1)}</td><td>{p.cod ? monthLabel(p.cod) : '–'}</td><td>{p.start ? monthLabel(p.start) : '–'}</td><td>{p.end ? monthLabel(p.end) : '–'}</td><td className="r">{p.termYears} years</td><td>{p.connection}</td></tr>
            ))}</tbody>
          </table></div>
          <p className="sc-foot">Only plants in commercial operation that the team has released to this client are listed. Click a plant to see its consumer units.</p>
        </div>
      )}
      {view === 'plants' && plantSel && <PlantPage c={c} plant={plantSel} audience="client" onClose={() => setPlantSel(null)} />}

      {view === 'energy' && <ClientEnergyPreview client={clientName} />}
    </div>
  );
}

function NewClientRequest({ client, author, open, onDone }: { client: Client360; author: string; open: Store['open']; onDone: (no: number) => void }) {
  const routing = useDesk((s) => s.routing);
  const [category, setCategory] = useState('');
  const [plant, setPlant] = useState('');
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const ok = category && subject.trim() && text.trim();
  return (
    <form className="pt-form" onSubmit={(e) => {
      e.preventDefault();
      if (!ok) return;
      onDone(open({ client: client.client, plant: plant || null, category, subject: subject.trim(), text: text.trim(), author, direction: 'client_asked', origin: 'portal', file: file ? { name: file.name, size: file.size } : undefined }));
    }}>
      <h3>New request</h3>
      <label>Topic<select value={category} onChange={(e) => setCategory(e.target.value)}><option value="">Choose…</option>{routing.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select></label>
      <label>Plant<select value={plant} onChange={(e) => setPlant(e.target.value)}><option value="">General, not about one plant</option>{client.plants.filter((p) => p.visible).map((p) => <option key={p.plant}>{p.plant}</option>)}</select></label>
      <label>Subject<input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="For example: credits missing on one unit" /></label>
      <label>Message<textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} /></label>
      <FilePick file={file} setFile={setFile} />
      <div className="pt-actions"><button className="pc-btn" disabled={!ok}>Send request</button></div>
    </form>
  );
}

function ClientThread({ no, author }: { no: number; author: string }) {
  const r = useDesk((s) => s.requests.find((x) => x.no === no))!;
  const { message, setStatus } = useDesk();
  const route = useRoute()(r.category);
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const msgs = r.messages.filter((m) => m.type !== 'internal');
  return (
    <div className="pt-thread">
      <div className="sc-cardhead"><h3>#{r.no} {r.subject}</h3><span className={`pt-cst pt-cst-${r.status}`}>{CLIENT_STATUS[r.status]}</span></div>
      <p className="muted pt-meta">{route?.label} · {r.plant ?? 'General'} · opened {fmtDate(r.created)}</p>
      {msgs.map((m, i) => (
        <div key={i} className={`pt-msg ${m.type === 'client' ? 'me' : 'them'}`}>
          <small>{m.type === 'client' ? m.author : `${m.author}, asset team`} · {fmtWhen(m.at)}</small>
          <p>{m.text}</p>
        </div>
      ))}
      {r.files.filter((f) => f.visible).length > 0 && (
        <div className="pt-files">{r.files.filter((f) => f.visible).map((f) => <span key={f.name} className="pt-filechip">{f.name} · {n0(f.size / 1000)} kB</span>)}</div>
      )}
      {r.status !== 'closed' ? (
        <form className="pt-form" onSubmit={(e) => { e.preventDefault(); if (!text.trim()) return; message(no, 'client', author, text.trim(), file ? { name: file.name, size: file.size } : undefined); setText(''); setFile(null); }}>
          <label>Reply<textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} /></label>
          <FilePick file={file} setFile={setFile} />
          <div className="pt-actions">
            <button type="button" className="chip-btn" onClick={() => setStatus(no, 'closed')}>Close request</button>
            <button className="pc-btn" disabled={!text.trim()}>Send</button>
          </div>
        </form>
      ) : <p className="muted">This request is closed.</p>}
    </div>
  );
}

function ClientEnergyPreview({ client }: { client: string }) {
  const p = extras().portal.find((x) => x.client === client);
  if (!p) return <div className="sc-card"><p className="muted">No energy figures for this client.</p></div>;
  const saving = p.months.reduce((s, m) => s + m.saving, 0);
  const mwh = p.months.reduce((s, m) => s + m.mwh, 0);
  return (
    <>
      <div className="pt-note"><MaturityTag level="concept" /> Not shown to clients yet. The team already sees these figures per unit in Client 360. A month will be published here only after the team has validated it.</div>
      <section className="kpis">
        <Kpi label="Savings this year" value={brlM(saving)} accent />
        <Kpi label="Clean energy received" value={`${n0(mwh)} MWh`} />
        <Kpi label="Latest invoice" value={brl(p.invoices[0].amount)} sub={p.invoices[0].status} />
      </section>
      <div className="sc-card">
        <h3>Monthly savings</h3>
        <LineChart labels={p.months.map((m) => monthLabel(m.month))} format={brlM} zero series={[{ name: 'Savings', color: CHART.blue, values: p.months.map((m) => m.saving) }]} />
      </div>
    </>
  );
}

/* =========================================================== SERVICE DESK */
type Filter = 'open' | 'new' | 'mine' | 'late' | 'reply_late' | 'awaiting_client' | 'awaiting_third_party' | 'all';
const FILTERS: { id: Filter; label: string; alert?: boolean; hint?: string }[] = [
  { id: 'open', label: 'Open' }, { id: 'new', label: 'New, not triaged' }, { id: 'mine', label: 'With me' },
  { id: 'late', label: 'Past deadline', alert: true, hint: 'The deadline moves on while the clock is paused' },
  { id: 'reply_late', label: 'First reply overdue', alert: true }, { id: 'awaiting_client', label: 'Awaiting client' },
  { id: 'awaiting_third_party', label: 'Awaiting third party' }, { id: 'all', label: 'All' },
];

export function ServiceDeskPanel() {
  const { requests, selected, select, notes, readAll } = useDesk();
  const routeOf = useRoute();
  const clients = useDesk((s) => s.clients);
  const [filter, setFilter] = useState<Filter>('open');
  const [area, setArea] = useState('All');
  const [client, setClient] = useState('All');
  const [q, setQ] = useState('');
  const [marked, setMarked] = useState<Set<number>>(new Set());
  const [registering, setRegistering] = useState(false);
  const [bell, setBell] = useState(false);
  const withSla = requests.map((r) => ({ r, s: sla(r, routeOf(r.category)) }));
  const test: Record<Filter, (x: { r: ServiceRequest; s: Sla }) => boolean> = {
    open: ({ r }) => r.status !== 'closed', new: ({ r }) => r.status === 'new', mine: ({ r }) => r.owner === ME && r.status !== 'closed',
    late: ({ s }) => s.situation === 'late', reply_late: ({ s }) => s.replyLate, awaiting_client: ({ r }) => r.status === 'awaiting_client',
    awaiting_third_party: ({ r }) => r.status === 'awaiting_third_party', all: () => true,
  };
  const ql = q.trim().toLowerCase();
  const rows = withSla.filter(test[filter]).filter(({ r }) => (area === 'All' || r.area === area) && (client === 'All' || r.client === client)
    && (!ql || `${r.no} ${r.subject} ${r.client} ${r.plant ?? ''}`.toLowerCase().includes(ql)));
  const unread = notes.filter((n) => !n.read).length;
  const areas = [...new Set(extras().service.team.map((t) => t.area))];
  const sel = withSla.find((x) => x.r.no === selected);
  return (
    <div className="sc">
      <ScreenHead title="Service desk" level="live">
        One queue for every client request, whether it came through the portal, by phone or by e-mail, plus the follow-ups the team owes clients. Each topic routes to an area and a default owner, with a first-reply target and a resolution deadline. The clock pauses while the team waits on the client or a third party. Transfers keep a trail, and internal notes stay internal, so the history becomes a record of how each client was handled.
      </ScreenHead>
      <div className="sc-tools">
        {FILTERS.map((f) => {
          const n = withSla.filter(test[f.id]).length;
          return <button key={f.id} title={f.hint} className={`pt-kpi${filter === f.id ? ' on' : ''}${f.alert && n ? ' alert' : ''}`} onClick={() => setFilter(f.id)}><b>{n}</b>{f.label}</button>;
        })}
        <div className="pt-bellwrap sc-right">
          <button className="pt-bell" aria-label={`${unread} notifications`} onClick={() => { setBell(!bell); }}>Notifications{unread > 0 && <b className="pt-dot">{unread}</b>}</button>
          {bell && (
            <div className="pt-belllist">
              <div className="sc-cardhead"><b>Notifications</b><button className="sc-link" onClick={readAll}>Mark all read</button></div>
              {notes.length === 0 && <p className="muted">Nothing new.</p>}
              {notes.map((n) => <button key={n.id} className={`pt-note-i${n.read ? '' : ' unread'}`} onClick={() => { if (n.no) select(n.no); setBell(false); }}>{n.text}<small>{fmtWhen(n.at)}</small></button>)}
            </div>
          )}
        </div>
      </div>
      <div className="sc-tools">
        <label className="sc-field">Area<select value={area} onChange={(e) => setArea(e.target.value)}><option>All</option>{areas.map((a) => <option key={a}>{a}</option>)}</select></label>
        <label className="sc-field">Client<select value={client} onChange={(e) => setClient(e.target.value)}><option>All</option>{clients.map((c) => <option key={c.client}>{c.client}</option>)}</select></label>
        <input className="sc-search" placeholder="Search number, subject, client or plant" aria-label="Search requests" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="pc-btn sc-right" onClick={() => setRegistering(true)}>Register request</button>
      </div>
      {registering && <RegisterRequest onClose={(no) => { setRegistering(false); if (no) select(no); }} />}
      {marked.size > 0 && <BulkBar marked={marked} clear={() => setMarked(new Set())} />}
      <div className="tablewrap sc-scroll"><table>
        <thead><tr>
          <th><input type="checkbox" aria-label="Select all" checked={rows.length > 0 && rows.every(({ r }) => marked.has(r.no))} onChange={(e) => setMarked(e.target.checked ? new Set(rows.map(({ r }) => r.no)) : new Set())} /></th>
          <th>#</th><th>Client · plant</th><th>Subject</th><th>Topic</th><th>Area · owner</th><th>Status</th><th>Deadline</th><th className="r">Age</th>
        </tr></thead>
        <tbody>{rows.map(({ r, s }) => (
          <tr key={r.no} className={`pt-row${selected === r.no ? ' on' : ''}`} onClick={() => select(r.no)}>
            <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Select #${r.no}`} checked={marked.has(r.no)} onChange={(e) => { const m = new Set(marked); if (e.target.checked) m.add(r.no); else m.delete(r.no); setMarked(m); }} /></td>
            <td className="strong">#{r.no}</td>
            <td>{r.client}<br /><small className="muted">{r.plant ?? 'General'}</small></td>
            <td className="wrap">{r.sensitivity === 'high' && <span className="pt-sens" title="High sensitivity">● </span>}{r.subject}{!r.visible && <span className="pt-hidden">Hidden from client</span>}{s.replyLate && <span className="pt-hidden alert">First reply overdue</span>}</td>
            <td>{routeOf(r.category)?.label}</td>
            <td>{r.area}<br /><small className="muted">{r.owner ?? 'Not assigned'}</small></td>
            <td>{STATUS_LABEL[r.status]}</td>
            <td><SlaBadge s={s} /></td>
            <td className="r" style={{ whiteSpace: 'nowrap' }}>{age(r.created)}</td>
          </tr>
        ))}</tbody>
      </table></div>
      {sel && <RequestDetail r={sel.r} s={sel.s} />}
    </div>
  );
}

function TransferForm({ initialArea, onSend, onCancel, count }: { initialArea: string; onSend: (area: string, owner: string, reason: string) => void; onCancel: () => void; count?: number }) {
  const team = extras().service.team;
  const [area, setArea] = useState(initialArea);
  const [owner, setOwner] = useState(team.find((t) => t.area === initialArea)?.name ?? team[0].name);
  const [reason, setReason] = useState('');
  return (
    <div className="pt-inline">
      <label className="sc-field">Area<select value={area} onChange={(e) => { setArea(e.target.value); setOwner(team.find((t) => t.area === e.target.value)?.name ?? owner); }}>{[...new Set(team.map((t) => t.area))].map((a) => <option key={a}>{a}</option>)}</select></label>
      <label className="sc-field">Owner<select value={owner} onChange={(e) => setOwner(e.target.value)}>{team.map((t) => <option key={t.name}>{t.name}</option>)}</select></label>
      <input className="sc-search" placeholder="Reason (kept in the trail)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button className="pc-btn" disabled={!reason.trim()} onClick={() => onSend(area, owner, reason.trim())}>Transfer{count ? ` ${count}` : ''}</button>
      <button className="chip-btn" onClick={onCancel}>Cancel</button>
    </div>
  );
}

function BulkBar({ marked, clear }: { marked: Set<number>; clear: () => void }) {
  const { transfer, setStatus, patch } = useDesk();
  const [moving, setMoving] = useState(false);
  const [done, setDone] = useState('');
  const each = (label: string, fn: (no: number) => void) => { marked.forEach(fn); setDone(`${label}: ${marked.size}`); clear(); };
  return (
    <div className="pt-bulk">
      <b>{marked.size} selected</b>
      <button className="chip-btn" onClick={() => setMoving(true)}>Transfer…</button>
      <select aria-label="Set status" value="" onChange={(e) => { const v = e.target.value as ReqStatus; if (v) each(`Status set to ${STATUS_LABEL[v].toLowerCase()}`, (no) => setStatus(no, v)); }}>
        <option value="">Set status…</option>{(Object.keys(STATUS_LABEL) as ReqStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
      </select>
      <button className="chip-btn" onClick={() => each('Shown to client', (no) => patch(no, () => ({ visible: true })))}>Show to client</button>
      <button className="chip-btn" onClick={() => each('Hidden from client', (no) => patch(no, () => ({ visible: false })))}>Hide from client</button>
      <button className="sc-link" onClick={clear}>Clear</button>
      {done && <span className="muted">{done}</span>}
      {moving && <TransferForm initialArea="Asset" count={marked.size} onCancel={() => setMoving(false)} onSend={(a, o, why) => { each('Transferred', (no) => transfer(no, a, o, why)); setMoving(false); }} />}
    </div>
  );
}

function RequestDetail({ r, s }: { r: ServiceRequest; s: Sla }) {
  const { setStatus, transfer, patch, message, select } = useDesk();
  const route = useRoute()(r.category);
  const [moving, setMoving] = useState(false);
  const [mode, setMode] = useState<'reply' | 'internal'>('reply');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  return (
    <div className="sc-card pt-detail">
      <div className="sc-cardhead">
        <h3>#{r.no} {r.subject}</h3>
        <button className="sc-link" onClick={() => select(null)}>Close panel</button>
      </div>
      <p className="muted pt-meta">{r.client} · {r.plant ?? 'General'} · {route?.label} · {DIRECTION[r.direction]} · {ORIGIN[r.origin]}</p>
      <div className="pt-stats">
        <div><small>First reply</small><b>{fmtH(s.replyH)}</b><small>{route && r.direction === 'client_asked' && r.origin !== 'imported' ? `target ${route.firstReplyHours} h` : 'not measured'}</small></div>
        <div><small>Days with the team</small><b>{n1(s.activeDays)}</b></div>
        <div title="Time awaiting the client or a third party, or answered: not counted"><small>Clock paused</small><b>{n1(s.pausedDays)} d</b></div>
        <div><small>Deadline</small><b>{fmtDate(s.deadline)}</b><SlaBadge s={s} /></div>
      </div>
      <div className="pt-controls">
        <label className="sc-field">Status<select value={r.status} onChange={(e) => setStatus(r.no, e.target.value as ReqStatus)}>{(Object.keys(STATUS_LABEL) as ReqStatus[]).map((k) => <option key={k} value={k}>{STATUS_LABEL[k]}</option>)}</select></label>
        <span>{r.area} · {r.owner ?? 'Not assigned'}</span>
        {r.owner !== ME && <button className="chip-btn" onClick={() => transfer(r.no, r.area, ME, 'Taken over')}>Take it</button>}
        <button className="chip-btn" onClick={() => setMoving(true)}>Transfer…</button>
        <label className="sc-field" title="Internal: how much this weighs on the client relationship"><input type="checkbox" checked={r.sensitivity === 'high'} onChange={(e) => patch(r.no, () => ({ sensitivity: e.target.checked ? 'high' : 'normal' }))} />High sensitivity</label>
        <label className="sc-field" title="Off: the client does not see this request"><input type="checkbox" checked={r.visible} onChange={(e) => patch(r.no, () => ({ visible: e.target.checked }))} />Client sees it</label>
      </div>
      {moving && <TransferForm initialArea={r.area} onCancel={() => setMoving(false)} onSend={(a, o, why) => { transfer(r.no, a, o, why); setMoving(false); }} />}
      <div className="pt-thread">
        {r.messages.map((m, i) => (
          <div key={i} className={`pt-msg ${m.type === 'client' ? 'them' : m.type === 'internal' ? 'internal' : 'me'}`}>
            <small>{m.type === 'internal' ? 'Internal note · ' : ''}{m.author} · {fmtWhen(m.at)}</small>
            <p>{m.text}</p>
          </div>
        ))}
      </div>
      {r.files.length > 0 && (
        <div className="pt-files">{r.files.map((f, i) => (
          <span key={i} className="pt-filechip">{f.name} · {n0(f.size / 1000)} kB · {f.by}
            <button className="sc-link" onClick={() => patch(r.no, (x) => ({ files: x.files.map((y, j) => (j === i ? { ...y, visible: !y.visible } : y)) }))}>{f.visible ? 'client sees it' : 'internal only'}</button>
          </span>
        ))}</div>
      )}
      <form className="pt-form" onSubmit={(e) => { e.preventDefault(); if (!text.trim()) return; message(r.no, mode, ME, text.trim(), file ? { name: file.name, size: file.size } : undefined); setText(''); setFile(null); }}>
        <div className="pt-mode">
          <button type="button" className={`chip-btn${mode === 'reply' ? ' on' : ''}`} onClick={() => setMode('reply')}>Reply to client</button>
          <button type="button" className={`chip-btn${mode === 'internal' ? ' on' : ''}`} onClick={() => setMode('internal')}>Internal note</button>
        </div>
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} className={mode === 'internal' ? 'internal' : ''}
          placeholder={mode === 'internal' ? 'Analysis, where the figure came from, who was consulted. Only the team sees this.' : 'Answer the client will read in the portal'} />
        <FilePick file={file} setFile={setFile} />
        <div className="pt-actions"><button className="pc-btn" disabled={!text.trim()}>{mode === 'reply' ? 'Send to client' : 'Save internal note'}</button></div>
      </form>
      <h4 className="pt-h4">Trail</h4>
      <ul className="pt-trail">{r.events.map((e, i) => <li key={i}><small>{fmtWhen(e.at)}</small> {e.text}</li>)}</ul>
    </div>
  );
}

function RegisterRequest({ onClose }: { onClose: (no?: number) => void }) {
  const { clients, routing, open } = useDesk();
  const [client, setClient] = useState(clients[0].client);
  const [plant, setPlant] = useState('');
  const [category, setCategory] = useState(routing[0].id);
  const [direction, setDirection] = useState<ServiceRequest['direction']>('client_asked');
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const c = clients.find((x) => x.client === client)!;
  return (
    <form className="sc-card pt-form pt-register" onSubmit={(e) => {
      e.preventDefault();
      if (!subject.trim() || !text.trim()) return;
      onClose(open({ client, plant: plant || null, category, subject: subject.trim(), text: text.trim(), author: direction === 'client_asked' ? `${client} contact (by phone or e-mail)` : ME, direction, origin: 'team' }));
    }}>
      <h3>Register request</h3>
      <div className="pt-formgrid">
        <label>Client<select value={client} onChange={(e) => { setClient(e.target.value); setPlant(''); }}>{clients.map((x) => <option key={x.client}>{x.client}</option>)}</select></label>
        <label>Plant<select value={plant} onChange={(e) => setPlant(e.target.value)}><option value="">General</option>{c.plants.map((p) => <option key={p.plant}>{p.plant}</option>)}</select></label>
        <label>Topic<select value={category} onChange={(e) => setCategory(e.target.value)}>{routing.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select></label>
        <label>Type<select value={direction} onChange={(e) => setDirection(e.target.value as ServiceRequest['direction'])}>{(Object.keys(DIRECTION) as ServiceRequest['direction'][]).map((d) => <option key={d} value={d}>{DIRECTION[d]}</option>)}</select></label>
      </div>
      <label>Subject<input value={subject} onChange={(e) => setSubject(e.target.value)} /></label>
      <label>{direction === 'team_asked' ? 'What we are asking the client' : 'Details'}<textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} /></label>
      <div className="pt-actions"><button type="button" className="chip-btn" onClick={() => onClose()}>Cancel</button><button className="pc-btn" disabled={!subject.trim() || !text.trim()}>Register</button></div>
    </form>
  );
}

/* ============================================================= CLIENT 360 */
export function Client360Panel({ go }: { go: (tab: string) => void }) {
  const { clients, requests } = useDesk();
  const routeOf = useRoute();
  const [name, setName] = useState<string | null>(null);
  const stats = (c: Client360) => {
    const rs = requests.filter((r) => r.client === c.client);
    const open = rs.filter((r) => r.status !== 'closed');
    return { open: open.length, late: open.filter((r) => sla(r, routeOf(r.category)).situation === 'late').length, high: open.filter((r) => r.sensitivity === 'high').length, warnings: c.ucs.filter((u) => u.warning).length };
  };
  const c = clients.find((x) => x.client === name);
  return (
    <div className="sc">
      <ScreenHead title="Client 360" level="live">
        Everything about one client on one page: the plants they can see, their requests by plant and topic, the points the team has learned to handle with care, who has portal access, and their consumer units with credits and warnings. A warning on a unit can be turned into a task in the Service desk with one click.
      </ScreenHead>
      {!c && (
        <div className="tablewrap"><table>
          <thead><tr><th>Client</th><th>Contract type</th><th className="r">Plants</th><th className="r">Open requests</th><th className="r">Past deadline</th><th className="r">High sensitivity</th><th className="r">Unit warnings</th><th className="r">Portal users</th></tr></thead>
          <tbody>{clients.map((x) => { const st = stats(x); return (
            <tr key={x.client} className="pt-row" onClick={() => setName(x.client)}>
              <td className="strong"><button className="sc-link">{x.client}</button></td><td>{x.model === 'AR' ? 'Billed on compensated energy' : 'Take-or-pay on injected energy'}</td>
              <td className="r">{x.plants.length}</td><td className="r">{st.open}</td><td className={`r${st.late ? ' pt-alert' : ''}`}>{st.late}</td><td className="r">{st.high}</td><td className="r">{st.warnings}</td><td className="r">{x.accesses.length}</td>
            </tr>
          ); })}</tbody>
        </table></div>
      )}
      {c && <ClientDetail c={c} back={() => setName(null)} go={go} />}
    </div>
  );
}

function Bars({ title, items }: { title: string; items: [string, number][] }) {
  const max = Math.max(1, ...items.map((i) => i[1]));
  return (
    <div className="sc-card"><h3>{title}</h3>
      {items.length === 0 && <p className="muted">No requests.</p>}
      {items.map(([k, v]) => <div key={k} className="pt-bar"><span>{k}</span><i style={{ width: `${(v / max) * 100}%` }} /><b>{v}</b></div>)}
    </div>
  );
}
const countBy = (xs: string[]) => [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]);

function ClientDetail({ c, back, go }: { c: Client360; back: () => void; go: (tab: string) => void }) {
  const { requests, client: edit, select } = useDesk();
  const routeOf = useRoute();
  const [tab, setTab] = useState<'overview' | 'energy'>('overview');
  const [note, setNote] = useState('');
  const [acc, setAcc] = useState({ name: '', email: '' });
  const [link, setLink] = useState('');
  const [plantSel, setPlantSel] = useState<string | null>(null);
  const rs = requests.filter((r) => r.client === c.client);
  const open = rs.filter((r) => r.status !== 'closed');
  const openDesk = (no: number) => { select(no); go('desk'); };
  return (
    <>
      <div className="sc-cardhead">
        <h3 className="pt-client">{c.client}</h3>
        <button className="chip-btn" onClick={back}>All clients</button>
      </div>
      <section className="kpis">
        <Kpi label="Open requests" value={String(open.length)} accent />
        <Kpi label="Past deadline" value={String(open.filter((r) => sla(r, routeOf(r.category)).situation === 'late').length)} />
        <Kpi label="Plants the client sees" value={`${c.plants.filter((p) => p.visible).length} of ${c.plants.length}`} />
        <Kpi label="Revenue, last 12 months" value={brlM(c.revenueYear)} sub="internal, the client does not see it" />
      </section>
      <nav className="pt-tabs">
        <button className={tab === 'overview' ? 'on' : ''} onClick={() => setTab('overview')}>Overview</button>
        <button className={tab === 'energy' ? 'on' : ''} onClick={() => setTab('energy')}>Energy: units, credits and balance</button>
      </nav>
      {tab === 'energy' && <ClientEnergy c={c} openDesk={openDesk} />}
      {tab === 'overview' && plantSel && <PlantPage c={c} plant={plantSel} audience="team" onClose={() => setPlantSel(null)} />}
      {tab === 'overview' && (
        <>
          <div className="sc-grid">
            <div className="sc-card">
              <h3>Plants released to the client</h3>
              <div className="tablewrap"><table>
                <thead><tr><th>Client sees</th><th>Plant</th><th>Distributor</th><th className="r">MWac</th><th>Status</th></tr></thead>
                <tbody>{c.plants.map((p) => (
                  <tr key={p.plant}>
                    <td><input type="checkbox" aria-label={`Client sees ${p.plant}`} checked={p.visible} disabled={!p.cod} onChange={(e) => edit(c.client, (x) => ({ plants: x.plants.map((y) => (y.plant === p.plant ? { ...y, visible: e.target.checked } : y)) }))} /></td>
                    <td className="strong"><button className="sc-link" onClick={() => setPlantSel(p.plant)}>{p.plant}</button></td><td>{p.disco}</td><td className="r">{p.mwac.toFixed(1)}</td><td>{p.connection}</td>
                  </tr>
                ))}</tbody>
              </table></div>
              <p className="sc-foot">Only plants in commercial operation can be released. Click a plant to see its consumer units.</p>
            </div>
            <div className="sc-card">
              <h3>Points to handle with care</h3>
              <ul className="pt-sens-list">{c.sensitivities.map((s, i) => (
                <li key={i}>{s}<button className="sc-link" onClick={() => edit(c.client, (x) => ({ sensitivities: x.sensitivities.filter((_, j) => j !== i) }))}>Remove</button></li>
              ))}</ul>
              <form className="pt-inline" onSubmit={(e) => { e.preventDefault(); if (!note.trim()) return; edit(c.client, (x) => ({ sensitivities: [...x.sensitivities, note.trim()] })); setNote(''); }}>
                <input className="sc-search" placeholder="Add what the team should know" value={note} onChange={(e) => setNote(e.target.value)} />
                <button className="pc-btn" disabled={!note.trim()}>Add</button>
              </form>
              <p className="sc-foot">Internal only. The client never sees this list.</p>
            </div>
          </div>
          <div className="sc-grid">
            <Bars title="Requests by plant" items={countBy(rs.map((r) => r.plant ?? 'General'))} />
            <Bars title="Requests by topic" items={countBy(rs.map((r) => routeOf(r.category)?.label ?? r.category))} />
          </div>
          <div className="sc-grid">
            <div className="sc-card">
              <h3>Portal access</h3>
              <div className="tablewrap"><table>
                <thead><tr><th>Name</th><th>E-mail</th><th>Last sign-in</th></tr></thead>
                <tbody>{c.accesses.map((a) => <tr key={a.email}><td className="strong">{a.name}</td><td>{a.email}</td><td>{a.lastSignIn ? fmtDate(`${a.lastSignIn}T12:00:00Z`) : 'Not signed in yet'}</td></tr>)}</tbody>
              </table></div>
              <form className="pt-inline" onSubmit={(e) => {
                e.preventDefault();
                if (!acc.name.trim() || !/^\S+@\S+\.\S+$/.test(acc.email)) return;
                edit(c.client, (x) => ({ accesses: [...x.accesses, { name: acc.name.trim(), email: acc.email.trim(), lastSignIn: null }] }));
                setLink(`Access created for ${acc.name.trim()}. In the platform this produces a one-time sign-in link to send to the client. Nothing is sent from this demo.`);
                setAcc({ name: '', email: '' });
              }}>
                <input className="sc-search" placeholder="Name" value={acc.name} onChange={(e) => setAcc({ ...acc, name: e.target.value })} />
                <input className="sc-search" placeholder="E-mail" value={acc.email} onChange={(e) => setAcc({ ...acc, email: e.target.value })} />
                <button className="pc-btn" disabled={!acc.name.trim() || !acc.email.trim()}>Create access</button>
              </form>
              {link && <p className="pt-ok">{link}</p>}
            </div>
            <div className="sc-card">
              <h3>Requests</h3>
              <div className="tablewrap sc-scroll"><table>
                <thead><tr><th>#</th><th>Subject</th><th>Status</th><th>Deadline</th></tr></thead>
                <tbody>{rs.map((r) => <tr key={r.no} className="pt-row" onClick={() => openDesk(r.no)}><td className="strong">#{r.no}</td><td className="wrap">{r.subject}</td><td>{STATUS_LABEL[r.status]}</td><td><SlaBadge s={sla(r, routeOf(r.category))} /></td></tr>)}</tbody>
              </table></div>
              <p className="sc-foot">Click a request to open it in the Service desk.</p>
            </div>
          </div>
        </>
      )}
    </>
  );
}

const WARN: Record<NonNullable<ClientUnit['warning']>, string> = {
  building: 'Credits building up: balance rising for 3 months and above 10 months of consumption',
  nocredits: 'Consumption without credits for 3 months',
};
type UnitSort = 'plant' | 'cons' | 'comp' | 'ratio' | 'balance' | 'balanceMonths';

function ClientEnergy({ c, openDesk }: { c: Client360; openDesk: (no: number) => void }) {
  const open = useDesk((s) => s.open);
  const [plant, setPlant] = useState('All');
  const [onlyWarn, setOnlyWarn] = useState(false);
  const [sort, setSort] = useState<{ k: UnitSort; d: 1 | -1 }>({ k: 'balanceMonths', d: -1 });
  const [created, setCreated] = useState<Record<string, number>>({});
  const units = useMemo(() => {
    const val = (u: ClientUnit) => (sort.k === 'plant' ? 0 : sort.k === 'ratio' ? (u.cons ? u.comp / u.cons : 0) : u[sort.k]);
    return c.ucs.filter((u) => (plant === 'All' || u.plant === plant) && (!onlyWarn || u.warning))
      .sort((a, b) => (sort.k === 'plant' ? a.plant.localeCompare(b.plant) * sort.d : (val(a) - val(b)) * sort.d));
  }, [c.ucs, plant, onlyWarn, sort]);
  if (!c.ucs.length) return <div className="sc-card"><p className="muted">{c.client} is billed on injected energy (take-or-pay), so there is no consumer unit view to follow.</p></div>;
  const warn = c.ucs.filter((u) => u.warning);
  const th = (k: UnitSort, label: string) => <th className={k === 'plant' ? '' : 'r'}><button className="sc-link" onClick={() => setSort({ k, d: sort.k === k ? (-sort.d as 1 | -1) : -1 })}>{label}{sort.k === k ? (sort.d < 0 ? ' ▼' : ' ▲') : ''}</button></th>;
  const toTask = (u: ClientUnit) => {
    const no = open({ client: c.client, plant: u.plant, category: 'credits', subject: `Unit ${u.uc}: ${u.warning === 'building' ? 'credits building up' : 'no credits for 3 months'}`,
      text: `${WARN[u.warning!]}. Balance ${n0(u.balance / 1000)} MWh, ${n1(u.balanceMonths)} months of consumption. Check the allocation for ${u.plant}.`, author: ME, direction: 'internal', origin: 'team', visible: false });
    setCreated((m) => ({ ...m, [u.uc]: no }));
  };
  const plants = [...new Set(c.ucs.map((u) => u.plant))];
  return (
    <>
      <section className="kpis">
        <Kpi label="Consumer units" value={n0(c.ucs.length)} />
        <Kpi label="Consumption, 12 months" value={`${n0(c.ucs.reduce((s, u) => s + u.cons, 0) / 1000)} MWh`} />
        <Kpi label="Credits used, 12 months" value={`${n0(c.ucs.reduce((s, u) => s + u.comp, 0) / 1000)} MWh`} accent />
        <Kpi label="Credit balance" value={`${n0(c.ucs.reduce((s, u) => s + u.balance, 0) / 1000)} MWh`} />
        <Kpi label="Units with a warning" value={String(warn.length)} />
      </section>
      {warn.length > 0 && (
        <div className="sc-card">
          <h3>Warnings</h3>
          <div className="tablewrap sc-scroll"><table>
            <thead><tr><th>Unit</th><th>Plant</th><th>Warning</th><th className="r">Balance (MWh)</th><th /></tr></thead>
            <tbody>{warn.map((u) => (
              <tr key={u.uc}><td className="strong">{u.uc}</td><td>{u.plant}</td><td className="wrap">{WARN[u.warning!]}</td><td className="r">{n1(u.balance / 1000)}</td>
                <td>{created[u.uc] ? <button className="sc-link" onClick={() => openDesk(created[u.uc])}>Task #{created[u.uc]} created</button> : <button className="chip-btn" onClick={() => toTask(u)}>Create internal task</button>}</td></tr>
            ))}</tbody>
          </table></div>
        </div>
      )}
      <div className="sc-tools">
        <label className="sc-field">Plant<select value={plant} onChange={(e) => setPlant(e.target.value)}><option>All</option>{plants.map((p) => <option key={p}>{p}</option>)}</select></label>
        <label className="sc-field"><input type="checkbox" checked={onlyWarn} onChange={(e) => setOnlyWarn(e.target.checked)} />Only units with a warning</label>
        <button className="chip-btn sc-right" onClick={() => downloadCsv(`units_${c.client}.csv`, [['plant', 'unit', 'share', 'consumption_kwh', 'credits_used_kwh', 'balance_kwh', 'balance_months', 'warning'], ...units.map((u) => [u.plant, u.uc, u.share, u.cons, u.comp, u.balance, u.balanceMonths, u.warning ?? ''])])}>Download CSV</button>
      </div>
      <div className="tablewrap sc-scroll"><table>
        <thead><tr>{th('plant', 'Plant')}<th>Unit</th><th className="r">Share</th>{th('cons', 'Consumption (MWh)')}{th('comp', 'Credits used (MWh)')}{th('ratio', 'Covered')}{th('balance', 'Balance (MWh)')}{th('balanceMonths', 'Balance in months')}<th>Balance, 6 months</th><th>Warning</th></tr></thead>
        <tbody>{units.map((u) => (
          <tr key={u.uc}><td>{u.plant}</td><td className="strong">{u.uc}</td><td className="r">{pct(u.share)}</td><td className="r">{n1(u.cons / 1000)}</td><td className="r">{n1(u.comp / 1000)}</td><td className="r">{u.cons ? pct(u.comp / u.cons, 0) : '–'}</td><td className="r">{n1(u.balance / 1000)}</td><td className="r">{n1(u.balanceMonths)}</td>
            <td>{u.trend.length > 1 && <Spark values={u.trend} color={u.warning ? CHART.orange : CHART.blue} />}</td><td>{u.warning ? <span className="st st-warn">▲ {u.warning === 'building' ? 'Building up' : 'No credits'}</span> : ''}</td></tr>
        ))}</tbody>
      </table></div>
    </>
  );
}

/* ========================================================= SERVICE LEVELS */
type GroupBy = 'area' | 'owner' | 'client' | 'category';
export function ServiceLevelsPanel() {
  const { requests, routing, route } = useDesk();
  const routeOf = useRoute();
  const team = extras().service.team;
  const [by, setBy] = useState<GroupBy>('area');
  const keyOf = (r: ServiceRequest) => (by === 'area' ? r.area : by === 'owner' ? r.owner ?? 'Not assigned' : by === 'client' ? r.client : routeOf(r.category)?.label ?? r.category);
  const groups = new Map<string, { r: ServiceRequest; s: Sla }[]>();
  for (const r of requests) { const k = keyOf(r); groups.set(k, [...(groups.get(k) ?? []), { r, s: sla(r, routeOf(r.category)) }]); }
  const line = (label: string, xs: { r: ServiceRequest; s: Sla }[]) => {
    const closed = xs.filter((x) => x.r.status === 'closed');
    const measured = xs.filter((x) => x.s.replyOk != null);
    const hs = measured.map((x) => x.s.replyH as number).sort((a, b) => a - b);
    return {
      label, total: xs.length, open: xs.length - closed.length, late: xs.filter((x) => x.s.situation === 'late').length,
      onTime: closed.length ? closed.filter((x) => x.s.situation === 'closed_on_time').length / closed.length : null, closedN: closed.length,
      replyOk: measured.length ? measured.filter((x) => x.s.replyOk).length / measured.length : null, replyN: measured.length,
      median: hs.length ? hs[Math.floor(hs.length / 2)] : null,
      days: closed.length ? closed.reduce((s, x) => s + x.s.activeDays, 0) / closed.length : null,
    };
  };
  const lines = [...groups].map(([k, xs]) => line(k, xs)).sort((a, b) => b.total - a.total);
  const all = line('All requests', requests.map((r) => ({ r, s: sla(r, routeOf(r.category)) })));
  const cell = (v: number | null, f: (v: number) => string) => (v == null ? '–' : f(v));
  return (
    <div className="sc">
      <ScreenHead title="Service levels" level="live">
        How quickly the team answers and resolves, by area, owner, client or topic. First reply is measured in working hours against the target for the topic. Resolution time leaves out the time spent waiting on the client or a third party. Items imported from the old spreadsheet have no reply time, so they are left out of the reply measure.
      </ScreenHead>
      <section className="kpis">
        <Kpi label="Open requests" value={String(all.open)} accent />
        <Kpi label="First reply within target" value={cell(all.replyOk, (v) => pct(v, 0))} sub={`${all.replyN} measured`} />
        <Kpi label="Closed on time" value={cell(all.onTime, (v) => pct(v, 0))} sub={`${all.closedN} closed`} />
        <Kpi label="Median first reply" value={fmtH(all.median)} />
      </section>
      <div className="sc-tools">
        <span>Group by</span>
        {(['area', 'owner', 'client', 'category'] as GroupBy[]).map((g) => <button key={g} className={`chip-btn${by === g ? ' on' : ''}`} onClick={() => setBy(g)}>{{ area: 'Area', owner: 'Owner', client: 'Client', category: 'Topic' }[g]}</button>)}
      </div>
      <div className="tablewrap sc-scroll"><table>
        <thead><tr><th>{{ area: 'Area', owner: 'Owner', client: 'Client', category: 'Topic' }[by]}</th><th className="r">Requests</th><th className="r">Open</th><th className="r">Past deadline</th><th className="r">First reply within target</th><th className="r">Median first reply</th><th className="r">Closed on time</th><th className="r">Days to close</th></tr></thead>
        <tbody>{[...lines, all].map((l) => (
          <tr key={l.label} className={l === all ? 'pt-total' : ''}>
            <td className="strong">{l.label}</td><td className="r">{l.total}</td><td className="r">{l.open}</td><td className={`r${l.late ? ' pt-alert' : ''}`}>{l.late}</td>
            <td className="r" title={`${l.replyN} measured`}>{cell(l.replyOk, (v) => pct(v, 0))}</td><td className="r">{fmtH(l.median)}</td>
            <td className="r">{cell(l.onTime, (v) => pct(v, 0))}</td><td className="r">{cell(l.days, n1)}</td>
          </tr>
        ))}</tbody>
      </table></div>
      <div className="sc-card">
        <h3>Routing rules</h3>
        <p className="sc-foot">Each topic a client can choose goes to an area and a default owner. Changes apply to new requests, and the reply target applies to every measure above.</p>
        <div className="tablewrap"><table>
          <thead><tr><th>Topic</th><th>Area</th><th>Default owner</th><th className="r">Deadline (days)</th><th className="r">First reply target (working hours)</th></tr></thead>
          <tbody>{routing.map((r) => (
            <tr key={r.id}>
              <td className="strong">{r.label}</td>
              <td><select value={r.area} onChange={(e) => route(r.id, { area: e.target.value, owner: team.find((t) => t.area === e.target.value)?.name ?? r.owner })}>{[...new Set(team.map((t) => t.area))].map((a) => <option key={a}>{a}</option>)}</select></td>
              <td><select value={r.owner} onChange={(e) => route(r.id, { owner: e.target.value })}>{team.map((t) => <option key={t.name}>{t.name}</option>)}</select></td>
              <td className="r"><input className="sc-num" type="number" min={1} value={r.deadlineDays} onChange={(e) => route(r.id, { deadlineDays: Math.max(1, +e.target.value || 1) })} /></td>
              <td className="r"><input className="sc-num" type="number" min={1} value={r.firstReplyHours} onChange={(e) => route(r.id, { firstReplyHours: Math.max(1, +e.target.value || 1) })} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      </div>
    </div>
  );
}

/* ============================================================== PLANT PAGE */
type UnitSortKey = 'uc' | 'share' | 'cons' | 'used' | 'covered' | 'balance';

/** One plant of one client: monthly energy and every consumer unit it credits. */
function PlantPage({ c, plant, audience, onClose }: { c: Client360; plant: string; audience: 'team' | 'client'; onClose: () => void }) {
  useDataVersion();
  const info = c.plants.find((p) => p.plant === plant)!;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [plant]);
  const cp = compPortfolio().get(plant) ?? null;
  const injSerie = injections()[plant]?.serie ?? {};
  const months = cp ? Object.keys(cp).filter((m) => m <= OPEN_MONTH).sort() : Object.keys(injSerie).filter((m) => m <= OPEN_MONTH && injSerie[m].injetadoMWh != null).sort();
  const regCount = cp ? new Set(Object.values(cp).flatMap((m) => m.ucs.filter((u) => u.injetado === 0).map((u) => u.uc))).size : 0;
  const isPartial = (m: string) => !!cp?.[m] && cp[m].ucs.filter((u) => u.injetado === 0).length < regCount;
  const [month, setMonth] = useState([...months].reverse().find((m) => !isPartial(m)) ?? months[months.length - 1] ?? '');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ k: UnitSortKey; d: 1 | -1 }>({ k: 'cons', d: -1 });
  const warnings = new Map(c.ucs.filter((u) => u.plant === plant && u.warning).map((u) => [u.uc, u.warning!]));
  const cur = cp?.[month];
  const units = useMemo(() => {
    if (!cur) return [];
    const ql = q.trim();
    const rows = cur.ucs.filter((u) => u.injetado === 0 && (!ql || u.uc.includes(ql)))
      .map((u) => ({ uc: u.uc, share: u.rateio, cons: u.consumo, used: u.compensado, covered: u.consumo ? u.compensado / u.consumo : 0, balance: u.saldo }));
    return rows.sort((a, b) => (sort.k === 'uc' ? a.uc.localeCompare(b.uc) : a[sort.k] - b[sort.k]) * sort.d);
  }, [cur, q, sort]);
  const allUnits = cur ? cur.ucs.filter((u) => u.injetado === 0) : [];
  const th = (k: UnitSortKey, label: string) => (
    <th className={k === 'uc' ? '' : 'r'}><button className="sc-link" onClick={() => setSort({ k, d: sort.k === k ? (-sort.d as 1 | -1) : -1 })}>{label}{sort.k === k ? (sort.d < 0 ? ' ▼' : ' ▲') : ''}</button></th>
  );
  const series = cp
    ? [{ name: 'Injected', color: CHART.blue, values: months.map((m) => cp[m].injecao / 1000) }, { name: 'Credits used', color: CHART.orange, values: months.map((m) => cp[m].compensado / 1000) }]
    : [{ name: 'Injected', color: CHART.blue, values: months.map((m) => injSerie[m].injetadoMWh) }];
  return (
    <div className="sc-card pt-plant" ref={box}>
      <div className="sc-cardhead">
        <h3>{plant} <small className="muted">· {c.client}</small></h3>
        <button className="chip-btn" onClick={onClose}>Close plant</button>
      </div>
      {audience === 'client' && <div className="pt-note"><MaturityTag level="concept" /> Not shown to clients yet. The team sees this page in Client 360 today. A month will be published here once the team has validated it.</div>}
      <div className="pt-facts">
        <span>Distributor<b>{info.disco}</b></span><span>Capacity<b>{info.mwac.toFixed(1)} MWac</b></span>
        <span>Commercial operation<b>{info.cod ? monthLabel(info.cod) : '–'}</b></span><span>Contract end<b>{info.end ? monthLabel(info.end) : '–'}</b></span>
        <span>Billing<b>{cp ? 'On credits used' : 'Take-or-pay on injection'}</b></span><span>Status<b>{info.connection}</b></span>
      </div>
      {months.length > 1 && <LineChart labels={months.map(monthLabel)} format={(v) => `${n0(v)} MWh`} height={200} series={series} />}
      {!cp && <p className="muted">This plant is billed on the energy it injects, so there are no consumer units to follow. The chart shows the metered injection.</p>}
      {cp && cur && (
        <>
          <div className="sc-tools">
            <label className="sc-field">Month<select value={month} onChange={(e) => setMonth(e.target.value)}>{[...months].reverse().map((m) => <option key={m} value={m}>{monthLabel(m)}{isPartial(m) ? ' (bills still arriving)' : ''}</option>)}</select></label>
            <input className="sc-search" placeholder="Search a unit number" aria-label="Search a unit" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="chip-btn sc-right" onClick={() => downloadCsv(`${plant}_${month}_units.csv`, [['unit', 'share', 'consumption_kwh', 'credits_used_kwh', 'covered', 'balance_kwh'], ...units.map((u) => [u.uc, u.share, u.cons, u.used, Number(u.covered.toFixed(3)), u.balance])])}>Download CSV</button>
          </div>
          <section className="kpis">
            <Kpi label="Consumer units" value={String(allUnits.length)} />
            <Kpi label="Injected" value={`${n1(cur.injecao / 1000)} MWh`} />
            <Kpi label="Credits used" value={`${n1(cur.compensado / 1000)} MWh`} sub={cur.injecao ? `${pct(cur.compensado / cur.injecao, 0)} of injection` : undefined} accent />
            <Kpi label="Consumption" value={`${n1(allUnits.reduce((s, u) => s + u.consumo, 0) / 1000)} MWh`} />
            <Kpi label="Credit balance" value={`${n1(allUnits.reduce((s, u) => s + u.saldo, 0) / 1000)} MWh`} />
          </section>
          <div className="tablewrap sc-scroll"><table>
            <thead><tr>{th('uc', 'Unit')}{th('share', 'Share of credits')}{th('cons', 'Consumption (kWh)')}{th('used', 'Credits used (kWh)')}{th('covered', 'Covered')}{th('balance', 'Balance (kWh)')}{audience === 'team' && <th>Warning</th>}</tr></thead>
            <tbody>{units.map((u) => (
              <tr key={u.uc}>
                <td className="strong">{u.uc}</td><td className="r">{pct(u.share)}</td><td className="r">{n0(u.cons)}</td><td className="r">{n0(u.used)}</td>
                <td className={`r${u.cons && u.covered < 0.6 ? ' pt-alert' : ''}`}>{u.cons ? pct(u.covered, 0) : '–'}</td><td className="r">{n0(u.balance)}</td>
                {audience === 'team' && <td>{warnings.get(u.uc) ? <span className="st st-warn" title={WARN[warnings.get(u.uc)!]}>▲ {warnings.get(u.uc) === 'building' ? 'Building up' : 'No credits'}</span> : ''}</td>}
              </tr>
            ))}</tbody>
          </table></div>
          <p className="sc-foot">Units credited by {plant} in {monthLabel(month)}, read from each unit's bill. Click a column to sort.</p>
        </>
      )}
    </div>
  );
}
