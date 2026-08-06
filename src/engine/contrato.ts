/**
 * Objeto Contrato — configura as especificidades de cada cliente e reparte
 * a receita nas 4 linhas (Equipamentos / O&M / Imóvel / Guarda-Chuva),
 * reproduzindo a lógica das colunas AB→AF da aba Forecast.
 *
 * A sacada do modelo: cada linha de custo tem um MODO
 *   - 'fixo'     → valor definido em contrato (R$/mês)
 *   - 'residual' → absorve o que sobra da receita (a margem)
 *   - 'zero'     → não usada neste contrato
 * Exatamente UMA linha deve ser 'residual'. Isso substitui, de forma limpa
 * e consistente, o emaranhado de IFs por cliente do Excel.
 */

import { baseCalculo, demandaUFV, type TarifaDisco } from './receita';
import { REGRAS_CLIENTE } from './clientes';
import type { DealComercial } from './comercial';
import { calcEnergia, type Perdas } from './energia';
import { perfCompDaRampa, mesDaRampa } from './comercial';

export type ClienteTipo =
  | 'TELMO' | 'TELCO' | 'NEXUS' | 'LOGIX' | 'SOLARA' | 'VERTA'
  | 'BANCOR' | 'HIDRUS' | 'PETRAX' | 'OPERON' | 'PADRAO';

export type ModoCusto = 'fixo' | 'residual' | 'zero';

export interface LinhaCusto {
  modo: ModoCusto;
  valorFixo: number; // R$/mês, usado quando modo === 'fixo'
}

export interface Contrato {
  usina: string;
  disco: string;
  cliente: string;
  clienteTipo: ClienteTipo; // define a fórmula de Base de Cálculo
  potMWac: number;
  potMWp?: number; // Capacity (MWp)
  desconto: number; // fração (0.081 = 8,1%)

  /** Base de Cálculo COLADA no Excel (sem fórmula) — usada quando a regra do
   *  cliente é grossUp 'fixo' (BANCOR). Se ausente, calcula pela fórmula. */
  baseFixa?: number;

  /** Valores ARMAZENADOS no Excel (col Q base R$/MWh, col M demanda ano) — só
   *  para o diagnóstico "por que diverge do Forecast", não entram no cálculo. */
  baseExcelMwh?: number;
  demandaExcelAno?: number;

  /** Tarifas por MWh (da aba Tarifas via DISCO; editável no contrato). */
  tarifa?: TarifaDisco;

  // Campos da aba COD
  nivelRisco?: number; // 1–3
  energizacao?: string; // data
  cod?: string; // COD da aba COD (= energização + 60), autoritativo
  faturamento?: string; // data 1º faturamento
  observacoes?: string;

  /** Overrides da cadeia de energia. Se undefined, usa o valor por mês (do Forecast).
   *  Se definido, aplica uniformemente a todos os meses (cenário editado). */
  perfOperOverride?: number; // 1 − Σperdas
  perfCompOverride?: number; // input manual MeterHub
  perdas?: Perdas; // detalhamento das 9 perdas (referência do perfOperacional)

  /** Repartição dos custos. Exatamente uma linha deve ser 'residual'. */
  equipamentos: LinhaCusto;
  om: LinhaCusto;
  imovel: LinhaCusto;
  guardaChuva: LinhaCusto;

  /** Budget anual (travado no início do ano) p/ comparar com o forecast. */
  budgetAno?: number;

  /** true se a usina não está na aba Forecast oficial (não entra no total). */
  semForecast?: boolean;

  /** Condições comerciais (aba Comercial), quando o projeto está no pipeline. */
  comercial?: DealComercial;
  /** Curva de rampa de take-or-pay (mês → fator, 1-based do Início da Compensação).
   *  Específica do contrato — semeada da curva do offtaker, mas editável por usina. */
  rampa?: number[];

  /** Se true, a Perf. Compensação é dirigida pelo deal (legado — rampa como perfComp).
   *  NÃO recomendado: a rampa é take-or-pay sobre INJEÇÃO, não compensação (ver topModo). */
  rampaAuto?: boolean;

