"use client";

import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { passkeyClient } from "@better-auth/passkey/client";
import { ssoClient } from "@better-auth/sso/client";
import { createAuthClient } from "better-auth/react";

/**
 * `oauthProviderClient` carries the signed OAuth request from the page's URL
 * into sign-in and consent calls, so an AI app's login continues afterwards.
 */
export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [passkeyClient(), oauthProviderClient(), ssoClient()],
});

/** True on a page an OAuth authorization request redirected to. */
export function inOAuthFlow(): boolean {
  if (typeof window === "undefined") return false;
  const q = new URLSearchParams(window.location.search);
  return q.has("client_id") && q.has("sig");
}

/** Follows the `{redirect, url}` Better Auth answers with mid-flow. Returns true if it navigated. */
export function followRedirect(data: unknown): boolean {
  const d = data as { redirect?: boolean; url?: string } | null;
  if (d?.url && (d.redirect ?? true)) {
    window.location.href = d.url;
    return true;
  }
  return false;
}
