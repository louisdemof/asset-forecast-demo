import { useMemo } from 'react';
import { useForecastStore } from '../store/forecastStore';
import { rodaContrato } from '../engine/contrato';
import { fimContrato } from '../engine/comercial';
import { reajusteDoDisco, aneelDoDisco } from '../data/aneel';

const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const isoHoje = (): string => new Date().toISOString().slice(0, 10);
const isoMais = (dias: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
};
/** data ISO daqui a N meses. */
const isoMaisMeses = (meses: number): string => {
  const d = new Date();
  d.setMonth(d.getMonth() + meses);
  return d.toISOString().slice(0, 10);
};

export interface Alerta {
  chave: string;
  titulo: string;
  detalhe: string;
  valor?: string;
}
interface Grupo {
  id: string;
  titulo: string;
  sev: 'alta' | 'media' | 'info';
  itens: Alerta[];
}

export default function AlertasPanel() {
  const usinas = useForecastStore((s) => s.usinas);
  const contratos = useForecastStore((s) => s.contratos);

  const grupos = useMemo<Grupo[]>(() => {
    const hoje = isoHoje();
    const em120 = isoMais(120);
    const em180 = isoMais(180);

    // 1 · receita negativa
    const negativas = usinas
      .filter((u) => u.receitaEngine < 0)
      .sort((a, b) => a.receitaEngine - b.receitaEngine)
      .map((u) => ({ chave: u.projeto, titulo: u.projeto, detalhe: `${u.disco} · ${u.cliente || 'no client'}`, valor: brl(u.receitaEngine) }));

    // 2 · abaixo do budget (top gaps)
    const abaixo = usinas
      .filter((u) => u.budget > 0 && u.receitaEngine < u.budget)
      .map((u) => ({ u, gap: u.receitaEngine - u.budget }))
      .sort((a, b) => a.gap - b.gap)
      .slice(0, 12)
      .map(({ u, gap }) => ({ chave: u.projeto, titulo: u.projeto, detalhe: `${u.disco} · forecast ${brl(u.receitaEngine)} vs budget ${brl(u.budget)}`, valor: brl(gap) }));

    // 3 · fora do Forecast oficial
    const fora = usinas
      .filter((u) => u.semForecast)
      .map((u) => ({ chave: u.projeto, titulo: u.projeto, detalhe: `${u.disco} — in Contracts but not in the Forecast tab`, valor: 'no forecast' }));

    // 4 · reajustes ANEEL a caminho (por DISCO, próximos 120 dias)
    const vistos = new Set<string>();
    const reaj: Alerta[] = [];
    for (const u of usinas) {
      if (vistos.has(u.disco)) continue;
      vistos.add(u.disco);
      const rj = reajusteDoDisco(u.disco);
      if (rj && rj.proximoISO >= hoje && rj.proximoISO <= em120) {
        const n = usinas.filter((x) => x.disco === u.disco).length;
        reaj.push({ chave: u.disco, titulo: u.disco, detalhe: `${n} plant(s) · ${rj.resolucao.replace('RESOLUÇÃO HOMOLOGATÓRIA', 'Res.').slice(0, 24)}`, valor: rj.proximo });
      }
    }
    reaj.sort((a, b) => (a.valor ?? '').localeCompare(b.valor ?? ''));

    // 5 · Billing manual diverge da rampa negociada
    const diverge: Alerta[] = [];
    for (const u of usinas) {
      const cc = contratos.get(u.projeto);
      if (!cc) continue;
      const { contrato, entradas } = cc;
      if (!(contrato.rampa && contrato.rampa.length && contrato.comercial?.inicioCompensacao)) continue;
      const manual = rodaContrato(contrato, entradas).receitaTotal;
      const auto = rodaContrato({ ...contrato, rampaAuto: true }, entradas).receitaTotal;
      const dif = auto - manual;
      if (Math.abs(dif) > Math.max(80000, Math.abs(manual) * 0.05)) {
        diverge.push({ chave: u.projeto, titulo: u.projeto, detalhe: `${u.disco} · ${contrato.comercial?.novoOfftaker ?? ''} — auto ramp vs manual Billing`, valor: `${dif >= 0 ? '+' : ''}${brl(dif)}` });
      }
    }
    diverge.sort((a, b) => Math.abs(parseFloat((b.valor ?? '0').replace(/[^\d-]/g, ''))) - Math.abs(parseFloat((a.valor ?? '0').replace(/[^\d-]/g, ''))));

    // 6 · troca de titularidade / início de compensação a caminho (180 dias)
    const eventos: Alerta[] = [];
    for (const u of usinas) {
      const com = contratos.get(u.projeto)?.contrato.comercial;
      if (!com) continue;
      const trocas: string[] = [];
      if (com.trocaTitularidade && com.trocaTitularidade >= hoje && com.trocaTitularidade <= em180) trocas.push(`ownership change ${com.trocaTitularidade}`);
      if (com.inicioCompensacao && com.inicioCompensacao >= hoje && com.inicioCompensacao <= em180) trocas.push(`compensation start ${com.inicioCompensacao}`);
      if (trocas.length) eventos.push({ chave: u.projeto, titulo: u.projeto, detalhe: `${u.disco} · ${com.novoOfftaker ?? ''}`, valor: trocas.join(' · ') });
    }

    // 6b · tarifa do contrato (Excel) diverge da ANEEL vigente (por distribuidora)
    const vistosTar = new Set<string>();
    const driftTar: Alerta[] = [];
    for (const u of usinas) {
      if (vistosTar.has(u.disco)) continue;
      vistosTar.add(u.disco);
      const tar = contratos.get(u.projeto)?.contrato.tarifa;
      const an = aneelDoDisco(u.disco);
      if (!tar || !an) continue;
      const contr = tar.tusd + tar.te;
      const aneel = an.tusd + an.te;
      if (aneel <= 0 || contr <= 0) continue;
      const dif = contr / aneel - 1;
      if (Math.abs(dif) > 0.03) {
        const n = usinas.filter((x) => x.disco === u.disco).length;
        driftTar.push({ chave: u.disco, titulo: u.disco, detalhe: `${n} plant(s) · contract ${contr.toFixed(0)} vs ANEEL ${aneel.toFixed(0)} R$/MWh (TUSD+TE)`, valor: `${dif >= 0 ? '+' : ''}${(dif * 100).toFixed(1)}%` });
      }
    }
    driftTar.sort((a, b) => Math.abs(parseFloat((b.valor ?? '0'))) - Math.abs(parseFloat((a.valor ?? '0'))));

    // 7 · contratos vencendo em < 24 meses + usinas sem data de fim (a preencher)
    const em24m = isoMaisMeses(24);
    const vencendo: Alerta[] = [];
    let semData = 0;
    for (const u of usinas) {
      const com = contratos.get(u.projeto)?.contrato.comercial;
      const f = fimContrato(com ?? { prazoContrato: '', signingDate: '', inicioCompensacao: '' });
      if (!f.fim) { semData += 1; continue; }
      if (f.fim >= hoje && f.fim <= em24m) {
        const dias = Math.round((new Date(f.fim).getTime() - new Date(hoje).getTime()) / 86400000);
        vencendo.push({ chave: u.projeto, titulo: u.projeto, detalhe: `${u.disco} · ${u.cliente || 'no client'} · ${f.detalhe}`, valor: `${f.fim.slice(0, 7)} (${Math.round(dias / 30)} months)` });
      }
    }
    vencendo.sort((a, b) => (a.valor ?? '').localeCompare(b.valor ?? ''));
    const semDataAlerta: Alerta[] = semData > 0
      ? [{ chave: 'semdata', titulo: `${semData} plants without a contract end date`, detalhe: 'not in the Commercial tab or with an undefined term — fill in from the contract PDFs / CRM', valor: 'to fill in' }]
      : [];

    // 8 · perfOper/perfComp inválido no Forecast.
    //    IMPOSSÍVEL (crítico): perfOper < 0 (injeção negativa) ou = 0 operando (mês COD).
    //    perfOper > 1 é PLAUSÍVEL — P50 é mediana, e mês de clima favorável supera o P50.
    //    Só sinaliza acima de 1.5 (bater o P50 em +50% num mês é implausível → rever).
    const perfRuim = (e: { perfOper?: number; perfComp?: number; status?: 'COD' | 'CONST' }) =>
      (e.perfOper != null && (e.perfOper < 0 || (e.perfOper === 0 && e.status === 'COD') || e.perfOper > 1.5)) ||
      (e.perfComp != null && (e.perfComp < -0.001 || e.perfComp > 1.5));
    const perfBad: Alerta[] = [];
    for (const [projeto, cc] of contratos) {
      const bad = cc.entradas.filter(perfRuim);
      if (!bad.length) continue;
      const critico = bad.some((e) => e.perfOper != null && (e.perfOper < 0 || (e.perfOper === 0 && e.status === 'COD')));
      perfBad.push({
        chave: projeto, titulo: `${critico ? '🛑 ' : ''}${projeto}`,
        detalhe: `${cc.contrato.disco} · ${critico ? 'perfOper ≤ 0 BREAKS the calculation (negative/zero injection while operating)' : 'implausible value (>1.5)'} in ${bad.map((e) => e.mes.slice(0, 7)).join(', ')} — fix in the Forecast`,
        valor: bad.map((e) => (e.perfOper != null && (e.perfOper <= 0 || e.perfOper > 1.5) ? `perfOper ${e.perfOper.toFixed(4)}` : `perfComp ${e.perfComp!.toFixed(4)}`)).join(' · '),
      });
    }
    perfBad.sort((a, b) => Number(b.titulo.startsWith('🛑')) - Number(a.titulo.startsWith('🛑'))); // críticos primeiro

    return [
      { id: 'perfoper', titulo: 'perfOper / perfComp invalid in the Forecast (data to fix)', sev: 'alta', itens: perfBad },
      { id: 'neg', titulo: 'Negative revenue in the forecast', sev: 'alta', itens: negativas },
      { id: 'fora', titulo: 'Plants outside the official Forecast', sev: 'alta', itens: fora },
      { id: 'vence', titulo: 'Contracts expiring in < 24 months', sev: 'media', itens: vencendo },
      { id: 'diverge', titulo: 'Manual Billing diverges from the deal ramp', sev: 'media', itens: diverge },
      { id: 'budget', titulo: 'Largest gaps vs Budget', sev: 'media', itens: abaixo },
      { id: 'drift', titulo: 'Contract tariff diverges from the current ANEEL', sev: 'media', itens: driftTar },
      { id: 'reaj', titulo: 'ANEEL adjustments in the next 120 days', sev: 'info', itens: reaj },
      { id: 'ev', titulo: 'Ownership change / compensation start (180 days)', sev: 'info', itens: eventos },
      { id: 'semdata', titulo: 'Contract end-date coverage', sev: 'info', itens: semDataAlerta },
    ].filter((g) => g.itens.length > 0) as Grupo[];
  }, [usinas, contratos]);

  const totalAlertas = grupos.reduce((s, g) => s + g.itens.length, 0);

  return (
    <>
      <section className="kpis">
        <Kpi label="Total alerts" value={String(totalAlertas)} sub="items needing attention" accent />
        <Kpi label="High severity" value={String(grupos.filter((g) => g.sev === 'alta').reduce((s, g) => s + g.itens.length, 0))} sub="negative revenue · outside forecast" />
        <Kpi label="Medium" value={String(grupos.filter((g) => g.sev === 'media').reduce((s, g) => s + g.itens.length, 0))} sub="budget · ramp vs Billing" />
        <Kpi label="Informational" value={String(grupos.filter((g) => g.sev === 'info').reduce((s, g) => s + g.itens.length, 0))} sub="adjustments · dates" />
      </section>

      {totalAlertas === 0 && <div className="state">No alerts — everything within expectations. 🎉</div>}

      <div className="alertas-grid">
        {grupos.map((g) => (
          <div className={`alerta-card sev-${g.sev}`} key={g.id}>
            <div className="alerta-head">
              <span className="alerta-dot" />
              <h4>{g.titulo}</h4>
              <span className="alerta-count">{g.itens.length}</span>
            </div>
            <ul className="alerta-list">
              {g.itens.slice(0, 10).map((a) => (
                <li key={a.chave}>
                  <div>
                    <b>{a.titulo}</b>
                    <small>{a.detalhe}</small>
                  </div>
                  {a.valor && <span className="alerta-val">{a.valor}</span>}
                </li>
              ))}
              {g.itens.length > 10 && <li className="alerta-mais">+{g.itens.length - 10} more…</li>}
            </ul>
          </div>
        ))}
      </div>
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
