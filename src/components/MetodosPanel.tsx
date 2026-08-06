import { Fragment, useEffect, useMemo, useState } from 'react';
import { REGRAS_CLIENTE, TIPOS_CLIENTE, precificacaoDe, type GrossUp, type LinhaResidual, type ModeloComercial, type RegraCliente } from '../engine/clientes';
import { useForecastStore, faturaPorCompensacao } from '../store/forecastStore';
import type { ClienteTipo } from '../engine/contrato';
import { useAuthStore } from '../store/authStore';
import { supabaseOn } from '../lib/supabase';
import { hidratarMetodos, persistMetodo, persistDesconto } from '../data/db/hidratar';

const GROSSUP_LABEL: Record<GrossUp, string> = {
  nenhum: 'sem gross-up',
  pis: 'gross-up PIS',
  pis_icms: 'gross-up PIS + ICMS',
  pis_icms_semdesc: 'gross-up PIS + ICMS (sem desconto)',
  split: 'split (fórmula própria)',
  plano: 'preço fixo R$/MWh',
  fixo: 'valor fixo (hardcoded)',
};
// opções oferecidas no seletor (split exige função própria → fora do editor)
const GROSSUP_OPTS: GrossUp[] = ['nenhum', 'pis', 'pis_icms', 'pis_icms_semdesc', 'plano', 'fixo'];

const pct = (v: number) => `${(v * 100).toFixed(1).replace(/\.0$/, '')}%`;

/** Regras de cálculo por cliente (offtaker) — EDITÁVEL (Asset/Comercial, sem código).
 *  A coluna Desconto vem dos contratos reais (é por usina, não por cliente). */
