import { Fragment, useEffect, useMemo, useState } from 'react';
import { REGRAS_CLIENTE, TIPOS_CLIENTE, precificacaoDe, type GrossUp, type LinhaResidual, type ModeloComercial, type RegraCliente } from '../engine/clientes';
import { useForecastStore, faturaPorCompensacao } from '../store/forecastStore';
import type { ClienteTipo } from '../engine/contrato';
import { useAuthStore } from '../store/authStore';
import { supabaseOn } from '../lib/supabase';
import { hidratarMetodos, persistMetodo, persistDesconto } from '../data/db/hidratar';

const GROSSUP_LABEL: Record<GrossUp, string> = {
  nenhum: 'no gross-up',
  pis: 'PIS gross-up',
  pis_icms: 'PIS + ICMS gross-up',
  pis_icms_semdesc: 'PIS + ICMS gross-up (no discount)',
  split: 'split (own formula)',
  plano: 'fixed price R$/MWh',
  fixo: 'fixed value (hardcoded)',
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
        <h3>Calculation methods by client <span className="metodos-edit-tag">{podeEditar ? 'editable' : '🔒 read-only'}</span></h3>
        {supabaseOn && !podeEditar && (
          <p className="metodos-lock">🔒 Sign in (button at top) to edit methods and discounts. Without login, it is read-only.</p>
        )}
        <p>
          Revenue = <b>Calculation Base × Final Energy − Demand</b>, split into 4 tax parcels.
          Per client, this changes (1) the tax gross-up of the base, (2) which parcel absorbs the residual and
          (3) the <b>commercial model</b>. <b>Edit directly in the table</b> — it applies to all of the client's plants and recalculates instantly.
        </p>
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          <b>Compensation billing</b> (bills on the compensation): all <b>AR</b> (TELMO, LOGIX, HIDRUS, TELCO) — measured by MeterHub —
          + <b>NEXUS</b> and <b>OPERON</b>. &nbsp;·&nbsp; <b>Take-or-Pay</b> (bills on the injection, with ramp floor): other GC.
          &nbsp;·&nbsp; <b>OPERON</b> operates the shared generation (Buriti) and SolarCo pays a <b>fee R$/MWh</b> to OPERON (cost). &nbsp;·&nbsp; <b>PPA/fixed</b>
          (price R$/MWh, independent of the tariff): PETRAX and BANCOR.
        </p>
      </div>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Client</th>
              <th>Model</th>
              <th title="Compensation = bills on the compensation (AR + NEXUS + OPERON). Take-or-Pay = bills on the injection (other GC).">Billing</th>
              <th title="Discount = % on TE+TUSD. PPA = fixed price R$/MWh (independent of the tariff).">Pricing</th>
              <th>Base gross-up</th>
              <th>Calculation Base formula</th>
              <th>Residual parcel</th>
              <th title="Shared-generation operation fee that SolarCo PAYS to the operator (OPERON only), R$/MWh compensated. Cost, not discount.">Op. fee <small>(R$/MWh)</small></th>
              <th>Discount <small>(click for plants)</small></th>
              <th>Note</th>
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
                  ? `${pct(d.min)} · ${d.n} plant${d.n > 1 ? 's' : ''}`
                  : `${pct(d.min)}–${pct(d.max)} · ${d.n} plants`;
              const amplo = d && d.max - d.min > 0.25;
              const comp = faturaPorCompensacao(tipo);
              const ppa = precificacaoDe(r) === 'ppa';
              const open = aberto === tipo;
              return (
                <Fragment key={tipo}>
                <tr className={padrao ? 'metodos-padrao' : ''}>
                  <td className="strong">{padrao ? 'DEFAULT (others)' : tipo}</td>
                  <td>
                    <select className="metodo-sel" value={r.modelo} disabled={!podeEditar} onChange={(e) => setRegra(tipo, { modelo: e.target.value as ModeloComercial })}>
                      <option value="AR">Remote Self-Consumption</option>
                      <option value="GC">Shared Generation</option>
                    </select>
                  </td>
                  <td><span className={`metodo-chip ${comp ? 'c-comp' : 'c-top'}`}>{comp ? 'Compensation' : 'Take-or-Pay'}</span></td>
                  <td><span className={`metodo-chip ${ppa ? 'c-ppa' : 'c-desc'}`}>{ppa ? 'PPA / fixed' : 'Discount %'}</span></td>
                  <td>
                    <select className="metodo-sel" value={r.grossUp} disabled={!podeEditar} onChange={(e) => setRegra(tipo, { grossUp: e.target.value as GrossUp })}>
                      {GROSSUP_OPTS.map((g) => <option key={g} value={g}>{GROSSUP_LABEL[g]}</option>)}
                      {r.grossUp === 'split' && <option value="split">{GROSSUP_LABEL.split}</option>}
                    </select>
                  </td>
                  <td className="mono">{r.descricaoBase}</td>
                  <td>
                    <select className="metodo-sel" value={r.residual} disabled={!podeEditar} onChange={(e) => setRegra(tipo, { residual: e.target.value as LinhaResidual })}>
                      <option value="guardaChuva">Umbrella</option>
                      <option value="om">O&M</option>
                    </select>
                  </td>
                  <td className="r">
                    <input className="metodo-fee" type="number" step={5} value={r.feeOperacaoMWh ?? 0} disabled={!podeEditar}
                      onChange={(e) => setRegra(tipo, { feeOperacaoMWh: +e.target.value || 0 })} />
                  </td>
                  <td className={amplo ? 'warn-amplo clickable' : 'muted clickable'}
                    title={d ? 'Click to see the discount per plant' : ''}
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
                        <span className="mu-h">{tipo === 'PADRAO' ? 'DEFAULT' : tipo} · discount per plant ({d.n}):</span>
                        {d.usinas.map((u) => (
                          <label key={u.usina} className="mu-item" title="Edit this plant's discount">
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
        Methodology per offtaker (applies to all of the client's plants). Editing here changes the rule for the
        entire client and recalculates the forecast instantly. One-off overrides stay in the plant's contract.
        <br />{supabaseOn
          ? <><b>Persistence:</b> when logged in, method and discount edits are saved to Supabase (with owner, date and change history). A viewer without login stays on the baseline.</>
          : <><b>Prototype:</b> edits apply for this session (Supabase not configured in this environment).</>}
      </footer>
    </section>
  );
}
