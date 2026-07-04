import type { NextConfig } from "next";

const HOST_ORIGIN = process.env.WINGMAN_HOST_ORIGIN || "http://localhost:3000";

const nextConfig: NextConfig = {
  eslint: {
    // The monorepo root ships a host-specific ESLint setup (nanoclaw's) that
    // next build would otherwise pick up; the dashboard is typechecked via
    // `tsc --noEmit` and the build's type-validity pass instead.
    ignoreDuringBuilds: true,
  },
  async rewrites() {
    return [
      {
        source: "/webhook/:path*",
        destination: `${HOST_ORIGIN}/webhook/:path*`,
      },
    ];
  },
};

export default nextConfig;
