import { create } from 'zustand';
import type { ContratoRow, UsinaResumo } from '../engine/types';
import { loadContratos, contratosPorUsina, loadComercial, loadForecastEnergia, loadCOD, type ContratoComEntradas } from '../data/loadForecast';
import { rodaContrato, presetRepartição, type Contrato, type ClienteTipo, type EntradaMes } from '../engine/contrato';
import { REGRAS_CLIENTE, editaRegra, tipoDeCliente, type RegraCliente } from '../engine/clientes';
import type { TarifaDisco } from '../engine/receita';

/** Dados mínimos p/ criar uma usina nova (wizard Cadastro de usina). */
export interface UsinaNova {
  usina: string;
  cliente: string;
  disco: string;
  potMWac: number;
  potMWp?: number;
  desconto: number;    // fração (0.35 = 35%)
  p50Ano: number;      // MWh/ano (distribuído pelo perfil de uma usina do mesmo disco)
  cod?: string;        // data de energização/COD (yyyy-mm-dd) — antes disso o mês é CONST
  takeOrPay?: boolean;
  perfOper?: number;   // default 0.85
}
import { loadPVsyst, type PVsystRow } from '../data/loadPVsyst';
import { loadCompReal, medidoDaUsina, fechadoAte, type CompReal } from '../data/compReal';

/** Contratos faturados na BASE COMPENSAÇÃO: todos os AR (TELMO/LOGIX/HIDRUS/TELCO)
 *  + NEXUS (único GC sem take-or-pay). Os demais GC faturam a injeção
 *  (take-or-pay), logo o compensado medido NÃO deve dirigir a receita deles. */
export function faturaPorCompensacao(tipo: ClienteTipo): boolean {
  // AR (MeterHub) + NEXUS (GC sem take-or-pay) + OPERON (GC operada por terceiro).
  return REGRAS_CLIENTE[tipo]?.modelo === 'AR' || tipo === 'NEXUS' || tipo === 'OPERON';
}

/** Mescla a compensação REAL medida (MeterHub) nos meses fechados de um contrato.
 *  Só para contratos base-compensação; a compMedida manual tem prioridade. */
export function comMedido(contrato: Contrato, projeto: string, compReal: CompReal): Contrato {
  if (!faturaPorCompensacao(contrato.clienteTipo)) return contrato;
  const med = medidoDaUsina(compReal, projeto);
  if (!med) return contrato;
  const auto: Record<string, number> = {};
  for (const [mes, mwh] of Object.entries(med)) if (mes <= fechadoAte && mwh > 0) auto[mes] = mwh;
  if (!Object.keys(auto).length) return contrato;
  return { ...contrato, compMedida: { ...auto, ...(contrato.compMedida ?? {}) } };
}

/** Deriva o resumo por usina rodando o objeto Contrato (nível Forecast/Energia Final).
 *  Se usarMedido, os meses fechados usam o compensado REAL (MeterHub) via comMedido. */
function resumoDeContratos(contratos: Map<string, ContratoComEntradas>, compReal?: CompReal, usarMedido = false): UsinaResumo[] {
  const out: UsinaResumo[] = [];
  for (const [projeto, cc] of contratos) {
    const contrato = usarMedido && compReal ? comMedido(cc.contrato, projeto, compReal) : cc.contrato;
    const r = rodaContrato(contrato, cc.entradas);
    const energiaFinalTotal = r.meses.reduce((s, m) => s + m.energiaFinal, 0);
    const energiaLiquida = r.meses.reduce((s, m) => s + m.p50 * m.perfOper, 0);
    const perfCompMedia = energiaLiquida > 0 ? energiaFinalTotal / energiaLiquida : 0;
    // fee de operação de GC (R$/MWh compensado) que a SolarCo PAGA ao operador (só OPERON).
    const feeMWh = REGRAS_CLIENTE[cc.contrato.clienteTipo]?.feeOperacaoMWh ?? 0;
    const custoOperacao = feeMWh * r.meses.reduce((s, m) => s + m.energiaComp, 0);
    out.push({
      projeto,
      disco: cc.contrato.disco,
      cliente: cc.contrato.cliente,
      potMWac: cc.contrato.potMWac,
      meses: cc.entradas.length,
      p50Total: r.p50,
      energiaFinalTotal,
      receitaEngine: r.receitaTotal,
      receitaForecast: cc.receitaForecastAno,
      budget: cc.budgetAno,
      noPipeline: !!cc.contrato.comercial,
      semForecast: !!cc.contrato.semForecast,
      perfCompMedia,
      modelo: REGRAS_CLIENTE[cc.contrato.clienteTipo]?.modelo ?? 'GC',
      custoOperacao,
      margem: r.receitaTotal - custoOperacao,
    });
  }
  out.sort((a, b) => b.receitaEngine - a.receitaEngine);
  return out;
}

