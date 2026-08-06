import { useRef, useState, type ReactNode } from 'react';

/** Cabeçalho de coluna com um ⓘ discreto que abre um popover explicativo (hover/foco/tap).
 *  Usa posição fixed (coords da viewport) p/ não ser cortado pelo overflow da tabela. */
export function ColHint({ label, titulo, oque, comoLer }: {
  label: ReactNode;
  titulo: string;
  oque: ReactNode;
  comoLer?: ReactNode;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  const abre = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ x: r.left + r.width / 2, y: r.bottom + 8 });
  };
  const fecha = () => setPos(null);
  return (
    <span className="colhint-wrap">
      {label}
      <button
        ref={ref}
        type="button"
        className="colhint-i"
        aria-label={`Help: ${titulo}`}
        onMouseEnter={abre}
        onMouseLeave={fecha}
        onFocus={abre}
        onBlur={fecha}
        onClick={(e) => { e.stopPropagation(); pos ? fecha() : abre(); }}
      >
        ⓘ
      </button>
      {pos && (
        <div className="colhint-pop" role="tooltip" style={{ left: pos.x, top: pos.y }} onClick={(e) => e.stopPropagation()}>
          <div className="colhint-t">{titulo}</div>
          <div className="colhint-d">{oque}</div>
          {comoLer && <div className="colhint-l"><b>How to read:</b> {comoLer}</div>}
        </div>
      )}
    </span>
  );
}
