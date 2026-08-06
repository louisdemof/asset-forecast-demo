import { useState } from 'react';

/** Glossário de fórmulas do tool — botão "?" abre um modal explicando tudo. */
const GRUPOS: { titulo: string; itens: { termo: string; formula: string; nota?: string }[] }[] = [
  {
    titulo: 'Revenue',
    itens: [
      { termo: 'Final Energy (MWh)', formula: 'P50 × Operational Perf. × Compensation Perf.', nota: 'only billed in COD months' },
      { termo: 'Operational Perf.', formula: '1 − Σ(9 losses)', nota: 'inverters, modules, soiling, weather…' },
      { termo: 'Compensation Perf.', formula: 'fraction of energy that becomes compensation', nota: 'measured (Invoices/API) or assumption (Billing)' },
      { termo: 'Calculation Base (R$/MWh)', formula: '(1−disc) × (TUSD+TE) [× tax gross-up]', nota: 'gross-up per client — see Methods tab' },
      { termo: 'PV Plant Demand (R$)', formula: '((T/(1−PIS)/(1−ICMS))×30 + (T/(1−PIS))×(kW−30)) × 1.05', nota: "plant's demand cost (30 kW min. + excess)" },
      { termo: 'Revenue', formula: 'Calculation Base × Final Energy − Demand', nota: 'split into 4 tax parcels' },
      { termo: 'R$/MWh', formula: 'Revenue ÷ Final Energy' },
      { termo: 'vs Budget', formula: 'Revenue ÷ Budget − 1' },
      { termo: 'Excel Match', formula: 'Revenue (engine) ÷ official Forecast Revenue', nota: '100% = reproduces the Excel exactly' },
    ],
  },
  {
    titulo: 'Compensation',
    itens: [
      { termo: 'Utilization', formula: 'Compensated ÷ Consumption', nota: 'always ≤ 100%' },
      { termo: 'perfComp (month)', formula: 'Compensated ÷ Injected (in the month)', nota: 'fluctuates; can exceed 100% (draws from the bank)' },
      { termo: 'perfComp rolling', formula: 'Σ Compensated ÷ Σ Injected (12-month window)', nota: 'reliable metric — converges' },
      { termo: 'Credit balance', formula: 'accumulated credit bank', nota: '60-month validity' },
    ],
  },
  {
    titulo: 'Allocation Optimization',
    itens: [
      { termo: 'Allocation split', formula: "% of the plant's injection allocated to each UC", nota: 'declared to the utility (column BV)' },
      { termo: 'Allocation (alloc)', formula: "Allocation split × Σ plant Injection" },
      { termo: 'Allocation Score', formula: 'Σ min(alloc, consumption) ÷ min(Σinj, Σconsumption) × 100', nota: '100% = injection perfectly allocated (nothing wasted)' },
      { termo: 'Excess → bank', formula: 'Σ max(0, alloc − consumption)', nota: 'over-allocated energy → becomes a credit in the bank (risk of expiring)' },
      { termo: 'Deficit (under-served)', formula: 'Σ max(0, consumption − alloc)', nota: 'consumption not covered by the current allocation' },
      { termo: 'Suggested allocation split', formula: 'UC Consumption ÷ Σ Consumption', nota: 'proportional to consumption (ideal)' },
    ],
  },
  {
    titulo: 'Commercial models',
    itens: [
      { termo: 'Remote Self-Consumption (AR)', formula: 'TELMO, LOGIX, HIDRUS, TELCO', nota: 'many own UCs; compensation MEASURED (Invoices/API)' },
      { termo: 'Shared Generation (GC)', formula: 'other clients', nota: 'compensation by contract (NEXUS reports it) — not in the Invoices' },
    ],
  },
];

export default function FormulasHelp() {
  const [aberto, setAberto] = useState(false);
  return (
    <>
      <button className="formulas-btn" onClick={() => setAberto(true)} title="Formula glossary">? Formulas</button>
      {aberto && (
        <div className="formulas-overlay" onClick={() => setAberto(false)}>
          <div className="formulas-modal" onClick={(e) => e.stopPropagation()}>
            <div className="formulas-head">
              <h3>Model formulas</h3>
              <button className="formulas-x" onClick={() => setAberto(false)}>×</button>
            </div>
            <div className="formulas-body">
              {GRUPOS.map((g) => (
                <section key={g.titulo} className="formulas-grupo">
                  <h4>{g.titulo}</h4>
                  {g.itens.map((it) => (
                    <div key={it.termo} className="formula-item">
                      <div className="formula-termo">{it.termo}</div>
                      <div className="formula-eq">{it.formula}</div>
                      {it.nota && <div className="formula-nota">{it.nota}</div>}
                    </div>
                  ))}
                </section>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
