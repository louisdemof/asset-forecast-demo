import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useForecastStore } from '../store/forecastStore';
import { rodaContrato } from '../engine/contrato';
import { REGRAS_CLIENTE } from '../engine/clientes';
import { parseGeracaoCSV } from '../data/loadGeracao';
import { parseFaturaGeradora, type FaturaGeradora } from '../data/parseFaturaGeradora';
import { CADASTRO_UC, DOC_DISCO } from '../data/cadastroUC';
import { fmtMes } from '../lib/date';
import { useAuthStore } from '../store/authStore';
import { supabaseOn } from '../lib/supabase';
import { upsertFatura, hidratarFaturas } from '../data/db/faturas';
import { cadastroDb, hidratarCadastro } from '../data/db/cadastro';
import CadastroUCEditor from './CadastroUCEditor';

const n0 = (v: number) => Math.round(v).toLocaleString('pt-BR');

const rs0 = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
const mwh = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString('pt-BR', { maximumFractionDigits: 1 }));
const pct = (v: number | null | undefined) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);

interface MesG { mes: string; p50: number; inj?: number; inv?: number }
interface LinhaG {
  projeto: string; cliente: string; nDado: number;
  p50: number; inj: number | null; inv: number | null;
  dPI: number | null; dVI: number | null; meses: MesG[];
}

const TEMPLATE = 'usina;mes;injecao;inversor\nUsina Demo 1;2026-01;180,5;192,3\nUsina Demo 1;2026-02;165,2;171,0\n';

