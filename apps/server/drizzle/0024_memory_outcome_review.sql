ALTER TABLE "memory_outcomes" ADD COLUMN "outcome_key" text;
ALTER TABLE "memory_outcomes" ADD COLUMN "task_id" uuid REFERENCES "agent_jobs"("id") ON DELETE SET NULL;
ALTER TABLE "memory_outcomes" ADD COLUMN "review_status" text DEFAULT 'clear' NOT NULL;
UPDATE "memory_outcomes" SET "outcome_key" = 'legacy:' || "id"::text WHERE "outcome_key" IS NULL;
ALTER TABLE "memory_outcomes" ALTER COLUMN "outcome_key" SET NOT NULL;
ALTER TABLE "memory_outcomes" ADD CONSTRAINT "memory_outcomes_project_key_unique" UNIQUE("project_id", "outcome_key");
CREATE INDEX "memory_outcomes_project_review_idx" ON "memory_outcomes" USING btree ("project_id", "review_status");
