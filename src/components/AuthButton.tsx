import { useEffect, useState } from 'react';
import { useAuthStore } from '../store/authStore';
import { supabaseOn } from '../lib/supabase';

let iniciado = false; // guard contra StrictMode (init roda 1×)

/**
 * Botão de login/logout no topo. Só aparece se o Supabase estiver configurado.
 * Login é necessário APENAS para editar (métodos, descontos, validar) — a
 * visualização continua pelo Gate de código, como hoje.
 */
export default function AuthButton() {
  const { userId, email, profile, ready, init, signOut } = useAuthStore();
  const [modal, setModal] = useState(false);
  const [trocaSenha, setTrocaSenha] = useState(false);

  useEffect(() => {
    if (!iniciado) { iniciado = true; void init(); }
  }, [init]);

  if (!supabaseOn) return null;
  if (!ready) return <span className="auth-chip auth-chip--load">…</span>;

  if (userId) {
    const nome = profile?.nome ?? email ?? 'user';
    const papel = profile?.role_id ? '' : ' · no role';
    const inativo = profile && !profile.is_active ? ' · inactive' : '';
    return (
      <span className="auth-chip">
        <span className="auth-who" title={email ?? ''}>👤 {nome}{papel}{inativo}</span>
        <button className="auth-link" onClick={() => setTrocaSenha(true)}>Password</button>
        <button className="auth-link" onClick={() => void signOut()}>Sign out</button>
        {trocaSenha && <ChangePasswordModal onClose={() => setTrocaSenha(false)} />}
      </span>
    );
  }

  return (
    <>
      <button className="topband-link auth-entrar" onClick={() => setModal(true)}>🔒 Sign in (edit)</button>
      {modal && <LoginModal onClose={() => setModal(false)} />}
    </>
  );
}

function LoginModal({ onClose }: { onClose: () => void }) {
  const signIn = useAuthStore((s) => s.signIn);
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);

  const entrar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !senha) return;
    setCarregando(true); setErro(null);
    const r = await signIn(email.trim(), senha);
    setCarregando(false);
    if (r.ok) onClose();
    else setErro(r.error ?? 'Login failed');
  };

  return (
    <div className="auth-overlay" onClick={onClose}>
      <form className="auth-card" onClick={(e) => e.stopPropagation()} onSubmit={entrar}>
        <h2 className="auth-title">Sign in to edit</h2>
        <p className="auth-sub">Only required to change methods, discounts or validate the month.</p>
        <label className="auth-label">Email</label>
        <input className="auth-input" type="email" autoFocus autoComplete="username"
          value={email} onChange={(e) => setEmail(e.target.value)} />
        <label className="auth-label">Password</label>
        <input className="auth-input" type="password" autoComplete="current-password"
          value={senha} onChange={(e) => setSenha(e.target.value)} />
        {erro && <p className="auth-erro">{erro}</p>}
        <div className="auth-actions">
          <button type="button" className="auth-btn auth-btn--ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="auth-btn" disabled={carregando || !email.trim() || !senha}>
            {carregando ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>
    </div>
  );
}

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const changePassword = useAuthStore((s) => s.changePassword);
  const [nova, setNova] = useState('');
  const [conf, setConf] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [carregando, setCarregando] = useState(false);

  const curta = nova.length > 0 && nova.length < 8;
  const naoBate = conf.length > 0 && nova !== conf;

  const salvar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (nova.length < 8 || nova !== conf) return;
    setCarregando(true); setErro(null);
    const r = await changePassword(nova);
    setCarregando(false);
    if (r.ok) { setOk(true); setTimeout(onClose, 1400); }
    else setErro(r.error ?? 'Failed to change password');
  };

  return (
    <div className="auth-overlay" onClick={onClose}>
      <form className="auth-card" onClick={(e) => e.stopPropagation()} onSubmit={salvar}>
        <h2 className="auth-title">Change password</h2>
        <p className="auth-sub">Minimum 8 characters. Applies to your own access.</p>
        {ok ? (
          <p className="auth-ok">✓ Password changed.</p>
        ) : (
          <>
            <label className="auth-label">New password</label>
            <input className="auth-input" type="password" autoFocus autoComplete="new-password"
              value={nova} onChange={(e) => setNova(e.target.value)} />
            <label className="auth-label">Confirm new password</label>
            <input className="auth-input" type="password" autoComplete="new-password"
              value={conf} onChange={(e) => setConf(e.target.value)} />
            {curta && <p className="auth-erro">Minimum 8 characters.</p>}
            {naoBate && <p className="auth-erro">Passwords do not match.</p>}
            {erro && <p className="auth-erro">{erro}</p>}
            <div className="auth-actions">
              <button type="button" className="auth-btn auth-btn--ghost" onClick={onClose}>Cancel</button>
              <button type="submit" className="auth-btn" disabled={carregando || nova.length < 8 || nova !== conf}>
                {carregando ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