interface ForecastState {
  rows: ContratoRow[];
  usinas: UsinaResumo[];
  contratos: Map<string, ContratoComEntradas>;
  pvsyst: PVsystRow[];
  compReal: CompReal;
  /** Geração medida pelos inversores (O&M), por usina (chave do contrato) → mes → MWh. */
  inversor: Map<string, Record<string, number>>;
  /** Meses fechados usam a compensação REAL (MeterHub) em vez da premissa. */
  usarMedido: boolean;
  setUsarMedido: (v: boolean) => void;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  /** Atualiza o objeto Contrato de uma usina (edição pelo usuário). */
  editaContrato: (usina: string, patch: Partial<Contrato>) => void;
  adicionaUsina: (nova: UsinaNova) => { ok: boolean; erro?: string };
  /** Importa nova versão do PVsyst; recalcula "Dif vs anterior" e propaga o P50 no forecast. */
  importaPVsyst: (novos: PVsystRow[]) => { atualizadas: number; total: number; deltaReceita: number };
  /** Importa injeção/compensação medida por usina/mês (CSV da fatura ou MeterHub). */
  importaMedicoes: (linhas: MedicaoRow[]) => { atualizadas: number; naoEncontradas: string[]; totalLinhas: number };
  /** Edita a regra de faturamento de um cliente (gross-up, residual, modelo…). */
  editaRegraCliente: (tipo: ClienteTipo, patch: Partial<RegraCliente>) => void;
  /** Incrementa a cada edição de regra — força re-render das telas que leem REGRAS_CLIENTE. */
  regrasVersion: number;
}

export interface MedicaoRow {
  usina: string;
  mes: string; // aceita mm-yyyy ou yyyy-mm
  injecao?: number; // MWh — fatura da geradora (distribuidora)
  compensacao?: number; // MWh
  inversor?: number; // MWh — geração medida pelos inversores (O&M)
}

const normNome = (s: string): string =>
  (s || '').normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
/** Normaliza mês para yyyy-mm, aceitando 'mm-yyyy', 'yyyy-mm' ou datas. */
const normMes = (s: string): string => {
  const t = (s || '').trim().slice(0, 10);
  let m = t.match(/^(\d{4})-(\d{2})/); // yyyy-mm
  if (m) return `${m[1]}-${m[2]}`;
  m = t.match(/^(\d{2})[-/](\d{4})/); // mm-yyyy
  if (m) return `${m[2]}-${m[1]}`;
  return '';
};

