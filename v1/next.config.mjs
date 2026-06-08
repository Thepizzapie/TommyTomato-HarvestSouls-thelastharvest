/** @type {import('next').NextConfig} */
// On GitHub Pages the site is served under /<repo>/<v1|v2>/. CI sets
// NEXT_PUBLIC_BASE_PATH to that sub-path so asset + link URLs resolve correctly;
// left empty for local dev and any root-hosted deploy.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const nextConfig = {
  // Fully static export: `next build` emits a self-contained `out/` with no Node
  // server at runtime. Deployable to any static host — the only backend is the
  // public PeerJS cloud used for co-op signaling.
  output: "export",
  basePath: basePath || undefined,
  assetPrefix: basePath || undefined,
  // emit `route/index.html` so deep links resolve on static hosts
  trailingSlash: true,
  // No next/image is used, but the default image loader needs a server; disable
  // optimization so the export doesn't require one.
  images: { unoptimized: true },
  reactStrictMode: false, // the game loop manages its own lifecycle; double-invoke in dev would spawn two loops
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
