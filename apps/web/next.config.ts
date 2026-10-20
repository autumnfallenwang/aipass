import type { NextConfig } from "next";

const apiUrl = (process.env.API_URL ?? "http://localhost:3001").replace(/\/$/, "");

const config: NextConfig = {
  transpilePackages: ["@aipass/shared"],
  poweredByHeader: false,
  // The end-to-end tests run a second dev server next to yours.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // One public origin: the browser only ever talks to this app, and /api/*
  // (Better Auth, admin API) is passed through to the api. Cookies and
  // passkeys therefore belong to a single origin.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/api/:path*` }];
  },
};

export default config;
