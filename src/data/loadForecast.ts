import Papa from 'papaparse';
import type { ContratoRow } from '../engine/types';
import { calcReceita, type TarifaDisco } from '../engine/receita';
import {
  presetRepartição,
  type Contrato,
  type EntradaMes,
} from '../engine/contrato';
import { tipoDeCliente, REGRAS_CLIENTE } from '../engine/clientes';
import type { DadosComercial } from '../engine/comercial';
import type { Perdas } from '../engine/energia';
import { secureText } from '../secure';
export { loadComercial } from '../engine/comercial';

export interface DadosCOD {
  potMWp: number;
  nivelRisco: number;
  energizacao: string;
  cod: string;
  faturamento: string;
  observacoes: string;
}

/** Carrega a aba COD (datas, risco, MWp) por usina. */
export async function loadCOD(): Promise<Map<string, DadosCOD>> {
  const parsed = Papa.parse<Record<string, string>>(secureText('COD.csv'), { header: true, skipEmptyLines: true });
  const map = new Map<string, DadosCOD>();
  for (const rec of parsed.data) {
    const projeto = (rec['Nome do Projeto'] || '').trim();
    if (!projeto) continue;
    map.set(projeto, {
      potMWp: num(rec['Pot (MWp)']),
      nivelRisco: num(rec['Nível de Risco']),
      energizacao: (rec['Energização'] || '').slice(0, 10),
      cod: (rec['COD'] || '').slice(0, 10),
      faturamento: (rec['Faturamento'] || '').slice(0, 10),
      observacoes: (rec['Observações'] || '').trim(),
    });
  }
  return map;
}

export interface PerfMes {
  perfOper: number;
  perfComp: number;
  status: 'COD' | 'CONST';
}

export interface EnergiaUsina {
  perdas: Perdas;
  budgetAno: number;
  receitaForecastAno: number; // AF oficial somado
  energiaFinalAno: number; // AA oficial somado
  porMes: Map<string, PerfMes>; // perf. operacional e compensação por mês
}

/** Carrega a cadeia de energia + budget oficial da aba Forecast (por mês). */
export async function loadForecastEnergia(): Promise<Map<string, EnergiaUsina>> {
  const parsed = Papa.parse<Record<string, string>>(secureText('Forecast_energia.csv'), { header: true, skipEmptyLines: true });
  const map = new Map<string, EnergiaUsina>();
  for (const rec of parsed.data) {
    const projeto = (rec['projeto'] || '').trim();
    if (!projeto) continue;
    let e = map.get(projeto);
    if (!e) {
      e = {
        perdas: {
          inversores: num(rec['inversores']), modulos: num(rec['modulos']), estrutura: num(rec['estrutura']),
          transformadores: num(rec['transformadores']), cabine: num(rec['cabine']), rede: num(rec['rede']),
          manutencao: num(rec['manutencao']), sujidade: num(rec['sujidade']), clima: num(rec['clima']),
        },
        budgetAno: 0, receitaForecastAno: 0, energiaFinalAno: 0, porMes: new Map(),
      };
      map.set(projeto, e);
    }
    e.budgetAno += num(rec['budget']);
    e.receitaForecastAno += num(rec['receitaForecast']);
    e.energiaFinalAno += num(rec['energiaFinal']);
    const status = (rec['status'] || '').trim() === 'COD' ? 'COD' : 'CONST';
    // IMPORTANTE: perfComp/perfOper podem ser 0 (compensação ainda não começou) —
    // não usar "|| 1", que converteria 0 em 1 e inventaria energia. Só cai em 1 se vazio.
    const perfN = (v: string): number => (v === '' || v === undefined ? 1 : num(v));
    if (rec['mes']) e.porMes.set(rec['mes'].trim(), { perfOper: perfN(rec['perfOper']), perfComp: perfN(rec['perfComp']), status });
  }
  return map;
}


