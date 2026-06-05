/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // the Pixi app manages its own lifecycle; double-invoke would boot two renderers
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
