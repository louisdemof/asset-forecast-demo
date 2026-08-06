/**
 * Referência de tarifas por distribuidora (base do reajuste tarifário anual ANEEL).
 * O reajuste da ANEEL é anual, num mês-aniversário fixo por distribuidora.
 */

import type { TarifaDisco } from './receita';

export interface TarifaRef extends TarifaDisco {
  vigenciaAno: number; // ano da última tarifa vigente
  reajusteMes: number; // mês-aniversário do reajuste (1–12)
}

const MESES_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** Próximo reajuste = próximo aniversário do mês de reajuste a partir de `hoje`. */
export function proximoReajuste(reajusteMes: number, hoje: Date): { data: Date; label: string } | null {
  if (!reajusteMes || reajusteMes < 1 || reajusteMes > 12) return null;
  const ano = hoje.getFullYear();
  // 1º dia do mês de reajuste neste ano; se já passou, vai pro próximo ano.
  let data = new Date(ano, reajusteMes - 1, 1);
  if (data.getTime() <= hoje.getTime()) data = new Date(ano + 1, reajusteMes - 1, 1);
  return { data, label: `${MESES_PT[reajusteMes - 1]}/${data.getFullYear()}` };
}

export const mesLabel = (m: number): string => (m >= 1 && m <= 12 ? MESES_PT[m - 1] : '—');
