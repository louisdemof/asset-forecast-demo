/**
 * Regras por cliente (offtaker) — FONTE ÚNICA DA VERDADE.
 *
 * Substitui os IFs aninhados que a planilha "Forecast 6+6.xlsx" repete em 3
 * colunas (Contratos!Q base de cálculo, Forecast!AC O&M, Forecast!AE Guarda-Chuva).
 * Cada cliente é UMA linha; adicionar/alterar um cliente é uma linha só.
 *
 * A receita segue sempre a MESMA fórmula:
 *     Receita = BaseDeCálculo(R$/MWh) × EnergiaFinal − Demanda
 * e é repartida em 4 parcelas fiscais (Equipamentos, O&M, Imóvel, Guarda-Chuva).
 * O que muda por cliente é só (1) o gross-up fiscal da base e (2) qual parcela
 * absorve o resíduo (as demais são fixas).
 */
import type { ClienteTipo } from './contrato';

/** Como a Base de Cálculo (R$/MWh) é derivada das tarifas — o gross-up fiscal (Contratos!Q). */
export type GrossUp =
  | 'nenhum' //   (1−desc)·(TUSD+TE)                       — sem gross-up
  | 'pis' //      (1−desc)·(TUSD+TE)/(1−PIS)               — gross-up de PIS/COFINS
  | 'pis_icms' // (1−desc)·(TUSD+TE)/(1−PIS)/(1−ICMS)      — gross-up de PIS e ICMS
  | 'split' //    TE e TUSD grossed-up separadamente       — fórmula própria
  | 'plano' //    taxa fixa R$/MWh, independe da tarifa    — preço negociado
  | 'pis_icms_semdesc' // (TUSD+TE)/(1−PIS)/(1−ICMS) SEM desconto — HIDRUS
  | 'fixo'; //    valor colado no Excel (sem fórmula) → usa contrato.baseFixa — BANCOR

/** Qual das 4 parcelas absorve o resíduo (as outras 3 são fixas). */
export type LinhaResidual = 'om' | 'guardaChuva';

/** Modelo comercial — define a FONTE da compensação (perfComp).
 *  AR (Autoconsumo Remoto): cliente com muitas UCs próprias; compensação medida
 *      pelas Faturas da MeterHub (validável). Só 4 clientes: TELMO, LOGIX, HIDRUS, TELCO.
 *  GC (Geração Compartilhada): compensação vem por contrato/cliente (ex. NEXUS
 *      informa), NÃO está nas Faturas. Checar caso a caso por cliente. */
export type ModeloComercial = 'AR' | 'GC';

export interface RegraCliente {
  grossUp: GrossUp;
  residual: LinhaResidual;
  modelo: ModeloComercial;
  /** Só para grossUp==='plano' (ex. PETRAX): preço fixo em R$/MWh. */
  taxaPlano?: number;
  /** Só para grossUp==='split' (BANCOR, HIDRUS): fórmula explícita. */
  split?: (tusd: number, te: number, pis: number, icms: number, desc: number) => number;
  /** Fee de operação de GC que a SolarCo PAGA ao operador, R$/MWh compensado.
   *  Custo (não desconto). Só OPERON opera nesse modelo (Buriti). */
  feeOperacaoMWh?: number;
  /** Rótulo legível da fórmula da base (UI + doc). */
  descricaoBase: string;
  nota?: string;
}

/** Precificação: 'desconto' (% sobre TE+TUSD) ou 'ppa' (preço fixo R$/MWh, independe da tarifa). */
export type Precificacao = 'desconto' | 'ppa';
export function precificacaoDe(regra: RegraCliente): Precificacao {
  return regra.grossUp === 'plano' || regra.grossUp === 'fixo' ? 'ppa' : 'desconto';
}

// PETRAX: preço fixo negociado — R$ 420.000,00 na energia de referência 720 MWh.
const TAXA_ULTRA = 420000 / 720; // ≈ R$ 582,70/MWh