  /** Modo take-or-pay da rampa. A rampa incide sobre a INJEÇÃO (não a compensação):
   *   - 'substitui': durante a rampa, energia faturável = rampa% × injeção
   *   - 'max':       energia faturável = max(compensação, rampa% × injeção)
   *   - undefined:   take-or-pay desligado (energia faturável = compensação). */
  topModo?: 'substitui' | 'max';

  /** Injeção MANUAL por mês (yyyy-mm → MWh), da fatura da distribuidora recebida
   *  pelo cliente GC (após a troca de titularidade). Base do take-or-pay quando
   *  presente; na falta, cai em P50 × perfOper. */
  injecaoTop?: Record<string, number>;

  /** Compensação MEDIDA por mês (yyyy-mm → MWh), da fatura/MeterHub. Quando presente,
   *  substitui a energia por compensação daquele mês (energiaComp), em vez da premissa. */
  compMedida?: Record<string, number>;
}

export interface EntradaMes {
  mes: string;
  p50: number; // MWh
  tarifa: TarifaDisco;
  status?: 'COD' | 'CONST'; // gating: só fatura em COD (como o Forecast)
  perfOper?: number; // Perf. Operacional do mês (default do Forecast)
  perfComp?: number; // Perf. Compensação do mês (ramp; default do Forecast)
}

export interface AlocacaoMes {
  mes: string;
  status: 'COD' | 'CONST';
  p50: number;
  perfOper: number;
  perfComp: number;
  injecao: number; // P50 × perfOper (energia líquida injetada) — base do take-or-pay
  fatorRampa: number | null; // fator da rampa no mês (null = sem rampa)
  energiaComp: number; // energia por compensação (P50 × perfOper × perfComp)
  energiaFinal: number; // energia faturável (= energiaComp, ou take-or-pay durante a rampa)
  base: number | null; // R$/MWh
  receitaBruta: number;
  demanda: number;
  equipamentos: number;
  om: number;
  imovel: number;
  guardaChuva: number;
  receitaTotal: number; // = receitaBruta − demanda (= soma das 4 linhas); 0 se CONST
}

/** Preset de repartição por tipo de cliente. A linha residual vem da regra do
 *  cliente (src/engine/clientes.ts — fonte única, espelha Forecast!AC/AE). */
export function presetRepartição(tipo: ClienteTipo): Pick<Contrato, 'equipamentos' | 'om' | 'imovel' | 'guardaChuva'> {
  const fixo = (valorFixo = 0): LinhaCusto => ({ modo: 'fixo', valorFixo });
  const residual: LinhaCusto = { modo: 'residual', valorFixo: 0 };
  const zero: LinhaCusto = { modo: 'zero', valorFixo: 0 };

  // Guarda-Chuva residual (TELMO, HIDRUS) ⇒ O&M é fixo.
  if (REGRAS_CLIENTE[tipo].residual === 'guardaChuva') {
    return { equipamentos: fixo(), om: fixo(), imovel: fixo(), guardaChuva: residual };
  }
  // O&M residual (demais) ⇒ Guarda-Chuva não é usado.
  return { equipamentos: fixo(), om: residual, imovel: fixo(), guardaChuva: zero };
}

