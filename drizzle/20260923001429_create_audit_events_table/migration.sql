CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY,
	"type" text NOT NULL,
	"user_id" uuid NOT NULL,
	"ip" text,
	"device_label" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_events_user_id_occurred_at_idx" ON "audit_events" ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_occurred_at_idx" ON "audit_events" ("occurred_at");