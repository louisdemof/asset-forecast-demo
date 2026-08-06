import Papa from 'papaparse';
import { secureText } from '../secure';

export interface PVsystRow {
  projeto: string;
  disco: string;
  cliente: string;
  potenciaMWp: number;
  meses: number[]; // 12 valores (jan–dez)
  total: number; // MWh/ano
  producaoEspecifica: number; // MWh/MWp/ano
  difVsAnterior: number; // fração (Dif MWh vs versão anterior)
}

const MES_COLS = [
  '2026-01-01 00:00:00', '2026-02-01 00:00:00', '2026-03-01 00:00:00', '2026-04-01 00:00:00',
  '2026-05-01 00:00:00', '2026-06-01 00:00:00', '2026-07-01 00:00:00', '2026-08-01 00:00:00',
  '2026-09-01 00:00:00', '2026-10-01 00:00:00', '2026-11-01 00:00:00', '2026-12-01 00:00:00',
];

const num = (v: unknown): number => {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

/** Parseia um CSV do PVsyst (mesmo formato do export) em linhas. Aceita cabeçalhos
 *  com datas completas OU abreviações de mês (jan…dez). */
export function parsePVsystCSV(text: string): PVsystRow[] {
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  const fields = parsed.meta.fields ?? [];
  // detecta as 12 colunas de mês: as do formato ISO, ou senão as 12 numéricas após o nome
  const mesFields = MES_COLS.every((c) => fields.includes(c))
    ? MES_COLS
    : fields.filter((f) => /^\d{4}-\d{2}/.test(f) || /^(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)/i.test(f)).slice(0, 12);
  const out: PVsystRow[] = [];
  for (const rec of parsed.data) {
    const projeto = (rec['Nome do Projeto'] || rec['projeto'] || rec['Usina'] || '').trim();
    if (!projeto) continue;
    const meses = mesFields.map((c) => num(rec[c]));
    out.push({
      projeto,
      disco: (rec['Concessionária'] || rec['Distribuidora'] || rec['DISCO'] || '').trim(),
      cliente: (rec['Cliente'] || '').trim(),
      potenciaMWp: num(rec['Potência'] || rec['MWp'] || rec['Pot MWp']),
      meses,
      total: num(rec['Total']) || meses.reduce((s, v) => s + v, 0),
      producaoEspecifica: num(rec['Produção Específica (MWh/MWp/ano)'] || rec['Produção Específica']),
      difVsAnterior: num(rec['Dif MWh']),
    });
  }
  out.sort((a, b) => b.total - a.total);
  return out;
}

export async function loadPVsyst(): Promise<PVsystRow[]> {
  const parsed = Papa.parse<Record<string, string>>(secureText('PVsyst.csv'), { header: true, skipEmptyLines: true });
  const out: PVsystRow[] = [];
  for (const rec of parsed.data) {
    const projeto = (rec['Nome do Projeto'] || '').trim();
    if (!projeto) continue;
    const meses = MES_COLS.map((c) => num(rec[c]));
    out.push({
      projeto,
      disco: (rec['Concessionária'] || '').trim(),
      cliente: (rec['Cliente'] || '').trim(),
      potenciaMWp: num(rec['Potência']),
      meses,
      total: num(rec['Total']) || meses.reduce((s, v) => s + v, 0),
      producaoEspecifica: num(rec['Produção Específica (MWh/MWp/ano)']),
      difVsAnterior: num(rec['Dif MWh']),
    });
  }
  out.sort((a, b) => b.total - a.total);
  return out;
}
