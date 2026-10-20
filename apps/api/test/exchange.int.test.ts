/**
 * S6: RFC 8693 token exchange for headless agents, against a real Keycloak
 * (the stand-in hospital login, `docker compose --profile keycloak up -d`)
 * and a tiny in-test identity provider for the cases Keycloak won't produce.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDb, runMigrations, seedDemo } from "@aipass/db";
import { FhirClient } from "@aipass/fhir";
import {
  type CryptoKey,
  decodeJwt,
  exportJWK,
  generateKeyPair,
  type JWTPayload,
  SignJWT,
} from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";
import { config } from "../src/config.ts";
import { TOKEN_EXCHANGE } from "../src/token-exchange.ts";

const DB =
  process.env.EXCHANGE_DATABASE_URL ??
  "postgres://aipass:aipass@127.0.0.1:5433/aipass_exchange_test";
const KEYCLOAK = process.env.KEYCLOAK_URL ?? "http://localhost:8180/realms/sunrise";
const ORIGIN = config.publicUrl;
const COACH_URL = `${config.gatewayUrl}/agents/diabetes-coach/mcp`;
const ACCESS_TOKEN = "urn:ietf:params:oauth:token-type:access_token";

let app: ReturnType<typeof createApp>;
let close: () => Promise<void>;
let admin = "";
let client = { id: "", secret: "" };
let testIdp: Server;
let testIdpUrl = "";
let testIdpKey: CryptoKey;

async function json(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

async function keycloakToken(
  username: string,
  password: string,
  clientId = "coach-cli",
): Promise<string> {
  const res = await fetch(`${KEYCLOAK}/protocol/openid-connect/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "password",
      client_id: clientId,
      username,
      password,
      scope: "openid",
    }),
  });
  const body = await json(res);
  if (!res.ok) throw new Error(`keycloak: ${JSON.stringify(body)}`);
  return body.access_token as string;
}

async function testIdpToken(claims: JWTPayload): Promise<string> {
  return new SignJWT({ email: "maria@example.org", email_verified: true, ...claims })
    .setProtectedHeader({ alg: "ES256", kid: "test-idp" })
    .setIssuer(testIdpUrl)
    .setSubject("maria-at-test-idp")
    .setAudience("aipass")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(testIdpKey);
}

async function exchange(
  subjectToken: string,
  opts: { auth?: string | null; resource?: string; extra?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    origin: ORIGIN,
  };
  const auth =
    opts.auth === undefined
      ? `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString("base64")}`
      : opts.auth;
  if (auth) headers.authorization = auth;
  return app.request("/api/auth/oauth2/token", {
    method: "POST",
    headers,
    body: new URLSearchParams({
      grant_type: TOKEN_EXCHANGE,
      subject_token: subjectToken,
      subject_token_type: ACCESS_TOKEN,
      resource: opts.resource ?? COACH_URL,
      ...opts.extra,
    }),
  });
}

beforeAll(async () => {
  // a fresh database
  const u = new URL(DB);
  const name = u.pathname.slice(1);
  u.pathname = "/postgres";
  const pg = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await pg.unsafe(`drop database if exists "${name}" with (force)`);
  await pg.unsafe(`create database "${name}"`);
  await pg.end();
  await runMigrations(DB);
  const made = createDb(DB);
  close = made.close;
  await seedDemo(made.db);
  app = createApp({
    db: made.db,
    auth: createAuth(made.db),
    fhir: new FhirClient({ baseUrl: "http://127.0.0.1:8080/fhir" }),
  });

  // the in-test identity provider
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  testIdpKey = privateKey;
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-idp", alg: "ES256" };
  testIdp = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/.well-known/openid-configuration") {
      res.end(JSON.stringify({ issuer: testIdpUrl, jwks_uri: `${testIdpUrl}/jwks` }));
    } else res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((r) => testIdp.listen(0, "127.0.0.1", r));
  testIdpUrl = `http://127.0.0.1:${(testIdp.address() as AddressInfo).port}`;

  // the first account is the admin
  const signup = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({
      name: "Ada",
      email: "admin@example.org",
      password: "a-long-password-1",
    }),
  });
  admin = (signup.headers.getSetCookie() ?? []).map((c) => c.split(";")[0]).join("; ");
  const asAdmin = async (path: string, body?: unknown) => {
    const res = await app.request(`/api/admin${path}`, {
      method: "POST",
      headers: { cookie: admin, "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify(body ?? {}),
    });
    if (res.status >= 300) console.error(path, res.status, await res.clone().text());
    return res;
  };

  // Maria's aipass login uses the same verified email as her hospital login
  expect(
    (
      await asAdmin("/persons/maria/login", {
        email: "maria@example.org",
        password: "maria-aipass-pw",
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await asAdmin("/connections", {
        name: "Sunrise Clinic login",
        issuer: KEYCLOAK,
        audience: "aipass",
      })
    ).status,
  ).toBe(201);
  expect(
    (await asAdmin("/connections", { name: "Test IdP", issuer: testIdpUrl, audience: "aipass" }))
      .status,
  ).toBe(201);
  const created = await json(await asAdmin("/agents/diabetes-coach/headless-client"));
  client = { id: created.clientId as string, secret: created.clientSecret as string };
  expect(client.secret).toBeTruthy();
}, 60_000);

afterAll(async () => {
  testIdp?.close();
  await close?.();
});

describe("RFC 8693 token exchange", () => {
  it("swaps Maria's hospital token, presented by the coach's own client, for a pass", async () => {
    const res = await exchange(await keycloakToken("maria", "maria-kc-password"));
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.issued_token_type).toBe(ACCESS_TOKEN);
    expect(body.refresh_token).toBeUndefined();
    const claims = decodeJwt(body.access_token as string);
    expect(claims.act).toEqual({ sub: "diabetes-coach" });
    expect(claims.patient).toBe("maria");
    expect([claims.aud].flat()).toContain(COACH_URL);
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(300);
    expect(claims.iss).toBe(`${ORIGIN}/api/auth`);
  });

  it("refuses an untrusted issuer", async () => {
    const { privateKey } = await generateKeyPair("ES256");
    const forged = await new SignJWT({ email: "maria@example.org", email_verified: true })
      .setProtectedHeader({ alg: "ES256" })
      .setIssuer("https://evil.example")
      .setSubject("x")
      .setAudience("aipass")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const body = await json(await exchange(forged));
    expect(body).toMatchObject({
      error: "invalid_grant",
      error_description: "untrusted issuer: https://evil.example",
    });
  });

  it("refuses a token signed with the wrong key for a trusted issuer", async () => {
    const { privateKey } = await generateKeyPair("ES256");
    const forged = await new SignJWT({ email: "maria@example.org", email_verified: true })
      .setProtectedHeader({ alg: "ES256", kid: "test-idp" })
      .setIssuer(testIdpUrl)
      .setSubject("x")
      .setAudience("aipass")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    expect(await json(await exchange(forged))).toMatchObject({ error: "invalid_grant" });
  });

  it("refuses a token meant for someone else (wrong audience)", async () => {
    const other = await keycloakToken("maria", "maria-kc-password", "other-app");
    const body = await json(await exchange(other));
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description).toContain("isn't for aipass");
  });

  it("refuses when the agent doesn't authenticate as itself (missing actor authentication)", async () => {
    const token = await keycloakToken("maria", "maria-kc-password");
    const none = await exchange(token, { auth: null });
    expect(none.status).toBe(401);
    expect((await json(none)).error).toBe("invalid_client");
    const wrongSecret = await exchange(token, {
      auth: `Basic ${Buffer.from(`${client.id}:not-the-secret`).toString("base64")}`,
    });
    expect(wrongSecret.status).toBe(401);
  });

  it.each([
    ["act", { act: { sub: "some-other-agent" } }],
    ["may_act", { may_act: { sub: "x" } }],
    ["cnf", { cnf: { jkt: "abc" } }],
  ])("refuses a subject token carrying %s (an unknown claim)", async (name, claims) => {
    const body = await json(await exchange(await testIdpToken(claims)));
    expect(body).toMatchObject({ error: "invalid_grant" });
    expect(body.error_description).toContain(name);
  });

  it("refuses an unverified email and an unknown person", async () => {
    const unverified = await json(await exchange(await testIdpToken({ email_verified: false })));
    expect(unverified.error_description).toContain("no verified email");
    const stranger = await json(
      await exchange(await testIdpToken({ email: "stranger@example.org" })),
    );
    expect(stranger.error_description).toContain("nobody in aipass");
    // Keycloak's own unverified user
    const mallory = await json(
      await exchange(await keycloakToken("mallory", "mallory-kc-password")),
    );
    expect(mallory.error_description).toContain("no verified email");
  });

  it("refuses an agent this client isn't approved to act as", async () => {
    const body = await json(
      await exchange(await keycloakToken("maria", "maria-kc-password"), {
        resource: `${config.gatewayUrl}/agents/scheduling-assistant/mcp`,
      }),
    );
    expect(body.error).toBe("invalid_target");
  });

  it("refuses an unsupported subject token type and nested actor tokens", async () => {
    const token = await keycloakToken("maria", "maria-kc-password");
    const t = await json(
      await exchange(token, {
        extra: { subject_token_type: "urn:ietf:params:oauth:token-type:saml2" },
      }),
    );
    expect(t.error).toBe("invalid_request");
    const a = await json(await exchange(token, { extra: { actor_token: "x" } }));
    expect(a.error).toBe("invalid_request");
  });

  it("stops trusting a connection the admin disables", async () => {
    await app.request("/api/admin/connections/sunrise-clinic-login/disable", {
      method: "POST",
      headers: { cookie: admin, origin: ORIGIN },
    });
    const body = await json(await exchange(await keycloakToken("maria", "maria-kc-password")));
    expect(body.error_description).toContain("untrusted issuer");
    await app.request("/api/admin/connections/sunrise-clinic-login/enable", {
      method: "POST",
      headers: { cookie: admin, origin: ORIGIN },
    });
  });
});
