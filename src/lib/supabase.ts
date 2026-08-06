import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Cliente Supabase. Fica ATRÁS de um feature flag: sem as env vars
 * (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY) o app roda exatamente como
 * hoje (código + CSV), sem tocar em nada. A anon key é pública por design —
 * a proteção real é a RLS no banco. A service_role NUNCA vai pro front.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabaseOn = Boolean(url && anon);

export const supabase: SupabaseClient | null = supabaseOn
  ? createClient(url as string, anon as string, {
      auth: { persistSession: true, autoRefreshToken: true },
    })
  : null;
