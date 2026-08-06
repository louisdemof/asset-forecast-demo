import { useEffect, useMemo, useState } from 'react';
import { secureText } from '../secure';

interface UCmes { uc: string; dist: string; rateio: number; consumo: number; compensado: number; injetado: number; saldo: number }
interface UsinaComp { usina: string; meses: Record<string, { ucs: UCmes[] }> }

type Problema = 'geradora' | 'glitch' | 'semRateio' | 'contingencia' | 'recuperacao';
interface UCFlag {
  uc: string; usina: string; dist: string; rateio: number;
  consumo: number; compensado: number; injetado: number;
  geradora: boolean; glitch: boolean; semRateio: boolean; contingencia: boolean; recuperacao: boolean;
}

const n0 = (v: number) => Math.round(v).toLocaleString('pt-BR');

/** Analisa a série mensal de uma UC e classifica os "picos" de compensação.
 *  Um pico (compensado >> consumo/injeção) só é GLITCH se NÃO puder ser
 *  explicado como recuperação de meses anteriores zerados (fatura represada):
 *  se os meses zerados imediatamente antes consumiram energia suficiente para
 *  cobrir o pico, é RECUPERAÇÃO — e esses meses zerados viram CONTINGÊNCIA
 *  (fatura pendente), mesmo no início da série. */
function analisaSerie(meses: { comp: number; cons: number; inj: number; saldo: number }[]) {
  const glitch = new Set<number>();
  const recuperacao = new Set<number>();
  const conting = new Set<number>();
  for (let i = 0; i < meses.length; i++) {
    const m = meses[i];
    if (m.comp <= Math.max(m.cons, m.inj, 1) * 1.5) continue; // mês normal
    // pico: tenta explicar como recuperação de meses zerados anteriores
    let z = 0, consAcum = m.cons;
    for (let j = i - 1; j >= 0 && meses[j].comp === 0 && meses[j].cons > 0; j--) { z++; consAcum += meses[j].cons; }
    if (z >= 1 && m.comp <= consAcum * 1.5) {
      recuperacao.add(i);
      for (let j = i - 1; j > i - 1 - z; j--) conting.add(j);
    } else {
      glitch.add(i);
    }
  }
  // contingência clássica: mês zerado entre dois meses que compensam
  const compIdx = meses.map((m, i) => (m.comp > 0 ? i : -1)).filter((i) => i >= 0);
  if (compIdx.length) {
    const first = compIdx[0], last = compIdx[compIdx.length - 1];
    meses.forEach((m, i) => { if (i > first && i < last && m.cons > 0 && m.comp === 0 && m.saldo === 0) conting.add(i); });
  }
  return { glitch, recuperacao, conting };
}

const PROBLEMAS: { key: Problema; label: string; cor: string; desc: string }[] = [
  { key: 'semRateio', label: 'Sem rateio', cor: 'r', desc: 'Compensa mas rateio declarado = 0% (BV faltando na Base MeterHub) — investigar com a MeterHub.' },
  { key: 'geradora', label: 'Geradora', cor: 'y', desc: 'A injeção domina — é o medidor da usina, não uma UC consumidora. Fica fora do total.' },
  { key: 'glitch', label: 'Glitch', cor: 'r', desc: 'Compensado impossível (acima do consumo/injeção e NÃO explicado por recuperação de meses represados) — erro de fatura escaneada.' },
  { key: 'contingencia', label: 'Contingência', cor: 'y', desc: 'Mês em que a UC consumiu mas não compensou (saldo 0) — fatura não emitida/escaneada. Inclui o mês anterior a uma recuperação.' },
  { key: 'recuperacao', label: 'Recuperação', cor: 'b', desc: 'Mês com compensação em dobro/triplo que cobre meses anteriores represados — energia real, não é erro. Sinaliza a fatura pendente do mês anterior.' },
];

