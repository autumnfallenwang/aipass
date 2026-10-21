import * as z from "zod";

/** The words an admin sees. Each maps to FHIR in `@aipass/fhir`. */
export const GROUPS = [
  "labs",
  "vitals",
  "medications",
  "conditions",
  "appointments",
  "demographics",
  "notes",
] as const;
export const Group = z.enum(GROUPS);
export type Group = z.infer<typeof Group>;

export const GROUP_LABELS: Record<Group, { one: string; many: string }> = {
  labs: { one: "lab result", many: "lab results" },
  vitals: { one: "vital sign", many: "vital signs" },
  medications: { one: "medication", many: "medications" },
  conditions: { one: "condition", many: "conditions" },
  appointments: { one: "appointment", many: "appointments" },
  demographics: { one: "patient summary", many: "patient details" },
  notes: { one: "visit note", many: "visit notes" },
};

/** read = see it; propose = suggest a change the person must approve; write = change it directly. */
export const ACTIONS = ["read", "propose", "write"] as const;
export const Action = z.enum(ACTIONS);
export type Action = z.infer<typeof Action>;

/** A permission is one group + one action, written `labs:read`. */
export type Permission = `${Group}:${Action}`;
export const Permission = z.custom<Permission>(
  (v) =>
    typeof v === "string" &&
    GROUPS.includes(v.split(":")[0] as Group) &&
    ACTIONS.includes(v.split(":")[1] as Action) &&
    v.split(":").length === 2,
  { message: "permission must look like labs:read" },
);

export function permission(group: Group, action: Action): Permission {
  return `${group}:${action}`;
}

/** Patient fields a role may see in demographics. Anything else is masked out. */
export const PATIENT_FIELDS = [
  "name",
  "phone",
  "email",
  "birthDate",
  "gender",
  "address",
  "identifier",
  "maritalStatus",
] as const;
export const PatientField = z.enum(PATIENT_FIELDS);
export type PatientField = z.infer<typeof PatientField>;

export const RoleRule = z.object({
  group: Group,
  read: z.boolean(),
  propose: z.boolean(),
  write: z.boolean(),
});
export type RoleRule = z.infer<typeof RoleRule>;

export function rulesToPermissions(rules: readonly RoleRule[]): Permission[] {
  const out: Permission[] = [];
  for (const r of rules) {
    for (const a of ACTIONS) if (r[a]) out.push(permission(r.group, a));
  }
  return out;
}