export default function GeracaoPanel() {
  const contratos = useForecastStore((s) => s.contratos);
  const inversor = useForecastStore((s) => s.inversor);
  const importaMedicoes = useForecastStore((s) => s.importaMedicoes);
  const [aberta, setAberta] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const pdfRef = useRef<HTMLInputElement | null>(null);
  const [faturas, setFaturas] = useState<(FaturaGeradora & { usina: string })[]>([]);
  const [lendo, setLendo] = useState(false);
  const userId = useAuthStore((s) => s.userId);
  const podeFaturas = useAuthStore((s) => (supabaseOn ? s.can('faturas', 'write') : false));

  // ao logar: carrega o cadastro UC do banco e reaplica as faturas confirmadas
  useEffect(() => {
    if (userId) { void hidratarCadastro().catch(() => {}); void hidratarFaturas(importaMedicoes).catch(() => {}); }
  }, [userId, importaMedicoes]);

  // ALVOS do upload de fatura: usinas GC (fora da MeterHub) — take-or-pay + NEXUS/OPERON.
  // AR (TELMO/LOGIX/HIDRUS/TELCO) está na MeterHub e é alimentada automática, não precisa de fatura.
  const gcUsinas = useMemo(() => [...contratos.keys()]
    .filter((k) => REGRAS_CLIENTE[contratos.get(k)!.contrato.clienteTipo]?.modelo === 'GC')
    .sort(), [contratos]);
  const discoDaUsina = useMemo(() => new Map(gcUsinas.map((u) => [u, contratos.get(u)!.contrato.disco])), [gcUsinas, contratos]);
  // usinas candidatas por distribuidora do documento (EMS/COSERN)
  const usinasDoDoc = (doc: string): string[] => {
    const disco = DOC_DISCO[doc];
    return disco ? gcUsinas.filter((u) => discoDaUsina.get(u) === disco) : gcUsinas;
  };
  const casaUsina = (r: FaturaGeradora): string => {
    for (const id of [r.uc, ...(r.ucs ?? [])]) { // 1) UC (definitivo): banco primeiro, depois baseline embutido
      if (id && cadastroDb[id]) return cadastroDb[id];
      if (id && CADASTRO_UC[id]) return CADASTRO_UC[id];
    }
    const cand = usinasDoDoc(r.doc); // 2) distribuidora + nome do arquivo
    const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/\p{Diacritic}/gu, '').replace(/[^a-z0-9]/g, '');
    const a = norm(r.arquivo);
    return cand.find((u) => a.includes(norm(u))) ?? (cand.length === 1 ? cand[0] : ''); // 3) única da distribuidora
  };

  const onPdf = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    setLendo(true); setMsg('');
    const out: (FaturaGeradora & { usina: string })[] = [];
    for (const f of files) {
      let r = await parseFaturaGeradora(f);
      if (r.flag === 'senha') { // PDF protegido (ex.: COPEL) — pede a senha e reprocessa
        const pw = window.prompt(`"${f.name}" está protegido por senha. Digite a senha do PDF:`);
        if (pw) r = await parseFaturaGeradora(f, pw);
      }
      out.push({ ...r, usina: casaUsina(r) });
    }
    out.sort((x, y) => x.arquivo.localeCompare(y.arquivo));
    setFaturas((prev) => [...prev, ...out]);
    setLendo(false);
    if (pdfRef.current) pdfRef.current.value = '';
  };

  const prontaParaAplicar = (f: FaturaGeradora & { usina: string }) =>
    Boolean(f.usina && f.mes && f.injecao > 0 && !/implaus|injeção 0/.test(f.flag));

  const aplicarFaturas = () => {
    const aplicadas = faturas.filter(prontaParaAplicar);
    if (!aplicadas.length) { setMsg('Nenhuma fatura pronta para aplicar (falta usina, mês ou injeção válida).'); return; }
    const r = importaMedicoes(aplicadas.map((f) => ({ usina: f.usina, mes: f.mes, injecao: f.injecao / 1000 }))); // kWh → MWh
    // persiste no Supabase (injeção/banco/demanda) quando autorizado
    if (podeFaturas) {
      Promise.allSettled(aplicadas.map((f) => upsertFatura(f))).then((res) => {
        const falhas = res.filter((x) => x.status === 'rejected').length;
        setMsg(`Injeção aplicada de ${aplicadas.length} fatura(s) · ${r.atualizadas} usina(s). ${falhas ? `⚠ ${falhas} não salva(s) no banco.` : '✓ salvas no Supabase.'}`);
      });
    } else {
      setMsg(`Injeção aplicada de ${aplicadas.length} fatura(s) · ${r.atualizadas} usina(s).${supabaseOn ? ' (entre para salvar no banco)' : ''}`);
    }
    setFaturas((prev) => prev.filter((f) => !prontaParaAplicar(f)));
  };

  // Mês "dobrado": a distribuidora não faturou o mês anterior (sem dado) e jogou os dois num só.
  // Divide a injeção entre o mês anterior e o atual, PROPORCIONAL ao P50 (esperado de cada mês).
  const ajustarDobrado = (usina: string, prev: MesG, cur: MesG) => {
    const total = cur.inj ?? 0; // MWh
    const soma = (prev.p50 + cur.p50) || 1;
    const injPrev = total * prev.p50 / soma;
    const injCur = total - injPrev;
    importaMedicoes([
      { usina, mes: prev.mes, injecao: injPrev },
      { usina, mes: cur.mes, injecao: injCur },
    ]);
    setMsg(`${usina}: injeção de ${fmtMes(cur.mes)} (dobrada) dividida → ${fmtMes(prev.mes)} ${mwh(injPrev)} + ${fmtMes(cur.mes)} ${mwh(injCur)} MWh (proporcional ao P50).`);
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const rows = parseGeracaoCSV(await f.text());
      if (!rows.length) { setMsg('CSV sem linhas reconhecidas — cabeçalho esperado: usina · mes · injecao [· inversor].'); return; }
      const r = importaMedicoes(rows);
      const ne = r.naoEncontradas.length ? ` · ${r.naoEncontradas.length} usina(s) não casada(s): ${r.naoEncontradas.slice(0, 3).join(', ')}${r.naoEncontradas.length > 3 ? '…' : ''}` : '';
      setMsg(`Importado: ${r.totalLinhas} linhas · ${r.atualizadas} usina(s) atualizada(s)${ne}.`);
    } catch (err) {
      setMsg('Erro ao ler o CSV: ' + (err as Error).message);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const baixaTemplate = () => {
    const blob = new Blob(['﻿' + TEMPLATE], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'template-geracao.csv'; a.click(); URL.revokeObjectURL(a.href);
  };

  const linhas = useMemo<LinhaG[]>(() => {
    const out: LinhaG[] = [];
    for (const [projeto, cc] of contratos) {
      if (REGRAS_CLIENTE[cc.contrato.clienteTipo]?.modelo !== 'GC') continue; // GC fora da MeterHub (take-or-pay + NEXUS/OPERON)
      const run = rodaContrato(cc.contrato, cc.entradas);
      const injTop = cc.contrato.injecaoTop ?? {};
      const invMap = inversor.get(projeto) ?? {};
      // P50 = P50 bruto (PVsyst) — MESMO valor da base/Receita/aba PVsyst (não P50×perfOper)
      const meses: MesG[] = run.meses.map((m) => ({ mes: m.mes, p50: m.p50, inj: injTop[m.mes], inv: invMap[m.mes] }));
      const comDado = meses.filter((m) => m.inj != null || m.inv != null);
      const base = comDado.length ? comDado : meses;
      const p50 = base.reduce((s, m) => s + m.p50, 0);
      const somaInj = comDado.reduce((s, m) => s + (m.inj ?? 0), 0);
      const somaInv = comDado.reduce((s, m) => s + (m.inv ?? 0), 0);
      const temInj = comDado.some((m) => m.inj != null);
      const temInv = comDado.some((m) => m.inv != null);
      const inj = temInj ? somaInj : null;
      const inv = temInv ? somaInv : null;
      // desvios sobre os mesmos meses (base comparável = meses com injeção)
      const p50NosInj = comDado.filter((m) => m.inj != null).reduce((s, m) => s + m.p50, 0);
      const invNosInj = comDado.filter((m) => m.inj != null && m.inv != null).reduce((s, m) => s + (m.inv ?? 0), 0);
      const injNosInv = comDado.filter((m) => m.inj != null && m.inv != null).reduce((s, m) => s + (m.inj ?? 0), 0);
      out.push({
        projeto, cliente: cc.contrato.cliente, nDado: comDado.length,
        p50, inj, inv,
        dPI: temInj && p50NosInj ? (somaInj - p50NosInj) / p50NosInj : null,
        dVI: temInj && temInv && injNosInv ? (invNosInj - injNosInv) / injNosInv : null,
        meses,
      });
    }
    out.sort((a, b) => b.nDado - a.nDado || (b.inj ?? 0) - (a.inj ?? 0) || b.p50 - a.p50);
    return out;
  }, [contratos, inversor]);

  const tot = useMemo(() => {
    const comDado = linhas.filter((l) => l.nDado > 0);
    const inj = comDado.reduce((s, l) => s + (l.inj ?? 0), 0);
    const p50sobreInj = comDado.reduce((s, l) => {
      const p = l.meses.filter((m) => m.inj != null).reduce((a, m) => a + m.p50, 0); return s + p;
    }, 0);
    return { nGC: linhas.length, nDado: comDado.length, inj, p50sobreInj, dev: p50sobreInj ? (inj - p50sobreInj) / p50sobreInj : null };
  }, [linhas]);

  // demanda PREVISTA (forecast) por usina × mês (YYYY-MM) — p/ comparar com a da fatura
  const demandaPrev = useMemo(() => {
    const m = new Map<string, Map<string, number>>();
    for (const [usina, cc] of contratos) {
      const mm = new Map<string, number>();
      for (const mes of rodaContrato(cc.contrato, cc.entradas).meses) mm.set(mes.mes.slice(0, 7), mes.demanda);
      m.set(usina, mm);
    }
    return m;
  }, [contratos]);
  const demPrevDe = (usina: string, mes: string): number | undefined =>
    usina && mes ? demandaPrev.get(usina)?.get(mes.slice(0, 7)) : undefined;

  // edição manual dos campos da fatura (corrige erro de OCR/parser antes de aplicar/salvar)
  const setCampoFatura = (i: number, campo: 'injecao' | 'banco' | 'demanda', str: string) => {
    const v = parseFloat(str.replace(/\./g, '').replace(',', '.'));
    setFaturas((prev) => prev.map((x, j) => (j === i ? { ...x, [campo]: Number.isFinite(v) ? v : 0 } : x)));
  };

  if (!contratos.size) return <div className="state">Carregando…</div>;

  return (
    <>
      <section className="kpis">
        <Kpi label="GD GC (fora da MeterHub)" value={`${tot.nGC}`} sub="injeção vem da fatura da geradora" />
        <Kpi label="Com fatura carregada" value={`${tot.nDado}`} sub={`de ${tot.nGC} · falta upload/OCR`} accent />
        <Kpi label="Injeção faturada" value={`${rs0(tot.inj)} MWh`} sub="soma dos meses com dado" />
        <Kpi label="Injeção × P50" value={pct(tot.dev)} sub="realidade vs engenharia" />
      </section>

      <div className="audit-head">
        <p>
          Reconciliação da <b>geração</b> dos GD <b>GC fora da MeterHub</b> (take-or-pay <b>+</b> NEXUS/OPERON — ex. Litoral, Ventania).
          Três fontes: <b>P50</b> (engenharia/PVsyst) × <b>Injeção</b> (fatura da distribuidora da geradora — <i>upload / OCR</i>, não está na MeterHub) × <b>Inversor</b> (O&M).
          Os desvios apontam performance (P50×Inversor), perdas/rede (Inversor×Injeção) e impacto na receita (P50×Injeção).
        </p>
        <div className="audit-filtros">
          <input ref={pdfRef} type="file" accept=".pdf" multiple style={{ display: 'none' }} onChange={onPdf} />
          <button className="btn-export" onClick={() => pdfRef.current?.click()}>{lendo ? '⏳ lendo…' : '⤒ Soltar fatura (PDF)'}</button>
          <input ref={fileRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={onFile} />
          <button className="chip-btn" onClick={() => fileRef.current?.click()}>⤒ CSV</button>
          <button className="chip-btn" onClick={baixaTemplate}>⤓ Template</button>
          {msg && <span className="import-msg">{msg}</span>}
        </div>
      </div>

      <CadastroUCEditor />

      {faturas.length > 0 && (
        <div className="tablewrap" style={{ marginBottom: 14 }}>
          <table className="comp-t">
            <thead>
              <tr><th>Arquivo</th><th>Layout</th><th>UC geradora</th><th>Mês</th><th className="r">Injeção (kWh)</th><th className="r">Banco (kWh)</th><th className="r" title="Demanda de geração da fatura">Demanda fat. (R$)</th><th className="r" title="Demanda UFV prevista no forecast (engenharia/contrato) p/ a usina e mês">Demanda prev. (R$)</th><th className="r" title="(fatura − forecast) ÷ forecast">Δ</th><th>Usina (destino)</th><th></th></tr>
            </thead>
            <tbody>
              {faturas.map((f, i) => (
                <tr key={f.arquivo + i} className={f.flag ? 'muted-row' : ''}>
                  <td className="mono" style={{ fontSize: 11 }}>{f.arquivo}</td>
                  <td>{f.doc}</td>
                  <td className="mono">{f.uc || '—'}</td>
                  <td>{f.mes ? fmtMes(f.mes) : <span className="warn-text">?</span>}</td>
                  <td className="r"><input className="fat-edit strong" defaultValue={f.injecao > 0 ? n0(f.injecao) : ''} placeholder="—"
                    onBlur={(e) => setCampoFatura(i, 'injecao', e.target.value)} title="Injeção (kWh) — editável; corrija se o OCR/parser errar" /></td>
                  <td className="r"><input className="fat-edit" defaultValue={f.banco > 0 ? n0(f.banco) : ''} placeholder="—"
                    onBlur={(e) => setCampoFatura(i, 'banco', e.target.value)} title="Banco (kWh) — editável" /></td>
                  <td className="r"><input className="fat-edit" defaultValue={f.demanda > 0 ? n0(f.demanda) : ''} placeholder="—"
                    onBlur={(e) => setCampoFatura(i, 'demanda', e.target.value)} title="Demanda de geração (R$) — editável" /></td>
                  {(() => {
                    const dp = demPrevDe(f.usina, f.mes);
                    const dv = dp && dp > 0 && f.demanda > 0 ? (f.demanda - dp) / dp : null;
                    return (<>
                      <td className="r muted">{dp != null ? n0(dp) : '—'}</td>
                      <td className={`r ${dv != null && Math.abs(dv) > 0.15 ? 'warn-text' : 'muted'}`}>{dv != null ? pct(dv) : '—'}</td>
                    </>);
                  })()}
                  <td>
                    <select value={f.usina} onChange={(e) => setFaturas((prev) => prev.map((x, j) => (j === i ? { ...x, usina: e.target.value } : x)))}>
                      <option value="">— escolher —</option>
                      <optgroup label={`${DOC_DISCO[f.doc] ?? 'distribuidora'} (sugeridas)`}>
                        {usinasDoDoc(f.doc).map((u) => <option key={u} value={u}>{u}</option>)}
                      </optgroup>
                      <optgroup label="todas">
                        {gcUsinas.map((u) => <option key={'all' + u} value={u}>{u}</option>)}
                      </optgroup>
                    </select>
                    {[f.uc, ...(f.ucs ?? [])].some((id) => id && CADASTRO_UC[id]) && <span className="perf-badge" title="Casado pela UC da fatura (cadastro)" style={{ marginLeft: 4 }}>✓ UC</span>}
                    {f.flag && <span className="custo-op" title={f.flag}> ⚠</span>}
                  </td>
                  <td><button className="chip-btn" onClick={() => setFaturas((prev) => prev.filter((_, j) => j !== i))}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ padding: '8px 10px', display: 'flex', gap: 10, alignItems: 'center' }}>
            <button className="btn-export" onClick={aplicarFaturas}>✓ Aplicar injeção nas usinas</button>
            <button className="chip-btn" onClick={() => setFaturas([])}>limpar</button>
            <span className="hint"><b>Injeção, banco e demanda são editáveis</b> (fundo amarelo) — corrija ali se o OCR/parser errar antes de aplicar. A injeção (kWh→MWh) alimenta o take-or-pay na Receita; <b>Demanda prev.</b> = demanda UFV do forecast. Ao aplicar, os valores (já corrigidos) são salvos no Supabase. ⚠ = conferir. Vale p/ GC fora da MeterHub (ex. Litoral/Ventania).</span>
          </div>
        </div>
      )}

      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th className="chev-col"></th>
              <th>Usina</th><th>Cliente</th><th className="r" title="Nº de meses com fatura da geradora carregada">Meses c/ fatura</th>
              <th className="r" title="P50 bruto (PVsyst) — o MESMO valor da base, da aba PVsyst e da Receita. Somado sobre os meses com fatura (ou o ano todo, se ainda sem fatura).">P50 (MWh)*</th>
              <th className="r" title="Injeção REAL da fatura da geradora (kWh→MWh), somada sobre os meses com fatura">Injeção (MWh)</th>
              <th className="r" title="Geração medida pelos inversores (O&M)">Inversor (MWh)</th>
              <th className="r" title="Desvio: (Injeção real − P50 esperado) ÷ P50. Negativo = injetou MENOS que a engenharia previu.">Inj vs P50</th>
              <th className="r" title="Inversor (gerado) vs Injeção (chegou na rede) — perdas/medição">Inv vs Inj</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((l) => {
              const open = aberta === l.projeto;
              const semDado = l.nDado === 0;
              const altoPI = l.dPI != null && Math.abs(l.dPI) > 0.1;
              const altoVI = l.dVI != null && Math.abs(l.dVI) > 0.05;
              return (
                <Fragment key={l.projeto}>
                  <tr className={`clickable ${open ? 'open' : ''} ${semDado ? 'muted-row' : ''}`} onClick={() => setAberta(open ? null : l.projeto)}>
                    <td className="chev-col">{open ? '▾' : '▸'}</td>
                    <td className="strong">{l.projeto}</td>
                    <td className="muted">{l.cliente}</td>
                    <td className="r">{semDado ? <span className="audit-tag y">sem fatura</span> : l.nDado}</td>
                    <td className="r muted">{mwh(l.p50)}</td>
                    <td className="r strong">{mwh(l.inj)}</td>
                    <td className="r">{mwh(l.inv)}</td>
                    <td className={`r ${altoPI ? (l.dPI! < 0 ? 'warn-text' : 'ok-text') : 'muted'}`}>{pct(l.dPI)}{altoPI ? (l.dPI! < 0 ? ' ▼' : ' ▲') : ''}</td>
                    <td className={`r ${altoVI ? 'warn-text' : 'muted'}`}>{pct(l.dVI)}{altoVI ? ' ⚠' : ''}</td>
                  </tr>
                  {open && !semDado && (
                    <tr>
                      <td colSpan={9} style={{ background: '#f7fafb' }}>
                        <div style={{ padding: '8px 14px' }}>
                          <table className="uc-mes-table">
                            <thead>
                              <tr><th>Mês</th><th className="r">P50</th><th className="r">Injeção</th><th className="r">Inversor</th><th className="r" title="(Injeção − P50) ÷ P50">Inj vs P50</th><th className="r" title="(Inversor − Injeção) ÷ Injeção">Inv vs Inj</th></tr>
                            </thead>
                            <tbody>
                              {l.meses.filter((m) => m.inj != null || m.inv != null).map((m) => {
                                const p50ok = m.p50 > 0.5; // P50 válido (perfOper negativo/zero na fonte quebra a conta)
                                const dPI = m.inj != null && p50ok ? (m.inj - m.p50) / m.p50 : null;
                                const dVI = m.inj != null && m.inv != null && m.inj ? (m.inv - m.inj) / m.inj : null;
                                // mês DOBRADO: mês anterior sem injeção (não faturado) e este ~2× o P50
                                const iFull = l.meses.findIndex((x) => x.mes === m.mes);
                                const prev = iFull > 0 ? l.meses[iFull - 1] : null;
                                const dobrado = !!(prev && prev.inj == null && m.inj != null && m.p50 && m.inj > m.p50 * 1.7);
                                return (
                                  <tr key={m.mes}>
                                    <td className="mono">{fmtMes(m.mes)}</td>
                                    <td className="r muted">{mwh(m.p50)}</td>
                                    <td className="r strong">{mwh(m.inj)}{dobrado && <span className="custo-op" title={`Injeção ~2× o P50 e ${prev ? fmtMes(prev.mes) : ''} sem fatura — provável mês dobrado pela distribuidora`}> ⚠2×</span>}</td>
                                    <td className="r">{mwh(m.inv)}</td>
                                    <td className={`r ${dPI == null ? 'muted' : Math.abs(dPI) > 0.1 ? 'warn-text' : ''}`}>{pct(dPI)}</td>
                                    <td className={`r ${dVI == null ? 'muted' : Math.abs(dVI) > 0.05 ? 'warn-text' : ''}`}>{pct(dVI)}
                                      {dobrado && prev && <button className="chip-btn" style={{ marginLeft: 6 }} title={`Dividir a injeção entre ${fmtMes(prev.mes)} e ${fmtMes(m.mes)}, proporcional ao P50`} onClick={() => ajustarDobrado(l.projeto, prev, m)}>↔ dividir c/ {fmtMes(prev.mes)}</button>}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <footer className="foot">
        <b>*P50</b> e <b>Injeção</b> são somados <b>sobre os mesmos meses com fatura</b> (por isso a comparação é justa); usinas ainda <b>sem fatura</b>
        mostram o P50 do ano todo como referência. P50 = <b>P50 bruto (PVsyst)</b>, o mesmo da base / aba PVsyst / Receita. Injeção = fatura da geradora (<b>upload</b>;
        GC não vem da MeterHub). Inversor = O&M. <b>Inj vs P50</b> = (Injeção − P50) ÷ P50 (negativo = injetou menos que o previsto);
        <b>Inv vs Inj</b> = (Inversor − Injeção) ÷ Injeção. Desvios &gt; 10% (Inj vs P50) e &gt; 5% (Inv vs Inj) destacados. A injeção alimenta o take-or-pay na Receita.
      </footer>
    </>
  );
}

function Kpi({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`kpi ${accent ? 'accent' : ''}`}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {sub && <span className="kpi-sub">{sub}</span>}
    </div>
  );
}
