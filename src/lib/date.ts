/** Formata mês ISO "2026-06" → "06-2026" (mm-yyyy). Convenção única de exibição. */
export const fmtMes = (mes: string): string => {
  const [y, m] = (mes || '').slice(0, 7).split('-');
  return m && y ? `${m}-${y}` : mes;
};
