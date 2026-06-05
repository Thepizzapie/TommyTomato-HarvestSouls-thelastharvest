/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // the game loop manages its own lifecycle; double-invoke in dev would spawn two loops
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
