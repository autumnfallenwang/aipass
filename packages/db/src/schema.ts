import type { AgentStatus, GrantStatus, PatientField, Permission, RoleRule } from "@aipass/shared";
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema.ts";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** The ceiling: what that kind of AI may ever do. */
export const roles = pgTable("roles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  rules: jsonb("rules").$type<RoleRule[]>().notNull().default(sql`'[]'::jsonb`),
  patientFields: jsonb("patient_fields")
    .$type<PatientField[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** One AI the clinic lets in. */
export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  roleId: text("role_id")
    .notNull()
    .references(() => roles.id),
  status: text("status").$type<AgentStatus>().notNull().default("active"),
  fhirDeviceId: text("fhir_device_id"),
  /** Where this agent's records live (S6). Null: aipass's own FHIR server. */
  fhirServerId: text("fhir_server_id").references(() => fhirServers.id),
  createdBy: text("created_by"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Who an agent acts for. */
export const persons = pgTable(
  "persons",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    /** `Patient/<id>` or `Practitioner/<id>` in the FHIR server. */
    fhirRef: text("fhir_ref").notNull(),
    /** The person's login (S3). */
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("persons_user_id_idx").on(t.userId)],
);

/**
 * Which AI apps (OAuth clients) may connect as which agent. The admin decides;
 * Better Auth's own client↔resource links are kept in step with this table.
 * Claude Code, for instance, is `https://claude.ai/oauth/claude-code-client-metadata`.
 */
export const agentClients = pgTable(
  "agent_clients",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.clientId] })],
);

/** The person's "yes", inside the role. */
export const grants = pgTable(
  "grants",
  {
    id: text("id").primaryKey(),
    personId: text("person_id")
      .notNull()
      .references(() => persons.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    permissions: jsonb("permissions").$type<Permission[]>().notNull().default(sql`'[]'::jsonb`),
    status: text("status").$type<GrantStatus>().notNull().default("active"),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("grants_person_agent_idx").on(t.personId, t.agentId)],
);

/** One line per request, refusals included. Hash-chained so edits show. */
export const receipts = pgTable(
  "receipts",
  {
    id: text("id").primaryKey(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    agentId: text("agent_id").notNull(),
    personId: text("person_id"),
    tool: text("tool"),
    action: text("action").notNull(),
    group: text("group_name"),
    target: text("target"),
    decision: text("decision").$type<"allow" | "refuse">().notNull(),
    rule: integer("rule"),
    code: text("code"),
    reason: text("reason"),
    sentence: text("sentence").notNull(),
    count: integer("count").notNull().default(0),
    withheld: integer("withheld").notNull().default(0),
    passJti: text("pass_jti"),
    mode: text("mode").$type<"live" | "preview">().notNull().default("live"),
    auditEventId: text("audit_event_id"),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [
    uniqueIndex("receipts_seq_idx").on(t.seq),
    index("receipts_agent_idx").on(t.agentId, t.ts),
    index("receipts_person_idx").on(t.personId, t.ts),
  ],
);

/** Signing keys for passes the api mints itself (dev passes, token exchange). */
export const passKeys = pgTable("pass_keys", {
  kid: text("kid").primaryKey(),
  alg: text("alg").notNull(),
  publicJwk: jsonb("public_jwk").$type<Record<string, unknown>>().notNull(),
  privateJwk: jsonb("private_jwk").$type<Record<string, unknown>>().notNull(),
  createdAt: createdAt(),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
});

export type ApprovalStatus = "pending" | "approved" | "used" | "denied" | "expired";

/**
 * The person's OK for one exact change (S5). The agent proposes; the approver
 * signs a passkey challenge bound to the payload hash; the agent commits the
 * same payload within two minutes, once.
 */
export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    /** Who the change is for (the pass's person). */
    personId: text("person_id").notNull(),
    /** Who must approve: the patient by default, or a named person (approval rules). */
    approverPersonId: text("approver_person_id").notNull(),
    action: text("action").$type<"create">().notNull(),
    group: text("group_name").notNull(),
    resourceType: text("resource_type").notNull(),
    /** The exact resource that will be written. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /** sha256 over the RFC 8785 canonical JSON of `payload`. */
    payloadHash: text("payload_hash").notNull(),
    /** What the approver is shown, in plain words. */
    summary: text("summary").notNull(),
    /** Mixed into the passkey challenge so one approval can't sign another. */
    nonce: text("nonce").notNull(),
    status: text("status").$type<ApprovalStatus>().notNull().default("pending"),
    passJti: text("pass_jti"),
    createdAt: createdAt(),
    /** A pending proposal is dropped after this. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedByUserId: text("approved_by_user_id"),
    credentialId: text("credential_id"),
    deniedAt: timestamp("denied_at", { withTimezone: true }),
    usedAt: timestamp("used_at", { withTimezone: true }),
    /** `Observation/<id>` once written. */
    resultRef: text("result_ref"),
  },
  (t) => [index("approvals_person_idx").on(t.personId, t.status)],
);

/** Who approves which proposals: per role and group. No row means "the patient". */
export const approvalRules = pgTable(
  "approval_rules",
  {
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    group: text("group_name").notNull(),
    approverPersonId: text("approver_person_id").references(() => persons.id, {
      onDelete: "cascade",
    }),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.group] })],
);

/**
 * Trusted identity providers (S6): a hospital's own login, Google, any OIDC
 * issuer. Only tokens from an enabled connection are accepted for token
 * exchange, and only connections with a login client offer sign-in.
 */
export const connections = pgTable("connections", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  issuer: text("issuer").notNull().unique(),
  jwksUri: text("jwks_uri").notNull(),
  /** The `aud` a subject token must carry to be exchanged here (e.g. "aipass"). */
  audience: text("audience").notNull(),
  /** Better Auth SSO provider id, when people and admins can sign in with it. */
  ssoProviderId: text("sso_provider_id"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
});

/**
 * FHIR servers other than aipass's own (S6): an EHR that speaks SMART on
 * FHIR. A person connects their record there once (a SMART standalone
 * launch); the gateway then reads it for them with the token in the vault.
 */
export const fhirServers = pgTable("fhir_servers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull().unique(),
  authorizeUrl: text("authorize_url").notNull(),
  tokenUrl: text("token_url").notNull(),
  clientId: text("client_id").notNull(),
  /** Sealed with the vault key; null for a public client. */
  clientSecretSealed: text("client_secret_sealed"),
  scope: text("scope").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
});

/** A SMART launch in progress: single use, 10 minutes. */
export const smartLaunches = pgTable("smart_launches", {
  state: text("state").primaryKey(),
  personId: text("person_id")
    .notNull()
    .references(() => persons.id, { onDelete: "cascade" }),
  serverId: text("server_id")
    .notNull()
    .references(() => fhirServers.id, { onDelete: "cascade" }),
  codeVerifier: text("code_verifier").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/**
 * The vault: a person's tokens for one FHIR server, sealed (AES-256-GCM,
 * bound to the person and server). Only the gateway opens it; agents never
 * see what's inside. The patient is pinned from the launch.
 */
export const vault = pgTable(
  "vault",
  {
    personId: text("person_id")
      .notNull()
      .references(() => persons.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => fhirServers.id, { onDelete: "cascade" }),
    /** The patient id at that server, from the token response. */
    patientId: text("patient_id").notNull(),
    tokensSealed: text("tokens_sealed").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    connectedAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.personId, t.serverId] })],
);