export const AgentStatus = z.enum(["active", "stopped"]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const GrantStatus = z.enum(["active", "revoked"]);
export type GrantStatus = z.infer<typeof GrantStatus>;

/** A person the clinic has paused (S9): every AI acting for them is refused. */
export const PersonStatus = z.enum(["active", "suspended"]);
export type PersonStatus = z.infer<typeof PersonStatus>;

/** Who gave a grant (D19): the person, or the admin (test persons only). */
export const GrantSetBy = z.enum(["person", "admin"]);
export type GrantSetBy = z.infer<typeof GrantSetBy>;

const TITLE = /^(dr|prof|mr|mrs|ms|mx)\.?$/i;

/** The name a sentence uses: the first name, or a title and surname ("Dr. Lee"). */
export function firstName(displayName: string): string {
  const words = displayName.trim().split(/\s+/);
  const [first] = words;
  if (!first) return displayName;
  return words.length > 1 && TITLE.test(first) ? `${first} ${words.at(-1)}` : first;
}

/**
 * Security labels that are always refused, whatever a role says.
 * Matched on `meta.security` (system + code).
 */
export const V3_ACT_CODE = "http://terminology.hl7.org/CodeSystem/v3-ActCode";
export const V3_CONFIDENTIALITY = "http://terminology.hl7.org/CodeSystem/v3-Confidentiality";
export const V3_OBSERVATION_VALUE = "http://terminology.hl7.org/CodeSystem/v3-ObservationValue";

export type LockedLabel = {
  system: string;
  code: string;
  kind: "mental-health" | "substance-use" | "hiv" | "restricted";
};

export const LOCKED_LABELS: readonly LockedLabel[] = [
  { system: V3_ACT_CODE, code: "PSY", kind: "mental-health" },
  { system: V3_ACT_CODE, code: "PSYTHPN", kind: "mental-health" },
  { system: V3_ACT_CODE, code: "ETH", kind: "substance-use" },
  { system: V3_ACT_CODE, code: "SUD", kind: "substance-use" },
  { system: V3_ACT_CODE, code: "42CFRPart2", kind: "substance-use" },
  { system: V3_ACT_CODE, code: "HIV", kind: "hiv" },
  { system: V3_CONFIDENTIALITY, code: "R", kind: "restricted" },
  { system: V3_CONFIDENTIALITY, code: "V", kind: "restricted" },
];

/** Labels we recognise and that don't restrict anything. Every other label is refused (fail closed). */
export const HARMLESS_LABELS: readonly { system: string; code: string }[] = [
  { system: V3_CONFIDENTIALITY, code: "U" },
  { system: V3_CONFIDENTIALITY, code: "L" },
  { system: V3_CONFIDENTIALITY, code: "M" },
  { system: V3_CONFIDENTIALITY, code: "N" },
  { system: V3_OBSERVATION_VALUE, code: "HTEST" },
];

/** The pass: a short-lived JWT naming the person (`sub`) and the agent (`act.sub`). */
export const PassClaims = z.object({
  iss: z.string(),
  sub: z.string().min(1),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  iat: z.number(),
  jti: z.string().min(1),
  act: z.object({ sub: z.string().min(1) }),
  patient: z.string().min(1).optional(),
  scope: z.string().optional(),
});
export type PassClaims = z.infer<typeof PassClaims>;

/** Longest a pass may live. */
export const PASS_MAX_SECONDS = 300;

export const Decision = z.enum(["allow", "refuse"]);
export type Decision = z.infer<typeof Decision>;

export function agentUrl(gatewayUrl: string, agentId: string): string {
  return `${gatewayUrl.replace(/\/$/, "")}/agents/${agentId}/mcp`;
}

export function agentDeviceId(agentId: string): string {
  return `aipass-agent-${agentId}`;
}

/** Titles the admin UI shows for each group. */
export const GROUP_TITLES: Record<Group, string> = {
  labs: "Lab results",
  vitals: "Vital signs",
  medications: "Medications",
  conditions: "Conditions",
  appointments: "Appointments",
  demographics: "Patient details",
  notes: "Visit notes",
};

export const ACTION_TITLES: Record<Action, string> = {
  read: "See",
  propose: "Propose",
  write: "Change",
};

export const PATIENT_FIELD_TITLES: Record<PatientField, string> = {
  name: "Name",
  phone: "Phone",
  email: "Email",
  birthDate: "Birth date",
  gender: "Gender",
  address: "Address",
  identifier: "Medical record number",
  maritalStatus: "Marital status",
};

export const LOCKED_LABEL_TITLES: Record<LockedLabel["kind"], string> = {
  "mental-health": "Mental health",
  "substance-use": "Substance use",
  hiv: "HIV",
  restricted: "Restricted",
};

/**
 * The secrets `compose.yaml` ships with for a local trial (S7). They are
 * public, so they are refused unless aipass's public origin is loopback.
 */
export const LOCAL_TRIAL_SECRETS = {
  auth: "aipass-local-trial-auth-secret-localhost-only",
  vault: "aipass-local-trial-vault-key-localhost-only",
} as const;

/** True for http(s)://localhost, 127.x and [::1] origins. */
export function isLoopbackUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h.endsWith(".localhost") || /^127\./.test(h) || h === "::1";
  } catch {
    return false;
  }
}

/**
 * Where to go after sign-in, from a `?next=` value: only a path on this
 * origin. Anything else (`//evil.example`, `/\\evil`, `https://…`) is dropped,
 * so a crafted link can't send someone off-site after they sign in.
 */
export function safeNextPath(next: string | null | undefined): string | null {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\"))
    return null;
  for (const ch of next) if (ch.charCodeAt(0) < 0x20) return null;
  return next;
}

const IP_CHARS = /^[0-9a-fA-F:.]+$/;

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return null;
  }
  return (
    ((parts[0] ?? 0) << 24) | ((parts[1] ?? 0) << 16) | ((parts[2] ?? 0) << 8) | (parts[3] ?? 0)
  );
}

/** True when `ip` is one of the trusted proxies: exact addresses, or IPv4 CIDR ranges. */
export function isTrustedProxy(ip: string, trusted: readonly string[]): boolean {
  const bare = ip.replace(/^::ffff:/, "");
  for (const t of trusted) {
    const [net, bits] = t.split("/");
    if (!net) continue;
    if (bits === undefined) {
      if (bare === net || ip === net) return true;
      continue;
    }
    const a = ipv4ToInt(bare);
    const b = ipv4ToInt(net);
    const n = Number(bits);
    if (a === null || b === null || !(n >= 0 && n <= 32)) continue;
    const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
    if ((a & mask) >>> 0 === (b & mask) >>> 0) return true;
  }
  return false;
}

/**
 * The caller's address: the socket's, unless the socket is a trusted proxy;
 * then the rightmost `X-Forwarded-For` entry that isn't one. A client can't
 * pick its own address by sending the header.
 */
export function clientAddress(
  socket: string | undefined,
  forwardedFor: string | undefined,
  trusted: readonly string[],
): string {
  if (!socket) return "unknown";
  if (!forwardedFor || !isTrustedProxy(socket, trusted)) return socket;
  const hops = forwardedFor
    .split(",")
    .map((h) => h.trim())
    .filter((h) => IP_CHARS.test(h));
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i] as string;
    if (!isTrustedProxy(hop, trusted)) return hop;
  }
  return socket;
}
