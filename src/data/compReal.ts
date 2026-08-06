/** Compensação REAL medida (MeterHub / comp_portfolio) por usina e mês.
 *
 *  Fecha o ciclo do forecast: para meses já fechados, a receita pode usar o
 *  compensado REAL (limpo) em vez da premissa (perfComp × P50 × perfOper).
 *
 *  "Limpo" = Σ compensado das UCs consumidoras, excluindo a geradora (medidor
 *  da usina) e glitches de fatura — exatamente o "Compensado ✓" da aba
 *  Compensação. Unidade: MWh (comp_portfolio vem em kWh → ÷1000).
 */
import { secureText } from '../secure';
import { DATA_INFO } from '../lib/dataInfo';

interface UCm { uc: string; consumo: number; compensado: number; injetado: number }
interface MesData { ucs: UCm[] }
interface UsinaComp { usina: string; meses: Record<string, MesData> }

const ehGeradora = (u: UCm) => (u.injetado ?? 0) > 5000 && (u.injetado ?? 0) > u.consumo;
const ehGlitch = (u: UCm) => !ehGeradora(u) && u.compensado > Math.max(u.consumo, u.injetado ?? 0, 1) * 1.5;

/** normaliza nome de usina p/ casar Compensação (MeterHub) × Receita (Forecast). */
const ROM: Record<string, string> = { i: '1', ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10' };
export const normU = (s: string): string => {
  let t = (s || '').normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  t = t.replace(/\([^)]*\)/g, '').replace(/,.*/, '').replace(/-/g, ' ');
  t = t.split(/\s+/).map((w) => ROM[w] ?? w).join('');
  t = t.replace(/0+(\d)/g, '$1');
  return t.replace(/[^a-z0-9]/g, '');
};
/** nomes que diferem demais entre as duas fontes (chave = nome MeterHub). */
export const ALIAS_USINA: Record<string, string> = {
  'Buriti - OPERON': 'Buriti',
  'Peroba 2 (TELCO)': 'Peroba 2',
  'Peroba 3 (TELCO)': 'Peroba 3',
  'Guará 1': 'Guará I',
  'Guará 2': 'Guará II',
  'Bandeirante': 'Bandeirante 1',
};

export type CompReal = Map<string, Record<string, number>>; // normU(usina) → { 'yyyy-mm': MWh limpo }

/** Lê comp_portfolio (encriptado) e devolve o compensado LIMPO por usina/mês (MWh). */
export function loadCompReal(): CompReal {
  const out: CompReal = new Map();
  let dados: UsinaComp[];
  try { dados = JSON.parse(secureText('comp_portfolio.json')); } catch { return out; }
  for (const u of dados) {
    const porMes: Record<string, number> = {};
    for (const [mes, m] of Object.entries(u.meses)) {
      let kwh = 0;
      for (const uc of m.ucs ?? []) if (!ehGeradora(uc) && !ehGlitch(uc)) kwh += uc.compensado;
      porMes[mes] = kwh / 1000;
    }
    out.set(normU(u.usina), porMes);
  }
  return out;
}

/** Devolve o mapa mes→MWh medido de uma usina do Forecast (aplica alias). */
export function medidoDaUsina(compReal: CompReal, projeto: string): Record<string, number> | undefined {
  const chave = ALIAS_USINA[projeto] ?? projeto;
  return compReal.get(normU(chave));
}

/** Último mês fechado da MeterHub (inclusive) — 'yyyy-mm'. */
export const fechadoAte = DATA_INFO.MeterHub.fechadoAte;
