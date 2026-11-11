#!/usr/bin/env node
/**
 * Generates every data file the demo ships, from a fixed seed.
 *
 * The only input is public/data/Tarifas_ref.csv, the published ANEEL tariffs.
 * Plants, clients, meters, volumes, contracts, invoices and events are invented
 * here. Do not add a real file as an input.
 *
 * Usage: node scripts/generate-synthetic.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');

// ---- seeded random ----------------------------------------------------------
let seed = 20261109;
function rnd() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (a, b) => a + (b - a) * rnd();
const int = (a, b) => Math.floor(between(a, b + 1));
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const round = (v, d = 2) => Number(v.toFixed(d));
const sum = (xs) => xs.reduce((s, v) => s + v, 0);

// ---- csv --------------------------------------------------------------------
const cell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const writeCsv = (name, header, rows) =>
  fs.writeFileSync(path.join(OUT, name), [header, ...rows].map((r) => r.map(cell).join(',')).join('\n') + '\n');
const writeJson = (name, value) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(value));

function readTariffs() {
  const lines = fs.readFileSync(path.join(OUT, 'Tarifas_ref.csv'), 'utf8').trim().split(/\r?\n/);
  const head = lines[0].split(',');
  return lines.slice(1).map((l) => {
    const c = l.split(',');
    const r = Object.fromEntries(head.map((h, i) => [h, c[i]]));
    return { disco: r.disco, tusd: +r.tusd, te: +r.te, tusdC: +r.tusdC, tusdG: +r.tusdG, pis: +r.pisCofins, icms: +r.icms };
  });
}

// ---- calendar ---------------------------------------------------------------
const YEAR = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`);
const HIST = ['2025-10', '2025-11', '2025-12', ...YEAR.slice(0, 10)];
const CLOSED = '2026-09';
const OPEN = '2026-10';
const stamp = (ym, d = '01') => `${ym}-${d} 00:00:00`;
const addMonths = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};
const SHAPE = [1.0, 0.92, 0.95, 0.9, 0.86, 0.8, 0.86, 0.97, 1.03, 1.1, 1.08, 1.05];
const shapeOf = (ym) => SHAPE[+ym.slice(5, 7) - 1];

// ---- client rules (mirror of src/engine/clientes.ts) ------------------------
const FIXED_RATE = 390000 / 700;
const CLIENTS = [
  ['TELMO', 'pis', 'AR', 15], ['TELCO', 'pis', 'AR', 8], ['LOGIX', 'pis_icms', 'AR', 6], ['HIDRUS', 'semdesc', 'AR', 4],
  ['NEXUS', 'none', 'GC', 12], ['SOLARA', 'none', 'GC', 7], ['VERTA', 'none', 'GC', 6], ['BANCOR', 'fixed', 'GC', 3],
  ['PETRAX', 'flat', 'GC', 3], ['OPERON', 'none', 'GC', 2], ['ALPHAEN', 'none', 'GC', 5], ['NOVASOL', 'none', 'GC', 5],
  ['MINCO', 'none', 'GC', 4], ['DISTRA', 'none', 'GC', 2], ['ENERVA', 'none', 'GC', 2],
];
const byCompensation = (c) => c.model === 'AR' || c.name === 'NEXUS' || c.name === 'OPERON';

function basePrice(p) {
  const s = p.t.tusd + p.t.te;
  switch (p.client.rule) {
    case 'pis': return (1 - p.discount) * (s / (1 - p.t.pis));
    case 'pis_icms': return (1 - p.discount) * (s / (1 - p.t.pis) / (1 - p.t.icms));
    case 'semdesc': return s / (1 - p.t.pis) / (1 - p.t.icms);
    case 'flat': return FIXED_RATE;
    case 'fixed': return p.fixedBase;
    default: return (1 - p.discount) * s;
  }
}
function gridCharge(p) {
  const T = ['COPEL', 'CEEE', 'ESS', 'ETO'].includes(p.t.disco.toUpperCase()) ? p.t.tusdC : p.t.tusdG;
  return ((T / (1 - p.t.pis) / (1 - p.t.icms)) * 30 + (T / (1 - p.t.pis)) * (p.mwac * 1000 - 30)) * 1.05;
}

// ---- portfolio --------------------------------------------------------------
const STEMS = ['Orion', 'Lyra', 'Vega', 'Altair', 'Cygnus', 'Draco', 'Perseus', 'Sirius', 'Polaris', 'Antares', 'Rigel', 'Deneb'];
const tariffs = readTariffs();
const CLIENT_BAG = CLIENTS.flatMap(([name, rule, model, weight]) => Array(weight).fill({ name, rule, model }));
const PLANTS = [];
const LOSS_KEYS = ['inversores', 'modulos', 'estrutura', 'transformadores', 'cabine', 'rede', 'manutencao', 'sujidade', 'clima'];
let bag = [...CLIENT_BAG];

for (let i = 0; i < 84; i++) {
  const stem = STEMS[i % STEMS.length];
  const number = Math.floor(i / STEMS.length) + 1;
  const name = `${stem} ${String(number).padStart(2, '0')}`;
  const client = bag.splice(Math.floor(rnd() * bag.length), 1)[0] ?? pick(CLIENT_BAG);
  const t = pick(tariffs);
  const mwac = round(pick([1, 1, 1, 1.5, 2, 2.5, 3, 4]), 1);
  const mwp = round(mwac * between(1.18, 1.36), 3);
  const yieldPerMwp = between(1520, 1880);
  const operating = i < 70;
  const cod = operating
    ? addMonths('2025-01', int(0, 11))
    : addMonths('2026-03', int(0, 15));
  const losses = {
    inversores: between(0.004, 0.012), modulos: between(0.001, 0.004), estrutura: between(0.002, 0.008),
    transformadores: between(0.003, 0.009), cabine: between(0.0004, 0.001), rede: between(0.002, 0.014),
    manutencao: between(0.001, 0.003), sujidade: between(0.008, 0.02), clima: 0.03,
  };
  const accumulating = operating && byCompensation(client) && rnd() < 0.2;
  const p = {
    i, name, client, t, mwac, mwp, cod, losses, accumulating,
    discount: round(between(0.08, 0.34), 3),
    fixedBase: round(between(520, 640), 2),
    risk: operating ? 1 : int(1, 3),
    perfComp: accumulating ? between(0.56, 0.74) : byCompensation(client) ? between(0.83, 0.98) : 1,
    p50: Object.fromEntries(YEAR.map((m) => [m, round((mwp * yieldPerMwp * shapeOf(m)) / sum(SHAPE), 2)])),
    actual: {},
  };
  p.perfOper = 1 - sum(LOSS_KEYS.map((k) => losses[k]));
  p.base = basePrice(p);
  p.grid = gridCharge(p);
  PLANTS.push(p);
}

const isLive = (p, ym) => ym >= p.cod;
const energy = (p, ym, comp = p.perfComp) => (isLive(p, ym) ? p.p50[ym] * p.perfOper * comp : 0);
const revenueOf = (p, mwh, ym) => (isLive(p, ym) ? p.base * mwh - p.grid : 0);

for (const p of PLANTS) {
  for (const m of HIST) {
    const key = m.startsWith('2025') ? `2026-${m.slice(5, 7)}` : m;
    const live = m >= p.cod;
    const weather = between(0.91, 1.06);
    p.actual[m] = {
      injected: live ? p.p50[key] * p.perfOper * weather : 0,
      weather,
    };
    p.actual[m].credited = p.actual[m].injected * (byCompensation(p.client) ? p.perfComp * between(0.95, 1.05) : 1);
  }
}

// ---- base forecast files ----------------------------------------------------
const NOTES = [
  'Grid connection works running late at the distributor', 'Land title transfer still open',
  'Waiting on the protection study', 'Substation bay shared with a third party', '',
  '', '', 'Civil works finished, waiting for energisation',
];
const dateNear = (ym, delta) => `${addMonths(ym, delta)}-${String(int(2, 27)).padStart(2, '0')} 00:00:00`;

writeCsv('COD.csv',
  ['Concessionária', 'Nome do Projeto', 'Cliente', 'Energização V1', 'COD V1', 'Energização', 'COD', 'Faturamento', 'Pot (MWp)', 'Nível de Risco', 'Observações'],
  PLANTS.map((p) => [p.t.disco, p.name, p.client.name, dateNear(p.cod, -3), dateNear(p.cod, -1), dateNear(p.cod, -2), stamp(p.cod, '15'), stamp(addMonths(p.cod, 1)), p.mwp, p.risk, p.i < 70 ? '' : pick(NOTES)]));

writeCsv('PVsyst.csv',
  ['Potência', 'Concessionária', 'Cliente', 'Nome do Projeto', ...YEAR.map((m) => stamp(m)), 'Total', '', 'Forecast 8+4', 'V3', 'Dif MWh', 'Produção Específica (MWh/MWp/ano)'],
  PLANTS.map((p) => {
    const total = sum(YEAR.map((m) => p.p50[m]));
    const prior = total * between(0.97, 1.03);
    return [p.mwp, p.t.disco, p.client.name, p.name, ...YEAR.map((m) => p.p50[m]), round(total), '', round(prior), round(prior), round((prior - total) / total, 4), round(total / p.mwp, 1)];
  }));

const contractRows = [];
const forecastRows = [];
for (const p of PLANTS) {
  const avgRev = sum(YEAR.map((m) => p.base * p.p50[m] - p.grid)) / 12;
  const equip = round(avgRev * between(0.55, 0.7));
  const om = round(avgRev * between(0.04, 0.07));
  const land = round(avgRev * between(0.01, 0.02));
  for (const m of YEAR) {
    const total = p.base * p.p50[m] - p.grid;
    contractRows.push([
      p.t.disco, p.name, p.client.name, stamp(m), p.mwac, p.t.tusd, p.t.te, p.t.tusdC, p.t.tusdG, p.t.pis, p.t.icms,
      p.p50[m], round(p.grid), p.discount, round(p.base), round(p.p50[m] * (p.t.tusd + p.t.te)), round(p.base, 4), round(total),
      equip, round(equip / total, 4), om, round(om / total, 4), land, round(land / total, 4), round(total - equip - om - land), round((total - equip - om - land) / total, 4),
    ]);
    const live = isLive(p, m);
    const finalMwh = energy(p, m);
    const budgetMwh = isLive(p, addMonths(m, -1)) || live ? p.p50[m] * 0.9 * (byCompensation(p.client) ? 0.92 : 1) : 0;
    const tweak = p.i % 21 === 4 ? 1.02 : 1;
    forecastRows.push([
      p.name, m, live ? 'COD' : 'CONST', live ? round(p.perfComp, 4) : 0, round(p.perfOper, 4), p.p50[m], round(finalMwh, 3),
      round(revenueOf(p, finalMwh, m) * tweak), round(budgetMwh ? p.base * budgetMwh - p.grid : 0),
      ...LOSS_KEYS.map((k) => round(p.losses[k], 4)),
    ]);
  }
}
writeCsv('Contratos.csv',
  ['Concessionária', 'Nome do Projeto', 'Cliente', 'Mês', 'Pot. (MWac)', 'TUSD (R$/MWh)', 'TE (R$/MWh)', 'TUSD C (R$/MWh)', 'TUSD G (R$/MWh)', 'PIS/COFINS', 'ICMS (%)', 'P50 (MWh)', 'Demanda UFV', 'Desconto', 'Tarifa GD', 'Custo Cativo', 'Base de Calculo', 'Receita Total', 'Loc. Equipamentos (R$) base', 'Loc. Equipamentos (%)', 'O&M (R$) base', 'O&M (%)', 'Loc. Terras (R$) base', 'Loc. Terras (%)', 'Guarda Chuva (R$) base', 'Guarda Chuva (%)'],
  contractRows);
writeCsv('Forecast_energia.csv',
  ['projeto', 'mes', 'status', 'perfComp', 'perfOper', 'P50', 'energiaFinal', 'receitaForecast', 'budget', ...LOSS_KEYS],
  forecastRows);

writeCsv('Performance_O&M.csv', ['Rótulos de Linha', ...YEAR.slice(5).map((m) => stamp(m))],
  PLANTS.filter((p) => p.i < 70).map((p) => [p.name, ...YEAR.slice(5).map(() => round(between(0.72, 0.93), 3))]));

const dealHeader = ['Status', 'Project', 'DISCO', 'Capacity (MWp)', 'Capacity (MWac)', 'Original offtaker', 'Pipeline status', 'New offtaker expected', 'Contract term', 'Take or Pay', 'Ramp up', 'Discount', 'Base de cálculo', 'Signing date', 'COD (Conexão com a Distribuidora)', 'Troca de titularidade', 'Início da Compensação', 'Riscos'];
const OFFTAKERS = ['NOVASOL', 'MINCO', 'ALPHAEN', 'DISTRA', 'VERTA', 'ENERVA'];
const deals = PLANTS.filter((p) => p.i >= 70).map((p) => {
  const off = pick(OFFTAKERS);
  const start = addMonths(p.cod, 2);
  return { p, off, row: (dated) => [pick(['Quente', 'Frio']), p.name, p.t.disco, p.mwp, p.mwac, p.client.name, 'Negotiation', off, pick(['10 years', '15 years', 'Until 2045']), 1, `${pick([3, 6, 9])} months`, p.discount, 'TE+TUSD', dated(addMonths(p.cod, -5)), dated(p.cod), dated(addMonths(p.cod, 1)), dated(start), pick(NOTES)] };
});
writeCsv('Comercial_pipeline.csv', dealHeader, deals.map((d) => d.row((m) => `${m}-01`)));
writeCsv('Comercial.csv', dealHeader, deals.map((d) => d.row((m) => stamp(m))));
writeCsv('Comercial_rampa.csv', ['Mês/rampa', ...OFFTAKERS], Array.from({ length: 12 }, (_, i) => [i + 1, ...OFFTAKERS.map((_, j) => round(Math.min(1, (i + 1) * (0.1 + j * 0.03)), 2))]));
writeCsv('Considerações.csv', ['Usina/ Cliente/ DISCO', 'Consideração'], [
  ['NEXUS', 'Compensation assumption taken from the last 6 closed months'],
  ['Pipeline', 'Construction plants enter the forecast from the contract COD date'],
  ['Tariffs', 'ANEEL published tariffs applied from each adjustment date'],
]);
fs.writeFileSync(path.join(OUT, 'Regras.csv'), '\n');

// ---- metered compensation ---------------------------------------------------
const portfolio = [];
const perfUsinas = {};
const ucSeries = [];
const rateioScore = {};
const injecao = {};
let ucCounter = 91000000;
const metered = PLANTS.filter((p) => p.i < 70 && byCompensation(p.client));

for (const p of metered) {
  const n = p.client.name === 'TELMO' ? int(24, 48) : int(5, 20);
  const raw = Array.from({ length: n }, () => between(0.4, 2));
  const total = sum(raw);
  const ucs = raw.map((r) => ({ uc: String(ucCounter += int(3, 90)), rateio: r / total, aproveit: between(0.86, 1), saldo: between(0, 6000), serie: [] }));
  p.ucList = ucs;
  const genId = String(ucCounter += 7);
  const dist = p.t.disco;
  const meses = {};
  const serie = [];
  p.bank = [];
  for (const m of HIST) {
    const a = p.actual[m];
    const injK = Math.round(a.injected * 1000);
    if (injK === 0) continue;
    const partial = m === OPEN;
    const list = [{ uc: genId, dist, rateio: 0.0002, consumo: 1100, compensado: 700, injetado: injK, saldo: 0 }];
    let comp = 0, cons = 0, saldo = 0;
    for (const u of ucs) {
      const seen = !partial || u.rateio % 0.01 > 0.0035;
      const credit = u.rateio * injK;
      const used = credit * (a.credited / a.injected) * (p.accumulating ? between(0.92, 1.05) : between(0.97, 1.02));
      const consumo = Math.round(used / u.aproveit);
      u.saldo = Math.max(0, u.saldo + credit - used);
      u.serie.push({ mes: m, comp: seen ? Math.round(used) : 0, cons: seen ? consumo : 0, saldo: Math.round(u.saldo) });
      if (!seen) continue;
      comp += used; cons += consumo; saldo += u.saldo;
      // A few planted anomalies so the audit screen has something to find.
      const unitIndex = ucs.indexOf(u);
      const spike = p.i % 4 === 0 && unitIndex === 0 && m === '2026-03';
      const missing = p.i % 5 === 0 && unitIndex === 1 && m === '2026-05';
      const shown = spike ? used * 2.4 : missing ? 0 : used;
      list.push({ uc: u.uc, dist, rateio: round(u.rateio, 4), consumo, compensado: Math.round(shown), injetado: 0, saldo: Math.round(u.saldo) });
    }
    meses[m] = {
      nUCs: list.length, consumo: Math.round(cons + 1100), compensado: Math.round(comp + 700), injecao: injK,
      perfComp: round(comp / injK, 4), aproveit: round(comp / cons, 4), rateioPct: partial ? round(between(0.58, 0.72), 4) : round(between(0.985, 1.012), 4), ucs: list,
    };
    p.bank.push({ m, saldoMWh: round(saldo / 1000, 1) });
    const pm = Math.round((comp / injK) * 100);
    const recent = serie.slice(-2).map((s) => s.perfMes).concat(pm);
    serie.push({ mes: m, injetado: injK, compensado: Math.round(comp), saldo: Math.round(saldo), perfMes: pm, perfMovel: Math.round(sum(recent) / recent.length) });
  }
  portfolio.push({ usina: p.name, meses });
  perfUsinas[p.name] = { serie };
  for (const u of ucs) {
    const cons = sum(u.serie.map((s) => s.cons));
    ucSeries.push({ uc: u.uc, serie: u.serie, aproveitAno: cons ? round(sum(u.serie.map((s) => s.comp)) / cons, 3) : null });
  }
  const scoreUcs = ucs.slice(0, 40).map((u) => {
    const delta = round(between(-0.012, 0.012), 4);
    return { uc: u.uc, rateio: round(u.rateio, 4), rateioSug: round(Math.max(0, u.rateio + delta), 4), delta, cons: int(2000, 22000), saldo: Math.round(u.saldo), status: delta < 0 ? 'excesso' : 'deficit' };
  });
  rateioScore[p.name] = {
    score: p.accumulating ? int(38, 64) : int(72, 96), excesso: int(5000, 90000), deficit: int(1000, 60000),
    aproveit: Math.round(p.perfComp * 100), bancoMeses: round(p.accumulating ? between(3, 9) : between(0.3, 2), 1), nUC: n, ucs: scoreUcs,
  };
}
for (const p of PLANTS.filter((x) => x.i < 70 && !byCompensation(x.client))) {
  injecao[p.name] = {
    excelNome: p.name,
    serie: Object.fromEntries(YEAR.map((m) => [m, { injetadoMWh: m <= CLOSED ? round(p.actual[m].injected) : null, pvsystMWh: p.p50[m] }])),
  };
}
writeJson('comp_portfolio.json', portfolio);
writeJson('perfcomp_usinas.json', perfUsinas);
writeJson('perfcomp_exemplo.json', { usina: portfolio[0].usina, serie: perfUsinas[portfolio[0].usina].serie });
writeJson('perfcomp_ucs.json', { ucs: ucSeries });
writeJson('rateio_score.json', rateioScore);
writeJson('injecao_excel.json', injecao);

// ---- derived views for the new screens --------------------------------------
const closedMonths = YEAR.filter((m) => m <= CLOSED);
const live = PLANTS.filter((p) => p.i < 70);
const actualRevenue = (p, m) => {
  if (!isLive(p, m) || m > CLOSED) return 0;
  return revenueOf(p, byCompensation(p.client) ? p.actual[m].credited : p.actual[m].injected, m);
};
const budgetByMonth = Object.fromEntries(YEAR.map((m) => [m, sum(forecastRows.filter((r) => r[1] === m).map((r) => r[8]))]));
const trueByMonth = Object.fromEntries(YEAR.map((m) => [m, m <= CLOSED ? sum(PLANTS.map((p) => actualRevenue(p, m))) : sum(forecastRows.filter((r) => r[1] === m).map((r) => r[7]))]));

// Forecast evolution
const CAUSES = ['COD timing', 'Generation', 'Compensation', 'Tariff', 'Client change'];
const revisions = [{ id: 'budget', label: 'Budget', closed: 0, byMonth: budgetByMonth, received: '2025-12-12' }];
for (let k = 1; k <= 9; k++) {
  const byMonth = {};
  YEAR.forEach((m, i) => {
    if (i < k) byMonth[m] = trueByMonth[m];
    else {
      const closeness = Math.max(0.15, Math.min(0.95, 0.25 + k * 0.08 + (0.1 * (k - i + 6)) / 6));
      byMonth[m] = budgetByMonth[m] + (trueByMonth[m] - budgetByMonth[m]) * closeness * between(0.94, 1.06);
    }
  });
  revisions.push({ id: `${k}+${12 - k}`, label: `${k}+${12 - k}`, closed: k, byMonth, received: `${addMonths(YEAR[k - 1], 1)}-${int(8, 14)}` });
}
const totalOf = (r) => sum(YEAR.map((m) => r.byMonth[m]));
const bridges = revisions.slice(1).map((r, i) => {
  const from = revisions[i];
  const delta = totalOf(r) - totalOf(from);
  const w = CAUSES.map(() => between(0.05, 1));
  const ws = sum(w);
  return { from: from.label, to: r.label, delta: Math.round(delta), causes: Object.fromEntries(CAUSES.map((c, j) => [c, Math.round((delta * w[j]) / ws)])) };
});
const accuracy = revisions.slice(1).map((r) => {
  const ahead = (h) => {
    const m = YEAR[r.closed + h - 1];
    if (!m || m > CLOSED) return null;
    return round(Math.abs(r.byMonth[m] - trueByMonth[m]) / trueByMonth[m], 4);
  };
  return { label: r.label, oneAhead: ahead(1), threeAhead: ahead(3) };
});
const movers = PLANTS.slice(0, 84).map((p) => ({
  plant: p.name, client: p.client.name, cause: pick(CAUSES), delta: Math.round(between(-260000, 140000)),
})).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 12);

// Credit bank
const bank = metered.map((p) => {
  const series = p.bank.slice(0, -1);
  const last = series.at(-1)?.saldoMWh ?? 0;
  const delta3m = last - (series.at(-4)?.saldoMWh ?? 0);
  return {
    plant: p.name, client: p.client.name, disco: p.t.disco, saldoMWh: last, value: Math.round(last * p.base), delta3m: round(delta3m, 1),
    expiring12m: round(p.accumulating ? last * between(0.02, 0.1) : 0, 1),
    status: delta3m > last * 0.08 ? 'Accumulating' : delta3m < -last * 0.05 ? 'Draining' : 'Stable',
    utilisation: Math.round(p.perfComp * 100), series: series.map((s) => s.saldoMWh),
  };
}).sort((a, b) => b.value - a.value);
const backtest = closedMonths.slice(-6).map((m) => {
  const real = sum(metered.map((p) => p.actual[m].credited));
  return {
    month: m, real: Math.round(real),
    flat: Math.round(sum(metered.map((p) => p.p50[m] * p.perfOper * 0.88))),
    simulated: Math.round(real * between(0.965, 1.035)),
  };
});

// Provisioning
const provisionMonth = OPEN;
const SOURCES = ['Measured', 'Partial + credit bank', 'Credit bank', 'Previous month', 'Estimated'];
const provision = PLANTS.filter((p) => isLive(p, provisionMonth)).map((p) => {
  const a = p.actual[provisionMonth];
  const comp = byCompensation(p.client);
  const source = comp ? pick([SOURCES[1], SOURCES[1], SOURCES[2], SOURCES[0]]) : pick([SOURCES[0], SOURCES[0], SOURCES[3], SOURCES[4]]);
  const mwh = comp ? a.credited : a.injected;
  const gridSource = pick(['Invoice', 'Invoice', 'Previous month', 'Model']);
  const grid = p.grid * (gridSource === 'Invoice' ? between(0.96, 1.05) : 1);
  return {
    plant: p.name, client: p.client.name, disco: p.t.disco, model: p.client.model, injected: round(a.injected, 1),
    mwh: round(mwh, 1), source, base: round(p.base, 2), grid: Math.round(grid), gridSource,
    forecast: Math.round(revenueOf(p, energy(p, provisionMonth), provisionMonth)),
    steps: comp
      ? [`Invoices already issued cover ${int(45, 92)}% of consumer units`, 'Remaining units estimated from each unit credit balance and consumption history', 'Result capped at consumption plus available credits']
      : ['Injected energy read from the generator invoice or site meter', 'Take-or-pay contract: billed on injected energy'],
  };
});

// Performance and O&M losses
const perfMonths = HIST.slice(0, 12);
const perfSeries = perfMonths.map((m) => {
  const key = m.startsWith('2025') ? `2026-${m.slice(5, 7)}` : m;
  const site = live.filter((p) => isLive(p, m));
  const p50 = sum(site.map((p) => p.p50[key]));
  const inj = sum(site.map((p) => p.actual[m].injected));
  return { month: m, ratio: round(inj / p50, 4), availability: round(between(0.965, 0.993), 4), irradiance: round(between(-0.06, 0.06), 3) };
});
const CAUSES_LOSS = ['Inverter fault', 'Grid outage', 'Transformer', 'Tracker or structure', 'Soiling', 'Communication loss'];
const incidents = Array.from({ length: 34 }, (_, i) => {
  const p = pick(live);
  const start = `2026-${String(int(6, 10)).padStart(2, '0')}-${String(int(1, 27)).padStart(2, '0')}`;
  const days = int(1, 16);
  const lost = round((p.p50['2026-09'] / 30) * days * between(0.08, 0.7), 1);
  return { id: `INC-${1400 + i}`, plant: p.name, client: p.client.name, cause: pick(CAUSES_LOSS), start, days, lostMWh: lost, lostValue: Math.round(lost * p.base), open: i % 4 === 0 };
}).sort((a, b) => b.lostValue - a.lostValue);
const plantPerf = live.map((p) => {
  const a = p.actual[CLOSED];
  return {
    plant: p.name, client: p.client.name, disco: p.t.disco, mwp: p.mwp, p50: p.p50[CLOSED], injected: round(a.injected, 1), ratio: round(a.injected / p.p50[CLOSED], 3),
    irrDelta: round(between(-0.08, 0.08), 3), yieldDelta: round(between(-0.09, 0.05), 3), lostMWh: round(sum(incidents.filter((x) => x.plant === p.name).map((x) => x.lostMWh)), 1),
  };
});

// Ingestion and reconciliation
const SOURCE_FEEDS = [
  { name: 'Inverter telemetry', kind: 'API, 15 min', expected: 1860480, received: 1842210, lag: 22, status: 'Healthy' },
  { name: 'Site revenue meters', kind: 'File drop, daily', expected: 2100, received: 2072, lag: 340, status: 'Healthy' },
  { name: 'Distributor invoices', kind: 'Portal robot, daily', expected: 1320, received: 1046, lag: 1560, status: 'Delayed' },
  { name: 'Consumer unit bills', kind: 'API, daily', expected: 9840, received: 9412, lag: 900, status: 'Healthy' },
  { name: 'Published tariffs', kind: 'Public API, weekly', expected: 18, received: 18, lag: 4320, status: 'Healthy' },
  { name: 'Finance ledger', kind: 'Export, monthly', expected: 84, received: 79, lag: 8640, status: 'Partial' },
];
const runs = Array.from({ length: 14 }, (_, i) => ({
  day: `2026-10-${String(30 - i).padStart(2, '0')}`, loaded: int(92000, 128000), rejected: int(10, 420), retried: int(0, 60), minutes: int(6, 19), ok: i !== 5,
}));
const heatSites = live.slice(0, 24).map((p) => ({
  plant: p.name, days: Array.from({ length: 21 }, () => { const r = rnd(); return r < 0.84 ? 100 : r < 0.95 ? int(70, 99) : int(0, 69); }),
}));
const recon = live.map((p, idx) => {
  const a = p.actual[CLOSED];
  const meter = a.injected;
  const flagged = idx % 6 === 2;
  const inverter = meter / (flagged && idx % 12 === 2 ? between(0.9, 0.95) : between(0.982, 0.992));
  const invoice = meter * (flagged && idx % 12 === 8 ? between(0.93, 0.97) : between(0.998, 1.003));
  const credited = byCompensation(p.client) ? a.credited : invoice;
  const billed = credited * (flagged && idx % 18 === 2 ? between(0.95, 0.98) : 1);
  return { plant: p.name, client: p.client.name, inverter: round(inverter, 1), meter: round(meter, 1), invoice: round(invoice, 1), credited: round(credited, 1), billed: round(billed, 1), base: round(p.base, 2) };
});

// Billing to finance
const billingClients = [...new Set(live.map((p) => p.client.name))];
const STAGES = ['Draft', 'Validated', 'Issued', 'Posted', 'Paid'];
const billing = billingClients.map((c, i) => {
  const ps = live.filter((p) => p.client.name === c);
  const mwh = sum(ps.map((p) => (byCompensation(p.client) ? p.actual[CLOSED].credited : p.actual[CLOSED].injected)));
  const gross = sum(ps.map((p) => revenueOf(p, byCompensation(p.client) ? p.actual[CLOSED].credited : p.actual[CLOSED].injected, CLOSED)));
  const accrual = gross * between(0.96, 1.04);
  return {
    id: `BST-2609-${String(i + 1).padStart(3, '0')}`, client: c, plants: ps.length, mwh: round(mwh, 1), gross: Math.round(gross), taxes: Math.round(gross * 0.0925), accrual: Math.round(accrual),
    stage: STAGES[Math.min(4, Math.floor(i / 3))], doc: i < 9 ? `FI-${5100000 + i * 37}` : '', costCentre: `CC-${int(410, 460)}`,
  };
});

// O&M tickets
const TEAMS = ['Field team North', 'Field team South', 'Remote operations', 'Distributor liaison'];
const TICKET_STATES = ['Open', 'Assigned', 'On site', 'Resolved'];
const tickets = incidents.slice(0, 26).map((x, i) => ({
  id: `TK-${2300 + i}`, plant: x.plant, client: x.client, title: x.cause, source: pick(['Alert rule', 'Alert rule', 'Reconciliation', 'Manual']), priority: i < 5 ? 'High' : i < 14 ? 'Medium' : 'Low',
  state: TICKET_STATES[i % 4], team: pick(TEAMS), slaHours: pick([24, 48, 72, 120]), ageHours: int(2, 150), mwhPerDay: round(x.lostMWh / x.days, 1), valuePerDay: Math.round(x.lostValue / x.days),
}));

// Asset register
const register = PLANTS.map((p) => {
  const docs = { contract: rnd() > 0.05, commissioning: p.i < 70 && rnd() > 0.12, warranty: rnd() > 0.2, insurance: rnd() > 0.15, landTitle: rnd() > 0.1 };
  const inverters = Math.max(2, Math.round(p.mwac * pick([8, 10, 12])));
  const filled = sum(Object.values(docs).map(Number));
  return { plant: p.name, client: p.client.name, disco: p.t.disco, mwp: p.mwp, mwac: p.mwac, cod: p.cod, status: p.i < 70 ? 'Operating' : 'Construction', inverters, docs, completeness: Math.round(((filled + 6) / 11) * 100) };
});
const registerChanges = Array.from({ length: 10 }, (_, i) => {
  const p = pick(live);
  const n = int(8, 24);
  return pick([
    { plant: p.name, field: 'Inverter count', register: n, source: n - 1, from: 'Monitoring API', action: 'Review' },
    { plant: p.name, field: 'Offtaker', register: p.client.name, source: pick(OFFTAKERS), from: 'Distributor invoice', action: 'Review' },
    { plant: p.name, field: 'Meter serial', register: `M${40000 + i * 11}`, source: `M${51000 + i * 7}`, from: 'Meter file', action: 'Review' },
    { plant: p.name, field: 'Commissioning date', register: `${p.cod}-15`, source: `${p.cod}-18`, from: 'Commissioning report', action: 'Auto-applied' },
  ]);
});

// Customer portal
const portal = billingClients.map((c) => {
  const ps = live.filter((p) => p.client.name === c);
  const months = closedMonths.map((m) => {
    const mwh = sum(ps.map((p) => (isLive(p, m) ? (byCompensation(p.client) ? p.actual[m].credited : p.actual[m].injected) : 0)));
    const saving = sum(ps.map((p) => (isLive(p, m) ? (byCompensation(p.client) ? p.actual[m].credited : p.actual[m].injected) * (p.t.tusd + p.t.te) * Math.max(p.discount, 0.05) : 0)));
    return { month: m, mwh: Math.round(mwh), saving: Math.round(saving) };
  });
  return {
    client: c, sites: ps.map((p) => ({ plant: p.name, mwp: p.mwp, disco: p.t.disco, ratio: round(p.actual[CLOSED].injected / p.p50[CLOSED], 3) })), months,
    invoices: closedMonths.slice(-6).reverse().map((m, i) => ({ id: `INV-${m.replace('-', '')}-${c.slice(0, 3)}`, month: m, amount: Math.round(sum(ps.map((p) => Math.max(0, actualRevenue(p, m))))), status: i === 0 ? 'Due' : 'Paid' })),
  };
});

// Client service: requests, routing, client 360 and energy per consumer unit
const NOW = '2026-11-11T12:00:00Z';
const TEAM = [
  { name: 'Ana Ribeiro', area: 'Asset' }, { name: 'Bruno Costa', area: 'Billing' }, { name: 'Carla Mendes', area: 'O&M' },
  { name: 'Diego Alves', area: 'Legal' }, { name: 'Elisa Nunes', area: 'Connection' }, { name: 'Felipe Rocha', area: 'Finance' },
];
const ROUTING = [
  { id: 'billing', label: 'Invoice or billing', area: 'Billing', owner: 'Bruno Costa', deadlineDays: 5, firstReplyHours: 8 },
  { id: 'credits', label: 'Credits and allocation', area: 'Asset', owner: 'Ana Ribeiro', deadlineDays: 10, firstReplyHours: 16 },
  { id: 'generation', label: 'Generation or plant issue', area: 'O&M', owner: 'Carla Mendes', deadlineDays: 7, firstReplyHours: 8 },
  { id: 'contract', label: 'Contract and documents', area: 'Legal', owner: 'Diego Alves', deadlineDays: 15, firstReplyHours: 24 },
  { id: 'connection', label: 'Connection or distributor', area: 'Connection', owner: 'Elisa Nunes', deadlineDays: 20, firstReplyHours: 24 },
  { id: 'other', label: 'Other', area: 'Asset', owner: 'Ana Ribeiro', deadlineDays: 10, firstReplyHours: 16 },
];
const routeOf = (id) => ROUTING.find((r) => r.id === id);
const ownerOfArea = (area) => TEAM.find((t) => t.area === area).name;
const TEMPLATES = {
  billing: [
    { s: 'September statement higher than August', q: 'Our September statement for {plant} is about 12% above August. Can you explain the difference?', n: 'Checked against the distributor invoice. The tariff adjustment explains it, no billing error.', a: 'The difference comes from the {disco} tariff adjustment that applies from this cycle. The breakdown per unit is attached.', f: 'statement_{plant}_2026-09.pdf' },
    { s: 'Copy of the October invoice', q: 'Please send a copy of the October invoice for our accounts payable team.', a: 'The October invoice is attached. It is also listed under your documents.', f: 'invoice_2026-10.pdf' },
    { s: 'Payment slip shows the wrong due date', q: 'The payment slip we received shows a due date before the invoice date.', n: 'Template issue on one slip only. Reissued with the correct date.', a: 'Thank you for flagging it. A corrected slip is attached and the original is cancelled.', f: 'payment_slip_corrected.pdf' },
  ],
  credits: [
    { s: 'Move credits between two of our units', q: 'We closed one branch. Can the credits from unit {uc} go to our main office from next month?', n: 'Allocation change needs a new form filed with {disco}. Minimum period applies, earliest effect is the next cycle.', a: 'Yes. We will file the new allocation with {disco}. The change takes effect from the next billing cycle and the existing balance stays with the unit.' },
    { s: 'Credits not showing on unit {uc}', q: 'Unit {uc} has had no compensation on its last bill even though the plant is generating.', n: 'Unit missing from the distributor allocation list since the last filing. Asked {disco} to reprocess.', a: 'The unit was left out of the distributor list in the last filing. We asked {disco} to reprocess it and the credits will appear on the next bill.' },
    { s: 'Balance of credits close to expiry?', q: 'Are any of our credits at risk of expiring in the next 12 months?', a: 'No credits expire in the next 12 months. The balance by unit and month is attached.', f: 'credit_balance_by_unit.xlsx' },
  ],
  generation: [
    { s: '{plant} generation low in October', q: 'Generation at {plant} looks lower than usual this month. Is there a problem at the site?', n: 'Inverter 3 tripped on 14 Oct, restarted on 17 Oct after a field visit. About 4 MWh lost.', a: 'One inverter stopped for three days and was restarted after a site visit. The plant is back to normal output.' },
    { s: 'Monthly generation report for {plant}', q: 'Can we receive the monthly generation report for {plant} by e-mail?', a: 'The October report is attached. Reports are also available here every month.', f: 'generation_report_{plant}_2026-10.pdf' },
  ],
  contract: [
    { s: 'Signed contract and amendments', q: 'Please share the signed contract and any amendments for {plant}.', a: 'The signed contract and the 2025 amendment are attached.', f: 'contract_{plant}_signed.pdf' },
    { s: 'Contract end date and renewal', q: 'When does the contract for {plant} end, and how does renewal work?', n: 'Renewal clause needs 12 months notice. Confirmed with the commercial team.', a: 'The contract runs to the end date shown under your plants. Renewal needs 12 months notice from either side.' },
  ],
  connection: [
    { s: 'New unit to add to compensation', q: 'We opened a new store and would like unit {uc} added to the credit allocation.', n: 'New unit must be in the same distributor area and under the same holder. Checked, both fine.', a: 'The unit qualifies. We will include it in the next allocation filing with {disco}.' },
    { s: 'Distributor still billing a unit without credits', q: '{disco} is still billing unit {uc} as if it had no credits.', a: 'We opened a claim with {disco}. They usually answer within 30 days and we will update you here.' },
  ],
  other: [
    { s: 'Access for a second colleague', q: 'Can my colleague from finance also have access to this portal?', a: 'Access created. Your colleague will receive a sign-in link.' },
  ],
};
const ASKED_CLIENT = [
  { c: 'credits', s: 'Updated list of consumer units needed', a: 'To prepare the next allocation filing, please confirm the current list of your consumer units.', r: 'Here is the updated list, two units were closed.', f: 'unit_list_2026-10.xlsx' },
  { c: 'contract', s: 'Signed allocation form pending', a: 'The allocation form for {plant} still needs your signature before we can file it with {disco}.', r: 'Signed form attached.', f: 'allocation_form_signed.pdf' },
  { c: 'billing', s: 'Confirm billing contact', a: 'Please confirm who should receive invoices from November.' },
];
const INTERNAL = [
  { c: 'credits', s: 'Credit balance growing at {plant}', n: 'Balance rising for three months. Check whether the allocation still matches consumption.' },
  { c: 'other', s: 'Prepare quarterly review pack', n: 'Collect generation, savings and open items for the quarterly meeting.' },
];
const fill = (t, ctx) => t && t.replace(/\{plant\}/g, ctx.plant).replace(/\{disco\}/g, ctx.disco).replace(/\{uc\}/g, ctx.uc);
const nowMs = Date.parse(NOW);
const iso = (ms) => new Date(ms).toISOString();
const HOUR = 3600000, DAY = 24 * HOUR;
const serviceClients = billingClients.map((c) => ({ name: c, plants: live.filter((p) => p.client.name === c) }));
const requests = [];
let reqNo = 1040;
const STATUS_OPEN = ['new', 'in_review', 'awaiting_client', 'awaiting_third_party', 'answered'];
for (let k = 0; k < 64; k++) {
  const sc = serviceClients[k < 30 ? k % 5 : int(0, serviceClients.length - 1)];
  const p = pick(sc.plants);
  const ctx = { plant: p.name, disco: p.t.disco, uc: p.ucList ? pick(p.ucList).uc : `${int(30000000, 39999999)}` };
  const imported = k >= 52;
  const kind = imported ? 'client' : k % 9 === 4 ? 'asked' : k % 13 === 7 ? 'internal' : 'client';
  const ageDays = imported ? between(45, 110) : k < 18 ? between(0.2, 9) : between(3, 80);
  const created = nowMs - ageDays * DAY;
  let cat, subject, msgs = [], files = [];
  const t0 = created;
  if (kind === 'client') {
    cat = pick(ROUTING.filter((r) => TEMPLATES[r.id])).id;
    const tp = pick(TEMPLATES[cat]);
    subject = fill(tp.s, ctx);
    msgs.push({ type: 'client', author: `${sc.name} contact`, text: fill(tp.q, ctx), at: iso(t0) });
    msgs._tp = tp;
  } else if (kind === 'asked') {
    const tp = pick(ASKED_CLIENT);
    cat = tp.c; subject = fill(tp.s, ctx);
    msgs.push({ type: 'reply', author: ownerOfArea(routeOf(cat).area), text: fill(tp.a, ctx), at: iso(t0) });
    msgs._tp = tp;
  } else {
    const tp = pick(INTERNAL);
    cat = tp.c; subject = fill(tp.s, ctx);
    msgs.push({ type: 'internal', author: ownerOfArea(routeOf(cat).area), text: fill(tp.n, ctx), at: iso(t0) });
  }
  const route = routeOf(cat);
  // status from age
  let status;
  if (imported) status = rnd() < 0.7 ? 'closed' : pick(['in_review', 'awaiting_third_party']);
  else if (ageDays > 25) status = rnd() < 0.85 ? 'closed' : pick(['awaiting_third_party', 'in_review']);
  else if (ageDays < 1.3) status = 'new';
  else status = pick(['in_review', 'in_review', 'awaiting_client', 'awaiting_third_party', 'answered', 'closed']);
  if (kind === 'asked' && status === 'new') status = 'awaiting_client';
  // first reply
  let firstReply = null;
  if (!imported && kind === 'client' && status !== 'new') {
    const lateReply = rnd() < 0.14;
    const h = lateReply ? between(route.firstReplyHours * 1.2, route.firstReplyHours * 3) : between(0.6, route.firstReplyHours * 0.9);
    firstReply = Math.min(created + h * HOUR * (rnd() < 0.3 ? 1.6 : 1), nowMs - HOUR);
  }
  const tp = msgs._tp;
  delete msgs._tp;
  let tCursor = firstReply ?? created + between(2, 20) * HOUR;
  if (kind === 'client' && status !== 'new') {
    if (tp.n) msgs.push({ type: 'internal', author: route.owner, text: fill(tp.n, ctx), at: iso(Math.min(tCursor - 0.3 * HOUR, nowMs - 2 * HOUR)) });
    if (status === 'in_review' || status === 'awaiting_third_party') {
      msgs.push({ type: 'reply', author: route.owner, text: 'Thank you, we are looking into it and will come back to you here.', at: iso(Math.min(tCursor, nowMs - HOUR)) });
    } else {
      msgs.push({ type: 'reply', author: route.owner, text: fill(tp.a, ctx), at: iso(Math.min(tCursor, nowMs - HOUR)) });
      if (tp.f) files.push({ name: fill(tp.f, ctx).replace(/ /g, '_'), size: int(80, 2400) * 1000, by: route.owner, visible: true });
    }
  }
  if (kind === 'asked' && status !== 'awaiting_client' && tp.r) {
    msgs.push({ type: 'client', author: `${sc.name} contact`, text: tp.r, at: iso(Math.min(created + between(20, 90) * HOUR, nowMs - HOUR)) });
    if (tp.f) files.push({ name: tp.f, size: int(30, 900) * 1000, by: `${sc.name} contact`, visible: true });
  }
  if (status === 'awaiting_client' && kind === 'client') msgs.push({ type: 'reply', author: route.owner, text: 'Could you send us the latest bill for this unit so we can check it?', at: iso(Math.min(tCursor + 2 * HOUR, nowMs - HOUR)) });
  if (imported) msgs.push({ type: 'internal', author: 'Import', text: 'Imported from the team spreadsheet with its history. Response time is not measured for imported items.', at: iso(created) });
  // transfers
  const events = [{ at: iso(created), text: imported ? 'Imported from spreadsheet' : kind === 'client' ? 'Opened by client in the portal' : 'Registered by the team' }];
  let area = route.area, owner = status === 'new' ? null : route.owner;
  if (!imported && status !== 'new' && rnd() < 0.18) {
    const to = pick(TEAM.filter((t) => t.area !== area));
    events.push({ at: iso(created + between(1, 6) * HOUR), text: `Transferred from ${area} to ${to.area} (${to.name}): ${pick(['Billing question, not credits', 'Needs a site visit', 'Contract clause involved', 'Distributor claim needed'])}` });
    area = to.area; owner = to.name;
  }
  const closed = status === 'closed' ? Math.min(created + between(0.5, route.deadlineDays * 1.35) * DAY, nowMs - HOUR) : null;
  if (closed) events.push({ at: iso(closed), text: 'Closed' });
  const paused = ['awaiting_client', 'awaiting_third_party', 'answered'].includes(status);
  const pausedSec = Math.round((rnd() < 0.35 ? between(0.5, 4) : 0) * DAY / 1000);
  requests.push({
    no: reqNo++, client: sc.name, plant: kind === 'internal' || rnd() > 0.15 ? p.name : null, category: cat, subject,
    direction: kind === 'client' ? 'client_asked' : kind === 'asked' ? 'team_asked' : 'internal',
    origin: imported ? 'imported' : kind === 'client' ? 'portal' : 'team',
    status, area, owner, created: iso(created), firstReply: firstReply ? iso(firstReply) : null, closed: closed ? iso(closed) : null,
    deadline: iso(created + route.deadlineDays * DAY).slice(0, 10), pausedSec, pauseSince: paused ? iso(Math.max(created, nowMs - between(0.3, 5) * DAY)) : null,
    sensitivity: rnd() < 0.1 ? 'high' : 'normal', visible: kind !== 'internal' && !(imported && rnd() < 0.5),
    messages: msgs.sort((a, b) => a.at.localeCompare(b.at)), files, events,
  });
}
requests.sort((a, b) => b.created.localeCompare(a.created));

const SENSITIVITIES = [
  'Finance team approves invoices only in the first five working days of the month.',
  'Prefers one consolidated statement for all sites instead of one per plant.',
  'Disputed a tariff adjustment in 2026. Resolved, keep the evidence at hand.',
  'Unit list changes often. Confirm it before each allocation filing.',
  'Main contact is the energy manager. Copy the finance director on anything about payment.',
  'Asked for generation reports in English for their parent company.',
  'Sensitive to delays on credits. Answer the same day where possible.',
];
const FIRST = ['Marina', 'Paulo', 'Renata', 'Lucas', 'Juliana', 'Rafael', 'Camila', 'Thiago', 'Beatriz', 'Gustavo'];
const LAST = ['Souza', 'Lima', 'Pereira', 'Carvalho', 'Gomes', 'Martins', 'Araujo', 'Barbosa'];
const monthsClosed = HIST.filter((m) => m <= CLOSED);
const clients360 = serviceClients.map((sc) => {
  const accesses = Array.from({ length: int(1, 3) }, (_, i) => {
    const f = pick(FIRST), l = pick(LAST);
    return { name: `${f} ${l}`, email: `${f[0].toLowerCase()}.${l.toLowerCase()}@${sc.name.toLowerCase()}.example`, lastSignIn: i === 2 ? null : `2026-${pick(['10', '11'])}-${String(int(1, 10)).padStart(2, '0')}` };
  });
  const plants = PLANTS.filter((p) => p.client.name === sc.name).map((p) => {
    const term = pick([10, 12, 15]);
    const operating = p.i < 70;
    return {
      plant: p.name, disco: p.t.disco, mwac: p.mwac, cod: operating ? p.cod : null, start: operating ? p.cod : null,
      end: operating ? addMonths(p.cod, term * 12) : null, termYears: term, connection: operating ? (byCompensation(p.client) ? 'Compensation active' : 'In operation') : 'Under construction', visible: operating,
    };
  });
  // energy per consumer unit (compensation clients only)
  const ucs = [];
  for (const p of sc.plants.filter((x) => x.ucList)) {
    for (const u of p.ucList) {
      const s = u.serie.filter((x) => x.mes <= CLOSED);
      const last12 = s.slice(-12);
      const cons = sum(last12.map((x) => x.cons)), comp = sum(last12.map((x) => x.comp));
      const bal = s.map((x) => x.saldo);
      const avgCons = cons / Math.max(1, last12.filter((x) => x.cons > 0).length);
      const rising = bal.length >= 4 && bal[bal.length - 1] > bal[bal.length - 2] && bal[bal.length - 2] > bal[bal.length - 3] && bal[bal.length - 3] > bal[bal.length - 4];
      const monthsCons = s.filter((x) => x.cons > 0).length;
      const balance = bal[bal.length - 1] ?? 0;
      let warning = rising && monthsCons >= 6 && balance > 10 * avgCons ? 'building' : null;
      ucs.push({ plant: p.name, uc: u.uc, share: round(u.rateio, 4), cons, comp, balance, balanceMonths: round(balance / Math.max(1, avgCons), 1), trend: bal.slice(-6), warning });
    }
  }
  // a few units with consumption but no credits for three months, for the warning list
  ucs.filter((_, i) => i % 37 === 11).forEach((u) => { u.warning = 'nocredits'; u.comp = Math.round(u.comp * 0.75); });
  return {
    client: sc.name, model: sc.plants[0].client.model, accesses, plants, sensitivities: Array.from(new Set([pick(SENSITIVITIES), pick(SENSITIVITIES)])),
    revenueYear: Math.round(sum(sc.plants.map((p) => sum(monthsClosed.slice(-12).map((m) => Math.max(0, actualRevenue(p, m))))))), ucs,
  };
});

writeJson('demo_extras.json', {
  generated: 'synthetic', closed: CLOSED, open: OPEN,
  evolution: { months: YEAR, causes: CAUSES, revisions: revisions.map((r) => ({ ...r, byMonth: Object.fromEntries(YEAR.map((m) => [m, Math.round(r.byMonth[m])])) })), actual: Object.fromEntries(closedMonths.map((m) => [m, Math.round(trueByMonth[m])])), bridges, accuracy, movers },
  bank: { plants: bank, months: HIST.slice(0, 12), backtest },
  provision: { month: provisionMonth, rows: provision },
  performance: { series: perfSeries, plants: plantPerf, incidents },
  pipeline: { feeds: SOURCE_FEEDS, runs, heat: heatSites, recon },
  billing: { month: CLOSED, stages: STAGES, rows: billing },
  tickets: { states: TICKET_STATES, rows: tickets },
  register: { rows: register, changes: registerChanges },
  portal,
  service: { now: NOW, team: TEAM, routing: ROUTING, requests, clients: clients360 },
});
console.log(`service requests ${requests.length}, clients ${clients360.length}, warnings ${sum(clients360.map((c) => c.ucs.filter((u) => u.warning).length))} of ${sum(clients360.map((c) => c.ucs.length))} units`);

console.log(`plants ${PLANTS.length}, metered ${metered.length}, consumer units ${ucSeries.length}`);
console.log(`2026 budget R$ ${Math.round(sum(Object.values(budgetByMonth))).toLocaleString('en')}, outlook R$ ${Math.round(sum(Object.values(trueByMonth))).toLocaleString('en')}`);
