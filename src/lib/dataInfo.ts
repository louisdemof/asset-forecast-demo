/**
 * Procedência e vintage dos dados — fonte única para os carimbos "as of" na UI.
 * ATUALIZAR mensalmente ao repuxar a MeterHub / trocar o Forecast.
 */
import { fmtMes } from './date';

export const DATA_INFO = {
  forecast: {
    fonte: 'Forecast 6+6',
    horizonteIni: '2026-01',
    horizonteFim: '2026-12',
  },
  MeterHub: {
    /** início do histórico puxado da API (12 meses). */
    historicoDesde: '2025-07',
    /** último mês com leitura FECHADA (fatura emitida + escaneada). */
    fechadoAte: '2026-05',
    /** mês ainda em fechamento — dados parciais, não confiar no total. */
    parcial: '2026-06',
    /** data aproximada do snapshot da API. */
    snapshot: '2026-07',
  },
} as const;

/** true se o mês (yyyy-mm) é o mês parcial da MeterHub. */
export const ehParcial = (mes: string): boolean => mes.slice(0, 7) === DATA_INFO.MeterHub.parcial;

/** Carimbo curto do Forecast: "horizonte jan-2026 → dez-2026". */
export const carimboForecast = (): string =>
  `horizonte ${fmtMes(DATA_INFO.forecast.horizonteIni)} → ${fmtMes(DATA_INFO.forecast.horizonteFim)}`;

/** Carimbo curto da MeterHub: "12m desde jul-2025 · fechado até mai-2026 · jun-2026 parcial". */
export const carimboMeterHub = (): string =>
  `12m desde ${fmtMes(DATA_INFO.MeterHub.historicoDesde)} · fechado até ${fmtMes(DATA_INFO.MeterHub.fechadoAte)} · ${fmtMes(DATA_INFO.MeterHub.parcial)} parcial`;
