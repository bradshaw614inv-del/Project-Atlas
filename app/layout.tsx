import type { Metadata } from "next";
import { Geist, Geist_Mono, Orbitron, Rajdhani } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const displayFont = Rajdhani({ variable: "--font-display", subsets: ["latin"], weight: ["500", "600", "700"] });
const numeralFont = Orbitron({ variable: "--font-numeral", subsets: ["latin"], weight: ["600", "700", "800", "900"] });

export const metadata: Metadata = {
  title: "Project Atlas — Forward News Tracker",
  description: "Record real market-moving news and track what happens from today forward.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
  openGraph: {
    title: "Project Atlas — Replay the news. Measure the edge.",
    description: "Configure and replay more than 1,000 historical news-driven trades against a benchmark.",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Project Atlas historical news replay engine" }],
  },
  twitter: { card: "summary_large_image", images: ["/og.png"] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${geistSans.variable} ${geistMono.variable} ${displayFont.variable} ${numeralFont.variable}`}>{children}</body></html>;
}
