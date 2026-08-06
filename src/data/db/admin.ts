import { createClient } from '@supabase/supabase-js';
import { supabase } from '../../lib/supabase';
import type { AuditRow } from '../../lib/db.types';

/** Acesso à administração de usuários (recurso 'users' na RLS). */

export interface Role { id: string; nome: string; nivel: number; }
export interface Dept { id: string; nome: string; }
export interface UserRow {
  id: string; nome: string; email: string; cargo: string | null;
  is_active: boolean; role_id: string | null; department_id: string | null;
  manager_id: string | null; created_at: string;
}

export async function listRoles(): Promise<Role[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from('roles').select('id,nome,nivel').order('nivel', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Role[];
}

export async function listDepartments(): Promise<Dept[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from('departments').select('id,nome').order('nome');
  if (error) throw error;
  return (data ?? []) as Dept[];
}

export async function listUsers(): Promise<UserRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('profiles')
    .select('id,nome,email,cargo,is_active,role_id,department_id,manager_id,created_at')
    .order('nome');
  if (error) throw error;
  return (data ?? []) as UserRow[];
}

export async function updateUser(
  id: string,
  patch: { role_id?: string | null; department_id?: string | null; is_active?: boolean; cargo?: string | null; nome?: string },
): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured');
  const { error } = await supabase.from('profiles').update(patch).eq('id', id);
  if (error) throw error;
}

/** Senha temporária forte (o usuário troca no 1º acesso). */
export function gerarSenhaTemp(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const arr = new Uint32Array(12);
  crypto.getRandomValues(arr);
  return 'Hlx-' + Array.from(arr, (n) => chars[n % chars.length]).join('');
}

/**
 * Provisiona um usuário a partir do painel admin, sem service_role no browser:
 * usa um cliente Supabase DESCARTÁVEL (não mexe na sessão do admin) para o signUp,
 * e então define papel/depto/nome pela sessão do admin (RLS 'users:admin').
 * A confirmação de e-mail continua LIGADA — o novo usuário confirma pelo e-mail
 * e entra com a senha temporária (que troca depois).
 */
export async function provisionUser(input: {
  email: string; nome: string; senha: string;
  role_id: string | null; department_id: string | null; cargo?: string | null; ativar: boolean;
}): Promise<{ id: string }> {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!url || !anon) throw new Error('Supabase not configured');
  const tmp = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await tmp.auth.signUp({ email: input.email.trim().toLowerCase(), password: input.senha });
  if (error) throw error;
  const id = data.user?.id;
  if (!id) throw new Error('E-mail já cadastrado (ou signup bloqueado).');
  await updateUser(id, {
    role_id: input.role_id, department_id: input.department_id,
    is_active: input.ativar, cargo: input.cargo ?? null, nome: input.nome.trim(),
  });
  return { id };
}

export async function listAudit(limit = 50): Promise<AuditRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('audit_log')
    .select('id,table_name,record_id,action,changed_fields,actor_email,occurred_at')
    .order('occurred_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as AuditRow[];
}
