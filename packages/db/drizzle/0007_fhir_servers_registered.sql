ALTER TABLE "fhir_servers" ALTER COLUMN "authorize_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "fhir_servers" ALTER COLUMN "token_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "fhir_servers" ALTER COLUMN "client_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "fhir_servers" ALTER COLUMN "scope" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "fhir_servers" ADD COLUMN "kind" text DEFAULT 'smart' NOT NULL;--> statement-breakpoint
ALTER TABLE "fhir_servers" ADD COLUMN "auth_header_sealed" text;--> statement-breakpoint
CREATE UNIQUE INDEX "fhir_servers_one_aipass_idx" ON "fhir_servers" USING btree ("kind") WHERE kind = 'aipass';