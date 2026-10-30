import Link from "next/link";
import type { ReactNode } from "react";

// Chrome for the demo merchant "Brew & Co." (D-060): deliberately its own look, so on screen it
// reads as a different website that accepts "Pay with Allowance".
export default function StoreLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-[#faf6f1] text-[#2b1d14] dark:bg-[#17110d] dark:text-[#f3e9df]">
      <div className="bg-[#2b1d14] px-4 py-1.5 text-center text-[11px] text-[#e8d9c9] dark:bg-black/40">
        Demo merchant site for the Allowance demo · <Link href="/" className="underline">open the Allowance dashboard</Link>
      </div>
      <header className="border-b border-[#e7dccf] dark:border-[#33261c]">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4 sm:px-6">
          <Link href="/store" className="flex items-center gap-2">
            <span className="grid size-9 place-items-center rounded-full bg-[#7a4a2a] text-lg text-white">☕</span>
            <span className="font-serif text-xl font-semibold tracking-tight">Brew &amp; Co.</span>
          </Link>
          <span className="text-xs text-[#8a6f5c] dark:text-[#bfa48f]">Small-batch coffee · free shipping over $40</span>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}

/** The "Pay with Allowance" button stores put on their checkout. */
export function AllowanceButton({ children, disabled, onClick }: { children: ReactNode; disabled?: boolean; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#003087] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#00256b] disabled:opacity-60"
    >
      <span className="grid size-5 place-items-center rounded-md bg-white text-[11px] font-bold text-[#003087]">A</span>
      {children}
    </button>
  );
}
