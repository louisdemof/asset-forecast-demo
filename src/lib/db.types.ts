/**
 * Tipos das tabelas do Supabase (espelham supabase/migrations/0001_init.sql).
 * Mantidos à mão por enquanto; quando o projeto existir dá pra gerar via
 * `supabase gen types typescript`.
 */

export type Recurso = 'cadastro_uc' | 'faturas' | 'regras' | 'validacoes' | 'users';
export type Acao = 'read' | 'write' | 'validate' | 'admin';

export interface Perm {
  read: boolean;
  write: boolean;
  validate: boolean;
  admin: boolean;
}
export type Perms = Record<Recurso, Perm>;

export const PERM_ZERO: Perm = { read: false, write: false, validate: false, admin: false };
export const PERMS_ZERO: Perms = {
  cadastro_uc: PERM_ZERO,
  faturas: PERM_ZERO,
  regras: PERM_ZERO,
  validacoes: PERM_ZERO,
  users: PERM_ZERO,
};

export interface Profile {
  id: string;
  nome: string;
  email: string;
  cargo: string | null;
  department_id: string | null;
  role_id: string | null;
  manager_id: string | null;
  is_active: boolean;
}

export interface RolePermission {
  role_id: string;
  recurso: Recurso;
  can_read: boolean;
  can_write: boolean;
  can_validate: boolean;
  can_admin: boolean;
}

// --- Domínio ---
export interface MetodoCliente {
  id: string;
  cliente: string;
  modelo: 'AR' | 'GC' | null;
  gross_up: string | null;
  base_formula: string | null;
  residual: string | null;
  pis: boolean;
  icms: boolean;
  desconto_na_base: boolean;
  take_or_pay: boolean | null;
  cap_compensada: string | null;
  fee_mwh: number;
  reajuste_tipo: 'aneel' | 'contratual';
  ativo: boolean;
  observacao: string | null;
  updated_by: string | null;
  updated_at: string;
}

export interface DescontoUsina {
  id: string;
  usina: string;
  cliente: string | null;
  distribuidora: string | null;
  precificacao: 'desconto' | 'ppa';
  desconto_pct: number | null;
  ppa_valor: number | null;
  reajuste_indice: string | null;
  reajuste_data_base: string | null;
  reajuste_mes_aniversario: number | null;
  ativo: boolean;
  observacao: string | null;
  updated_by: string | null;
  updated_at: string;
}

export interface AuditRow {
  id: number;
  table_name: string;
  record_id: string | null;
  action: 'INSERT' | 'UPDATE' | 'DELETE';
  changed_fields: string[] | null;
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
  actor_email: string | null;
  occurred_at: string;
}
