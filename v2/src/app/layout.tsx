import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tommy Tomato: Harvest Souls — v2",
  description:
    "A tomato soulslike, rebuilt on a WebGL renderer. Real lighting, particles, and animation. Next.js + React + PixiJS, co-op over PeerJS.",
};

export const viewport: Viewport = {
  themeColor: "#0d0a09",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
