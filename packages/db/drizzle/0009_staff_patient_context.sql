CREATE TABLE "patient_contexts" (
	"person_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"patient_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_contexts_person_id_agent_id_pk" PRIMARY KEY("person_id","agent_id")
);
--> statement-breakpoint
ALTER TABLE "patient_contexts" ADD CONSTRAINT "patient_contexts_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_contexts" ADD CONSTRAINT "patient_contexts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;