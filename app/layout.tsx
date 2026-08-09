import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { ThemeProvider } from "@/providers/theme-provider";
import { themeInitializationScript } from "@/providers/theme-script";
import { PwaServiceWorker } from "@/components/pwa-service-worker";
import { APP_DESCRIPTION, APP_NAME } from "@/lib/constants";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: APP_NAME,
    template: `%s | ${APP_NAME}`,
  },
  description: APP_DESCRIPTION,
  applicationName: "Flip Manager",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Flip Manager" },
};

export const viewport: Viewport = { themeColor: "#0D0F12", colorScheme: "dark", viewportFit: "cover" };

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="pl"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitializationScript() }} />
      </head>
      <body className="min-h-full bg-background font-sans text-foreground">
        <ThemeProvider defaultTheme="dark">
          {children}
          <PwaServiceWorker />
        </ThemeProvider>
      </body>
    </html>
  );
}
