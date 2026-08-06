/**
 * Cadeia de energia (aba Forecast, colunas W→AA):
 *   Energia Final = P50 × Performance Operacional × Performance Compensação
 *
 * - Performance Operacional = 1 − Σ(9 perdas)  [editável; futuro: aba Performance O&M]
 * - Performance Compensação = input manual da MeterHub (solarhub.MeterHub.io)
 */

export interface Perdas {
  inversores: number;
  modulos: number;
  estrutura: number;
  transformadores: number;
  cabine: number;
  rede: number;
  manutencao: number;
  sujidade: number;
  clima: number;
}

export const PERDAS_LABELS: { key: keyof Perdas; label: string }[] = [
  { key: 'inversores', label: 'Inversores' },
  { key: 'modulos', label: 'Módulos' },
  { key: 'estrutura', label: 'Estrutura' },
  { key: 'transformadores', label: 'Transformadores' },
  { key: 'cabine', label: 'Cabine' },
  { key: 'rede', label: 'Rede' },
  { key: 'manutencao', label: 'Manut. Preventiva' },
  { key: 'sujidade', label: 'Sujidade' },
  { key: 'clima', label: 'Clima' },
];

export const somaPerdas = (p: Perdas): number =>
  PERDAS_LABELS.reduce((s, { key }) => s + (p[key] || 0), 0);

/** Performance Operacional = 1 − Σperdas. */
export const perfOperacionalDePerdas = (p: Perdas): number => 1 - somaPerdas(p);

export interface CadeiaEnergia {
  p50: number;
  perfOperacional: number;
  perfCompensacao: number;
  perdasPerformance: number; // P50 × (1 − perfOper)
  energiaLiquida: number; // P50 × perfOper
  perdasCompensacao: number; // energiaLiquida × (1 − perfComp)
  energiaFinal: number; // P50 × perfOper × perfComp
}

export function calcEnergia(p50: number, perfOper: number, perfComp: number): CadeiaEnergia {
  const perdasPerformance = p50 * (1 - perfOper);
  const energiaLiquida = p50 - perdasPerformance;
  const perdasCompensacao = energiaLiquida * (1 - perfComp);
  const energiaFinal = energiaLiquida - perdasCompensacao;
  return { p50, perfOperacional: perfOper, perfCompensacao: perfComp, perdasPerformance, energiaLiquida, perdasCompensacao, energiaFinal };
}
