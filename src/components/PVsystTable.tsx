import { Fragment, useMemo, useRef, useState } from 'react';
import { useForecastStore } from '../store/forecastStore';
import { parsePVsystCSV } from '../data/loadPVsyst';

const mwh = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
const MES_ABREV = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const MES_NOME = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

export default function PVsystTable() {
  const pvsyst = useForecastStore((s) => s.pvsyst);
  const importaPVsyst = useForecastStore((s) => s.importaPVsyst);
  const [busca, setBusca] = useState('');
  const [aberta, setAberta] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const rows = parsePVsystCSV(await f.text());
      if (!rows.length) { setMsg('CSV sem linhas reconhecidas (verifique o cabeçalho).'); return; }
      const r = importaPVsyst(rows);
      const dl = r.deltaReceita;
      const dlTxt = Math.abs(dl) < 1 ? 'sem efeito na receita' : `receita forecast ${dl >= 0 ? '+' : ''}${dl.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 })}`;
      setMsg(`Nova versão importada: ${r.total} usinas · ${r.atualizadas} com geração alterada. "Dif vs anterior" recalculado · ${dlTxt}.`);
    } catch (err) {
      setMsg('Erro ao ler o CSV: ' + (err as Error).message);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const filtradas = useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return pvsyst;
    return pvsyst.filter((p) => p.projeto.toLowerCase().includes(q) || p.disco.toLowerCase().includes(q) || p.cliente.toLowerCase().includes(q));
  }, [pvsyst, busca]);

  const totais = useMemo(() => {
    const mwp = filtradas.reduce((s, p) => s + p.potenciaMWp, 0);
    const total = filtradas.reduce((s, p) => s + p.total, 0);
    const prod = filtradas.length ? filtradas.reduce((s, p) => s + p.producaoEspecifica, 0) / filtradas.length : 0;
    return { mwp, total, prod };
  }, [filtradas]);

  const kpi = useMemo(() => {
    const totalGer = pvsyst.reduce((s, p) => s + p.total, 0);
    const totalMWp = pvsyst.reduce((s, p) => s + p.potenciaMWp, 0);
    const prodMedia = pvsyst.length ? pvsyst.reduce((s, p) => s + p.producaoEspecifica, 0) / pvsyst.length : 0;
    return { totalGer, totalMWp, prodMedia, n: pvsyst.length };
  }, [pvsyst]);

  return (
    <>
      <section className="kpis">
        <Kpi label="Usinas (PVsyst)" value={String(kpi.n)} sub={`${kpi.totalMWp.toFixed(0)} MWp instalados`} />
        <Kpi label="Geração total / ano" value={`${mwh(kpi.totalGer)} MWh`} sub="soma P50 do portfólio" accent />
        <Kpi label="Produção específica média" value={`${mwh(kpi.prodMedia)}`} sub="MWh/MWp/ano" />
        <Kpi label="Fonte" value="PVsyst" sub="simulação de irradiação" />
      </section>

      <div className="toolbar">
        <input className="search" placeholder="Buscar usina, distribuidora ou cliente…" value={busca} onChange={(e) => setBusca(e.target.value)} />
        <span className="count">{filtradas.length} usinas</span>
        <input ref={fileRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={onFile} />
        <button className="btn-export" onClick={() => fileRef.current?.click()}>⤒ Importar PVsyst (CSV)</button>
      </div>
      {msg && <div className="import-msg">{msg}</div>}

      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Usina</th>
              <th>Distribuidora</th>
              <th className="r">MWp</th>
              <th className="pv-spark-col">Curva mensal (MWh)</th>
              <th className="r">Total / ano</th>
              <th className="r">Prod. Específica</th>
              <th className="r">Dif vs anterior</th>
            </tr>
          </thead>
          <tbody>
            {filtradas.map((p) => {
              const max = Math.max(...p.meses, 1);
              const open = aberta === p.projeto;
              return (
                <Fragment key={p.projeto}>
                  <tr className={`clickable ${open ? 'open' : ''}`} onClick={() => setAberta(open ? null : p.projeto)}>
                    <td className="strong">{open ? '▾ ' : '▸ '}{p.projeto}</td>
                    <td>{p.disco}</td>
                    <td className="r">{p.potenciaMWp.toFixed(2)}</td>
                    <td>
                      <div className="pv-spark">
                        {p.meses.map((v, i) => (
                          <span key={i} className="pv-bar" style={{ height: `${Math.max(6, (v / max) * 100)}%` }} title={`${MES_ABREV[i]}: ${mwh(v)} MWh`} />
                        ))}
                      </div>
                    </td>
                    <td className="r strong">{mwh(p.total)}</td>
                    <td className="r muted">{mwh(p.producaoEspecifica)}</td>
                    <td className={`r ${Math.abs(p.difVsAnterior) < 0.005 ? 'muted' : 'diff'}`}>
                      {p.difVsAnterior ? `${p.difVsAnterior > 0 ? '+' : ''}${(p.difVsAnterior * 100).toFixed(1)}%` : '—'}
                    </td>
                  </tr>
                  {open && (
                    <tr className="panel-row">
                      <td colSpan={7}>
                        <div className="pv-detail">
                          <div className="pv-detail-head">Geração mensal PVsyst — {p.projeto} <small>(MWh · P50)</small></div>
                          <div className="pv-months">
                            {p.meses.map((v, i) => (
                              <div className="pv-month" key={i}>
                                <div className="pv-month-bar-wrap">
                                  <div className="pv-month-bar" style={{ height: `${Math.max(4, (v / max) * 100)}%` }} />
                                </div>
                                <span className="pv-month-val">{mwh(v)}</span>
                                <span className="pv-month-lbl">{MES_NOME[i]}</span>
                              </div>
                            ))}
                          </div>
                          <div className="pv-detail-foot">
                            Total <b>{mwh(p.total)} MWh</b> · versão anterior (5+7) <b>{mwh(p.total * (1 + p.difVsAnterior))} MWh</b> · Dif <b>{p.difVsAnterior ? `${p.difVsAnterior > 0 ? '+' : ''}${(p.difVsAnterior * 100).toFixed(1)}%` : '—'}</b>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="totais">
              <td>Total · {filtradas.length} usinas</td>
              <td></td>
              <td className="r">{totais.mwp.toFixed(1)}</td>
              <td></td>
              <td className="r">{mwh(totais.total)}</td>
              <td className="r">{mwh(totais.prod)} <small>(méd.)</small></td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <footer className="foot">
        Geração <b>P50</b> por usina (simulação PVsyst). É o insumo bruto da cadeia de energia — antes dos
        haircuts de Perf. Operacional e Compensação. A coluna <b>Dif vs anterior</b> compara com a versão
        Forecast 5+7. Prod. Específica (MWh/MWp/ano) é o indicador de qualidade do ativo.
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
