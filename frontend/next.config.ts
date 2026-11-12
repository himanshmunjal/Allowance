import type { NextConfig } from "next";

// The UI calls relative /api/* URLs; Next proxies them to the backend service, so the browser
// sees a single origin (no CORS, PayPal redirects work unchanged). BACKEND_URL is read at
// build time and at dev-server start.
const backendUrl = (process.env.BACKEND_URL ?? "http://localhost:4000").replace(/\/$/, "");

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    // The /api rewrite proxy drops the socket after 30s by default (ECONNRESET "socket hang up").
    // AI routes like /api/policy/parse can take longer: provider timeout + retry + fallback chain.
    proxyTimeout: 180_000,
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${backendUrl}/api/:path*` }];
  },
};

export default nextConfig;
