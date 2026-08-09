import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Flip Manager by Jakub Okruszek",
    short_name: "Flip Manager",
    description: "Flip Manager by Jakub Okruszek",
    start_url: "/flip-finder",
    display: "standalone",
    background_color: "#0D0F12",
    theme_color: "#0D0F12",
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
