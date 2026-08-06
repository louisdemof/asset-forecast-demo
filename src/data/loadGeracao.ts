/** Parser do upload manual de geração/injeção da unidade geradora.
 *
 *  Para os GD com take-or-pay, a fatura da geradora NÃO está na MeterHub — a
 *  injeção entra por Excel/CSV (ou OCR futuro). Colunas aceitas (cabeçalho
 *  flexível, delimitador ; ou ,):
 *    usina · mes · injecao [· inversor]
 *  - injecao  = MWh da fatura da distribuidora (base do take-or-pay)
 *  - inversor = MWh medido pelos inversores (O&M) — opcional
 */
import type { MedicaoRow } from '../store/forecastStore';

const norm = (s: string) =>
  (s || '').normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();

/** aceita "1.234,5" (pt-BR) e "1234.5" (en). */
function num(s: string): number | undefined {
  const t = (s || '').trim();
  if (!t) return undefined;
  const v = t.includes(',') ? Number(t.replace(/\./g, '').replace(',', '.')) : Number(t);
  return Number.isFinite(v) ? v : undefined;
}

const ACHA = (cols: string[], nomes: string[]) => cols.findIndex((c) => nomes.some((n) => c === n || c.includes(n)));

export function parseGeracaoCSV(text: string): MedicaoRow[] {
  const linhas = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!linhas.length) return [];
  const delim = (linhas[0].match(/;/g)?.length ?? 0) >= (linhas[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  const head = linhas[0].split(delim).map(norm);
  const iU = ACHA(head, ['usina', 'projeto', 'planta']);
  const iM = ACHA(head, ['mes', 'competencia', 'referencia', 'data']);
  const iI = ACHA(head, ['injecao', 'injetad', 'fatura', 'reversa']);
  const iV = ACHA(head, ['inversor', 'geracao', 'o&m', 'oem', 'datalogger']);
  if (iU < 0 || iM < 0) return []; // sem usina/mes não dá pra casar

  const out: MedicaoRow[] = [];
  for (let r = 1; r < linhas.length; r++) {
    const c = linhas[r].split(delim);
    const usina = (c[iU] ?? '').trim();
    const mes = (c[iM] ?? '').trim();
    if (!usina || !mes) continue;
    const injecao = iI >= 0 ? num(c[iI]) : undefined;
    const inversor = iV >= 0 ? num(c[iV]) : undefined;
    if (injecao === undefined && inversor === undefined) continue;
    out.push({ usina, mes, injecao, inversor });
  }
  return out;
}
