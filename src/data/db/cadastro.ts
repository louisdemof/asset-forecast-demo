import { supabase } from '../../lib/supabase';

/** Cadastro UC → usina, editável (sobrepõe o CADASTRO_UC hardcoded no parser). */

export interface CadastroUC {
  id: string;
  uc: string;
  w_codes: string[];
  usina: string;
  distribuidora: string | null;
  modelo: string | null;
  tipo_cliente: string | null;
  fonte: string;
  observacao: string | null;
}

// mapa UC/W-code → usina carregado do banco; o parser consulta antes do hardcoded
export const cadastroDb: Record<string, string> = {};

export async function listCadastro(): Promise<CadastroUC[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('cadastro_uc')
    .select('id,uc,w_codes,usina,distribuidora,modelo,tipo_cliente,fonte,observacao')
    .order('usina');
  if (error) throw error;
  return (data ?? []) as CadastroUC[];
}

export async function hidratarCadastro(): Promise<number> {
  if (!supabase) return 0;
  const rows = await listCadastro();
  for (const k of Object.keys(cadastroDb)) delete cadastroDb[k];
  for (const r of rows) {
    if (r.uc) cadastroDb[r.uc] = r.usina;
    for (const w of r.w_codes ?? []) if (w) cadastroDb[w] = r.usina;
  }
  return rows.length;
}

export async function upsertUc(row: {
  id?: string; uc: string; usina: string;
  distribuidora?: string | null; w_codes?: string[]; observacao?: string | null;
}): Promise<void> {
  if (!supabase) throw new Error('Supabase não configurado');
  const payload = {
    uc: row.uc.trim(), usina: row.usina.trim(),
    distribuidora: row.distribuidora?.trim() || null,
    w_codes: (row.w_codes ?? []).map((w) => w.trim()).filter(Boolean),
    observacao: row.observacao?.trim() || null, fonte: 'manual',
  };
  const { error } = row.id
    ? await supabase.from('cadastro_uc').update(payload).eq('id', row.id)
    : await supabase.from('cadastro_uc').upsert(payload, { onConflict: 'uc,usina' });
  if (error) throw error;
}

export async function deleteUc(id: string): Promise<void> {
  if (!supabase) throw new Error('Supabase não configurado');
  const { error } = await supabase.from('cadastro_uc').delete().eq('id', id);
  if (error) throw error;
}
