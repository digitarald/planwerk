import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Geist_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Planwerk",
  description: "AI-first SDLC work management",
  icons: {
    icon: [
      { url: "/logo-light-32.png", sizes: "32x32", type: "image/png", media: "(prefers-color-scheme: light)" },
      { url: "/logo-light-64.png", sizes: "64x64", type: "image/png", media: "(prefers-color-scheme: light)" },
      { url: "/logo-light-128.png", sizes: "128x128", type: "image/png", media: "(prefers-color-scheme: light)" },
      { url: "/logo-dark-32.png", sizes: "32x32", type: "image/png", media: "(prefers-color-scheme: dark)" },
      { url: "/logo-dark-64.png", sizes: "64x64", type: "image/png", media: "(prefers-color-scheme: dark)" },
      { url: "/logo-dark-128.png", sizes: "128x128", type: "image/png", media: "(prefers-color-scheme: dark)" },
    ],
    apple: [
      { url: "/logo-light-256.png", sizes: "256x256", type: "image/png", media: "(prefers-color-scheme: light)" },
      { url: "/logo-dark-256.png", sizes: "256x256", type: "image/png", media: "(prefers-color-scheme: dark)" },
    ],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} ${geistMono.variable} h-full`}>
      <body className="h-full overflow-hidden bg-background text-foreground font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
