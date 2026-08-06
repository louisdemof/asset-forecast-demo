import { useMemo, useState } from 'react';
import { useForecastStore, type UsinaNova } from '../store/forecastStore';
import { useAuthStore } from '../store/authStore';
import { supabaseOn } from '../lib/supabase';
import { upsertUsinaCadastro } from '../data/db/usinas';

const PASSOS = ['Identificação', 'Geração (P50)', 'Comercial & datas', 'Revisão'];

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
      if (!f.usina.trim()) return 'Informe o nome da usina';
      if (contratos.has(f.usina.trim())) return 'Já existe uma usina com esse nome';
      if (!f.cliente.trim()) return 'Escolha o cliente';
      if (!f.disco.trim()) return 'Escolha a distribuidora';
      if (!(f.potMWac > 0)) return 'Informe a potência (MWac)';
    }
    if (passo === 1 && !(f.p50Ano > 0)) return 'Informe o P50 anual (MWh)';
    return null;
  };

  const avancar = () => { const e = validaPasso(); if (e) { setErro(e); return; } setErro(null); setPasso((p) => Math.min(p + 1, PASSOS.length - 1)); };
  const voltar = () => { setErro(null); setPasso((p) => Math.max(p - 1, 0)); };

  const criar = async () => {
    setSalvando(true); setErro(null);
    const r = adicionaUsina(f);
    if (!r.ok) { setErro(r.erro ?? 'Falha ao criar'); setSalvando(false); return; }
    if (supabaseOn && podeSalvar) {
      try { await upsertUsinaCadastro(f); } catch (e) { setErro('Criada na sessão, mas não salva no banco: ' + (e as Error).message); }
    }
    setSalvando(false);
    onCriada?.(f.usina.trim());
    onClose();
  };

  return (
    <div className="auth-overlay" onClick={onClose}>
      <div className="cadu-card" onClick={(e) => e.stopPropagation()}>
        <div className="cadu-head">
          <h2>Cadastro de usina</h2>
          <ol className="cadu-steps">
            {PASSOS.map((p, i) => <li key={p} className={i === passo ? 'on' : i < passo ? 'done' : ''}>{i + 1}. {p}</li>)}
          </ol>
        </div>

        <div className="cadu-body">
          {passo === 0 && (
            <div className="cadu-grid">
              <label>Nome da usina<input value={f.usina} autoFocus onChange={(e) => set('usina', e.target.value)} placeholder="ex.: Araucária 08" /></label>
              <label>Cliente (offtaker)
                <input list="cadu-clientes" value={f.cliente} onChange={(e) => set('cliente', e.target.value)} placeholder="ex.: NEXUS" />
                <datalist id="cadu-clientes">{clientes.map((c) => <option key={c} value={c} />)}</datalist>
              </label>
              <label>Distribuidora
                <input list="cadu-discos" value={f.disco} onChange={(e) => set('disco', e.target.value)} placeholder="ex.: CPFL Pta" />
                <datalist id="cadu-discos">{discos.map((d) => <option key={d} value={d} />)}</datalist>
              </label>
              <label>Potência (MWac)<input type="number" step="0.01" value={f.potMWac || ''} onChange={(e) => set('potMWac', +e.target.value || 0)} /></label>
              <label>Potência (MWp) <span className="opt">opcional</span><input type="number" step="0.01" value={f.potMWp ?? ''} onChange={(e) => set('potMWp', e.target.value ? +e.target.value : undefined)} /></label>
            </div>
          )}

          {passo === 1 && (
            <div className="cadu-grid">
              <label>P50 anual (MWh/ano)<input type="number" step="1" value={f.p50Ano || ''} onChange={(e) => set('p50Ano', +e.target.value || 0)} placeholder="ex.: 8500" /></label>
              <label>Perf. operacional <span className="opt">1 − perdas</span><input type="number" step="0.01" value={f.perfOper ?? 0.85} onChange={(e) => set('perfOper', +e.target.value || 0.85)} /></label>
              <p className="cadu-hint">O P50 anual é distribuído pelo <b>perfil sazonal</b> de uma usina da mesma distribuidora. Refine depois pela aba Geração (PVsyst) se tiver os 12 meses.</p>
            </div>
          )}

          {passo === 2 && (
            <div className="cadu-grid">
              <label>Desconto (%)<input type="number" step="0.1" value={descPct} onChange={(e) => { setDescPct(e.target.value); set('desconto', (+e.target.value || 0) / 100); }} placeholder="ex.: 35" /></label>
              <label>COD / energização <span className="opt">data</span><input type="date" value={f.cod ?? ''} onChange={(e) => set('cod', e.target.value)} /></label>
              <label className="cadu-check"><input type="checkbox" checked={!!f.takeOrPay} onChange={(e) => set('takeOrPay', e.target.checked)} /> Take-or-pay (fatura sobre injeção)</label>
              <p className="cadu-hint">O método de cálculo (gross-up, base, parcela residual) vem do <b>cliente</b> escolhido. Ajuste fino depois na aba Métodos / no contrato da usina.</p>
            </div>
          )}

          {passo === 3 && (
            <div className="cadu-review">
              <Row k="Usina" v={f.usina} />
              <Row k="Cliente" v={f.cliente} />
              <Row k="Distribuidora" v={f.disco} />
              <Row k="Potência" v={`${f.potMWac} MWac${f.potMWp ? ` · ${f.potMWp} MWp` : ''}`} />
              <Row k="P50 anual" v={`${f.p50Ano.toLocaleString('pt-BR')} MWh`} />
              <Row k="Desconto" v={descPct ? `${descPct}%` : '—'} />
              <Row k="COD" v={f.cod || '—'} />
              <Row k="Take-or-pay" v={f.takeOrPay ? 'Sim' : 'Não'} />
              <p className="cadu-hint">
                {supabaseOn
                  ? (podeSalvar ? 'Será adicionada ao forecast e salva no Supabase (auditada).' : 'Será adicionada só nesta sessão (sem permissão p/ salvar no banco).')
                  : 'Será adicionada nesta sessão (Supabase não configurado).'}
              </p>
            </div>
          )}

          {erro && <p className="cadu-erro">{erro}</p>}
        </div>

        <div className="cadu-foot">
          <button className="auth-btn auth-btn--ghost" onClick={onClose}>Cancelar</button>
          <div style={{ flex: 1 }} />
          {passo > 0 && <button className="auth-btn auth-btn--ghost" onClick={voltar}>Voltar</button>}
          {passo < PASSOS.length - 1
            ? <button className="auth-btn" onClick={avancar}>Próximo</button>
            : <button className="auth-btn" disabled={salvando} onClick={criar}>{salvando ? 'Criando…' : '✓ Criar usina'}</button>}
        </div>
      </div>
    </div>
  );
}

const Row = ({ k, v }: { k: string; v: string }) => (
  <div className="cadu-row"><span>{k}</span><b>{v || '—'}</b></div>
);
