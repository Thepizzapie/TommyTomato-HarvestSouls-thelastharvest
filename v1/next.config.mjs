/** @type {import('next').NextConfig} */
const nextConfig = {
  // Fully static export: `next build` emits a self-contained `out/` with no Node
  // server at runtime. Deployable to any static host — the only backend is the
  // public PeerJS cloud used for co-op signaling.
  output: "export",
  // No next/image is used, but the default image loader needs a server; disable
  // optimization so the export doesn't require one.
  images: { unoptimized: true },
  reactStrictMode: false, // the game loop manages its own lifecycle; double-invoke in dev would spawn two loops
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
