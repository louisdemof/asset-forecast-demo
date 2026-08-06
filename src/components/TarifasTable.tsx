import { useMemo, useState } from 'react';
import { useForecastStore } from '../store/forecastStore';
import { reajusteDoDisco, tarifasAneelMWh, ANEEL_GERADO_EM } from '../data/aneel';

/** Botão que dispara o pull da ANEEL (via serverless → GitHub Action → deploy). */
function AtualizarANEEL() {
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const go = async () => {
    setLoading(true); setMsg('');
    try {
      const r = await fetch('/api/refresh-aneel', { method: 'POST' });
      const d = await r.json();
      setMsg(r.ok ? `✓ ${d.message}` : `⚠ ${d.error}${d.hint ? ' — ' + d.hint : ''}`);
    } catch {
      setMsg('⚠ Network failure calling the function.');
    }
    setLoading(false);
  };
  return (
    <div className="aneel-refresh">
      <button className="btn-export" disabled={loading} onClick={go}>{loading ? 'Triggering…' : '🔄 Update ANEEL tariffs now'}</button>
      {msg && <span className={`aneel-refresh-msg ${msg.startsWith('✓') ? 'ok' : 'warn'}`}>{msg}</span>}
      <span className="aneel-refresh-hint">Updates automatically every Monday; this button forces it now.</span>
    </div>
  );
}

interface LinhaDisco {
  disco: string;
  nUsinas: number;
  mwac: number;
  excelTusd: number;
  excelTe: number;
  tusdG: number;
  tusdC: number;
  demandaDisco: boolean; // usa TUSD C (COPEL/CEEE/ESS/ETO) em vez de TUSD G
  aneelTusd?: number;
  aneelTe?: number;
  proximo?: string;
  proximoISO?: string;
  resolucao?: string;
}

export default function TarifasTable() {
  const contratos = useForecastStore((s) => s.contratos);
  const usinas = useForecastStore((s) => s.usinas);

  const linhas = useMemo<LinhaDisco[]>(() => {
    const map = new Map<string, LinhaDisco>();
    for (const u of usinas) {
      const tarifa = contratos.get(u.projeto)?.contrato.tarifa;
      let l = map.get(u.disco);
      if (!l) {
        const aneel = tarifasAneelMWh(u.disco);
        const rj = reajusteDoDisco(u.disco);
        l = {
          disco: u.disco, nUsinas: 0, mwac: 0,
          excelTusd: tarifa?.tusd ?? 0, excelTe: tarifa?.te ?? 0,
          tusdG: tarifa?.tusdG ?? 0, tusdC: tarifa?.tusdC ?? 0,
          demandaDisco: ['COPEL', 'CEEE', 'ESS', 'ETO'].includes(u.disco.toUpperCase()),
          aneelTusd: aneel?.tusd, aneelTe: aneel?.te,
          proximo: rj?.proximo, proximoISO: rj?.proximoISO, resolucao: rj?.resolucao,
        };
        map.set(u.disco, l);
      }
      l.nUsinas += 1;
      l.mwac += u.potMWac;
      if (!l.excelTusd && tarifa) { l.excelTusd = tarifa.tusd; l.excelTe = tarifa.te; }
    }
    return [...map.values()].sort((a, b) => (a.proximoISO ?? '9').localeCompare(b.proximoISO ?? '9'));
  }, [usinas, contratos]);

  const status = (l: LinhaDisco): { txt: string; cls: string } => {
    if (l.aneelTusd === undefined) return { txt: 'no ANEEL match', cls: '' };
    const dif = Math.abs(l.aneelTusd - l.excelTusd) > 1 || Math.abs((l.aneelTe ?? 0) - l.excelTe) > 1;
    return dif ? { txt: 'ANEEL differs — check', cls: 'warn' } : { txt: 'up to date', cls: 'ok' };
  };

  const proximos = linhas.filter((l) => l.proximoISO && l.proximoISO >= '2026-07' && l.proximoISO <= '2026-12').length;

  return (
    <>
      <section className="kpis">
        <Kpi label="Utilities in the portfolio" value={String(linhas.length)} sub={`${usinas.length} plants`} />
        <Kpi label="Adjustments through Dec/2026" value={String(proximos)} sub="to track" accent />
        <Kpi label="Source" value="ANEEL" sub={`open data · ${ANEEL_GERADO_EM}`} />
        <Kpi label="Tariffs checked" value={`${linhas.filter((l) => status(l).cls === 'ok').length}/${linhas.length}`} sub="Excel = ANEEL today" />
      </section>

      <AtualizarANEEL />

      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Utility</th>
              <th className="r">Plants</th>
              <th className="r">MWac</th>
              <th className="r">TUSD/TE (Excel)</th>
              <th className="r">TUSD demand</th>
              <th className="r">TUSD/TE (ANEEL)</th>
              <th>Next adjustment</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((l) => {
              const st = status(l);
              return (
                <tr key={l.disco}>
                  <td className="strong">{l.disco}</td>
                  <td className="r muted">{l.nUsinas}</td>
                  <td className="r muted">{l.mwac.toFixed(1)}</td>
                  <td className="r">{l.excelTusd.toFixed(0)} / {l.excelTe.toFixed(0)}</td>
                  <td className="r" title={l.demandaDisco ? 'uses TUSD C (COPEL/CEEE/ESS/ETO)' : 'uses TUSD G'}>
                    <b>{(l.demandaDisco ? l.tusdC : l.tusdG).toFixed(1)}</b> <small className="muted">{l.demandaDisco ? 'TUSD C' : 'TUSD G'}</small>
                  </td>
                  <td className="r muted">{l.aneelTusd !== undefined ? `${l.aneelTusd.toFixed(0)} / ${l.aneelTe!.toFixed(0)}` : '—'}</td>
                  <td title={l.resolucao}>{l.proximo ?? '—'}</td>
                  <td>{st.cls ? <span className={`badge ${st.cls}`}>{st.txt}</span> : <span className="badge">{st.txt}</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <footer className="foot">
        Next adjustment = end of the current tariff's effective period at ANEEL (taken directly from the Resolução Homologatória).
        Sorted by the nearest adjustment. "ANEEL differs" flags utilities that adjusted recently —
        worth checking/syncing in the contract.
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
