import { supabase } from '../../lib/supabase';
import type { AuditRow, DescontoUsina, MetodoCliente } from '../../lib/db.types';

/**
 * Acesso às tabelas editáveis de método/desconto. Toda escrita passa pela RLS
 * (recurso 'regras') e é auditada por trigger no banco. Sem Supabase ligado,
 * `list*` devolve [] e `upsert*` lança — o chamador cai no baseline código/CSV.
 */

export async function listMetodos(): Promise<MetodoCliente[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from('metodos_cliente').select('*').order('cliente');
  if (error) throw error;
  return (data ?? []) as MetodoCliente[];
}

export async function upsertMetodo(cliente: string, patch: Partial<MetodoCliente>): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured');
  const { error } = await supabase.from('metodos_cliente').update(patch).eq('cliente', cliente);
  if (error) throw error;
}

export async function listDescontos(): Promise<DescontoUsina[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from('descontos_usina').select('*').order('usina');
  if (error) throw error;
  return (data ?? []) as DescontoUsina[];
}

export async function upsertDesconto(usina: string, patch: Partial<DescontoUsina>): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured');
  const { error } = await supabase.from('descontos_usina').update(patch).eq('usina', usina);
  if (error) throw error;
}

/** Histórico de alterações de um registro (para o painel de histórico). */
export async function historicoDe(table: string, recordId: string): Promise<AuditRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('audit_log')
    .select('*')
    .eq('table_name', table)
    .eq('record_id', recordId)
    .order('occurred_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as AuditRow[];
}
