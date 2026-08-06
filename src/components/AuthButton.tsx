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
    const nome = profile?.nome ?? email ?? 'usuário';
    const papel = profile?.role_id ? '' : ' · sem papel';
    const inativo = profile && !profile.is_active ? ' · inativo' : '';
    return (
      <span className="auth-chip">
        <span className="auth-who" title={email ?? ''}>👤 {nome}{papel}{inativo}</span>
        <button className="auth-link" onClick={() => setTrocaSenha(true)}>Senha</button>
        <button className="auth-link" onClick={() => void signOut()}>Sair</button>
        {trocaSenha && <ChangePasswordModal onClose={() => setTrocaSenha(false)} />}
      </span>
    );
  }

  return (
    <>
      <button className="topband-link auth-entrar" onClick={() => setModal(true)}>🔒 Entrar (editar)</button>
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
    else setErro(r.error ?? 'Falha no login');
  };

  return (
    <div className="auth-overlay" onClick={onClose}>
      <form className="auth-card" onClick={(e) => e.stopPropagation()} onSubmit={entrar}>
        <h2 className="auth-title">Entrar para editar</h2>
        <p className="auth-sub">Necessário só para alterar métodos, descontos ou validar o mês.</p>
        <label className="auth-label">E-mail</label>
        <input className="auth-input" type="email" autoFocus autoComplete="username"
          value={email} onChange={(e) => setEmail(e.target.value)} />
        <label className="auth-label">Senha</label>
        <input className="auth-input" type="password" autoComplete="current-password"
          value={senha} onChange={(e) => setSenha(e.target.value)} />
        {erro && <p className="auth-erro">{erro}</p>}
        <div className="auth-actions">
          <button type="button" className="auth-btn auth-btn--ghost" onClick={onClose}>Cancelar</button>
          <button type="submit" className="auth-btn" disabled={carregando || !email.trim() || !senha}>
            {carregando ? 'Entrando…' : 'Entrar'}
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
    else setErro(r.error ?? 'Falha ao trocar a senha');
  };

  return (
    <div className="auth-overlay" onClick={onClose}>
      <form className="auth-card" onClick={(e) => e.stopPropagation()} onSubmit={salvar}>
        <h2 className="auth-title">Trocar senha</h2>
        <p className="auth-sub">Mínimo 8 caracteres. Vale para o seu próprio acesso.</p>
        {ok ? (
          <p className="auth-ok">✓ Senha alterada.</p>
        ) : (
          <>
            <label className="auth-label">Nova senha</label>
            <input className="auth-input" type="password" autoFocus autoComplete="new-password"
              value={nova} onChange={(e) => setNova(e.target.value)} />
            <label className="auth-label">Confirmar nova senha</label>
            <input className="auth-input" type="password" autoComplete="new-password"
              value={conf} onChange={(e) => setConf(e.target.value)} />
            {curta && <p className="auth-erro">Mínimo 8 caracteres.</p>}
            {naoBate && <p className="auth-erro">As senhas não conferem.</p>}
            {erro && <p className="auth-erro">{erro}</p>}
            <div className="auth-actions">
              <button type="button" className="auth-btn auth-btn--ghost" onClick={onClose}>Cancelar</button>
              <button type="submit" className="auth-btn" disabled={carregando || nova.length < 8 || nova !== conf}>
                {carregando ? 'Salvando…' : 'Salvar'}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
