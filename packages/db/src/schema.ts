import type { AgentStatus, GrantStatus, PatientField, Permission, RoleRule } from "@aipass/shared";
import { sql } from "drizzle-orm";
import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
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
