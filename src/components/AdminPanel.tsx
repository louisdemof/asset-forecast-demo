import { useEffect, useState } from 'react';
import { useAuthStore } from '../store/authStore';
import { listUsers, listRoles, listDepartments, updateUser, listAudit, provisionUser, gerarSenhaTemp, type UserRow, type Role, type Dept } from '../data/db/admin';
import type { AuditRow } from '../lib/db.types';

/** Painel de administração — usuários, papéis, departamentos e histórico.
 *  Visível só para quem tem 'users:read'; edição exige 'users:admin'. */
export default function AdminPanel() {
  const canRead = useAuthStore((s) => s.can('users', 'read'));
  const canAdmin = useAuthStore((s) => s.can('users', 'admin'));
  const meuId = useAuthStore((s) => s.userId);

  const [users, setUsers] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [deps, setDeps] = useState<Dept[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);

  const recarregar = async () => {
    try {
      const [u, r, d, a] = await Promise.all([listUsers(), listRoles(), listDepartments(), listAudit(40)]);
      setUsers(u); setRoles(r); setDeps(d); setAudit(a); setErro(null);
    } catch (e) { setErro((e as Error).message); }
    finally { setCarregando(false); }
  };
  useEffect(() => { void recarregar(); }, []);

  const salvar = async (id: string, patch: Parameters<typeof updateUser>[1]) => {
    try { await updateUser(id, patch); await recarregar(); }
    catch (e) { setErro((e as Error).message); }
  };

  // --- novo usuário ---
  const [novoAberto, setNovoAberto] = useState(false);
  const [nvNome, setNvNome] = useState('');
  const [nvEmail, setNvEmail] = useState('');
  const [nvRole, setNvRole] = useState('');
  const [nvDep, setNvDep] = useState('');
  const [nvAtivar, setNvAtivar] = useState(true);
  const [nvSenha, setNvSenha] = useState('');
  const [criando, setCriando] = useState(false);
  const [criado, setCriado] = useState<{ email: string; senha: string } | null>(null);

  const abrirNovo = () => {
    setNvNome(''); setNvEmail(''); setNvRole(''); setNvDep(''); setNvAtivar(true);
    setNvSenha(gerarSenhaTemp()); setCriado(null); setErro(null); setNovoAberto(true);
  };
  const criarUsuario = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nvNome.trim() || !nvEmail.trim()) return;
    setCriando(true); setErro(null);
    try {
      await provisionUser({ email: nvEmail, nome: nvNome, senha: nvSenha,
        role_id: nvRole || null, department_id: nvDep || null, ativar: nvAtivar });
      setCriado({ email: nvEmail.trim().toLowerCase(), senha: nvSenha });
      setNovoAberto(false);
      await recarregar();
    } catch (err) { setErro((err as Error).message); }
    finally { setCriando(false); }
  };

  if (!canRead) {
    return <section className="metodos"><p className="metodos-lock">🔒 Acesso restrito. Entre com uma conta de administrador.</p></section>;
  }

  const inativos = users.filter((u) => !u.is_active).length;

  return (
    <section className="metodos admin">
      <div className="metodos-head">
        <h3>Administração <span className="metodos-edit-tag">{canAdmin ? 'admin' : '🔒 leitura'}</span></h3>
        <p>
          Usuários, papéis e departamentos (estilo Salesforce). Novo cadastro entra como <b>viewer inativo</b> —
          um admin ativa e atribui papel. {inativos > 0 && <b>{inativos} aguardando ativação.</b>}
        </p>
      </div>
      {erro && <p className="metodos-lock" style={{ color: '#c0392b', background: '#fdecea', borderColor: '#f5c6cb' }}>Erro: {erro}</p>}

      {canAdmin && (
        <div className="admin-novo">
          {!novoAberto && !criado && <button className="admin-btn" onClick={abrirNovo}>＋ Novo usuário</button>}
          {criado && (
            <div className="admin-criado">
              <b>✓ Usuário criado: {criado.email}</b>
              <p>Envie a senha temporária ao usuário. Ele precisa <b>confirmar o e-mail</b> (link enviado pela Supabase) e trocar a senha no 1º acesso.</p>
              <div className="admin-cred">
                <span>Senha temporária:</span> <code>{criado.senha}</code>
                <button className="auth-link" onClick={() => void navigator.clipboard.writeText(criado.senha)}>copiar</button>
              </div>
              <button className="admin-btn" onClick={abrirNovo} style={{ marginTop: 8 }}>＋ Criar outro</button>
            </div>
          )}
          {novoAberto && (
            <form className="admin-form" onSubmit={criarUsuario}>
              <div className="admin-form-grid">
                <label>Nome<input value={nvNome} autoFocus onChange={(e) => setNvNome(e.target.value)} required /></label>
                <label>E-mail<input type="email" value={nvEmail} onChange={(e) => setNvEmail(e.target.value)} required /></label>
                <label>Papel
                  <select value={nvRole} onChange={(e) => setNvRole(e.target.value)}>
                    <option value="">— viewer (padrão) —</option>
                    {roles.map((r) => <option key={r.id} value={r.id}>{r.nome}</option>)}
                  </select>
                </label>
                <label>Departamento
                  <select value={nvDep} onChange={(e) => setNvDep(e.target.value)}>
                    <option value="">—</option>
                    {deps.map((d) => <option key={d.id} value={d.id}>{d.nome}</option>)}
                  </select>
                </label>
                <label>Senha temporária
                  <span className="admin-senha"><code>{nvSenha}</code><button type="button" className="auth-link" onClick={() => setNvSenha(gerarSenhaTemp())}>gerar</button></span>
                </label>
                <label className="admin-check"><input type="checkbox" checked={nvAtivar} onChange={(e) => setNvAtivar(e.target.checked)} /> ativar já</label>
              </div>
              <div className="auth-actions">
                <button type="button" className="auth-btn auth-btn--ghost" onClick={() => setNovoAberto(false)}>Cancelar</button>
                <button type="submit" className="auth-btn" disabled={criando || !nvNome.trim() || !nvEmail.trim()}>{criando ? 'Criando…' : 'Criar usuário'}</button>
              </div>
            </form>
          )}
        </div>
      )}

      {carregando ? <div className="state">Carregando…</div> : (
        <>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Nome</th><th>E-mail</th><th>Departamento</th><th>Papel</th><th>Cargo</th><th>Ativo</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const eu = u.id === meuId;
                  return (
                    <tr key={u.id} className={!u.is_active ? 'metodos-padrao' : ''}>
                      <td className="strong">{u.nome}{eu && <span className="admin-eu"> (você)</span>}</td>
                      <td className="mono" style={{ fontSize: 12 }}>{u.email}</td>
                      <td>
                        <select className="metodo-sel" value={u.department_id ?? ''} disabled={!canAdmin}
                          onChange={(e) => salvar(u.id, { department_id: e.target.value || null })}>
                          <option value="">—</option>
                          {deps.map((d) => <option key={d.id} value={d.id}>{d.nome}</option>)}
                        </select>
                      </td>
                      <td>
                        <select className="metodo-sel" value={u.role_id ?? ''} disabled={!canAdmin || eu}
                          title={eu ? 'Não pode mudar o próprio papel' : ''}
                          onChange={(e) => salvar(u.id, { role_id: e.target.value || null })}>
                          <option value="">— sem papel —</option>
                          {roles.map((r) => <option key={r.id} value={r.id}>{r.nome}</option>)}
                        </select>
                      </td>
                      <td>
                        <input className="metodo-nota" defaultValue={u.cargo ?? ''} placeholder="—" disabled={!canAdmin}
                          onBlur={(e) => e.target.value !== (u.cargo ?? '') && salvar(u.id, { cargo: e.target.value || null })} />
                      </td>
                      <td className="r">
                        <button className={`admin-toggle ${u.is_active ? 'on' : 'off'}`} disabled={!canAdmin || eu}
                          title={eu ? 'Não pode desativar a si mesmo' : (u.is_active ? 'Desativar' : 'Ativar')}
                          onClick={() => salvar(u.id, { is_active: !u.is_active })}>
                          {u.is_active ? '● ativo' : '○ inativo'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {!users.length && <tr><td colSpan={6} className="muted">Nenhum usuário.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="metodos-head" style={{ marginTop: 22 }}>
            <h3 style={{ fontSize: 16 }}>Histórico de alterações <small style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(últimas {audit.length})</small></h3>
          </div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>Quando</th><th>Quem</th><th>Ação</th><th>Tabela</th><th>Campos alterados</th></tr>
              </thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.id}>
                    <td className="mono" style={{ fontSize: 12 }}>{new Date(a.occurred_at).toLocaleString('pt-BR')}</td>
                    <td style={{ fontSize: 12 }}>{a.actor_email ?? '—'}</td>
                    <td><span className={`metodo-chip ${a.action === 'DELETE' ? 'c-top' : a.action === 'INSERT' ? 'c-comp' : 'c-desc'}`}>{a.action}</span></td>
                    <td className="mono" style={{ fontSize: 12 }}>{a.table_name}</td>
                    <td style={{ fontSize: 12 }} className="muted">{a.changed_fields?.join(', ') ?? '—'}</td>
                  </tr>
                ))}
                {!audit.length && <tr><td colSpan={5} className="muted">Sem histórico ainda.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
