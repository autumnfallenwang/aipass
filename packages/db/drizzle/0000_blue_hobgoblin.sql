CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"role_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"fhir_device_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grants" (
	"id" text PRIMARY KEY NOT NULL,
	"person_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pass_keys" (
	"kid" text PRIMARY KEY NOT NULL,
	"alg" text NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"private_jwk" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "persons" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"fhir_ref" text NOT NULL,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_id" text NOT NULL,
	"person_id" text,
	"tool" text,
	"action" text NOT NULL,
	"group_name" text,
	"target" text,
	"decision" text NOT NULL,
	"rule" integer,
	"code" text,
	"reason" text,
	"sentence" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"withheld" integer DEFAULT 0 NOT NULL,
	"pass_jti" text,
	"mode" text DEFAULT 'live' NOT NULL,
	"audit_event_id" text,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"patient_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "grants_person_agent_idx" ON "grants" USING btree ("person_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "persons_user_id_idx" ON "persons" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_seq_idx" ON "receipts" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "receipts_agent_idx" ON "receipts" USING btree ("agent_id","ts");--> statement-breakpoint
CREATE INDEX "receipts_person_idx" ON "receipts" USING btree ("person_id","ts");