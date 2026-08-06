import { useState } from 'react';

/** Glossário de fórmulas do tool — botão "?" abre um modal explicando tudo. */
const GRUPOS: { titulo: string; itens: { termo: string; formula: string; nota?: string }[] }[] = [
  {
    titulo: 'Receita',
    itens: [
      { termo: 'Energia Final (MWh)', formula: 'P50 × Perf. Operacional × Perf. Compensação', nota: 'só é faturada nos meses em COD' },
      { termo: 'Perf. Operacional', formula: '1 − Σ(9 perdas)', nota: 'inversores, módulos, sujidade, clima…' },
      { termo: 'Perf. Compensação', formula: 'fração da energia que vira compensação', nota: 'medida (Faturas/API) ou premissa (Billing)' },
      { termo: 'Base de Cálculo (R$/MWh)', formula: '(1−desc) × (TUSD+TE) [× gross-up fiscal]', nota: 'gross-up por cliente — ver aba Métodos' },
      { termo: 'Demanda UFV (R$)', formula: '((T/(1−PIS)/(1−ICMS))×30 + (T/(1−PIS))×(kW−30)) × 1,05', nota: 'custo de demanda da usina (30 kW mín. + excedente)' },
      { termo: 'Receita', formula: 'Base de Cálculo × Energia Final − Demanda', nota: 'repartida em 4 parcelas fiscais' },
      { termo: 'R$/MWh', formula: 'Receita ÷ Energia Final' },
      { termo: 'vs Budget', formula: 'Receita ÷ Budget − 1' },
      { termo: 'Match Excel', formula: 'Receita (motor) ÷ Receita Forecast oficial', nota: '100% = reproduz o Excel exato' },
    ],
  },
  {
    titulo: 'Compensação',
    itens: [
      { termo: 'Aproveitamento', formula: 'Compensado ÷ Consumo', nota: 'sempre ≤ 100%' },
      { termo: 'perfComp (mês)', formula: 'Compensado ÷ Injetado (no mês)', nota: 'oscila; pode passar de 100% (saca do banco)' },
      { termo: 'perfComp móvel', formula: 'Σ Compensado ÷ Σ Injetado (janela 12 meses)', nota: 'métrica confiável — converge' },
      { termo: 'Saldo de créditos', formula: 'banco de créditos acumulado', nota: 'validade de 60 meses' },
    ],
  },
  {
    titulo: 'Otimização de Rateio',
    itens: [
      { termo: 'Rateio', formula: '% da injeção da usina alocada a cada UC', nota: 'declarado à distribuidora (coluna BV)' },
      { termo: 'Alocação (alloc)', formula: 'Rateio × Σ Injeção da usina' },
      { termo: 'Score de Rateio', formula: 'Σ min(alloc, consumo) ÷ min(Σinj, Σconsumo) × 100', nota: '100% = injeção perfeitamente alocada (nada desperdiçado)' },
      { termo: 'Excesso → banco', formula: 'Σ max(0, alloc − consumo)', nota: 'energia alocada a mais → vira crédito no banco (risco de expirar)' },
      { termo: 'Déficit (sub-servido)', formula: 'Σ max(0, consumo − alloc)', nota: 'consumo não coberto pela alocação atual' },
      { termo: 'Rateio sugerido', formula: 'Consumo da UC ÷ Σ Consumo', nota: 'proporcional ao consumo (ideal)' },
    ],
  },
  {
    titulo: 'Modelos comerciais',
    itens: [
      { termo: 'Autoconsumo Remoto (AR)', formula: 'TELMO, LOGIX, HIDRUS, TELCO', nota: 'muitas UCs próprias; compensação MEDIDA (Faturas/API)' },
      { termo: 'Geração Compartilhada (GC)', formula: 'demais clientes', nota: 'compensação por contrato (NEXUS informa) — não nas Faturas' },
    ],
  },
];

export default function FormulasHelp() {
  const [aberto, setAberto] = useState(false);
  return (
    <>
      <button className="formulas-btn" onClick={() => setAberto(true)} title="Glossário de fórmulas">? Fórmulas</button>
      {aberto && (
        <div className="formulas-overlay" onClick={() => setAberto(false)}>
          <div className="formulas-modal" onClick={(e) => e.stopPropagation()}>
            <div className="formulas-head">
              <h3>Fórmulas do modelo</h3>
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
