import { useEffect, useState } from 'react';
import { useAuthStore } from '../store/authStore';
import { supabaseOn } from '../lib/supabase';
import { listCadastro, upsertUc, deleteUc, hidratarCadastro, type CadastroUC } from '../data/db/cadastro';

/** Editor do Cadastro UC → usina (recurso 'cadastro_uc'). Alimenta o roteamento
 *  das faturas no parser. Baseline hardcoded continua; aqui adiciona/edita no banco. */
export default function CadastroUCEditor() {
  const userId = useAuthStore((s) => s.userId);
  const podeEditar = useAuthStore((s) => s.can('cadastro_uc', 'write'));
  const podeApagar = useAuthStore((s) => s.can('cadastro_uc', 'admin'));

  const [aberto, setAberto] = useState(false);
  const [rows, setRows] = useState<CadastroUC[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [nvUc, setNvUc] = useState('');
  const [nvUsina, setNvUsina] = useState('');
  const [nvDisco, setNvDisco] = useState('');
  const [nvW, setNvW] = useState('');
  const [busy, setBusy] = useState(false);

  const recarregar = async () => {
    try { setRows(await listCadastro()); await hidratarCadastro(); setErro(null); }
    catch (e) { setErro((e as Error).message); }
  };
  useEffect(() => { if (userId && aberto) void recarregar(); }, [userId, aberto]);

  if (!supabaseOn || !userId) return null;

  const adicionar = async () => {
    if (!nvUc.trim() || !nvUsina.trim()) return;
    setBusy(true); setErro(null);
    try {
      await upsertUc({ uc: nvUc, usina: nvUsina, distribuidora: nvDisco, w_codes: nvW ? nvW.split(/[,\s]+/) : [] });
      setNvUc(''); setNvUsina(''); setNvDisco(''); setNvW('');
      await recarregar();
    } catch (e) { setErro((e as Error).message); }
    finally { setBusy(false); }
  };
  const remover = async (id: string) => {
    setBusy(true);
    try { await deleteUc(id); await recarregar(); }
    catch (e) { setErro((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="cadastro-uc">
      <button className="cadastro-toggle" onClick={() => setAberto((v) => !v)}>
        {aberto ? '▾' : '▸'} UC → plant registration {rows.length ? `(${rows.length} in the database)` : ''}
      </button>
      {aberto && (
        <div className="cadastro-body">
          <p className="cadastro-hint">Maps the invoice's UC (installation code / registration number) to the plant. Overrides the embedded baseline; used in the upload routing.</p>
          {erro && <p className="valbar-erro">{erro}</p>}
          {podeEditar && (
            <div className="cadastro-form">
              <input placeholder="UC / code" value={nvUc} onChange={(e) => setNvUc(e.target.value)} />
              <input placeholder="Plant" value={nvUsina} onChange={(e) => setNvUsina(e.target.value)} />
              <input placeholder="Utility (opt.)" value={nvDisco} onChange={(e) => setNvDisco(e.target.value)} />
              <input placeholder="W-codes (opt., space-separated)" value={nvW} onChange={(e) => setNvW(e.target.value)} />
              <button className="admin-btn" disabled={busy || !nvUc.trim() || !nvUsina.trim()} onClick={adicionar}>＋ Add</button>
            </div>
          )}
          <div className="tablewrap">
            <table className="comp-t">
              <thead><tr><th>UC</th><th>Plant</th><th>Utility</th><th>W-codes</th><th></th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.uc}</td>
                    <td>{r.usina}</td>
                    <td>{r.distribuidora ?? '—'}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{r.w_codes?.join(', ') || '—'}</td>
                    <td className="r">{podeApagar && <button className="auth-link" onClick={() => void remover(r.id)}>delete</button>}</td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={5} className="muted">No registration in the database yet (using only the embedded baseline).</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
