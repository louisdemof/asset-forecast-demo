/**
 * Módulo de Receita — engine de cálculo.
 * Porte TypeScript da spec validada contra a planilha "Forecast 6+6.xlsx".
 *
 * Fórmula canônica (convenção NOVA, padronizada):
 *     Receita = BaseDeCalculo(cliente) × P50 − DemandaUFV
 *
 * A convenção ANTIGA (breakdown, com gross-up extra de ICMS) é suportada
 * apenas para reconciliação contra o Excel legado — não deve ser usada em
 * novos cálculos.
 */
import { regraDeCliente, baseDeCalculo } from './clientes';

export type Convencao = 'nova' | 'antiga';

export interface TarifaDisco {
  disco: string;
  tusd: number; // TUSD (R$/MWh)
  te: number; // TE (R$/MWh)
  tusdC: number; // TUSD C (R$/MWh)
  tusdG: number; // TUSD G (R$/MWh)
  pisCofins: number; // fração (ex. 0.05)
  icms: number; // fração (ex. 0.19)
}

/**
 * Base de Cálculo (R$/MWh) — preço efetivo da energia GD por MWh.
 * Delega para a regra do cliente (ver src/engine/clientes.ts — fonte única).
 * PETRAX agora resolvido como preço fixo (grossUp 'plano'); só retorna null se
 * uma regra 'split' estiver sem fórmula.
 */
export function baseCalculo(
  cliente: string,
  tusd: number,
  te: number,
  pis: number,
  icms: number,
  desc: number,
): number | null {
  return baseDeCalculo(regraDeCliente(cliente), tusd, te, pis, icms, desc);
}

/**
 * Demanda UFV (R$) — custo de demanda da própria usina, deduzido da receita.
 * Variante COPEL/CEEE/ESS/ETO usa TUSD-C; demais usam TUSD-G.
 */
export function demandaUFV(
  disco: string,
  tusdC: number,
  tusdG: number,
  pis: number,
  icms: number,
  mwac: number,
): number {
  const d = (disco || '').toUpperCase();
  const T = ['COPEL', 'CEEE', 'ESS', 'ETO'].includes(d) ? tusdC : tusdG;
  return ((T / (1 - pis) / (1 - icms)) * 30 + (T / (1 - pis)) * (mwac * 1000 - 30)) * 1.05;
}

export interface ReceitaInput {
  cliente: string;
  desconto: number;
  p50MWh: number;
  potMWac: number;
  tarifa: TarifaDisco;
  convencao?: Convencao; // default 'nova'
}

export interface ReceitaResult {
  base: number | null; // R$/MWh
  demanda: number; // R$
  receita: number | null; // R$
}

export function calcReceita(input: ReceitaInput): ReceitaResult {
  const { cliente, desconto, p50MWh, potMWac, tarifa } = input;
  const { tusd, te, tusdC, tusdG, pisCofins: pis, icms } = tarifa;
  const conv = input.convencao ?? 'nova';
  const demanda = demandaUFV(tarifa.disco, tusdC, tusdG, pis, icms, potMWac);

  if (conv === 'antiga') {
    // convenção legada: gross-up (1-pis-icms)·(1-icms). Só p/ reconciliação.
    const bruto = (1 - desconto) * ((tusd + te) / (1 - pis - icms)) * (1 - icms) * p50MWh;
    return { base: null, demanda, receita: bruto - demanda };
  }

  const base = baseCalculo(cliente, tusd, te, pis, icms, desconto);
  const receita = base === null ? null : base * p50MWh - demanda;
  return { base, demanda, receita };
}
