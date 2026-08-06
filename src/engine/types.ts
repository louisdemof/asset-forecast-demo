/** Modelo de dados do Módulo de Receita (derivado das 9 abas visíveis). */

export interface ContratoRow {
  disco: string; // Concessionária
  projeto: string; // Nome do Projeto
  cliente: string;
  mes: string; // ISO date (yyyy-mm)
  potMWac: number;
  tusd: number;
  te: number;
  tusdC: number;
  tusdG: number;
  pisCofins: number;
  icms: number;
  p50MWh: number;
  demandaExcel: number;
  desconto: number;
  baseExcel: number;
  receitaExcel: number; // "Receita Total" da planilha (para reconciliação)
  convencaoExcel: 'nova' | 'antiga'; // qual convenção o Excel usou nesta linha
  // valores fixos de custo (base) — insumos da repartição
  equipBase: number; // Loc. Equipamentos (R$) base
  omBase: number; // O&M (R$) base
  imovelBase: number; // Loc. Terras (R$) base
}

export interface UsinaResumo {
  projeto: string;
  disco: string;
  cliente: string;
  potMWac: number;
  meses: number;
  p50Total: number; // MWh/ano
  energiaFinalTotal: number; // MWh/ano (após haircuts)
  receitaEngine: number; // R$/ano pela engine (nível Forecast, Energia Final)
  receitaForecast: number; // R$/ano oficial (AF)
  budget: number; // R$/ano orçado
  noPipeline: boolean; // tem deal comercial
  semForecast: boolean; // fora da aba Forecast oficial
  perfCompMedia: number; // compensação média anual (0–1): energiaFinal / energiaLíquida
  modelo: 'AR' | 'GC'; // Autoconsumo Remoto (compensação medível na MeterHub) vs Geração Compartilhada (premissa)
  custoOperacao: number; // R$/ano — fee de operação de GC pago pela SolarCo (só OPERON hoje). 0 na maioria.
  margem: number; // R$/ano — receitaEngine − custoOperacao
}
