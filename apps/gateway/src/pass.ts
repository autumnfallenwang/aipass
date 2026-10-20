import {
  agentUrl,
  PASS_MAX_SECONDS,
  type PassClaims,
  PassClaims as PassClaimsSchema,
} from "@aipass/shared";
import {
  createRemoteJWKSet,
  decodeJwt,
  errors,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from "jose";
import * as z from "zod";
import type { Defect } from "./broken.ts";
import type { TrustedIssuer } from "./config.ts";

/** `clientId` is the OAuth client that holds the pass (OAuth passes only). */
export type PassResult =
  | { ok: true; claims: PassClaims; clientId?: string }
  | { ok: false; error: string };

/** What the api signs when an admin asks to preview a chart. */
export const PreviewClaims = z.object({
  iss: z.string(),
  sub: z.string(),
  jti: z.string(),
  exp: z.number(),
  iat: z.number(),
  preview: z.union([
    z.object({ roleId: z.string().min(1), personId: z.string().min(1) }),
    z.object({ agentId: z.string().min(1), personId: z.string().min(1) }),
  ]),
});
export type PreviewClaims = z.infer<typeof PreviewClaims>;
export type PreviewResult = { ok: true; claims: PreviewClaims } | { ok: false; error: string };

const ALLOWED_ALGS = ["ES256", "RS256", "EdDSA", "PS256"];
const CLOCK_SKEW_SECONDS = 10;

/**
 * Verifies a pass offline: signature against a trusted issuer's keys, the
 * audience is *this agent's* gateway URL, it hasn't expired, it isn't
 * longer-lived than a pass may be, and it names this agent as the actor.
 */
export class PassVerifier {
  private readonly keySets = new Map<string, JWTVerifyGetKey>();

  constructor(
    private readonly gatewayUrl: string,
    issuers: TrustedIssuer[],
    /** Tests inject local key sets here. */
    keySets?: Map<string, JWTVerifyGetKey>,
    /** Planted defects (S4 self-test only). */
    private readonly broken: ReadonlySet<Defect> = new Set(),
  ) {
    for (const i of issuers) {
      this.keySets.set(i.issuer, keySets?.get(i.issuer) ?? createRemoteJWKSet(new URL(i.jwksUri)));
    }
  }

  /** A preview request from the api: signed by the api's own key, for the preview endpoint only. */
  async verifyPreview(
    authorization: string | undefined,
    apiIssuer: string,
  ): Promise<PreviewResult> {
    const token = authorization?.match(/^Bearer\s+(\S+)$/)?.[1];
    if (!token) return { ok: false, error: "missing" };
    const keys = this.keySets.get(apiIssuer);
    if (!keys) return { ok: false, error: "untrusted issuer" };
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: apiIssuer,
        audience: `${this.gatewayUrl}/internal/preview`,
        algorithms: ALLOWED_ALGS,
        clockTolerance: CLOCK_SKEW_SECONDS,
        maxTokenAge: 120,
      });
      const parsed = PreviewClaims.safeParse(payload);
      return parsed.success
        ? { ok: true, claims: parsed.data }
        : { ok: false, error: "missing claims" };
    } catch {
      return { ok: false, error: "invalid" };
    }
  }

  async verify(authorization: string | undefined, agentId: string): Promise<PassResult> {
    const audience = agentUrl(this.gatewayUrl, agentId);
    if (!authorization) {
      if (this.broken.has("require_pass")) return this.plantedDefaultPass(agentId, audience);
      return { ok: false, error: "missing" };
    }
    const m = authorization.match(/^Bearer\s+([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)$/);
    if (!m?.[1]) return { ok: false, error: "malformed" };
    const token = m[1];

    let decoded: JWTPayload;
    try {
      decoded = decodeJwt(token);
    } catch {
      return { ok: false, error: "malformed" };
    }
    const iss = decoded.iss;
    const keys = iss ? this.keySets.get(iss) : undefined;
    if (!iss || !keys) return { ok: false, error: "untrusted issuer" };

    if (this.broken.has("signature")) return this.checkUnsigned(decoded, audience, agentId);

    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: iss,
        audience: this.broken.has("audience") ? undefined : audience,
        algorithms: ALLOWED_ALGS,
        clockTolerance: CLOCK_SKEW_SECONDS,
        requiredClaims: ["exp", "iat", "sub", "jti"],
        // planted defect: judge expiry as if it were still the moment of issue
        currentDate:
          this.broken.has("expiry") && decoded.iat ? new Date(decoded.iat * 1000) : undefined,
      });
      return this.checkClaims(payload, agentId);
    } catch (err) {
      if (err instanceof errors.JWTExpired) return { ok: false, error: "expired" };
      if (err instanceof errors.JWTClaimValidationFailed && err.claim === "aud") {
        return { ok: false, error: "wrong audience" };
      }
      if (err instanceof errors.JWSSignatureVerificationFailed) {
        return { ok: false, error: "bad signature" };
      }
      if (err instanceof errors.JWKSNoMatchingKey) {
        return { ok: false, error: "unknown signing key" };
      }
      return { ok: false, error: "invalid" };
    }
  }

  /** The checks after the signature: claims present, lifetime, the actor is this agent. */
  private checkClaims(payload: JWTPayload, agentId: string): PassResult {
    const parsed = PassClaimsSchema.safeParse(payload);
    if (!parsed.success) return { ok: false, error: "missing claims" };
    const claims = parsed.data;
    if (claims.exp - claims.iat > PASS_MAX_SECONDS + CLOCK_SKEW_SECONDS) {
      return { ok: false, error: "lifetime too long" };
    }
    if (claims.act.sub !== agentId) return { ok: false, error: "issued to a different agent" };
    const clientId = typeof payload.client_id === "string" ? payload.client_id : undefined;
    return { ok: true, claims, clientId };
  }

  /** Planted defect "signature": everything is checked except who signed it. */
  private checkUnsigned(decoded: JWTPayload, audience: string, agentId: string): PassResult {
    const now = Date.now() / 1000;
    if (!this.broken.has("expiry") && (decoded.exp ?? 0) < now - CLOCK_SKEW_SECONDS) {
      return { ok: false, error: "expired" };
    }
    if (!this.broken.has("audience") && ![decoded.aud].flat().includes(audience)) {
      return { ok: false, error: "wrong audience" };
    }
    return this.checkClaims(decoded, agentId);
  }

  /** Planted defect "require_pass": no pass at all is treated as the default person's pass. */
  private plantedDefaultPass(agentId: string, audience: string): PassResult {
    const now = Math.floor(Date.now() / 1000);
    const person = process.env.AIPASS_BROKEN_PERSON ?? "maria";
    return this.checkClaims(
      {
        iss: "planted-defect",
        sub: person,
        aud: audience,
        iat: now,
        exp: now + 60,
        jti: `planted-${now}`,
        act: { sub: agentId },
        patient: person,
      },
      agentId,
    );
  }
}
