/**
 * Ícones inline em SVG.
 *
 * Nenhuma biblioteca de ícones: são poucos ícones e cada um vira alguns bytes
 * no bundle, em vez de uma dependência inteira.
 *
 * Todos herdam `currentColor` e recebem `aria-hidden` — o rótulo acessível fica
 * no botão que os contém.
 */

type Props = { className?: string };

const base = "shrink-0";

export function IconeLogo({ className = "h-6 w-6" }: Props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`${base} ${className}`} aria-hidden>
      <path
        d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7L12 2.5Z"
        fill="currentColor"
        opacity="0.25"
      />
      <path
        d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7L12 2.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M12 7.5 16.5 10v4L12 16.5 7.5 14v-4L12 7.5Z" fill="currentColor" />
    </svg>
  );
}

export function IconeMais({ className = "h-4 w-4" }: Props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`${base} ${className}`} aria-hidden>
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function IconeBusca({ className = "h-4 w-4" }: Props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`${base} ${className}`} aria-hidden>
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function IconeConversa({ className = "h-4 w-4" }: Props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`${base} ${className}`} aria-hidden>
      <path
        d="M21 12a8 8 0 0 1-8 8H7l-4 3v-5.5A8 8 0 0 1 11 4h2a8 8 0 0 1 8 8Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconeMenu({ className = "h-4 w-4" }: Props) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={`${base} ${className}`} aria-hidden>
      <circle cx="12" cy="5" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="12" cy="19" r="1.8" />
    </svg>
  );
}

export function IconeClipe({ className = "h-5 w-5" }: Props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`${base} ${className}`} aria-hidden>
      <path
        d="M21 11.5 12.5 20a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 1 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 1 1-2.6-2.6l7.8-7.8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconeEnviar({ className = "h-5 w-5" }: Props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`${base} ${className}`} aria-hidden>
      <path
        d="M4 12 20 4l-4.5 16-3.5-6.5L4 12Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconeParar({ className = "h-4 w-4" }: Props) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={`${base} ${className}`} aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

export function IconeFechar({ className = "h-4 w-4" }: Props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`${base} ${className}`} aria-hidden>
      <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function IconeCheck({ className = "h-4 w-4" }: Props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`${base} ${className}`} aria-hidden>
      <path
        d="m5 13 4.5 4.5L19 7"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconeAlerta({ className = "h-4 w-4" }: Props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`${base} ${className}`} aria-hidden>
      <path
        d="M12 3.5 21.5 20h-19L12 3.5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M12 10v4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="17.5" r="1.1" fill="currentColor" />
    </svg>
  );
}

export function IconeCopiar({ className = "h-4 w-4" }: Props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`${base} ${className}`} aria-hidden>
      <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M5 15V6a2 2 0 0 1 2-2h9"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconeRecolher({ className = "h-4 w-4" }: Props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`${base} ${className}`} aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M9 4v16" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

export function IconePlanilha({ className = "h-8 w-8" }: Props) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={`${base} ${className}`} aria-hidden>
      <path d="M6 3h13l7 7v19a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" fill="#1d6f42" />
      <path d="M19 3l7 7h-7V3Z" fill="#14532d" />
      <path
        d="M10 14h12M10 19h12M10 24h12M14 14v10M18 14v10"
        stroke="#fff"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconePdf({ className = "h-8 w-8" }: Props) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={`${base} ${className}`} aria-hidden>
      <path d="M6 3h13l7 7v19a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" fill="#b91c1c" />
      <path d="M19 3l7 7h-7V3Z" fill="#7f1d1d" />
      <text x="16" y="24" textAnchor="middle" fill="#fff" fontSize="9" fontWeight="700">
        PDF
      </text>
    </svg>
  );
}

export function IconeTexto({ className = "h-8 w-8" }: Props) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={`${base} ${className}`} aria-hidden>
      <path d="M6 3h13l7 7v19a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" fill="#475569" />
      <path d="M19 3l7 7h-7V3Z" fill="#334155" />
      <path
        d="M10 15h12M10 19h12M10 23h8"
        stroke="#fff"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconeSupabase({ className = "h-5 w-5" }: Props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`${base} ${className}`} aria-hidden>
      <path d="M13 2 4 13.5h7.5L11 22l9-11.5h-7.5L13 2Z" fill="#3ecf8e" />
    </svg>
  );
}

export function IconeDrive({ className = "h-5 w-5" }: Props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`${base} ${className}`} aria-hidden>
      <path d="M8.5 3h7l6 10.5h-7L8.5 3Z" fill="#ffc107" />
      <path d="M2.5 13.5 8.5 3l3.5 6-6 10.5-3.5-6Z" fill="#1a73e8" />
      <path d="M6 19.5 9.5 13.5h12L18 19.5H6Z" fill="#34a853" />
    </svg>
  );
}

export function IconeEscudo({ className = "h-5 w-5" }: Props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`${base} ${className}`} aria-hidden>
      <path
        d="M12 3l7.5 3v6c0 4.5-3 8.2-7.5 9.5C7.5 20.2 4.5 16.5 4.5 12V6L12 3Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconeChevron({ className = "h-4 w-4" }: Props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`${base} ${className}`} aria-hidden>
      <path
        d="m6 9 6 6 6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Ícone conforme a extensão do arquivo.
 *
 * É um componente (e não uma função que devolve um componente) de propósito:
 * retornar um tipo de componente durante o render faz o React tratá-lo como
 * um componente novo a cada render, remontando a subárvore.
 */
export function IconeArquivo({
  extensao,
  className = "h-8 w-8",
}: {
  extensao: string;
  className?: string;
}) {
  const ext = extensao.toLowerCase().replace(".", "");
  if (["xlsx", "xls", "csv"].includes(ext)) return <IconePlanilha className={className} />;
  if (ext === "pdf") return <IconePdf className={className} />;
  return <IconeTexto className={className} />;
}
