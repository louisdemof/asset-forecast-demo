import { create } from 'zustand';
import { supabase, supabaseOn } from '../lib/supabase';
import {
  PERMS_ZERO,
  type Acao,
  type Perms,
  type Profile,
  type Recurso,
  type RolePermission,
} from '../lib/db.types';

/**
 * Autenticação de usuário (Supabase). Espelha no front o has_perm() do banco:
 * o `can()` esconde/desabilita botões, mas a RLS é quem garante de verdade.
 *
 * Sem `supabaseOn` (nenhuma env var) o app não tem login — `ready=true`,
 * sem usuário, e `can()` devolve false (nada editável). O modo atual (só
 * leitura via Gate de criptografia) continua igual.
 */
interface AuthState {
  ready: boolean;              // já checou a sessão inicial?
  userId: string | null;
  email: string | null;
  profile: Profile | null;
  perms: Perms;
  init: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  signOut: () => Promise<void>;
  changePassword: (novaSenha: string) => Promise<{ ok: boolean; error?: string }>;
  can: (recurso: Recurso, acao: Acao) => boolean;
}

async function carregarPerfil(userId: string): Promise<{ profile: Profile | null; perms: Perms }> {
  if (!supabase) return { profile: null, perms: PERMS_ZERO };

  const { data: prof } = await supabase
    .from('profiles')
    .select('id, nome, email, cargo, department_id, role_id, manager_id, is_active')
    .eq('id', userId)
    .single();

  const profile = (prof as Profile) ?? null;
  if (!profile || !profile.is_active || !profile.role_id) {
    return { profile, perms: PERMS_ZERO };
  }

  const { data: rps } = await supabase
    .from('role_permissions')
    .select('*')
    .eq('role_id', profile.role_id);

  const perms: Perms = { ...PERMS_ZERO };
  for (const rp of (rps ?? []) as RolePermission[]) {
    perms[rp.recurso] = {
      read: rp.can_read,
      write: rp.can_write,
      validate: rp.can_validate,
      admin: rp.can_admin,
    };
  }
  return { profile, perms };
}

export const useAuthStore = create<AuthState>((set, get) => ({
  ready: false,
  userId: null,
  email: null,
  profile: null,
  perms: PERMS_ZERO,

  init: async () => {
    if (!supabaseOn || !supabase) {
      set({ ready: true });
      return;
    }
    const { data } = await supabase.auth.getSession();
    const user = data.session?.user ?? null;
    if (user) {
      const { profile, perms } = await carregarPerfil(user.id);
      set({ userId: user.id, email: user.email ?? null, profile, perms });
    }
    set({ ready: true });

    // reage a login/logout/refresh de token
    supabase.auth.onAuthStateChange(async (_evt, session) => {
      const u = session?.user ?? null;
      if (!u) {
        set({ userId: null, email: null, profile: null, perms: PERMS_ZERO });
        return;
      }
      const { profile, perms } = await carregarPerfil(u.id);
      set({ userId: u.id, email: u.email ?? null, profile, perms });
    });
  },

  signIn: async (email, password) => {
    if (!supabase) return { ok: false, error: 'Supabase não configurado' };
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, error: error.message };
    // registra atividade (best-effort — não bloqueia login se falhar)
    const uid = (await supabase.auth.getUser()).data.user?.id;
    if (uid) await supabase.from('user_activity').insert({ user_id: uid, evento: 'login' });
    return { ok: true };
  },

  signOut: async () => {
    if (supabase) await supabase.auth.signOut();
    set({ userId: null, email: null, profile: null, perms: PERMS_ZERO });
  },

  changePassword: async (novaSenha) => {
    if (!supabase) return { ok: false, error: 'Supabase não configurado' };
    const { error } = await supabase.auth.updateUser({ password: novaSenha });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  },

  can: (recurso, acao) => {
    const p = get().perms[recurso];
    return p ? p[acao] : false;
  },
}));
