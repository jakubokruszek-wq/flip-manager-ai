import type { NextConfig } from "next";

const supabaseImageHost = (() => {
  try { return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").hostname; }
  catch { return null; }
})();

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "ireland.apollo.olxcdn.com",
        port: "",
        pathname: "/**",
        search: "",
      },
      {
        protocol: "https",
        hostname: "img1.staticmorizon.com.pl",
        port: "",
        pathname: "/**",
        search: "",
      },
      {
        protocol: "https",
        hostname: "scontent-*.fbcdn.net",
        port: "",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "scontent.*.fbcdn.net",
        port: "",
        pathname: "/**",
      },
      ...(supabaseImageHost ? [{
        protocol: "https" as const,
        hostname: supabaseImageHost,
        port: "",
        pathname: "/storage/v1/object/public/facebook-watcher-images/**",
        search: "",
      }] : []),
    ],
  },
};

export default nextConfig;
