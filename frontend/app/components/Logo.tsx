// The Allowance mark: a budget ring that is mostly full. Same shape as the favicon.
export default function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="shrink-0">
      <rect width="32" height="32" rx="9" fill="var(--brand-ink)" />
      <circle cx="16" cy="16" r="7.5" fill="none" stroke="var(--on-accent)" strokeOpacity="0.28" strokeWidth="3" />
      <circle
        cx="16"
        cy="16"
        r="7.5"
        fill="none"
        stroke="var(--on-accent)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="35.3 47.1"
        transform="rotate(-90 16 16)"
      />
    </svg>
  );
}

export function Wordmark({ sub }: { sub?: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <Logo />
      <div className="leading-tight">
        <div className="font-serif text-xl tracking-tight">Allowance</div>
        {sub && <div className="hidden text-xs text-muted 2xl:block">{sub}</div>}
      </div>
    </div>
  );
}
