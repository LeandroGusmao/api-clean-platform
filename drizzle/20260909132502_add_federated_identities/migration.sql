CREATE TABLE "federated_identities" (
	"id" uuid PRIMARY KEY,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"email_at_link" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "federated_identities_provider_subject_unique" ON "federated_identities" ("provider","provider_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "federated_identities_user_provider_unique" ON "federated_identities" ("user_id","provider");--> statement-breakpoint
CREATE INDEX "federated_identities_user_id_idx" ON "federated_identities" ("user_id");--> statement-breakpoint
ALTER TABLE "federated_identities" ADD CONSTRAINT "federated_identities_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;