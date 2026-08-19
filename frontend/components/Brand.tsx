import Link from "next/link";

interface BrandProps {
  /** Linka lockupen till denna sökväg. Utelämna för en statisk lockup (t.ex. inloggning). */
  href?: string;
  className?: string;
}

/**
 * Eneo-märket: ett flödesglyf (en nod som förgrenar sig till två) i en rundad
 * bricka. Inline-SVG i stället för <img> så att märket ärver accent-färgen från
 * temat och håller sig skarpt i alla storlekar.
 */
function EneoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      role="img"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <rect width="40" height="40" rx="10" fill="currentColor" />
      <g stroke="#fff" strokeWidth="2" strokeLinecap="round">
        <path d="M15.5 18.6 L24.5 13.4" />
        <path d="M15.5 21.4 L24.5 26.6" />
      </g>
      <circle cx="13" cy="20" r="3.6" fill="#fff" />
      <circle cx="27" cy="12.4" r="3" fill="#fff" />
      <circle cx="27" cy="27.6" r="3" fill="#fff" />
    </svg>
  );
}

// Header-lockup: Eneo-märke + ordbild · vertikal avdelare · produktnamnet "Flöden".
// Måtten är desamma som tidigare lockup (märke 40px, avdelare 32px, produkt 19px)
// så att headerns rytm är oförändrad. Ordbilden sätts i header-typsnittet
// (Raleway) precis som produktnamnet.
export function Brand({ href, className }: BrandProps) {
  const headerFont = {
    fontFamily: 'var(--sk-fontFamily-header), "Raleway", sans-serif',
  };

  const lockup = (
    <span className={`inline-flex items-center gap-4 ${className ?? ""}`}>
      <span className="inline-flex items-center gap-2.5">
        <EneoMark className="block h-10 w-10 shrink-0 text-accent" />
        <span
          className="whitespace-nowrap text-[22px] font-extrabold leading-none tracking-[-0.02em] text-ink"
          style={headerFont}
        >
          Eneo
        </span>
      </span>
      <span aria-hidden className="block h-8 w-px shrink-0 bg-rule" />
      <span
        className="whitespace-nowrap text-[19px] font-bold leading-none"
        style={headerFont}
      >
        Flöden
      </span>
    </span>
  );

  if (!href) return lockup;
  return (
    <Link
      href={href}
      aria-label="Flöden – Eneo"
      className="inline-flex rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
    >
      {lockup}
    </Link>
  );
}
