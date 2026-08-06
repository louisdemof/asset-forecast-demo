import { supabase } from '../../lib/supabase';

export interface Validacao {
  id: string;
  mes: string;              // 'YYYY-MM-DD' (1º do mês)
  escopo: string;
  alvo: string | null;
  status: string;          // 'validado' | 'pendente' | 'rejeitado'
  metricas: Record<string, unknown> | null;
  observacao: string | null;
  validated_by: string | null;
  validated_at: string | null;
}

// portfolio usa alvo fixo (não-nulo) p/ o unique (mes,escopo,alvo) deduplicar
const ALVO_PORTFOLIO = 'ALL';

export async function listValidacoes(): Promise<Validacao[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('validacoes_mensais')
    .select('id,mes,escopo,alvo,status,metricas,observacao,validated_by,validated_at')
    .order('mes', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Validacao[];
}

export async function validarMes(
  mesISO: string,
  metricas: Record<string, unknown>,
  observacao?: string,
): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured');
  const uid = (await supabase.auth.getUser()).data.user?.id ?? null;
  const { error } = await supabase.from('validacoes_mensais').upsert(
    {
      mes: mesISO, escopo: 'portfolio', alvo: ALVO_PORTFOLIO, status: 'validado',
      metricas, observacao: observacao ?? null,
      validated_by: uid, validated_at: new Date().toISOString(),
    },
    { onConflict: 'mes,escopo,alvo' },
  );
  if (error) throw error;
}

export async function reverterValidacao(mesISO: string): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured');
  const uid = (await supabase.auth.getUser()).data.user?.id ?? null;
  const { error } = await supabase.from('validacoes_mensais').upsert(
    {
      mes: mesISO, escopo: 'portfolio', alvo: ALVO_PORTFOLIO, status: 'pendente',
      validated_by: uid, validated_at: new Date().toISOString(),
    },
    { onConflict: 'mes,escopo,alvo' },
  );
  if (error) throw error;
}
