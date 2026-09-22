CREATE TABLE "account_exists_notices" (
	"user_id" uuid PRIMARY KEY,
	"sent_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_exists_notices" ADD CONSTRAINT "account_exists_notices_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;