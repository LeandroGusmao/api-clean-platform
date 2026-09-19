ALTER TABLE "refresh_tokens" ADD COLUMN "ip" text;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "device_label" text;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "session_started_at" timestamp with time zone;