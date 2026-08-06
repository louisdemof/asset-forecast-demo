import { supabase } from '../../lib/supabase';
import type { FaturaGeradora } from '../parseFaturaGeradora';
import { DOC_DISCO } from '../cadastroUC';

/** Persistência das faturas da unidade geradora (GC fora da MeterHub). */

export async function upsertFatura(f: FaturaGeradora & { usina: string }): Promise<void> {
  if (!supabase) return; // sem Supabase: aplica só em memória (comportamento antigo)
  const mesISO = /^\d{4}-\d{2}$/.test(f.mes) ? `${f.mes}-01` : f.mes;
  const { error } = await supabase.from('faturas_geradora').upsert(
    {
      usina: f.usina, mes: mesISO, uc: f.uc || '',
      distribuidora: DOC_DISCO[f.doc] ?? null,
      injecao_kwh: f.injecao || null, compensado_kwh: f.compensado || null,
      banco_kwh: f.banco || null, demanda_rs: f.demanda || null,
      doc: f.doc || null, flag: f.flag || null, arquivo: f.arquivo || null,
      parsed: { ucs: f.ucs, injecao: f.injecao, compensado: f.compensado, banco: f.banco, demanda: f.demanda },
      status: 'confirmado',
    },
    { onConflict: 'usina,mes,uc' },
  );
  if (error) throw error;
}

/** Carrega as faturas confirmadas e reaplica a injeção no motor (via importa). */
export async function hidratarFaturas(
  importa: (linhas: { usina: string; mes: string; injecao: number }[]) => unknown,
): Promise<number> {
  if (!supabase) return 0;
  const { data, error } = await supabase
    .from('faturas_geradora')
    .select('usina,mes,injecao_kwh,status')
    .eq('status', 'confirmado');
  if (error) throw error;
  const linhas = (data ?? [])
    .filter((f) => f.usina && f.mes && f.injecao_kwh)
    .map((f) => ({ usina: f.usina as string, mes: (f.mes as string).slice(0, 7), injecao: Number(f.injecao_kwh) / 1000 }));
  if (linhas.length) importa(linhas);
  return linhas.length;
}
