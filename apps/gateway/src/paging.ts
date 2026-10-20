import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Group } from "@aipass/shared";

/**
 * A paging token wraps the FHIR server's own "next" links. It is encrypted
 * and authenticated (AES-256-GCM), so an agent can neither read the internal
 * FHIR address nor edit the link. It is bound to the agent, the patient and
 * the group, and every page it leads to is filtered again.
 */
export type PagePayload = {
  agentId: string;
  patientRef: string;
  group: Group;
  links: string[];
  exp: number;
};

function keyOf(secret: Buffer): Buffer {
  return createHash("sha256").update("aipass-page-token").update(secret).digest();
}

export function sealPage(secret: Buffer, p: Omit<PagePayload, "exp">, ttlSeconds = 600): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyOf(secret), iv);
  const plain = JSON.stringify({ ...p, exp: Math.floor(Date.now() / 1000) + ttlSeconds });
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

export function openPage(
  secret: Buffer,
  token: string,
  expect: { agentId: string; patientRef: string; group: Group },
): PagePayload | null {
  let p: PagePayload;
  try {
    const raw = Buffer.from(token, "base64url");
    if (raw.length < 29) return null;
    const decipher = createDecipheriv("aes-256-gcm", keyOf(secret), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    p = JSON.parse(plain.toString("utf8")) as PagePayload;
  } catch {
    return null;
  }
  if (p.exp < Date.now() / 1000) return null;
  if (
    p.agentId !== expect.agentId ||
    p.patientRef !== expect.patientRef ||
    p.group !== expect.group
  ) {
    return null;
  }
  return p;
}
