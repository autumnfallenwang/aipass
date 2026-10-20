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
