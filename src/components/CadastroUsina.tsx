import { useMemo, useState } from 'react';
import { useForecastStore, type UsinaNova } from '../store/forecastStore';
import { useAuthStore } from '../store/authStore';
import { supabaseOn } from '../lib/supabase';
import { upsertUsinaCadastro } from '../data/db/usinas';

const PASSOS = ['Identification', 'Generation (P50)', 'Commercial & dates', 'Review'];

/** Wizard multi-passo para criar uma usina nova (fora do Forecast 6+6). */
export default function CadastroUsina({ onClose, onCriada }: { onClose: () => void; onCriada?: (usina: string) => void }) {
  const contratos = useForecastStore((s) => s.contratos);
  const adicionaUsina = useForecastStore((s) => s.adicionaUsina);
  const podeSalvar = useAuthStore((s) => (supabaseOn ? s.can('cadastro_uc', 'write') : true));

  const { clientes, discos } = useMemo(() => {
    const cl = new Set<string>(), di = new Set<string>();
    for (const cc of contratos.values()) { if (cc.contrato.cliente) cl.add(cc.contrato.cliente); if (cc.contrato.disco) di.add(cc.contrato.disco); }
    return { clientes: [...cl].sort(), discos: [...di].sort() };
  }, [contratos]);

  const [passo, setPasso] = useState(0);
  const [f, setF] = useState<UsinaNova>({ usina: '', cliente: '', disco: '', potMWac: 0, desconto: 0, p50Ano: 0, takeOrPay: false });
  const [descPct, setDescPct] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  const set = <K extends keyof UsinaNova>(k: K, v: UsinaNova[K]) => setF((p) => ({ ...p, [k]: v }));

  const validaPasso = (): string | null => {
    if (passo === 0) {
      if (!f.usina.trim()) return 'Enter the plant name';
      if (contratos.has(f.usina.trim())) return 'A plant with this name already exists';
      if (!f.cliente.trim()) return 'Choose the client';
      if (!f.disco.trim()) return 'Choose the utility';
      if (!(f.potMWac > 0)) return 'Enter the capacity (MWac)';
    }
    if (passo === 1 && !(f.p50Ano > 0)) return 'Enter the annual P50 (MWh)';
    return null;
  };

  const avancar = () => { const e = validaPasso(); if (e) { setErro(e); return; } setErro(null); setPasso((p) => Math.min(p + 1, PASSOS.length - 1)); };
  const voltar = () => { setErro(null); setPasso((p) => Math.max(p - 1, 0)); };

  const criar = async () => {
    setSalvando(true); setErro(null);
    const r = adicionaUsina(f);
    if (!r.ok) { setErro(r.erro ?? 'Failed to create'); setSalvando(false); return; }
    if (supabaseOn && podeSalvar) {
      try { await upsertUsinaCadastro(f); } catch (e) { setErro('Created in the session, but not saved to the database: ' + (e as Error).message); }
    }
    setSalvando(false);
    onCriada?.(f.usina.trim());
    onClose();
  };

  return (
    <div className="auth-overlay" onClick={onClose}>
      <div className="cadu-card" onClick={(e) => e.stopPropagation()}>
        <div className="cadu-head">
          <h2>Add Plant</h2>
          <ol className="cadu-steps">
            {PASSOS.map((p, i) => <li key={p} className={i === passo ? 'on' : i < passo ? 'done' : ''}>{i + 1}. {p}</li>)}
          </ol>
        </div>

        <div className="cadu-body">
          {passo === 0 && (
            <div className="cadu-grid">
              <label>Plant name<input value={f.usina} autoFocus onChange={(e) => set('usina', e.target.value)} placeholder="e.g.: Araucária 08" /></label>
              <label>Client (offtaker)
                <input list="cadu-clientes" value={f.cliente} onChange={(e) => set('cliente', e.target.value)} placeholder="e.g.: NEXUS" />
                <datalist id="cadu-clientes">{clientes.map((c) => <option key={c} value={c} />)}</datalist>
              </label>
              <label>Utility
                <input list="cadu-discos" value={f.disco} onChange={(e) => set('disco', e.target.value)} placeholder="e.g.: CPFL Pta" />
                <datalist id="cadu-discos">{discos.map((d) => <option key={d} value={d} />)}</datalist>
              </label>
              <label>Capacity (MWac)<input type="number" step="0.01" value={f.potMWac || ''} onChange={(e) => set('potMWac', +e.target.value || 0)} /></label>
              <label>Capacity (MWp) <span className="opt">optional</span><input type="number" step="0.01" value={f.potMWp ?? ''} onChange={(e) => set('potMWp', e.target.value ? +e.target.value : undefined)} /></label>
            </div>
          )}

          {passo === 1 && (
            <div className="cadu-grid">
              <label>Annual P50 (MWh/year)<input type="number" step="1" value={f.p50Ano || ''} onChange={(e) => set('p50Ano', +e.target.value || 0)} placeholder="e.g.: 8500" /></label>
              <label>Operational profile <span className="opt">1 − losses</span><input type="number" step="0.01" value={f.perfOper ?? 0.85} onChange={(e) => set('perfOper', +e.target.value || 0.85)} /></label>
              <p className="cadu-hint">The annual P50 is distributed by the <b>seasonal profile</b> of a plant on the same utility. Refine it later via the Generation (PVsyst) tab if you have the 12 months.</p>
            </div>
          )}

          {passo === 2 && (
            <div className="cadu-grid">
              <label>Discount (%)<input type="number" step="0.1" value={descPct} onChange={(e) => { setDescPct(e.target.value); set('desconto', (+e.target.value || 0) / 100); }} placeholder="e.g.: 35" /></label>
              <label>COD / energization <span className="opt">date</span><input type="date" value={f.cod ?? ''} onChange={(e) => set('cod', e.target.value)} /></label>
              <label className="cadu-check"><input type="checkbox" checked={!!f.takeOrPay} onChange={(e) => set('takeOrPay', e.target.checked)} /> Take-or-pay (invoice based on injection)</label>
              <p className="cadu-hint">The calculation method (gross-up, base, residual portion) comes from the chosen <b>client</b>. Fine-tune it later in the Methods tab / in the plant's contract.</p>
            </div>
          )}

          {passo === 3 && (
            <div className="cadu-review">
              <Row k="Plant" v={f.usina} />
              <Row k="Client" v={f.cliente} />
              <Row k="Utility" v={f.disco} />
              <Row k="Capacity" v={`${f.potMWac} MWac${f.potMWp ? ` · ${f.potMWp} MWp` : ''}`} />
              <Row k="Annual P50" v={`${f.p50Ano.toLocaleString('pt-BR')} MWh`} />
              <Row k="Discount" v={descPct ? `${descPct}%` : '—'} />
              <Row k="COD" v={f.cod || '—'} />
              <Row k="Take-or-pay" v={f.takeOrPay ? 'Yes' : 'No'} />
              <p className="cadu-hint">
                {supabaseOn
                  ? (podeSalvar ? 'It will be added to the forecast and saved to Supabase (audited).' : 'It will be added only in this session (no permission to save to the database).')
                  : 'It will be added in this session (Supabase not configured).'}
              </p>
            </div>
          )}

          {erro && <p className="cadu-erro">{erro}</p>}
        </div>

        <div className="cadu-foot">
          <button className="auth-btn auth-btn--ghost" onClick={onClose}>Cancel</button>
          <div style={{ flex: 1 }} />
          {passo > 0 && <button className="auth-btn auth-btn--ghost" onClick={voltar}>Back</button>}
          {passo < PASSOS.length - 1
            ? <button className="auth-btn" onClick={avancar}>Next</button>
            : <button className="auth-btn" disabled={salvando} onClick={criar}>{salvando ? 'Creating…' : '✓ Create plant'}</button>}
        </div>
      </div>
    </div>
  );
}

const Row = ({ k, v }: { k: string; v: string }) => (
  <div className="cadu-row"><span>{k}</span><b>{v || '—'}</b></div>
);
