/** Generator unit → plant, used to route a loose invoice in the Generation tab.
 *  Empty in the demo: the Data centre builds this mapping at runtime from the invented
 *  generator units, and anything unmatched falls back to distributor + file name. */
export const CADASTRO_UC: Record<string, string> = {};

/** Layout do documento → sigla da distribuidora (coluna Concessionária/disco). */
export const DOC_DISCO: Record<string, string> = {
  EMS_FATURA: 'EMS',
  EMS_DEMO: 'EMS',
  EQUATORIAL_GO: 'EQUATORIAL GO',
  ELEKTRO: 'Elektro SP',
  EDP_SP: 'EDP SP',
  COPEL: 'COPEL',
  CPFL: 'CPFL Pta',
  ENEL_CE: 'ENEL CE',
  COSERN: 'COSERN',
  COSERN_FATURA: 'COSERN',
  COSERN_DEMO: 'COSERN',
};
