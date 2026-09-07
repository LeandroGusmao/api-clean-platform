CREATE TABLE "pending_registrations" (
	"id" uuid PRIMARY KEY,
	"email" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer NOT NULL,
	"code_issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "pending_registrations_email_lower_idx" ON "pending_registrations" (lower("email"));--> statement-breakpoint
CREATE INDEX "pending_registrations_active_idx" ON "pending_registrations" (lower("email")) WHERE "consumed_at" is null;