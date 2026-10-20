CREATE TABLE "fhir_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"authorize_url" text NOT NULL,
	"token_url" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_sealed" text,
	"scope" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fhir_servers_base_url_unique" UNIQUE("base_url")
);
--> statement-breakpoint
CREATE TABLE "smart_launches" (
	"state" text PRIMARY KEY NOT NULL,
	"person_id" text NOT NULL,
	"server_id" text NOT NULL,
	"code_verifier" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault" (
	"person_id" text NOT NULL,
	"server_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"tokens_sealed" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vault_person_id_server_id_pk" PRIMARY KEY("person_id","server_id")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "fhir_server_id" text;--> statement-breakpoint
ALTER TABLE "smart_launches" ADD CONSTRAINT "smart_launches_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smart_launches" ADD CONSTRAINT "smart_launches_server_id_fhir_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."fhir_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault" ADD CONSTRAINT "vault_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault" ADD CONSTRAINT "vault_server_id_fhir_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."fhir_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_fhir_server_id_fhir_servers_id_fk" FOREIGN KEY ("fhir_server_id") REFERENCES "public"."fhir_servers"("id") ON DELETE no action ON UPDATE no action;