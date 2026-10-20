import { join } from "node:path";
import type { NextConfig } from "next";

const apiUrl = (process.env.API_URL ?? "http://localhost:3001").replace(/\/$/, "");

const config: NextConfig = {
  transpilePackages: ["@aipass/shared"],
  // The Docker image (S7) runs Next's standalone server; dev and e2e don't.
  ...(process.env.NEXT_OUTPUT === "standalone"
    ? {
        output: "standalone" as const,
        outputFileTracingRoot: join(import.meta.dirname, "..", ".."),
      }
    : {}),
  poweredByHeader: false,
  devIndicators: false,
  // The end-to-end tests run a second dev server next to yours.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // One public origin: the browser only ever talks to this app, and /api/*
  // (Better Auth, admin API) is passed through to the api. Cookies and
  // passkeys therefore belong to a single origin.
  // Security headers (S7). The policy only goes into production builds:
  // `next dev` needs eval for hot reload.
  async headers() {
    if (process.env.NODE_ENV !== "production") return [];
    const csp = [
      "default-src 'self'",
      // Next inlines its bootstrap scripts and styles.
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'none'",
      "object-src 'none'",
    ].join("; ");
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "Strict-Transport-Security", value: "max-age=31536000" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${apiUrl}/api/:path*` },
      // OAuth discovery for the issuer `<this origin>/api/auth` (RFC 8414 path form).
      {
        source: "/.well-known/oauth-authorization-server/api/auth",
        destination: `${apiUrl}/.well-known/oauth-authorization-server/api/auth`,
      },
      {
        source: "/.well-known/openid-configuration/api/auth",
        destination: `${apiUrl}/.well-known/openid-configuration/api/auth`,
      },
    ];
  },
};

export default config;