export const REGRAS_CLIENTE: Record<ClienteTipo, RegraCliente> = {
  NEXUS: { grossUp: 'nenhum', residual: 'om', modelo: 'GC', descricaoBase: '(1−desc)·(TUSD+TE)' },
  SOLARA: { grossUp: 'nenhum', residual: 'om', modelo: 'GC', descricaoBase: '(1−desc)·(TUSD+TE)' },
  VERTA: { grossUp: 'nenhum', residual: 'om', modelo: 'GC', descricaoBase: '(1−desc)·(TUSD+TE)' },
  TELCO: { grossUp: 'pis', residual: 'om', modelo: 'AR', descricaoBase: '(1−desc)·(TUSD+TE)/(1−PIS)' },
  LOGIX: { grossUp: 'pis_icms', residual: 'om', modelo: 'AR', descricaoBase: '(1−desc)·(TUSD+TE)/(1−PIS)/(1−ICMS)' },
  BANCOR: {
    grossUp: 'fixo',
    residual: 'om',
    modelo: 'GC',
    nota: 'Calculation Base is a value PASTED into Excel (no formula) → uses the stored per-plant value. ⚠ confirm source with Asset.',
    descricaoBase: 'fixed contract value (pasted into Excel)',
  },
  HIDRUS: {
    grossUp: 'pis_icms_semdesc',
    residual: 'guardaChuva',
    modelo: 'AR',
    nota: 'O&M fixed; Umbrella is residual. Base WITHOUT discount in Excel. ⚠ confirm with Asset (7% discount not applied to the base).',
    descricaoBase: '(TUSD+TE)/(1−PIS)/(1−ICMS)  — no discount',
  },
  TELMO: {
    grossUp: 'pis',
    residual: 'guardaChuva',
    modelo: 'AR',
    nota: 'O&M is a fixed line; Umbrella absorbs the residual. TELMO ≈84% of metered UCs.',
    descricaoBase: '(1−desc)·(TUSD+TE)/(1−PIS)',
  },
  PETRAX: {
    grossUp: 'plano',
    residual: 'om',
    modelo: 'GC',
    taxaPlano: TAXA_ULTRA,
    nota: 'Negotiated fixed price: R$ 420.000,00 @ 720 MWh reference. Independent of the ANEEL tariff.',
    descricaoBase: `R$ ${TAXA_ULTRA.toFixed(2).replace('.', ',')}/MWh (fixed)`,
  },
  OPERON: {
    grossUp: 'nenhum',
    residual: 'om',
    modelo: 'GC',
    feeOperacaoMWh: 85, // SolarCo PAGA R$ 85/MWh compensado à OPERON pela operação da GC (Buriti)
    nota: 'Shared generation operated by OPERON (Buriti): billed under COMPENSATION (not take-or-pay). Client keeps the normal discount AND SolarCo pays a R$ 85/MWh fee to OPERON (cost ≈ R$ 302k/year). Only operator in this model.',
    descricaoBase: '(1−desc)·(TUSD+TE)',
  },
  // PADRÃO cobre ALPHAEN, NOVASOL, MINCO, DISTRA, ENERVA, AGROVA — todos GC,
  // SEM gross-up (validado contra a col Q do Excel: batem sem o /(1−PIS)).
  PADRAO: { grossUp: 'nenhum', residual: 'om', modelo: 'GC', descricaoBase: '(1−desc)·(TUSD+TE)' },
};

/** Rótulo da fórmula da base por tipo de gross-up (usado ao editar a regra). */
export const DESCR_POR_GROSSUP: Record<GrossUp, string> = {
  nenhum: '(1−desc)·(TUSD+TE)',
  pis: '(1−desc)·(TUSD+TE)/(1−PIS)',
  pis_icms: '(1−desc)·(TUSD+TE)/(1−PIS)/(1−ICMS)',
  pis_icms_semdesc: '(TUSD+TE)/(1−PIS)/(1−ICMS)  — no discount',
  plano: 'R$ fixed/MWh (negotiated price)',
  fixo: 'fixed contract value (pasted into Excel)',
  split: 'custom formula',
};

/** Edita a regra de um cliente EM MEMÓRIA (Asset/Comercial, sem mexer no código).
 *  Muta o objeto que o motor inteiro lê; a store recomputa em seguida. */
export function editaRegra(tipo: ClienteTipo, patch: Partial<RegraCliente>): void {
  const r = REGRAS_CLIENTE[tipo];
  Object.assign(r, patch);
  // se mudou o gross-up e não veio descrição explícita, deriva o rótulo padrão
  if (patch.grossUp && patch.descricaoBase === undefined) r.descricaoBase = DESCR_POR_GROSSUP[patch.grossUp];
}

/** Todos os tipos declarados (inclui PADRAO). */
export const TIPOS_CLIENTE = Object.keys(REGRAS_CLIENTE) as ClienteTipo[];

/** Mapeia o nome do cliente (string livre) → tipo declarado. Desconhecido ⇒ PADRAO. */
export function tipoDeCliente(cliente: string): ClienteTipo {
  const c = (cliente || '').trim().toUpperCase();
  return TIPOS_CLIENTE.find((t) => t !== 'PADRAO' && t === c) ?? 'PADRAO';
}

export function regraDeCliente(cliente: string): RegraCliente {
  return REGRAS_CLIENTE[tipoDeCliente(cliente)];
}

/** Base de Cálculo (R$/MWh) a partir da regra do cliente. null se indefinível. */
export function baseDeCalculo(
  regra: RegraCliente,
  tusd: number,
  te: number,
  pis: number,
  icms: number,
  desc: number,
): number | null {
  const soma = tusd + te;
  switch (regra.grossUp) {
    case 'nenhum':
      return (1 - desc) * soma;
    case 'pis':
      return (1 - desc) * (soma / (1 - pis));
    case 'pis_icms':
      return (1 - desc) * (soma / (1 - pis) / (1 - icms));
    case 'split':
      return regra.split ? regra.split(tusd, te, pis, icms, desc) : null;
    case 'plano':
      return regra.taxaPlano ?? null;
    case 'pis_icms_semdesc':
      return soma / (1 - pis) / (1 - icms); // HIDRUS — sem desconto
    case 'fixo':
      return null; // BANCOR — o valor vem de contrato.baseFixa (colado no Excel)
  }
}