/** Normaliza nomes p/ casar pipeline × usina (tira acentos, espaços, pontos). */
const normNome = (s: string): string =>
  (s || '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/** Acha os dados de energia da usina (exato → normalizado). */
function achaEnergia(energia: Map<string, EnergiaUsina> | undefined, projeto: string): EnergiaUsina | undefined {
  if (!energia) return undefined;
  const exato = energia.get(projeto);
  if (exato) return exato;
  const n = normNome(projeto);
  for (const [nome, e] of energia) if (normNome(nome) === n) return e;
  return undefined;
}

/** Acha a curva de rampa do offtaker; desambigua colunas repetidas (ex. ENERVA
 *  (Jatobá 7.2) vs (Jatobá 7.4)) pelo nome da usina no rótulo. */
function achaRampa(rampas: Record<string, number[]>, offtaker: string, usina: string): number[] | undefined {
  const exato = rampas[offtaker];
  if (exato?.length) return exato;
  const o = normNome(offtaker);
  const cand = Object.keys(rampas).filter((k) => {
    const base = normNome(k.split('(')[0]);
    return base === o || base.startsWith(o) || o.startsWith(base);
  });
  if (cand.length === 0) return undefined;
  if (cand.length === 1) return rampas[cand[0]];
  const u = normNome(usina);
  const desambig = cand.find((k) => {
    const paren = k.match(/\(([^)]+)\)/)?.[1];
    return paren ? normNome(paren) === u || u.includes(normNome(paren)) || normNome(paren).includes(u) : false;
  });
  return rampas[desambig ?? cand[0]];
}

const tarifaDe = (r: ContratoRow): TarifaDisco => ({
  disco: r.disco, tusd: r.tusd, te: r.te, tusdC: r.tusdC, tusdG: r.tusdG,
  pisCofins: r.pisCofins, icms: r.icms,
});

const num = (v: unknown): number => {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

const isoMes = (v: string): string => (v ? String(v).slice(0, 7) : '');

/** Classifica a convenção da linha testando qual fórmula reproduz a Receita Total do Excel. */
function detectaConvencao(r: ContratoRow): 'nova' | 'antiga' {
  const tarifa: TarifaDisco = {
    disco: r.disco,
    tusd: r.tusd,
    te: r.te,
    tusdC: r.tusdC,
    tusdG: r.tusdG,
    pisCofins: r.pisCofins,
    icms: r.icms,
  };
  const nova = calcReceita({ cliente: r.cliente, desconto: r.desconto, p50MWh: r.p50MWh, potMWac: r.potMWac, tarifa, convencao: 'nova' }).receita ?? Infinity;
  const antiga = calcReceita({ cliente: r.cliente, desconto: r.desconto, p50MWh: r.p50MWh, potMWac: r.potMWac, tarifa, convencao: 'antiga' }).receita ?? Infinity;
  const dNova = Math.abs(nova - r.receitaExcel);
  const dAntiga = Math.abs(antiga - r.receitaExcel);
  return dAntiga < dNova ? 'antiga' : 'nova';
}

export async function loadContratos(): Promise<ContratoRow[]> {
  const text = secureText('Contratos.csv');
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });

  const rows: ContratoRow[] = [];
  for (const rec of parsed.data) {
    const projeto = (rec['Nome do Projeto'] || '').trim();
    if (!projeto) continue;
    const row: ContratoRow = {
      disco: (rec['Concessionária'] || '').trim(),
      projeto,
      cliente: (rec['Cliente'] || '').trim(),
      mes: isoMes(rec['Mês']),
      potMWac: num(rec['Pot. (MWac)']),
      tusd: num(rec['TUSD (R$/MWh)']),
      te: num(rec['TE (R$/MWh)']),
      tusdC: num(rec['TUSD C (R$/MWh)']),
      tusdG: num(rec['TUSD G (R$/MWh)']),
      pisCofins: num(rec['PIS/COFINS']),
      icms: num(rec['ICMS (%)']),
      p50MWh: num(rec['P50 (MWh)']),
      demandaExcel: num(rec['Demanda UFV']),
      desconto: num(rec['Desconto']),
      baseExcel: num(rec['Base de Calculo']),
      receitaExcel: num(rec['Receita Total']),
      convencaoExcel: 'nova',
      equipBase: num(rec['Loc. Equipamentos (R$) base']),
      omBase: num(rec['O&M (R$) base']),
      imovelBase: num(rec['Loc. Terras (R$) base']),
    };
    row.convencaoExcel = detectaConvencao(row);
    rows.push(row);
  }
  return rows;
}

export interface ContratoComEntradas {
  contrato: Contrato;
  entradas: EntradaMes[];
  receitaExcelAno: number; // soma "Receita Total" do Contratos, p/ reconciliação
  receitaForecastAno: number; // AF oficial (nível Forecast, Energia Final)
  budgetAno: number; // orçamento travado
}

