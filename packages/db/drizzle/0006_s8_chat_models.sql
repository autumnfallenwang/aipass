CREATE TABLE "chat_launches" (
	"state" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"code_verifier" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_links" (
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"tokens_sealed" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_links_user_id_agent_id_pk" PRIMARY KEY("user_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "model_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key_sealed" text,
	"data_location" text DEFAULT 'cloud' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "model_connection_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "fallback_connection_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "fallback_model" text;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "client_id" text;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "network_models_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_launches" ADD CONSTRAINT "chat_launches_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_launches" ADD CONSTRAINT "chat_launches_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_links" ADD CONSTRAINT "chat_links_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_links" ADD CONSTRAINT "chat_links_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_model_connection_id_model_connections_id_fk" FOREIGN KEY ("model_connection_id") REFERENCES "public"."model_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_fallback_connection_id_model_connections_id_fk" FOREIGN KEY ("fallback_connection_id") REFERENCES "public"."model_connections"("id") ON DELETE set null ON UPDATE no action;