/** Calcula a alocação de um mês a partir do objeto Contrato. */
export function alocaMes(contrato: Contrato, entrada: EntradaMes): AlocacaoMes {
  const { p50 } = entrada;
  const tarifa = contrato.tarifa ?? entrada.tarifa;
  const status = entrada.status ?? 'COD';
  const perfOper = contrato.perfOperOverride ?? entrada.perfOper ?? 1;
  // Perf. Compensação: override > rampa automática (do deal) > valor mensal (Billing).
  let perfComp: number;
  if (contrato.perfCompOverride !== undefined) {
    perfComp = contrato.perfCompOverride;
  } else if (contrato.rampaAuto && contrato.rampa && contrato.comercial?.inicioCompensacao) {
    perfComp = perfCompDaRampa(contrato.comercial.inicioCompensacao, contrato.rampa, entrada.mes);
  } else {
    perfComp = entrada.perfComp ?? 1;
  }
  // Injeção: manual (fatura do cliente GC) quando informada; senão, P50 × perfOper.
  const injecao = contrato.injecaoTop?.[entrada.mes] ?? p50 * perfOper;
  // Compensação: medida (fatura/MeterHub) quando informada; senão, premissa via perfComp.
  const compMed = contrato.compMedida?.[entrada.mes];
  const energiaComp = compMed ?? calcEnergia(p50, perfOper, perfComp).energiaFinal;
  if (compMed !== undefined && p50 * perfOper > 0) perfComp = compMed / (p50 * perfOper); // mantém a cadeia consistente

  // Take-or-pay: a rampa incide sobre a INJEÇÃO (não a compensação). Durante a rampa
  // (fator < 1, a partir do Início da Compensação) a energia faturável vem da injeção.
  let fatorRampa: number | null = null;
  let energiaFinal = energiaComp;
  if (contrato.rampa && contrato.rampa.length && contrato.comercial?.inicioCompensacao) {
    const k = mesDaRampa(contrato.comercial.inicioCompensacao, entrada.mes); // 1-based
    fatorRampa = k < 1 ? 0 : k > contrato.rampa.length ? 1 : contrato.rampa[k - 1];
    if (contrato.topModo && k >= 1 && fatorRampa < 1) {
      const topEnergia = fatorRampa * injecao;
      energiaFinal = contrato.topModo === 'max' ? Math.max(energiaComp, topEnergia) : topEnergia;
    }
  }
  const base = contrato.baseFixa ?? baseCalculo(contrato.clienteTipo, tarifa.tusd, tarifa.te, tarifa.pisCofins, tarifa.icms, contrato.desconto);
  const demanda = demandaUFV(tarifa.disco, tarifa.tusdC, tarifa.tusdG, tarifa.pisCofins, tarifa.icms, contrato.potMWac);

  // Só fatura em COD (igual ao Forecast: AF = IF(status="COD", ..., 0)).
  const cod = status === 'COD';
  const receitaBruta = cod && base !== null ? base * energiaFinal : 0;
  const receitaTotal = cod ? receitaBruta - demanda : 0;

  // Reparte: somatório dos fixos; a linha residual pega (receitaTotal − fixos).
  const linhas: LinhaCusto[] = [contrato.equipamentos, contrato.om, contrato.imovel, contrato.guardaChuva];
  const somaFixos = linhas.filter((l) => l.modo === 'fixo').reduce((s, l) => s + l.valorFixo, 0);
  const valorDe = (l: LinhaCusto): number => {
    if (!cod) return 0;
    if (l.modo === 'fixo') return l.valorFixo;
    if (l.modo === 'residual') return receitaTotal - somaFixos;
    return 0;
  };

  return {
    mes: entrada.mes,
    status,
    p50,
    perfOper,
    perfComp,
    injecao,
    fatorRampa,
    energiaComp,
    energiaFinal,
    base,
    receitaBruta,
    demanda,
    equipamentos: valorDe(contrato.equipamentos),
    om: valorDe(contrato.om),
    imovel: valorDe(contrato.imovel),
    guardaChuva: valorDe(contrato.guardaChuva),
    receitaTotal,
  };
}

export interface ResumoContrato {
  equipamentos: number;
  om: number;
  imovel: number;
  guardaChuva: number;
  receitaTotal: number;
  p50: number;
  meses: AlocacaoMes[];
}

/** Roda o contrato sobre uma lista de meses e soma o ano. */
export function rodaContrato(contrato: Contrato, entradas: EntradaMes[]): ResumoContrato {
  const meses = entradas.map((e) => alocaMes(contrato, e));
  const soma = (f: (m: AlocacaoMes) => number) => meses.reduce((s, m) => s + f(m), 0);
  return {
    equipamentos: soma((m) => m.equipamentos),
    om: soma((m) => m.om),
    imovel: soma((m) => m.imovel),
    guardaChuva: soma((m) => m.guardaChuva),
    receitaTotal: soma((m) => m.receitaTotal),
    p50: soma((m) => m.p50),
    meses,
  };
}
