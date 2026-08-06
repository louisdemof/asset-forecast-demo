import { useEffect, useMemo, useState } from 'react';
import { useAuthStore } from '../store/authStore';
import { useForecastStore } from '../store/forecastStore';
import { supabaseOn } from '../lib/supabase';
import { listValidacoes, validarMes, reverterValidacao, type Validacao } from '../data/db/validacoes';

/** Barra de validação mensal do forecast (aba Receita).
 *  Alguém do Asset (permissão 'validacoes:validate') assina o mês; grava
 *  snapshot das métricas + quem/quando em validacoes_mensais (auditado). */
export default function ValidacaoBar() {
  const userId = useAuthStore((s) => s.userId);
  const podeValidar = useAuthStore((s) => s.can('validacoes', 'validate'));
  const usinas = useForecastStore((s) => s.usinas);

  const hoje = new Date();
  const [mesUI, setMesUI] = useState(`${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`);
  const [vals, setVals] = useState<Validacao[]>([]);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const mesISO = `${mesUI}-01`;

  const recarregar = async () => {
    try { setVals(await listValidacoes()); setErro(null); }
    catch (e) { setErro((e as Error).message); }
  };
  useEffect(() => { if (userId) void recarregar(); }, [userId]);

  const snapshot = useMemo(() => ({
    receitaAnualEngine: Math.round(usinas.reduce((s, u) => s + u.receitaEngine, 0)),
    nUsinas: usinas.length,
    geradoEm: undefined as string | undefined,
  }), [usinas]);

  if (!supabaseOn || !userId) return null; // só p/ usuários logados

  const atual = vals.find((v) => v.mes.slice(0, 7) === mesUI && v.escopo === 'portfolio');
  const validado = atual?.status === 'validado';

  const validar = async () => {
    setBusy(true); setErro(null);
    try { await validarMes(mesISO, snapshot); await recarregar(); }
    catch (e) { setErro((e as Error).message); }
    finally { setBusy(false); }
  };
  const reverter = async () => {
    setBusy(true); setErro(null);
    try { await reverterValidacao(mesISO); await recarregar(); }
    catch (e) { setErro((e as Error).message); }
    finally { setBusy(false); }
  };

  const fmtData = (s: string | null) => (s ? new Date(s).toLocaleDateString('pt-BR') : '');

  return (
    <div className={`valbar ${validado ? 'valbar--ok' : 'valbar--pend'}`}>
      <label className="valbar-mes">
        Validação do forecast
        <input type="month" value={mesUI} onChange={(e) => setMesUI(e.target.value)} />
      </label>
      <span className="valbar-status">
        {validado
          ? <>✓ <b>Validado</b>{atual?.metricas && typeof atual.metricas.receitaAnualEngine === 'number' && <> · R$ {(atual.metricas.receitaAnualEngine as number).toLocaleString('pt-BR')}/ano</>} · {fmtData(atual?.validated_at ?? null)}</>
          : <>⏳ <b>Pendente</b> — R$ {snapshot.receitaAnualEngine.toLocaleString('pt-BR')}/ano · {snapshot.nUsinas} usinas no snapshot</>}
      </span>
      {podeValidar && (
        validado
          ? <button className="valbar-btn ghost" disabled={busy} onClick={reverter}>Reabrir</button>
          : <button className="valbar-btn" disabled={busy} onClick={validar}>{busy ? '…' : '✓ Validar mês'}</button>
      )}
      {!podeValidar && <span className="valbar-hint">(sem permissão para validar)</span>}
      {erro && <span className="valbar-erro">{erro}</span>}
    </div>
  );
}
