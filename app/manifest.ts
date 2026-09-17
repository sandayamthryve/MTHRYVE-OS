import type { MetadataRoute } from "next";

// Web App Manifest for installing Mthryve OS to a phone / desktop home screen.
// Served by Next at /manifest.webmanifest. Colors mirror the OS design tokens
// (obsidian base + teal primary) so the install splash and status bar match the
// running app. The manifest is intentionally static — no user/session data —
// so it is safe to serve to an uncredentialed install prompt (the middleware
// matcher exempts it from the auth redirect).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "M-THRYVE OS",
    short_name: "MThryve",
    description: "The AI operating system for Mthryve Marketing Inc.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#080b11",
    theme_color: "#080b11",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
