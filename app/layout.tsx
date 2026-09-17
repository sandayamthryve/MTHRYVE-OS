import type { Metadata, Viewport } from "next";
import { Nunito_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import "./logo-override.css";
import { ServiceWorkerRegistrar } from "@/components/pwa/ServiceWorkerRegistrar";
import { SpeedInsights } from "@vercel/speed-insights/next";

const display = Nunito_Sans({
  subsets: ["latin"],
  variable: "--font-display",
});

const body = Nunito_Sans({
  subsets: ["latin"],
  variable: "--font-body",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  applicationName: "M-THRYVE OS",
  title: "Mthryve OS",
  description: "The AI operating system for Mthryve Marketing Inc.",
  // Next serves app/manifest.ts at /manifest.webmanifest; link it explicitly.
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "MThryve",
    // Translucent bar lets the obsidian app background bleed under the notch.
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

// Standalone-PWA viewport: viewport-fit=cover so content can extend under the
// notch/home-indicator (paired with env(safe-area-inset-*) padding in the
// shell), plus the obsidian theme color for the browser/OS chrome.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#080b11",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        {children}
        <ServiceWorkerRegistrar />
        <SpeedInsights />
      </body>
    </html>
  );
}