export const useForecastStore = create<ForecastState>((set) => ({
  rows: [],
  usinas: [],
  contratos: new Map(),
  pvsyst: [],
  compReal: new Map(),
  inversor: new Map(),
  usarMedido: true,
  loading: false,
  error: null,
  regrasVersion: 0,
  setUsarMedido: (v) =>
    set((state) => ({ usarMedido: v, usinas: resumoDeContratos(state.contratos, state.compReal, v) })),
  load: async () => {
    set({ loading: true, error: null });
    try {
      const [rows, comercial, energia, pvsyst, cod] = await Promise.all([loadContratos(), loadComercial(), loadForecastEnergia(), loadPVsyst(), loadCOD()]);
      const contratos = contratosPorUsina(rows, comercial, energia, cod);
      const compReal = loadCompReal();
      set((state) => ({
        rows,
        contratos,
        pvsyst,
        compReal,
        usinas: resumoDeContratos(contratos, compReal, state.usarMedido),
        loading: false,
      }));
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },
  editaContrato: (usina, patch) =>
    set((state) => {
      const atual = state.contratos.get(usina);
      if (!atual) return {};
      let contrato = { ...atual.contrato, ...patch };
      // Troca de titularidade: mudou o cliente → reaplica a repartição (linha residual),
      // preservando os valores fixos atuais. Base de Cálculo já recomputa via clienteTipo.
      if (patch.clienteTipo && patch.clienteTipo !== atual.contrato.clienteTipo) {
        const preset = presetRepartição(patch.clienteTipo);
        const merge = (nova: { modo: string }, velha: { valorFixo: number }) => ({ modo: nova.modo, valorFixo: velha.valorFixo }) as typeof contrato.om;
        contrato = {
          ...contrato,
          equipamentos: merge(preset.equipamentos, atual.contrato.equipamentos),
          om: merge(preset.om, atual.contrato.om),
          imovel: merge(preset.imovel, atual.contrato.imovel),
          guardaChuva: merge(preset.guardaChuva, atual.contrato.guardaChuva),
        };
      }
      const next = new Map(state.contratos);
      next.set(usina, { ...atual, contrato });
      return { contratos: next, usinas: resumoDeContratos(next, state.compReal, state.usarMedido) };
    }),

  adicionaUsina: (nova) => {
    let result: { ok: boolean; erro?: string } = { ok: false, erro: 'erro desconhecido' };
    set((state) => {
      const nome = nova.usina.trim();
      if (!nome) { result = { ok: false, erro: 'Informe o nome da usina' }; return {}; }
      if (state.contratos.has(nome)) { result = { ok: false, erro: 'Já existe uma usina com esse nome' }; return {}; }
      const refs = [...state.contratos.values()].filter((cc) => cc.contrato.tarifa && cc.entradas.length);
      // referência p/ clonar tarifa + estrutura de meses: mesmo disco se houver, senão qualquer uma
      const ref = refs.find((cc) => cc.contrato.disco.trim().toUpperCase() === nova.disco.trim().toUpperCase()) ?? refs[0];
      if (!ref) { result = { ok: false, erro: 'Sem usina de referência (carregue o forecast antes)' }; return {}; }

      const tipo = tipoDeCliente(nova.cliente);
      const tarifa: TarifaDisco = { ...(ref.contrato.tarifa as TarifaDisco), disco: nova.disco.trim() };
      const preset = presetRepartição(tipo);
      const codYM = (nova.cod || '').slice(0, 7); // yyyy-mm
      const refAno = ref.entradas.reduce((s, e) => s + e.p50, 0) || 1;
      const perfOper = nova.perfOper ?? 0.85;

      const entradas: EntradaMes[] = ref.entradas.map((e) => ({
        mes: e.mes,
        p50: nova.p50Ano * (e.p50 / refAno),                    // distribui pelo PERFIL sazonal da ref
        tarifa,
        status: !codYM || e.mes.slice(0, 7) >= codYM ? 'COD' : 'CONST',
        perfOper,
        perfComp: 1,
      }));

      const contrato: Contrato = {
        usina: nome, disco: nova.disco.trim(), cliente: nova.cliente.trim(), clienteTipo: tipo,
        potMWac: nova.potMWac, potMWp: nova.potMWp, desconto: nova.desconto,
        tarifa, energizacao: nova.cod, cod: nova.cod,
        perfOperOverride: perfOper,
        topModo: nova.takeOrPay ? 'substitui' : undefined,
        equipamentos: preset.equipamentos, om: preset.om, imovel: preset.imovel, guardaChuva: preset.guardaChuva,
      };
      const cc: ContratoComEntradas = { contrato, entradas, receitaExcelAno: 0, receitaForecastAno: 0, budgetAno: 0 };
      const next = new Map(state.contratos);
      next.set(nome, cc);
      result = { ok: true };
      return { contratos: next, usinas: resumoDeContratos(next, state.compReal, state.usarMedido) };
    });
    return result;
  },
  importaPVsyst: (novos) => {
    let atualizadas = 0;
    let receitaAntes = 0;
    let receitaDepois = 0;
    set((state) => {
      receitaAntes = state.usinas.reduce((s, u) => s + u.receitaEngine, 0);
      const anterior = new Map(state.pvsyst.map((p) => [p.projeto, p]));
      const comDif = novos.map((n) => {
        const ant = anterior.get(n.projeto);
        // versionamento: Dif = versão anterior ÷ nova − 1 (mesma convenção do Excel)
        const dif = ant && n.total ? ant.total / n.total - 1 : n.difVsAnterior;
        return { ...n, difVsAnterior: dif };
      });
      comDif.sort((a, b) => b.total - a.total);

      // Propaga o novo P50 para os contratos: escala as entradas pela razão novo/anterior.
      const contratos = new Map(state.contratos);
      for (const n of novos) {
        const ant = anterior.get(n.projeto);
        if (!ant || !ant.total || Math.abs(ant.total - n.total) < 0.5) continue;
        const cc = contratos.get(n.projeto);
        if (!cc) continue;
        const ratio = n.total / ant.total;
        const entradas = cc.entradas.map((e) => ({ ...e, p50: e.p50 * ratio }));
        contratos.set(n.projeto, { ...cc, entradas });
        atualizadas += 1;
      }
      const usinas = resumoDeContratos(contratos, state.compReal, state.usarMedido);
      receitaDepois = usinas.reduce((s, u) => s + u.receitaEngine, 0);
      return { pvsyst: comDif, contratos, usinas };
    });
    return { atualizadas, total: novos.length, deltaReceita: receitaDepois - receitaAntes };
  },
  importaMedicoes: (linhas) => {
    const usinasAtualizadas = new Set<string>();
    const naoEncontradas: string[] = [];
    set((state) => {
      const idx = new Map<string, string>(); // nome normalizado → chave real
      for (const k of state.contratos.keys()) idx.set(normNome(k), k);
      const next = new Map(state.contratos);
      const inv = new Map(state.inversor);
      for (const l of linhas) {
        const mes = normMes(l.mes);
        const chave = state.contratos.has(l.usina) ? l.usina : idx.get(normNome(l.usina));
        if (!chave || !mes) { if (l.usina) naoEncontradas.push(l.usina); continue; }
        const cc = next.get(chave)!;
        const contrato = { ...cc.contrato };
        if (l.injecao != null && Number.isFinite(l.injecao)) contrato.injecaoTop = { ...(contrato.injecaoTop ?? {}), [mes]: l.injecao };
        if (l.compensacao != null && Number.isFinite(l.compensacao)) contrato.compMedida = { ...(contrato.compMedida ?? {}), [mes]: l.compensacao };
        if (l.inversor != null && Number.isFinite(l.inversor)) inv.set(chave, { ...(inv.get(chave) ?? {}), [mes]: l.inversor });
        next.set(chave, { ...cc, contrato });
        usinasAtualizadas.add(chave);
      }
      return { contratos: next, inversor: inv, usinas: resumoDeContratos(next, state.compReal, state.usarMedido) };
    });
    return { atualizadas: usinasAtualizadas.size, naoEncontradas: [...new Set(naoEncontradas)], totalLinhas: linhas.length };
  },
  editaRegraCliente: (tipo, patch) =>
    set((state) => {
      editaRegra(tipo, patch); // muta REGRAS_CLIENTE (o motor lê daí)
      let contratos = state.contratos;
      // Se mudou a parcela residual, reaplica a repartição às usinas desse cliente
      // (preservando os valores fixos), já que os modos são fixados na carga.
      if (patch.residual) {
        contratos = new Map(state.contratos);
        const preset = presetRepartição(tipo);
        const merge = (nova: { modo: string }, velha: { valorFixo: number }) =>
          ({ modo: nova.modo, valorFixo: velha.valorFixo }) as Contrato['om'];
        for (const [usina, cc] of contratos) {
          if (cc.contrato.clienteTipo !== tipo) continue;
          contratos.set(usina, {
            ...cc,
            contrato: {
              ...cc.contrato,
              equipamentos: merge(preset.equipamentos, cc.contrato.equipamentos),
              om: merge(preset.om, cc.contrato.om),
              imovel: merge(preset.imovel, cc.contrato.imovel),
              guardaChuva: merge(preset.guardaChuva, cc.contrato.guardaChuva),
            },
          });
        }
      }
      return { contratos, usinas: resumoDeContratos(contratos, state.compReal, state.usarMedido), regrasVersion: state.regrasVersion + 1 };
    }),
}));
