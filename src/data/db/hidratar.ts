import { listMetodos, listDescontos, upsertMetodo, upsertDesconto } from './metodos';
import { supabaseOn } from '../../lib/supabase';
import { useForecastStore } from '../../store/forecastStore';
import { TIPOS_CLIENTE, type GrossUp, type LinhaResidual, type ModeloComercial, type RegraCliente } from '../../engine/clientes';
import type { ClienteTipo } from '../../engine/contrato';

/**
 * Ponte entre o Supabase (fonte da verdade editável) e o motor (REGRAS_CLIENTE + contratos).
 * - hidratarMetodos(): lê metodos_cliente + descontos_usina e aplica por cima do baseline.
 * - persistMetodo/persistDesconto: gravam a edição no banco (com audit por trigger).
 *
 * Só funciona logado (a RLS bloqueia leitura de quem não tem 'regras'). Viewer via
 * Gate segue no baseline código/CSV — os descontos comerciais NÃO vazam pela anon key.
 */

const DECLARADOS = new Set<string>(TIPOS_CLIENTE.filter((t) => t !== 'PADRAO'));
// engine tipo → nomes de cliente no banco (PADRAO agrupa vários offtakers reais)
let clientesPorTipo: Record<string, string[]> = {};

function tipoDe(cliente: string): ClienteTipo {
  return (DECLARADOS.has(cliente) ? cliente : 'PADRAO') as ClienteTipo;
}
const residDbToEng = (v: string | null): LinhaResidual => (v === 'Guarda-Chuva' ? 'guardaChuva' : 'om');
const residEngToDb = (v: LinhaResidual): string => (v === 'guardaChuva' ? 'Guarda-Chuva' : 'O&M');

export async function hidratarMetodos(): Promise<void> {
  if (!supabaseOn) return;
  const { editaRegraCliente, editaContrato } = useForecastStore.getState();
  const [metodos, descontos] = await Promise.all([listMetodos(), listDescontos()]);
  if (!metodos.length && !descontos.length) return; // sem acesso (não logado) → mantém baseline

  clientesPorTipo = {};
  for (const m of metodos) (clientesPorTipo[tipoDe(m.cliente)] ??= []).push(m.cliente);

  const feito = new Set<ClienteTipo>();
  for (const m of metodos) {
    const t = tipoDe(m.cliente);
    if (feito.has(t)) continue; // PADRAO: 1ª linha basta (todas idênticas)
    feito.add(t);
    const patch: Partial<RegraCliente> = { residual: residDbToEng(m.residual) };
    if (m.modelo) patch.modelo = m.modelo as ModeloComercial;
    if (m.gross_up) patch.grossUp = m.gross_up as GrossUp;
    patch.feeOperacaoMWh = Number(m.fee_mwh) || 0;
    if (m.observacao != null) patch.nota = m.observacao;
    editaRegraCliente(t, patch);
  }
  for (const d of descontos) {
    if (d.precificacao === 'desconto' && d.desconto_pct != null) {
      editaContrato(d.usina, { desconto: Number(d.desconto_pct) });
    }
  }
}

export async function persistMetodo(tipo: ClienteTipo, patch: Partial<RegraCliente>): Promise<void> {
  if (!supabaseOn) return;
  const db: Record<string, unknown> = {};
  if (patch.modelo !== undefined) db.modelo = patch.modelo;
  if (patch.grossUp !== undefined) db.gross_up = patch.grossUp;
  if (patch.residual !== undefined) db.residual = residEngToDb(patch.residual);
  if (patch.feeOperacaoMWh !== undefined) db.fee_mwh = patch.feeOperacaoMWh;
  if (patch.nota !== undefined) db.observacao = patch.nota;
  if (!Object.keys(db).length) return;
  const alvos = clientesPorTipo[tipo] ?? (tipo !== 'PADRAO' ? [tipo] : []);
  await Promise.all(alvos.map((c) => upsertMetodo(c, db)));
}

export async function persistDesconto(usina: string, descontoFrac: number): Promise<void> {
  if (!supabaseOn) return;
  await upsertDesconto(usina, { desconto_pct: descontoFrac });
}
