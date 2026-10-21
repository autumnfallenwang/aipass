ALTER TABLE "grants" ADD COLUMN "set_by" text DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "is_test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "persons_fhir_ref_idx" ON "persons" USING btree ("fhir_ref");--> statement-breakpoint
CREATE INDEX "persons_name_idx" ON "persons" USING btree ("display_name");--> statement-breakpoint
CREATE UNIQUE INDEX "vault_server_patient_idx" ON "vault" USING btree ("server_id","patient_id");