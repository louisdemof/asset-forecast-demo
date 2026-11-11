import { secureText } from '../secure';

export interface Revision { id: string; label: string; closed: number; received: string; byMonth: Record<string, number> }
export interface BankPlant { plant: string; client: string; disco: string; saldoMWh: number; value: number; delta3m: number; expiring12m: number; status: string; utilisation: number; series: number[] }
export interface ProvisionRow { plant: string; client: string; disco: string; model: string; injected: number; mwh: number; source: string; base: number; grid: number; gridSource: string; forecast: number; steps: string[] }
export interface PlantPerf { plant: string; client: string; disco: string; mwp: number; p50: number; injected: number; ratio: number; irrDelta: number; yieldDelta: number; lostMWh: number }
export interface Incident { id: string; plant: string; client: string; cause: string; start: string; days: number; lostMWh: number; lostValue: number; open: boolean }
export interface Feed { name: string; kind: string; expected: number; received: number; lag: number; status: string }
export interface ReconRow { plant: string; client: string; inverter: number; meter: number; invoice: number; credited: number; billed: number; base: number }
export interface BillingRow { id: string; client: string; plants: number; mwh: number; gross: number; taxes: number; accrual: number; stage: string; doc: string; costCentre: string }
export interface Ticket { id: string; plant: string; client: string; title: string; source: string; priority: string; state: string; team: string; slaHours: number; ageHours: number; mwhPerDay: number; valuePerDay: number }
export interface RegisterRow { plant: string; client: string; disco: string; mwp: number; mwac: number; cod: string; status: string; inverters: number; docs: Record<string, boolean>; completeness: number }
export interface RegisterChange { plant: string; field: string; register: string | number; source: string | number; from: string; action: string }
export interface PortalClient {
  client: string;
  sites: { plant: string; mwp: number; disco: string; ratio: number }[];
  months: { month: string; mwh: number; saving: number }[];
  invoices: { id: string; month: string; amount: number; status: string }[];
}

export type ReqStatus = 'new' | 'in_review' | 'awaiting_client' | 'awaiting_third_party' | 'answered' | 'closed';
export interface ReqMessage { type: 'client' | 'reply' | 'internal'; author: string; text: string; at: string }
export interface ReqFile { name: string; size: number; by: string; visible: boolean }
export interface ServiceRequest {
  no: number; client: string; plant: string | null; category: string; subject: string;
  direction: 'client_asked' | 'team_asked' | 'internal'; origin: 'portal' | 'team' | 'imported';
  status: ReqStatus; area: string; owner: string | null; created: string; firstReply: string | null; closed: string | null;
  deadline: string; pausedSec: number; pauseSince: string | null; sensitivity: 'high' | 'normal'; visible: boolean;
  messages: ReqMessage[]; files: ReqFile[]; events: { at: string; text: string }[];
}
export interface Route { id: string; label: string; area: string; owner: string; deadlineDays: number; firstReplyHours: number }
export interface ClientUnit { plant: string; uc: string; share: number; cons: number; comp: number; balance: number; balanceMonths: number; trend: number[]; warning: 'building' | 'nocredits' | null }
export interface Client360 {
  client: string; model: string; revenueYear: number; sensitivities: string[];
  accesses: { name: string; email: string; lastSignIn: string | null }[];
  plants: { plant: string; disco: string; mwac: number; cod: string | null; start: string | null; end: string | null; termYears: number; connection: string; visible: boolean }[];
  ucs: ClientUnit[];
}

export interface Extras {
  service: { now: string; team: { name: string; area: string }[]; routing: Route[]; requests: ServiceRequest[]; clients: Client360[] };
  closed: string;
  open: string;
  evolution: {
    months: string[]; causes: string[]; revisions: Revision[]; actual: Record<string, number>;
    bridges: { from: string; to: string; delta: number; causes: Record<string, number> }[];
    accuracy: { label: string; oneAhead: number | null; threeAhead: number | null }[];
    movers: { plant: string; client: string; cause: string; delta: number }[];
  };
  bank: { plants: BankPlant[]; months: string[]; backtest: { month: string; real: number; flat: number; simulated: number }[] };
  provision: { month: string; rows: ProvisionRow[] };
  performance: { series: { month: string; ratio: number; availability: number; irradiance: number }[]; plants: PlantPerf[]; incidents: Incident[] };
  pipeline: { feeds: Feed[]; runs: { day: string; loaded: number; rejected: number; retried: number; minutes: number; ok: boolean }[]; heat: { plant: string; days: number[] }[]; recon: ReconRow[] };
  billing: { month: string; stages: string[]; rows: BillingRow[] };
  tickets: { states: string[]; rows: Ticket[] };
  register: { rows: RegisterRow[]; changes: RegisterChange[] };
  portal: PortalClient[];
}

let cache: Extras | null = null;
export const extras = (): Extras => (cache ??= JSON.parse(secureText('demo_extras.json')) as Extras);
