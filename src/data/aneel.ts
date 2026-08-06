/**
 * Link com a base ANEEL (dados abertos), snapshot fresco.
 * Fonte: https://dadosabertos.aneel.gov.br — B3 Convencional "Tarifa de Aplicação".
 * Tarifas em R$/MWh (com tributos por dentro, como no Excel). A vigência (DatFimVigencia)
 * dá a data exata do próximo reajuste tarifário.
 */

import snapshot from './aneel-tariffs.json';

interface ANEELDist {
  sigAgente: string;
  tusd: number; // R$/MWh
  te: number; // R$/MWh
  resolution: string;
  vigInicio: string; // ISO
  vigFim: string; // ISO — data do próximo reajuste
  cnpj?: string;
}

const SNAP = snapshot as { fetchedAt: string; geradoAneel?: string; distribuidoras: ANEELDist[] };
const DISTRIBUIDORAS = SNAP.distribuidoras;
export const ANEEL_GERADO_EM: string = SNAP.geradoAneel ?? SNAP.fetchedAt.slice(0, 10);

/** Mapa DISCO (Excel) → sigla ANEEL (nomes atuais na base). */
const ALIAS: Record<string, string> = {
  AME: 'Âmbar Amazonas',
  CEEE: 'CEEE-D',
  CELPE: 'Neoenergia PE',
  COELBA: 'COELBA',
  COPEL: 'COPEL-DIS',
  COSERN: 'COSERN',
  'CPFL JAGUARI /STA CRUZ': 'CPFL Santa Cruz',
  'CPFL PTA': 'CPFL-PAULISTA',
  'EDP SP': 'EDP SP',
  'ELEKTRO SP': 'ELEKTRO',
  EMS: 'EMS',
  'ENEL CE': 'ENEL CE',
  'EQUATORIAL GO': 'EQUATORIAL GO',
  'ENEL SP': 'ELETROPAULO',
  ESS: 'ESS',
  ETO: 'ETO',
  ERO: 'ERO',
};

const norm = (s: string): string => (s || '').trim().toUpperCase();

export function aneelDoDisco(disco: string): ANEELDist | null {
  const sig = ALIAS[norm(disco)] ?? disco;
  // Pode haver duplicatas de sigla (ex. "CPFL SANTA CRUZ" 2018 vs "CPFL Santa Cruz" 2027,
  // distribuidora renomeada). Fica com a de vigência MAIS RECENTE, não a primeira.
  const matches = DISTRIBUIDORAS.filter((d) => norm(d.sigAgente) === norm(sig));
  if (!matches.length) return null;
  return matches.reduce((a, b) => ((b.vigFim || '') > (a.vigFim || '') ? b : a));
}

const MESES_ABREV = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const fmtData = (iso: string): string => {
  if (!iso || iso.length < 10) return '—';
  const [a, m, d] = iso.split('-');
  return `${d} ${MESES_ABREV[+m - 1]}/${a}`;
};

export interface ReajusteInfo {
  vigente: string; // início da vigência atual
  vigenteISO: string;
  proximo: string; // fim da vigência = próximo reajuste
  proximoISO: string;
  resolucao: string;
}

/** Próximo reajuste = fim da vigência da tarifa atual (dado direto da ANEEL). */
export function reajusteDoDisco(disco: string): ReajusteInfo | null {
  const rec = aneelDoDisco(disco);
  if (!rec) return null;
  return {
    vigente: fmtData(rec.vigInicio), vigenteISO: rec.vigInicio,
    proximo: fmtData(rec.vigFim), proximoISO: rec.vigFim,
    resolucao: rec.resolution,
  };
}

/** Tarifas ANEEL em R$/MWh (para referência/sincronização). */
export function tarifasAneelMWh(disco: string): { tusd: number; te: number } | null {
  const rec = aneelDoDisco(disco);
  if (!rec) return null;
  return { tusd: rec.tusd, te: rec.te };
}