export default function MetodosPanel() {
  const contratos = useForecastStore((s) => s.contratos);
  const editaRegra = useForecastStore((s) => s.editaRegraCliente);
  const editaContrato = useForecastStore((s) => s.editaContrato);
  void useForecastStore((s) => s.regrasVersion); // subscreve → re-render ao editar qualquer regra
  const [aberto, setAberto] = useState<ClienteTipo | null>(null);

  // login só é exigido para editar quando o Supabase está ligado; senão, edição de sessão (legado)
  const userId = useAuthStore((s) => s.userId);
  const podeEditar = useAuthStore((s) => (supabaseOn ? s.can('regras', 'write') : true));

  // ao logar (ou no boot), puxa métodos/descontos do banco por cima do baseline
  useEffect(() => { if (userId) void hidratarMetodos(); }, [userId]);

  // edições: aplicam no motor (recalcula na hora) e persistem no Supabase quando autorizado
  const setRegra = (tipo: ClienteTipo, patch: Partial<RegraCliente>) => {
    editaRegra(tipo, patch);
    if (podeEditar) void persistMetodo(tipo, patch);
  };
  const setDesc = (usina: string, frac: number) => {
    editaContrato(usina, { desconto: frac });
    if (podeEditar) void persistDesconto(usina, frac);
  };

  // por tipo de cliente: faixa de desconto (min–max) + lista de usinas (desconto por usina)
  const desconto = useMemo(() => {
    const acc = new Map<ClienteTipo, { n: number; min: number; max: number; usinas: { usina: string; desconto: number }[] }>();
    for (const { contrato } of contratos.values()) {
      const t = contrato.clienteTipo;
      const cur = acc.get(t) ?? { n: 0, min: Infinity, max: -Infinity, usinas: [] };
      cur.n += 1;
      cur.min = Math.min(cur.min, contrato.desconto);
      cur.max = Math.max(cur.max, contrato.desconto);
      cur.usinas.push({ usina: contrato.usina, desconto: contrato.desconto });
      acc.set(t, cur);
    }
    for (const v of acc.values()) v.usinas.sort((a, b) => b.desconto - a.desconto);
    return acc;
  }, [contratos]);

  return (
    <section className="metodos">
      <div className="metodos-head">
        <h3>Métodos de cálculo por cliente <span className="metodos-edit-tag">{podeEditar ? 'editável' : '🔒 leitura'}</span></h3>
        {supabaseOn && !podeEditar && (
          <p className="metodos-lock">🔒 Entre (botão no topo) para editar métodos e descontos. Sem login, é só leitura.</p>
        )}
        <p>
          Receita = <b>Base de Cálculo × Energia Final − Demanda</b>, repartida em 4 parcelas fiscais.
          Por cliente muda (1) o gross-up fiscal da base, (2) qual parcela absorve o resíduo e
          (3) o <b>modelo comercial</b>. <b>Edite direto na tabela</b> — vale para todas as usinas do cliente e recalcula na hora.
        </p>
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          <b>Faturamento compensada</b> (fatura sobre a compensação): todos os <b>AR</b> (TELMO, LOGIX, HIDRUS, TELCO) — medidos pela MeterHub —
          + <b>NEXUS</b> e <b>OPERON</b>. &nbsp;·&nbsp; <b>Take-or-Pay</b> (fatura sobre a injeção, com piso da rampa): demais GC.
          &nbsp;·&nbsp; <b>OPERON</b> opera a GC (Buriti) e a SolarCo paga <b>fee R$/MWh</b> à OPERON (custo). &nbsp;·&nbsp; <b>PPA/fixo</b>
          (preço R$/MWh, independe da tarifa): PETRAX e BANCOR.
        </p>
      </div>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Cliente</th>
              <th>Modelo</th>
              <th title="Compensada = fatura sobre a compensação (AR + NEXUS + OPERON). Take-or-Pay = fatura sobre a injeção (demais GC).">Faturamento</th>
              <th title="Desconto = % sobre TE+TUSD. PPA = preço fixo R$/MWh (independe da tarifa).">Precificação</th>
              <th>Gross-up da base</th>
              <th>Fórmula da Base de Cálculo</th>
              <th>Parcela residual</th>
              <th title="Fee de operação de GC que a SolarCo PAGA ao operador (só OPERON), R$/MWh compensado. Custo, não desconto.">Fee op. <small>(R$/MWh)</small></th>
              <th>Desconto <small>(clique p/ usinas)</small></th>
              <th>Observação</th>
            </tr>
          </thead>
          <tbody>
            {TIPOS_CLIENTE.map((tipo) => {
              const r = REGRAS_CLIENTE[tipo];
              const padrao = tipo === 'PADRAO';
              const d = desconto.get(tipo);
              const faixa = !d
                ? '—'
                : d.min === d.max
                  ? `${pct(d.min)} · ${d.n} usina${d.n > 1 ? 's' : ''}`
                  : `${pct(d.min)}–${pct(d.max)} · ${d.n} usinas`;
              const amplo = d && d.max - d.min > 0.25;
              const comp = faturaPorCompensacao(tipo);
              const ppa = precificacaoDe(r) === 'ppa';
              const open = aberto === tipo;
              return (
                <Fragment key={tipo}>
                <tr className={padrao ? 'metodos-padrao' : ''}>
                  <td className="strong">{padrao ? 'PADRÃO (demais)' : tipo}</td>
                  <td>
                    <select className="metodo-sel" value={r.modelo} disabled={!podeEditar} onChange={(e) => setRegra(tipo, { modelo: e.target.value as ModeloComercial })}>
                      <option value="AR">Autoconsumo Remoto</option>
                      <option value="GC">Geração Compart.</option>
                    </select>
                  </td>
                  <td><span className={`metodo-chip ${comp ? 'c-comp' : 'c-top'}`}>{comp ? 'Compensada' : 'Take-or-Pay'}</span></td>
                  <td><span className={`metodo-chip ${ppa ? 'c-ppa' : 'c-desc'}`}>{ppa ? 'PPA / fixo' : 'Desconto %'}</span></td>
                  <td>
                    <select className="metodo-sel" value={r.grossUp} disabled={!podeEditar} onChange={(e) => setRegra(tipo, { grossUp: e.target.value as GrossUp })}>
                      {GROSSUP_OPTS.map((g) => <option key={g} value={g}>{GROSSUP_LABEL[g]}</option>)}
                      {r.grossUp === 'split' && <option value="split">{GROSSUP_LABEL.split}</option>}
                    </select>
                  </td>
                  <td className="mono">{r.descricaoBase}</td>
                  <td>
                    <select className="metodo-sel" value={r.residual} disabled={!podeEditar} onChange={(e) => setRegra(tipo, { residual: e.target.value as LinhaResidual })}>
                      <option value="guardaChuva">Guarda-Chuva</option>
                      <option value="om">O&M</option>
                    </select>
                  </td>
                  <td className="r">
                    <input className="metodo-fee" type="number" step={5} value={r.feeOperacaoMWh ?? 0} disabled={!podeEditar}
                      onChange={(e) => setRegra(tipo, { feeOperacaoMWh: +e.target.value || 0 })} />
                  </td>
                  <td className={amplo ? 'warn-amplo clickable' : 'muted clickable'}
                    title={d ? 'Clique para ver o desconto por usina' : ''}
                    onClick={() => d && setAberto(open ? null : tipo)}>
                    {d ? (open ? '▾ ' : '▸ ') : ''}{faixa}{amplo ? ' ⚠' : ''}
                  </td>
                  <td>
                    <input className="metodo-nota" value={r.nota ?? ''} placeholder="—" disabled={!podeEditar} onChange={(e) => setRegra(tipo, { nota: e.target.value })} />
                  </td>
                </tr>
                {open && d && (
                  <tr className="metodos-usinas-row">
                    <td colSpan={10}>
                      <div className="metodos-usinas">
                        <span className="mu-h">{tipo === 'PADRAO' ? 'PADRÃO' : tipo} · desconto por usina ({d.n}):</span>
                        {d.usinas.map((u) => (
                          <label key={u.usina} className="mu-item" title="Editar o desconto desta usina">
                            <span className="mu-usina">{u.usina}</span>
                            <input type="number" step={0.5} value={+(u.desconto * 100).toFixed(2)} disabled={!podeEditar}
                              onChange={(e) => setDesc(u.usina, (+e.target.value || 0) / 100)} />%
                          </label>
                        ))}
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
        Metodologia por offtaker (vale para todas as usinas do cliente). Editar aqui muda a regra do
        cliente inteiro e recalcula o forecast na hora. Overrides pontuais ficam no contrato da usina.
        <br />{supabaseOn
          ? <><b>Persistência:</b> logado, as edições de método e desconto são salvas no Supabase (com dono, data e histórico de alterações). Viewer sem login continua no baseline.</>
          : <><b>Protótipo:</b> as edições valem nesta sessão (Supabase não configurado neste ambiente).</>}
      </footer>
    </section>
  );
}
