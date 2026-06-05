import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tommy Tomato: Harvest Souls",
  description:
    "A Temu-budget soulslike. You are Tommy, a tomato. The harvest is coming. Roll, parry, and ripen against the agricultural hellscape — solo or in co-op.",
  applicationName: "Tommy Tomato",
  authors: [{ name: "The Compost Heap" }],
  keywords: ["soulslike", "tomato", "co-op", "browser game", "next.js"],
};

export const viewport: Viewport = {
  themeColor: "#0d0a09",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="grain" aria-hidden />
        <div className="vignette" aria-hidden />
        {children}
      </body>
    </html>
  );
}
