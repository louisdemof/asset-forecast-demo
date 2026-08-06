/**
 * Dados comerciais da aba Comercial:
 *  - pipeline (linhas 2–34): condições de cada deal por projeto
 *  - rampa (linhas 37–62): curva de rampa de compensação por offtaker (mês → fator)
 */

import Papa from 'papaparse';
import { secureText } from '../secure';

export interface DealComercial {
  projeto: string;
  status: string; // Quente / Frio
  disco: string;
  offtakerOriginal: string;
  pipelineStatus: string;
  novoOfftaker: string; // New offtaker expected → chave da rampa
  prazoContrato: string; // Contract term
  takeOrPay: number;
  rampUp: string; // ex. "3 months"
  desconto: number; // Discount
  baseCalculo: string; // ex. "TE+TUSD"
  signingDate: string;
  codDate: string;
  trocaTitularidade: string;
  inicioCompensacao: string;
  riscos: string;
}

/** offtaker → curva de rampa (index 0 = mês 1). Fora da curva ⇒ 1.0 (rampado). */
export type RampaTabela = Record<string, number[]>;

export interface DadosComercial {
  deals: Map<string, DealComercial>; // por nome de projeto
  rampas: RampaTabela;
}

const num = (v: unknown): number => {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

export async function loadComercial(): Promise<DadosComercial> {
  const pipeText = secureText('Comercial_pipeline.csv');
  const rampText = secureText('Comercial_rampa.csv');

  const pipe = Papa.parse<Record<string, string>>(pipeText, { header: true, skipEmptyLines: true });
  const deals = new Map<string, DealComercial>();
  for (const rec of pipe.data) {
    const projeto = str(rec['Project']);
    if (!projeto) continue;
    deals.set(projeto, {
      projeto,
      status: str(rec['Status']),
      disco: str(rec['DISCO']),
      offtakerOriginal: str(rec['Original offtaker']),
      pipelineStatus: str(rec['Pipeline status']),
      novoOfftaker: str(rec['New offtaker expected']),
      prazoContrato: str(rec['Contract term']),
      takeOrPay: num(rec['Take or Pay']),
      rampUp: str(rec['Ramp up']),
      desconto: num(rec['Discount']),
      baseCalculo: str(rec['Base de cálculo']),
      signingDate: str(rec['Signing date']),
      codDate: str(rec['COD (Conexão com a Distribuidora)']),
      trocaTitularidade: str(rec['Troca de titularidade']),
      inicioCompensacao: str(rec['Início da Compensação']),
      riscos: str(rec['Riscos']),
    });
  }

  const ramp = Papa.parse<Record<string, string>>(rampText, { header: true, skipEmptyLines: true });
  const rampas: RampaTabela = {};
  const offtakers = ramp.meta.fields?.filter((f) => f !== 'Mês/rampa') ?? [];
  for (const off of offtakers) rampas[off] = [];
  for (const rec of ramp.data) {
    for (const off of offtakers) {
      const v = rec[off];
      if (v !== '' && v !== undefined) rampas[off].push(num(v));
    }
  }
  return { deals, rampas };
}

/** Resultado da derivação do fim de contrato a partir do deal comercial. */
export interface FimContrato {
  fim: string | null;        // data ISO (yyyy-mm-dd) ou null se indeterminável
  tipo: 'explícito' | 'estimada' | 'indeterminado';
  detalhe: string;           // ex. "estimada (+15a de início compensação)"
  termOriginal: string;      // texto cru da coluna "Contract term"
}

/**
 * Deriva a data de fim de contrato a partir do "Contract term" da aba Comercial.
 *  - "Until AAAA"   → 31/12/AAAA (explícito)
 *  - "N years" / "N" → data-base + N anos, onde data-base = Início da Compensação
 *    (ou, na falta, a data de assinatura). Estimada.
 *  - "NEXUS" como data-base, texto inválido ou vazio → indeterminado.
 * A base de cálculo real (assinatura vs. início) precisa de confirmação do time.
 */
export function fimContrato(deal: Pick<DealComercial, 'prazoContrato' | 'signingDate' | 'inicioCompensacao'>): FimContrato {
  const t = str(deal.prazoContrato);
  const termOriginal = t;
  if (!t) return { fim: null, tipo: 'indeterminado', detalhe: 'sem prazo', termOriginal };

  const mUntil = t.match(/until\s+(\d{4})/i);
  if (mUntil) return { fim: `${mUntil[1]}-12-31`, tipo: 'explícito', detalhe: `explícito (${t})`, termOriginal };

  const mYears = t.match(/^(\d+)\s*(years?)?\s*\*?$/i);
  if (mYears) {
    const n = Number(mYears[1]);
    if (n >= 1 && n <= 50) {
      const iniOk = /^\d{4}-\d{2}-\d{2}/.test(str(deal.inicioCompensacao));
      const signOk = /^\d{4}-\d{2}-\d{2}/.test(str(deal.signingDate));
      const baseISO = iniOk ? deal.inicioCompensacao : signOk ? deal.signingDate : null;
      if (baseISO) {
        const d = new Date(baseISO.slice(0, 10) + 'T00:00:00Z');
        d.setUTCFullYear(d.getUTCFullYear() + n);
        const marco = iniOk ? 'início compensação' : 'assinatura';
        return { fim: d.toISOString().slice(0, 10), tipo: 'estimada', detalhe: `estimada (+${n}a de ${marco})`, termOriginal };
      }
      return { fim: null, tipo: 'indeterminado', detalhe: `prazo ${n}a — sem data-base (NEXUS)`, termOriginal };
    }
  }
  return { fim: null, tipo: 'indeterminado', detalhe: `prazo inválido (${t})`, termOriginal };
}

/** Fator de rampa para um offtaker no mês (1-based). Fora da curva ⇒ 1.0. */
export function fatorRampa(rampas: RampaTabela, offtaker: string, mes1based: number): number {
  const curva = rampas[offtaker];
  if (!curva || curva.length === 0) return 1;
  const i = mes1based - 1;
  if (i < 0) return 0;
  if (i >= curva.length) return 1; // já rampado
  return curva[i];
}

/** Nº de meses (1-based) de um mês ISO em relação ao início da compensação.
 *  O mês de início = 1; meses anteriores retornam < 1. */
export function mesDaRampa(inicioISO: string, mesISO: string): number {
  const [iy, im] = inicioISO.slice(0, 7).split('-').map(Number);
  const [my, mm] = mesISO.slice(0, 7).split('-').map(Number);
  if (!iy || !my) return NaN;
  return (my - iy) * 12 + (mm - im) + 1;
}

/** Perf. Compensação derivada do deal: 0 antes do início; sobe pela curva; 1.0 quando rampado. */
export function perfCompDaRampa(inicioISO: string, rampa: number[], mesISO: string): number {
  const k = mesDaRampa(inicioISO, mesISO);
  if (!Number.isFinite(k) || k < 1) return 0;
  if (k > rampa.length) return 1;
  return rampa[k - 1];
}
