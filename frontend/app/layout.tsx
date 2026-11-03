import type { Metadata } from "next";
import { Instrument_Sans, Instrument_Serif, Geist_Mono } from "next/font/google";
import "./globals.css";

const sans = Instrument_Sans({ variable: "--font-sans-face", subsets: ["latin"] });
const serif = Instrument_Serif({ variable: "--font-serif-face", subsets: ["latin"], weight: "400" });
const mono = Geist_Mono({ variable: "--font-mono-face", subsets: ["latin"] });

// Runs before first paint so there's no flash: saved choice, else the system setting.
const themeScript = `try{var t=localStorage.getItem("theme");if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.dataset.theme=t}catch(e){}`;

export const metadata: Metadata = {
  title: "Allowance: let AI agents pay with PayPal, safely",
  description:
    "Give your AI shopping agent a PayPal allowance with rules. Every purchase is checked by a policy engine and an AI risk check, then auto-paid, sent for your approval, or blocked.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning className={`${sans.variable} ${serif.variable} ${mono.variable} h-full antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full font-sans">{children}</body>
    </html>
  );
}
