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
    return <section className="metodos"><p className="metodos-lock">🔒 Restricted access. Sign in with an administrator account.</p></section>;
  }

  const inativos = users.filter((u) => !u.is_active).length;

  return (
    <section className="metodos admin">
      <div className="metodos-head">
        <h3>Administration <span className="metodos-edit-tag">{canAdmin ? 'admin' : '🔒 read-only'}</span></h3>
        <p>
          Users, roles and departments (Salesforce style). A new registration enters as an <b>inactive viewer</b> —
          an admin activates and assigns a role. {inativos > 0 && <b>{inativos} awaiting activation.</b>}
        </p>
      </div>
      {erro && <p className="metodos-lock" style={{ color: '#c0392b', background: '#fdecea', borderColor: '#f5c6cb' }}>Error: {erro}</p>}

      {canAdmin && (
        <div className="admin-novo">
          {!novoAberto && !criado && <button className="admin-btn" onClick={abrirNovo}>＋ New user</button>}
          {criado && (
            <div className="admin-criado">
              <b>✓ User created: {criado.email}</b>
              <p>Send the temporary password to the user. They need to <b>confirm the email</b> (link sent by Supabase) and change the password on first access.</p>
              <div className="admin-cred">
                <span>Temporary password:</span> <code>{criado.senha}</code>
                <button className="auth-link" onClick={() => void navigator.clipboard.writeText(criado.senha)}>copy</button>
              </div>
              <button className="admin-btn" onClick={abrirNovo} style={{ marginTop: 8 }}>＋ Create another</button>
            </div>
          )}
          {novoAberto && (
            <form className="admin-form" onSubmit={criarUsuario}>
              <div className="admin-form-grid">
                <label>Name<input value={nvNome} autoFocus onChange={(e) => setNvNome(e.target.value)} required /></label>
                <label>Email<input type="email" value={nvEmail} onChange={(e) => setNvEmail(e.target.value)} required /></label>
                <label>Role
                  <select value={nvRole} onChange={(e) => setNvRole(e.target.value)}>
                    <option value="">— viewer (default) —</option>
                    {roles.map((r) => <option key={r.id} value={r.id}>{r.nome}</option>)}
                  </select>
                </label>
                <label>Department
                  <select value={nvDep} onChange={(e) => setNvDep(e.target.value)}>
                    <option value="">—</option>
                    {deps.map((d) => <option key={d.id} value={d.id}>{d.nome}</option>)}
                  </select>
                </label>
                <label>Temporary password
                  <span className="admin-senha"><code>{nvSenha}</code><button type="button" className="auth-link" onClick={() => setNvSenha(gerarSenhaTemp())}>generate</button></span>
                </label>
                <label className="admin-check"><input type="checkbox" checked={nvAtivar} onChange={(e) => setNvAtivar(e.target.checked)} /> activate now</label>
              </div>
              <div className="auth-actions">
                <button type="button" className="auth-btn auth-btn--ghost" onClick={() => setNovoAberto(false)}>Cancel</button>
                <button type="submit" className="auth-btn" disabled={criando || !nvNome.trim() || !nvEmail.trim()}>{criando ? 'Creating…' : 'Create user'}</button>
              </div>
            </form>
          )}
        </div>
      )}

      {carregando ? <div className="state">Loading…</div> : (
        <>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th><th>Email</th><th>Department</th><th>Role</th><th>Title</th><th>Active</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const eu = u.id === meuId;
                  return (
                    <tr key={u.id} className={!u.is_active ? 'metodos-padrao' : ''}>
                      <td className="strong">{u.nome}{eu && <span className="admin-eu"> (you)</span>}</td>
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
                          title={eu ? 'Cannot change your own role' : ''}
                          onChange={(e) => salvar(u.id, { role_id: e.target.value || null })}>
                          <option value="">— no role —</option>
                          {roles.map((r) => <option key={r.id} value={r.id}>{r.nome}</option>)}
                        </select>
                      </td>
                      <td>
                        <input className="metodo-nota" defaultValue={u.cargo ?? ''} placeholder="—" disabled={!canAdmin}
                          onBlur={(e) => e.target.value !== (u.cargo ?? '') && salvar(u.id, { cargo: e.target.value || null })} />
                      </td>
                      <td className="r">
                        <button className={`admin-toggle ${u.is_active ? 'on' : 'off'}`} disabled={!canAdmin || eu}
                          title={eu ? 'Cannot deactivate yourself' : (u.is_active ? 'Deactivate' : 'Activate')}
                          onClick={() => salvar(u.id, { is_active: !u.is_active })}>
                          {u.is_active ? '● active' : '○ inactive'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {!users.length && <tr><td colSpan={6} className="muted">No users.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="metodos-head" style={{ marginTop: 22 }}>
            <h3 style={{ fontSize: 16 }}>Change history <small style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(last {audit.length})</small></h3>
          </div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>When</th><th>Who</th><th>Action</th><th>Table</th><th>Changed fields</th></tr>
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
                {!audit.length && <tr><td colSpan={5} className="muted">No history yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
