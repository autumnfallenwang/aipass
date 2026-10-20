import {
  Client,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { E2E } from "./env.ts";

export const CALLBACK = "http://localhost:4999/callback";

/** An MCP client's OAuth state, kept in memory. Registers itself (DCR), then PKCE. */
class MemoryOAuth implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier = "";
  authorizationUrl?: URL;

  get redirectUrl() {
    return CALLBACK;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "aipass e2e client",
      redirect_uris: [CALLBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "openid offline_access",
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(t: OAuthTokens) {
    this.saved = t;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
}

/**
 * Plays an AI app that only knows the agent's gateway URL. `start()` runs
 * discovery and registration and stops at "send the user here"; `finish()`
 * takes the browser's callback URL and connects with the issued token.
 */
export function oauthAgent(agentId: string) {
  const oauth = new MemoryOAuth();
  const url = new URL(`${E2E.gateway}/agents/${agentId}/mcp`);
  let client: Client | undefined;

  return {
    oauth,
    async start(): Promise<string> {
      const c = new Client({ name: "aipass-e2e", version: "0.0.0" });
      try {
        await c.connect(new StreamableHTTPClientTransport(url, { authProvider: oauth }));
        throw new Error("expected the gateway to ask for authorization");
      } catch (err) {
        if (!(err instanceof UnauthorizedError)) throw err;
      }
      if (!oauth.authorizationUrl) throw new Error("no authorization URL");
      return oauth.authorizationUrl.toString();
    },
    async finish(callbackUrl: string) {
      const t = new StreamableHTTPClientTransport(url, { authProvider: oauth });
      await t.finishAuth(new URL(callbackUrl).searchParams);
      client = new Client({ name: "aipass-e2e", version: "0.0.0" });
      await client.connect(new StreamableHTTPClientTransport(url, { authProvider: oauth }));
    },
    async call(name: string, args: Record<string, unknown> = {}) {
      if (!client) throw new Error("not connected");
      const r = await client.callTool({ name, arguments: args });
      const text = (r.content as { text?: string }[]).map((c) => c.text ?? "").join("\n");
      return { text, refused: r.isError === true };
    },
    accessToken: () => oauth.saved?.access_token ?? "",
    refreshToken: () => oauth.saved?.refresh_token ?? "",
    clientId: () => (oauth.info as { client_id?: string } | undefined)?.client_id ?? "",
    close: () => client?.close(),
  };
}

export function claimsOf(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"));
}
