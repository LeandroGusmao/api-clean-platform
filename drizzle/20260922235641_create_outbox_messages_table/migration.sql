CREATE TABLE "outbox_messages" (
	"id" uuid PRIMARY KEY,
	"to" text NOT NULL,
	"subject" text NOT NULL,
	"text" text NOT NULL,
	"attempts" integer NOT NULL,
	"last_error" text,
	"dispatched_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"claimed_until" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "outbox_messages_pending_idx" ON "outbox_messages" ("created_at") WHERE "dispatched_at" is null and "failed_at" is null;