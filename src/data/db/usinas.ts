import { supabase } from '../../lib/supabase';
import { useForecastStore, type UsinaNova } from '../../store/forecastStore';

/** Usinas criadas na plataforma (fora do Forecast 6+6). Persistem e são
 *  reaplicadas no boot por cima do baseline CSV. Recurso RLS: 'cadastro_uc'. */

export interface UsinaCadastroRow extends UsinaNova {
  id: string;
}

export async function listUsinasCadastro(): Promise<UsinaNova[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('usinas_cadastro')
    .select('usina,cliente,disco,pot_mwac,pot_mwp,desconto,p50_ano,cod,take_or_pay,perf_oper')
    .eq('ativo', true)
    .order('usina');
  if (error) throw error;
  return (data ?? []).map((r) => ({
    usina: r.usina as string, cliente: r.cliente as string, disco: r.disco as string,
    potMWac: Number(r.pot_mwac) || 0, potMWp: r.pot_mwp != null ? Number(r.pot_mwp) : undefined,
    desconto: Number(r.desconto) || 0, p50Ano: Number(r.p50_ano) || 0,
    cod: (r.cod as string) ?? undefined, takeOrPay: Boolean(r.take_or_pay),
    perfOper: r.perf_oper != null ? Number(r.perf_oper) : undefined,
  }));
}

/** Ao logar: recria no forecast as usinas cadastradas na plataforma. */
export async function hidratarUsinas(): Promise<number> {
  if (!supabase) return 0;
  const novas = await listUsinasCadastro();
  const add = useForecastStore.getState().adicionaUsina;
  let n = 0;
  for (const u of novas) { if (add(u).ok) n++; }
  return n;
}

export async function upsertUsinaCadastro(n: UsinaNova): Promise<void> {
  if (!supabase) return; // sem Supabase: fica só na sessão
  const { error } = await supabase.from('usinas_cadastro').upsert(
    {
      usina: n.usina.trim(), cliente: n.cliente.trim(), disco: n.disco.trim(),
      pot_mwac: n.potMWac, pot_mwp: n.potMWp ?? null, desconto: n.desconto,
      p50_ano: n.p50Ano, cod: n.cod || null, take_or_pay: !!n.takeOrPay, perf_oper: n.perfOper ?? null,
    },
    { onConflict: 'usina' },
  );
  if (error) throw error;
}
