import { useEffect, useState } from 'react';
import App from './App';
import { loadDemo, isUnlocked } from './secure';

/**
 * DEMO boot. No access code — the shipped data is synthetic. We fetch it into
 * memory, then render the app. (Production gates this behind an encrypted bundle.)
 */
export default function Gate() {
  const [pronto, setPronto] = useState(isUnlocked());
  const [erro, setErro] = useState(false);

  useEffect(() => {
    if (pronto) return;
    loadDemo().then(() => setPronto(true)).catch(() => setErro(true));
  }, [pronto]);

  if (pronto) return <App />;

  return (
    <div className="gate">
      <div className="gate-card">
        <img className="gate-logo" src={`${import.meta.env.BASE_URL}assetperf_logo_navy.svg`} alt="AssetPerf" />
        <h1 className="gate-title">Asset Forecast</h1>
        <p className="gate-sub">Solar revenue forecasting &amp; reconciliation platform</p>
        <span className="gate-demo-tag">DEMO · synthetic data</span>
        {erro ? (
          <p className="gate-erro">Falha ao carregar os dados. Recarregue a página.</p>
        ) : (
          <p className="gate-foot">Carregando dados…</p>
        )}
      </div>
    </div>
  );
}