/** Constrói um objeto Contrato editável por usina, com valores derivados do Excel. */
export function contratosPorUsina(
  rows: ContratoRow[],
  comercial?: DadosComercial,
  energia?: Map<string, EnergiaUsina>,
  cod?: Map<string, DadosCOD>,
): Map<string, ContratoComEntradas> {
  const map = new Map<string, ContratoRow[]>();
  for (const r of rows) {
    const arr = map.get(r.projeto) ?? [];
    arr.push(r);
    map.set(r.projeto, arr);
  }

  // índice normalizado dos deals p/ casar nomes com formatos diferentes
  const dealsNorm = new Map<string, import('../engine/comercial').DealComercial>();
  if (comercial) for (const [nome, deal] of comercial.deals) dealsNorm.set(normNome(nome), deal);
  const achaDeal = (projeto: string): import('../engine/comercial').DealComercial | undefined => {
    if (!comercial) return undefined;
    const exato = comercial.deals.get(projeto);
    if (exato) return exato;
    const n = normNome(projeto);
    const norm = dealsNorm.get(n);
    if (norm) return norm;
    for (const [dn, deal] of dealsNorm) if (dn.length >= 6 && (n.startsWith(dn) || dn.startsWith(n))) return deal;
    return undefined;
  };

  const out = new Map<string, ContratoComEntradas>();
  for (const [projeto, arr] of map) {
    const first = arr[0];
    const tipo = tipoDeCliente(first.cliente);
    const preset = presetRepartição(tipo);
    // valores fixos = base do contrato (constante no ano); pega o 1º mês com valor.
    const equip = arr.find((r) => r.equipBase)?.equipBase ?? 0;
    const om = arr.find((r) => r.omBase)?.omBase ?? 0;
    const imovel = arr.find((r) => r.imovelBase)?.imovelBase ?? 0;

    const deal = achaDeal(projeto);
    const rampa = deal && comercial ? achaRampa(comercial.rampas, deal.novoOfftaker, projeto) : undefined;

    // cadeia de energia + budget (nível Forecast oficial)
    const en = energia?.get(projeto) ?? achaEnergia(energia, projeto);
    const cd = cod?.get(projeto);

    const contrato: Contrato = {
      usina: projeto,
      disco: first.disco,
      cliente: first.cliente,
      clienteTipo: tipo,
      potMWac: first.potMWac,
      potMWp: cd?.potMWp,
      desconto: first.desconto,
      // BANCOR: base é valor colado no Excel → usa o Base de Cálculo armazenado.
      baseFixa: REGRAS_CLIENTE[tipo].grossUp === 'fixo' ? first.baseExcel : undefined,
      baseExcelMwh: first.baseExcel,
      demandaExcelAno: arr.reduce((s, r) => s + r.demandaExcel, 0),
      tarifa: tarifaDe(first),
      nivelRisco: cd?.nivelRisco,
      energizacao: cd?.energizacao,
      cod: cd?.cod,
      faturamento: cd?.faturamento,
      observacoes: cd?.observacoes,
      perdas: en?.perdas,
      equipamentos: { ...preset.equipamentos, valorFixo: preset.equipamentos.modo === 'fixo' ? equip : 0 },
      om: { ...preset.om, valorFixo: preset.om.modo === 'fixo' ? om : 0 },
      imovel: { ...preset.imovel, valorFixo: preset.imovel.modo === 'fixo' ? imovel : 0 },
      guardaChuva: { ...preset.guardaChuva, valorFixo: 0 },
      budgetAno: en?.budgetAno,
      semForecast: !en,
      comercial: deal,
      rampa: rampa && rampa.length ? rampa : undefined,
    };

    const entradas: EntradaMes[] = arr
      .filter((r) => r.mes)
      .sort((a, b) => a.mes.localeCompare(b.mes))
      .map((r) => {
        const pm = en?.porMes.get(r.mes);
        // usina fora do Forecast oficial → não fatura (CONST), não inventa receita P50.
        return { mes: r.mes, p50: r.p50MWh, tarifa: tarifaDe(r), status: en ? pm?.status : 'CONST', perfOper: pm?.perfOper, perfComp: pm?.perfComp };
      });

    out.set(projeto, {
      contrato,
      entradas,
      receitaExcelAno: arr.reduce((s, r) => s + r.receitaExcel, 0),
      receitaForecastAno: en?.receitaForecastAno ?? 0,
      budgetAno: en?.budgetAno ?? 0,
    });
  }
  return out;
}

