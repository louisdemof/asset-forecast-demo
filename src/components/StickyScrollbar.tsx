import { useEffect, useRef } from 'react';

/** Barra de rolagem horizontal FIXA no rodapé da viewport, sincronizada com um
 *  container que transborda (ex. a tabela larga). Aparece só quando o container
 *  transborda E seu fundo real está abaixo da tela — some quando a barra nativa
 *  do próprio container já está visível. */
export function StickyScrollbar({ targetRef }: { targetRef: React.RefObject<HTMLElement | null> }) {
  const barRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = targetRef.current;
    const bar = barRef.current;
    const spacer = spacerRef.current;
    if (!target || !bar || !spacer) return;

    const update = () => {
      spacer.style.width = `${target.scrollWidth}px`;
      const transborda = target.scrollWidth > target.clientWidth + 1;
      const rect = target.getBoundingClientRect();
      const fundoAbaixoDaTela = rect.bottom > window.innerHeight; // barra nativa fora da vista
      bar.style.display = transborda && fundoAbaixoDaTela ? 'block' : 'none';
      bar.style.left = `${rect.left}px`;
      bar.style.width = `${rect.width}px`;
      if (bar.scrollLeft !== target.scrollLeft) bar.scrollLeft = target.scrollLeft;
    };
    const fromBar = () => { if (target.scrollLeft !== bar.scrollLeft) target.scrollLeft = bar.scrollLeft; };
    const fromTarget = () => { if (bar.scrollLeft !== target.scrollLeft) bar.scrollLeft = target.scrollLeft; };

    update();
    bar.addEventListener('scroll', fromBar, { passive: true });
    target.addEventListener('scroll', fromTarget, { passive: true });
    window.addEventListener('scroll', update, { passive: true, capture: true });
    window.addEventListener('resize', update);
    const ro = new ResizeObserver(update);
    ro.observe(target);

    return () => {
      bar.removeEventListener('scroll', fromBar);
      target.removeEventListener('scroll', fromTarget);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      ro.disconnect();
    };
  });

  return (
    <div ref={barRef} className="sticky-hscroll" aria-hidden="true">
      <div ref={spacerRef} className="sticky-hscroll-inner" />
    </div>
  );
}
