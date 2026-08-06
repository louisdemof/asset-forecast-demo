// DEMO build: data ships as plaintext (synthetic, non-sensitive) under public/data.
// The production build encrypts this bundle behind an access code; here we just
// fetch the files into an in-memory store so the loaders (secureText) work unchanged.
let STORE: Record<string, string> | null = null;

// every file the loaders may request via secureText()
const FILES = [
  'COD.csv', 'Comercial.csv', 'Comercial_pipeline.csv', 'Comercial_rampa.csv',
  'Considerações.csv', 'Contratos.csv', 'Forecast_energia.csv', 'PVsyst.csv',
  'Performance_O&M.csv', 'Regras.csv', 'Tarifas.csv', 'Tarifas_ref.csv',
  'comp_portfolio.json',
  'injecao_excel.json', 'perfcomp_exemplo.json', 'perfcomp_ucs.json',
  'perfcomp_usinas.json', 'rateio_score.json',
];

/** Carrega os dados (texto plano) para a memória. Resolve quando tudo chegou. */
export async function loadDemo(): Promise<void> {
  const base = import.meta.env.BASE_URL;
  const pairs = await Promise.all(
    FILES.map(async (f) => [f, await (await fetch(`${base}data/${f}`)).text()] as const),
  );
  STORE = Object.fromEntries(pairs);
}

export const isUnlocked = () => STORE !== null;

/** Lê um arquivo de dados já carregado (da memória). */
export function secureText(name: string): string {
  if (!STORE) throw new Error('dados ainda não carregados');
  const v = STORE[name];
  if (v == null) throw new Error(`arquivo não encontrado: ${name}`);
  return v;
}
