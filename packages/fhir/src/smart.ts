import { createHash, randomBytes } from "node:crypto";

/**
 * The SMART on FHIR client calls aipass makes (S6): discovery, a standalone
 * patient launch with PKCE, the code exchange and refresh. Nothing here ever
 * hands a token to an agent; the api stores it and the gateway uses it.
 */

export type SmartEndpoints = { authorizeUrl: string; tokenUrl: string };

export type SmartClient = {
  tokenUrl: string;
  clientId: string;
  /** Confidential clients authenticate with client_secret_basic. */
  clientSecret?: string | null;
};

export type SmartTokens = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  /** The patient chosen at launch. aipass pins every call to it. */
  patient?: string;
  token_type?: string;
};

export class SmartError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = "SmartError";
  }
}

/** Reads `<base>/.well-known/smart-configuration`. */
export async function discoverSmart(
  baseUrl: string,
  doFetch: typeof fetch = fetch,
): Promise<SmartEndpoints> {
  const res = await doFetch(`${baseUrl.replace(/\/$/, "")}/.well-known/smart-configuration`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
    // No redirects: the server answers for itself or not at all.
    redirect: "error",
  });
  if (!res.ok) throw new SmartError(`SMART discovery answered ${res.status}`, res.status);
  const meta = (await res.json()) as { authorization_endpoint?: string; token_endpoint?: string };
  if (!meta.authorization_endpoint || !meta.token_endpoint) {
    throw new SmartError("SMART discovery has no authorization or token endpoint");
  }
  return { authorizeUrl: meta.authorization_endpoint, tokenUrl: meta.token_endpoint };
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** Where to send the person's browser for a standalone patient launch. */
export function authorizeUrl(p: {
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
  /** The FHIR base URL the token is for. */
  aud: string;
}): string {
  const u = new URL(p.authorizeUrl);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    scope: p.scope,
    state: p.state,
    aud: p.aud,
    code_challenge: p.codeChallenge,
    code_challenge_method: "S256",
  })) {
    u.searchParams.set(k, v);
  }
  return u.toString();
}

async function tokenRequest(
  c: SmartClient,
  form: Record<string, string>,
  doFetch: typeof fetch,
): Promise<SmartTokens> {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  const body = new URLSearchParams(form);
  if (c.clientSecret) {
    const enc = (s: string) => encodeURIComponent(s);
    headers.authorization = `Basic ${Buffer.from(`${enc(c.clientId)}:${enc(c.clientSecret)}`).toString("base64")}`;
  } else {
    body.set("client_id", c.clientId);
  }
  const res = await doFetch(c.tokenUrl, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  const json = (await res.json().catch(() => ({}))) as SmartTokens & { error?: string };
  // The error code only: a token endpoint's description can echo what we sent.
  if (!res.ok || !json.access_token)
    throw new SmartError(`token endpoint: ${json.error ?? res.status}`, res.status);
  return json;
}

export function exchangeCode(
  c: SmartClient,
  p: { code: string; redirectUri: string; codeVerifier: string },
  doFetch: typeof fetch = fetch,
): Promise<SmartTokens> {
  return tokenRequest(
    c,
    {
      grant_type: "authorization_code",
      code: p.code,
      redirect_uri: p.redirectUri,
      code_verifier: p.codeVerifier,
    },
    doFetch,
  );
}

export function refreshTokens(
  c: SmartClient,
  refreshToken: string,
  doFetch: typeof fetch = fetch,
): Promise<SmartTokens> {
  return tokenRequest(c, { grant_type: "refresh_token", refresh_token: refreshToken }, doFetch);
}
