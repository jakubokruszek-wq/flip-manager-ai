import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Flip Manager — MetrON",
    short_name: "Flip Manager",
    description: "Flip Manager · MetrON — Nieruchomości i Inwestycje",
    start_url: "/investments",
    display: "standalone",
    background_color: "#0D0F12",
    theme_color: "#0D0F12",
    icons: [
      { src: "/icons/flip-manager-192.png?v=metron-1", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/flip-manager-maskable-512.png?v=metron-1", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
