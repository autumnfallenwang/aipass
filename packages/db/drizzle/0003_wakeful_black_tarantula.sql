CREATE TABLE "approval_rules" (
	"role_id" text NOT NULL,
	"group_name" text NOT NULL,
	"approver_person_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_rules_role_id_group_name_pk" PRIMARY KEY("role_id","group_name")
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"person_id" text NOT NULL,
	"approver_person_id" text NOT NULL,
	"action" text NOT NULL,
	"group_name" text NOT NULL,
	"resource_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"summary" text NOT NULL,
	"nonce" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"pass_jti" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by_user_id" text,
	"credential_id" text,
	"denied_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	"result_ref" text
);
--> statement-breakpoint
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_approver_person_id_persons_id_fk" FOREIGN KEY ("approver_person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_person_idx" ON "approvals" USING btree ("person_id","status");