export default function AuditoriaPanel({ onAbrir }: { onAbrir?: (usina: string, uc: string) => void }) {
  const [dados, setDados] = useState<UsinaComp[] | null>(null);
  const [filtro, setFiltro] = useState<Problema | 'todos'>('todos');
  const [usinaF, setUsinaF] = useState('todas');
  const [busca, setBusca] = useState('');
  const [ajuda, setAjuda] = useState(false);

  useEffect(() => {
    try { setDados(JSON.parse(secureText('comp_portfolio.json'))); } catch { setDados([]); }
  }, []);

  const flags = useMemo<UCFlag[]>(() => {
    if (!dados) return [];
    const acc = new Map<string, { usina: string; uc: string; dist: string; rateio: number; consumo: number; compensado: number; injetado: number; meses: { mes: string; comp: number; cons: number; inj: number; saldo: number }[] }>();
    for (const u of dados) {
      for (const [mes, m] of Object.entries(u.meses)) {
        for (const x of m.ucs) {
          const k = `${u.usina}|${x.uc}`;
          let a = acc.get(k);
          if (!a) { a = { usina: u.usina, uc: x.uc, dist: x.dist || '', rateio: 0, consumo: 0, compensado: 0, injetado: 0, meses: [] }; acc.set(k, a); }
          a.consumo += x.consumo; a.compensado += x.compensado; a.injetado += x.injetado ?? 0;
          a.rateio = Math.max(a.rateio, x.rateio ?? 0);
          if (!a.dist && x.dist) a.dist = x.dist;
          a.meses.push({ mes, comp: x.compensado, cons: x.consumo, inj: x.injetado ?? 0, saldo: x.saldo ?? 0 });
        }
      }
    }
    const out: UCFlag[] = [];
    for (const a of acc.values()) {
      a.meses.sort((x, y) => x.mes.localeCompare(y.mes));
      const geradora = a.injetado > 5000 && a.injetado > a.consumo;
      const { glitch: gSet, recuperacao: rSet, conting: cSet } = analisaSerie(a.meses);
      const glitch = gSet.size > 0;
      const recuperacao = rSet.size > 0;
      const contingencia = cSet.size > 0;
      const semRateio = a.compensado > 1000 && a.rateio === 0 && !geradora;
      if (geradora || glitch || semRateio || contingencia || recuperacao) {
        out.push({ uc: a.uc, usina: a.usina, dist: a.dist, rateio: a.rateio, consumo: a.consumo, compensado: a.compensado, injetado: a.injetado, geradora, glitch, semRateio, contingencia, recuperacao });
      }
    }
    return out.sort((x, y) => y.compensado - x.compensado);
  }, [dados]);

  const cont = useMemo(() => {
    const c = { total: flags.length, geradora: 0, glitch: 0, semRateio: 0, contingencia: 0, recuperacao: 0 };
    for (const f of flags) { if (f.geradora) c.geradora++; if (f.glitch) c.glitch++; if (f.semRateio) c.semRateio++; if (f.contingencia) c.contingencia++; if (f.recuperacao) c.recuperacao++; }
    return c;
  }, [flags]);

  const usinas = useMemo(() => [...new Set(flags.map((f) => f.usina))].sort(), [flags]);

  const lista = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return flags.filter((f) => {
      if (filtro !== 'todos' && !f[filtro]) return false;
      if (usinaF !== 'todas' && f.usina !== usinaF) return false;
      if (q && !(f.uc.toLowerCase().includes(q) || f.usina.toLowerCase().includes(q) || f.dist.toLowerCase().includes(q))) return false;
      return true;
    }).slice(0, 800);
  }, [flags, filtro, usinaF, busca]);

  const exportCSV = () => {
    const head = ['UC', 'Usina', 'Distribuidora', 'Rateio %', 'Consumo (ano)', 'Compensado (ano)', 'Injeção (ano)', 'Problemas'];
    const rows = flags.filter((f) => filtro === 'todos' || f[filtro]).map((f) => [
      f.uc, f.usina, f.dist, (f.rateio * 100).toFixed(2), f.consumo.toFixed(0), f.compensado.toFixed(0), f.injetado.toFixed(0),
      [f.semRateio && 'sem rateio', f.geradora && 'geradora', f.glitch && 'glitch', f.contingencia && 'contingência', f.recuperacao && 'recuperação'].filter(Boolean).join(' + '),
    ]);
    const csv = [head, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'auditoria-ucs.csv'; a.click(); URL.revokeObjectURL(a.href);
  };

  if (!dados) return <div className="state">Carregando…</div>;

  return (
    <>
      <section className="kpis">
        <Kpi label="UCs sinalizadas" value={n0(cont.total)} sub="com alguma inconsistência" accent />
        <Kpi label="Sem rateio" value={n0(cont.semRateio)} sub="compensam, BV faltando" />
        <Kpi label="Geradoras" value={n0(cont.geradora)} sub="medidor da usina" />
        <Kpi label="Glitch / contingência" value={`${cont.glitch} / ${cont.contingencia}`} sub="fatura com erro / pendente" />
      </section>

      <div className="audit-head">
        <p>
          Varredura de qualidade das UCs medidas (MeterHub, 12 meses). Clique num tipo para filtrar; exporte a lista para tratar com o time.
          <button className="ajuda-toggle" onClick={() => setAjuda((v) => !v)}>{ajuda ? '▾ ocultar' : '❔ como funciona'}</button>
        </p>

        {ajuda && (
          <div className="ajuda-box">
            <h4>Por que esta auditoria existe</h4>
            <p>
              O forecast de receita depende de <b>quanto cada usina compensa</b> nas UCs consumidoras. Esse dado vem da <b>MeterHub</b>, que
              escaneia as faturas das distribuidoras de <b>~6.800 UCs</b>. Em qualquer base desse tamanho há ruído: faturas mal escaneadas,
              rateio (BV) não cadastrado, o medidor da própria usina misturado com consumidores, faturas que não saíram num mês. Se ninguém
              varre isso, o erro entra <b>silenciosamente na receita prevista</b>. Esta aba faz a varredura e classifica cada anomalia — para
              você saber <b>o que investigar, por quê e com quem resolver</b>.
            </p>

            <h4>Como cada sinal é calculado</h4>
            <ul className="ajuda-list">
              <li>
                <span className="audit-tag r">sem rateio</span>
                <b>Regra:</b> a UC compensa &gt; 1 MWh/ano mas o rateio declarado é <b>0%</b>.
                <b>Por quê:</b> energia sendo compensada sem estar amarrada a nenhuma usina no cadastro → risco de atribuição/faturamento errado.
                <b>Ação:</b> pedir à MeterHub o BV correto daquela UC.
              </li>
              <li>
                <span className="audit-tag y">⚡ geradora</span>
                <b>Regra:</b> injeção &gt; 5.000 kWh <b>e</b> maior que o consumo.
                <b>Por quê:</b> é o <b>medidor da usina</b>, não uma UC consumidora — se contada como consumo, infla a compensação e a receita.
                <b>Ação:</b> nenhuma; a aba já a exclui do total limpo. Serve de conferência.
              </li>
              <li>
                <span className="audit-tag r">⚠ glitch</span>
                <b>Regra:</b> um mês compensa &gt; máx(consumo, injeção) × 1,5 <b>e isso não é explicado por recuperação</b> (ver abaixo).
                <b>Por quê:</b> compensar muito mais do que se consumiu, sem banco para sacar, é fisicamente impossível → erro de OCR na fatura.
                <b>Ação:</b> pedir à MeterHub reconferir aquele mês contra o PDF; candidato a correção manual.
              </li>
              <li>
                <span className="audit-tag y">contingência</span>
                <b>Regra:</b> mês em que a UC <b>consumiu mas compensou 0</b> (saldo 0) — entre meses que compensam, ou logo antes de uma recuperação.
                <b>Por quê:</b> a fatura daquele mês <b>não foi emitida/escaneada</b> → buraco no histórico.
                <b>Ação:</b> cobrar a fatura faltante da distribuidora/MeterHub.
              </li>
              <li>
                <span className="audit-tag b">recuperação</span>
                <b>Regra:</b> um pico de compensação que <b>cobre meses anteriores represados</b> — o compensado ≤ (consumo acumulado dos meses zerados anteriores + o do mês) × 1,5.
                <b>Por quê:</b> quando uma fatura atrasa, a compensação represada cai toda no mês seguinte. É <b>energia real, não erro</b> — por isso <b>não</b> é glitch. O total do ano fica certo; só o faseamento é que "junta" dois meses.
                <b>Ação:</b> nenhuma sobre o valor; o item real é a <b>fatura pendente</b> do mês anterior (marcado como contingência).
              </li>
            </ul>

            <h4>O caso que motivou a regra "recuperação"</h4>
            <p>
              UC 2124500-2 (Manaus): outubro/2025 consumiu 1.894 kWh e compensou 0 (fatura não escaneada); novembro compensou <b>3.316</b> ≈
              outubro + novembro juntos. A leitura ingênua chamaria novembro de "glitch" (180% do consumo). Mas 3.316 ≤ (1.894 + 1.841) × 1,5,
              logo é <b>recuperação</b> — e o problema real é a <b>fatura de outubro</b>. A regra agora separa os dois automaticamente.
            </p>

            <p className="ajuda-caveat">
              ⚠ <b>São heurísticas, não veredictos.</b> Os limiares (injeção &gt; 5.000 kWh, pico &gt; 1,5× consumo) foram calibrados nos casos que
              investigamos. Elas <b>apontam candidatos</b> a erro — cada sinal ainda pede conferência humana. Por isso cada linha é clicável:
              leva direto à aba <b>Compensação</b>, ao histórico real de banco/rateio daquela UC.
            </p>
          </div>
        )}

        <div className="audit-filtros">
          <button className={`chip-btn ${filtro === 'todos' ? 'on' : ''}`} onClick={() => setFiltro('todos')}>Todos ({cont.total})</button>
          {PROBLEMAS.map((p) => (
            <button key={p.key} className={`chip-btn sev-${p.cor} ${filtro === p.key ? 'on' : ''}`} title={p.desc} onClick={() => setFiltro(p.key)}>
              {p.label} ({cont[p.key]})
            </button>
          ))}
          <input className="search" placeholder="Buscar UC, usina, distribuidora…" value={busca} onChange={(e) => setBusca(e.target.value)} />
          <select value={usinaF} onChange={(e) => setUsinaF(e.target.value)}>
            <option value="todas">todas as usinas</option>
            {usinas.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
          <button className="btn-export" onClick={exportCSV}>⤓ Exportar CSV</button>
        </div>
      </div>

      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>UC</th><th>Usina</th><th>Distribuidora</th><th className="r">Rateio</th>
              <th className="r">Consumo (ano)</th><th className="r">Compensado (ano)</th><th>Problema(s)</th>
            </tr>
          </thead>
          <tbody>
            {lista.map((f) => (
              <tr key={f.usina + f.uc} className={onAbrir ? 'clickable' : ''} onClick={onAbrir ? () => onAbrir(f.usina, f.uc) : undefined} title={onAbrir ? 'Abrir na aba Compensação' : ''}>
                <td className="mono"><span className="audit-uc-link">{f.uc} ↗</span></td>
                <td>{f.usina}</td>
                <td className="muted">{f.dist || '—'}</td>
                <td className="r">{(f.rateio * 100).toFixed(2)}%</td>
                <td className="r muted">{n0(f.consumo)}</td>
                <td className="r strong">{n0(f.compensado)}</td>
                <td>
                  {f.semRateio && <span className="audit-tag r">sem rateio</span>}
                  {f.geradora && <span className="audit-tag y">⚡ geradora</span>}
                  {f.glitch && <span className="audit-tag r">⚠ glitch</span>}
                  {f.contingencia && <span className="audit-tag y">contingência</span>}
                  {f.recuperacao && <span className="audit-tag b">recuperação</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {flags.length > lista.length && filtro === 'todos' && !busca && usinaF === 'todas' && (
          <p className="hint">Mostrando as {lista.length} maiores por compensação. Use os filtros ou exporte o CSV para ver todas ({cont.total}).</p>
        )}
      </div>
      <footer className="foot">
        Fonte: <b>MeterHub</b> (comp_portfolio, 12 meses). Regras: <b>geradora</b> = injeção &gt; 5.000 kWh e &gt; consumo · <b>glitch</b> = pico de compensado &gt; máx(consumo, injeção)×1,5 <i>não</i> explicado por recuperação · <b>recuperação</b> = pico que cobre meses anteriores represados (≤ consumo acumulado×1,5) · <b>sem rateio</b> = compensa &gt; 1 MWh/ano com BV 0% · <b>contingência</b> = mês consumindo sem compensar (inclui o mês antes de uma recuperação).
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
