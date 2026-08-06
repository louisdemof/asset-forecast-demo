import { Fragment, useMemo, useRef, useState } from 'react';
import { useForecastStore } from '../store/forecastStore';
import { parsePVsystCSV } from '../data/loadPVsyst';

const mwh = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
const MES_ABREV = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const MES_NOME = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

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
      if (!rows.length) { setMsg('CSV with no recognized rows (check the header).'); return; }
      const r = importaPVsyst(rows);
      const dl = r.deltaReceita;
      const dlTxt = Math.abs(dl) < 1 ? 'no effect on revenue' : `forecast revenue ${dl >= 0 ? '+' : ''}${dl.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 })}`;
      setMsg(`New version imported: ${r.total} plants · ${r.atualizadas} with changed generation. "Dif vs previous" recalculated · ${dlTxt}.`);
    } catch (err) {
      setMsg('Error reading the CSV: ' + (err as Error).message);
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
        <Kpi label="Plants (PVsyst)" value={String(kpi.n)} sub={`${kpi.totalMWp.toFixed(0)} MWp installed`} />
        <Kpi label="Total generation / year" value={`${mwh(kpi.totalGer)} MWh`} sub="portfolio P50 sum" accent />
        <Kpi label="Average specific yield" value={`${mwh(kpi.prodMedia)}`} sub="MWh/MWp/year" />
        <Kpi label="Source" value="PVsyst" sub="irradiation simulation" />
      </section>

      <div className="toolbar">
        <input className="search" placeholder="Search plant, utility or client…" value={busca} onChange={(e) => setBusca(e.target.value)} />
        <span className="count">{filtradas.length} plants</span>
        <input ref={fileRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={onFile} />
        <button className="btn-export" onClick={() => fileRef.current?.click()}>⤒ Import PVsyst (CSV)</button>
      </div>
      {msg && <div className="import-msg">{msg}</div>}

      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Plant</th>
              <th>Utility</th>
              <th className="r">MWp</th>
              <th className="pv-spark-col">Monthly curve (MWh)</th>
              <th className="r">Total / year</th>
              <th className="r">Specific Yield</th>
              <th className="r">Dif vs previous</th>
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
                          <div className="pv-detail-head">PVsyst monthly generation — {p.projeto} <small>(MWh · P50)</small></div>
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
                            Total <b>{mwh(p.total)} MWh</b> · previous version (5+7) <b>{mwh(p.total * (1 + p.difVsAnterior))} MWh</b> · Dif <b>{p.difVsAnterior ? `${p.difVsAnterior > 0 ? '+' : ''}${(p.difVsAnterior * 100).toFixed(1)}%` : '—'}</b>
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
              <td>Total · {filtradas.length} plants</td>
              <td></td>
              <td className="r">{totais.mwp.toFixed(1)}</td>
              <td></td>
              <td className="r">{mwh(totais.total)}</td>
              <td className="r">{mwh(totais.prod)} <small>(avg.)</small></td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <footer className="foot">
        <b>P50</b> generation per plant (PVsyst simulation). It is the raw input of the energy chain — before the
        Operational Performance and Compensation haircuts. The <b>Dif vs previous</b> column compares with the
        Forecast 5+7 version. Specific Yield (MWh/MWp/year) is the asset's quality indicator.
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
