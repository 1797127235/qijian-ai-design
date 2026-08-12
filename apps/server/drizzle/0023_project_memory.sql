CREATE TABLE "memory_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"event_key" text NOT NULL,
	"event_type" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_events_project_key_unique" UNIQUE("project_id", "event_key")
);
--> statement-breakpoint
CREATE TABLE "memory_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"proposal_key" text NOT NULL,
	"operation" text NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"stable_key" text,
	"family" text,
	"authority" text NOT NULL,
	"content" jsonb,
	"applies_to" jsonb,
	"target_item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proposed_by" text NOT NULL,
	"decision_by" text,
	"decision_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_proposals_project_key_unique" UNIQUE("project_id", "proposal_key")
);
--> statement-breakpoint
CREATE TABLE "memory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"stable_key" text NOT NULL,
	"family" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"current_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_items_project_stable_key_unique" UNIQUE("project_id", "stable_key")
);
--> statement-breakpoint
CREATE TABLE "memory_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"item_id" uuid NOT NULL REFERENCES "memory_items"("id") ON DELETE CASCADE,
	"version_no" integer NOT NULL,
	"content" jsonb NOT NULL,
	"authority" text NOT NULL,
	"applies_to" jsonb,
	"source_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proposal_id" uuid REFERENCES "memory_proposals"("id") ON DELETE SET NULL,
	"created_by_type" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_versions_item_number_unique" UNIQUE("item_id", "version_no")
);
--> statement-breakpoint
CREATE TABLE "memory_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"stable_key" text NOT NULL,
	"active_item_id" uuid NOT NULL REFERENCES "memory_items"("id") ON DELETE CASCADE,
	"proposal_id" uuid NOT NULL REFERENCES "memory_proposals"("id") ON DELETE CASCADE,
	"active_summary" text NOT NULL,
	"proposed_summary" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memory_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"revision" integer NOT NULL,
	"content_hash" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_checkpoints_project_revision_unique" UNIQUE("project_id", "revision")
);
--> statement-breakpoint
CREATE TABLE "memory_retrieval_traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"checkpoint_revision" integer NOT NULL,
	"task_type" text NOT NULL,
	"query" jsonb NOT NULL,
	"trace" jsonb NOT NULL,
	"compiled_context" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"artifact_version_id" uuid REFERENCES "artifact_versions"("id") ON DELETE SET NULL,
	"checkpoint_revision" integer NOT NULL,
	"consistency_status" text NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"analyzer_version" text NOT NULL,
	"designer_outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "memory_events_project_occurred_idx" ON "memory_events" USING btree ("project_id", "occurred_at");
CREATE INDEX "memory_proposals_project_status_idx" ON "memory_proposals" USING btree ("project_id", "status", "created_at");
CREATE INDEX "memory_items_project_status_idx" ON "memory_items" USING btree ("project_id", "status");
CREATE INDEX "memory_versions_project_item_idx" ON "memory_versions" USING btree ("project_id", "item_id");
CREATE INDEX "memory_conflicts_project_status_idx" ON "memory_conflicts" USING btree ("project_id", "status");
CREATE INDEX "memory_checkpoints_project_created_idx" ON "memory_checkpoints" USING btree ("project_id", "created_at");
CREATE INDEX "memory_retrieval_traces_project_created_idx" ON "memory_retrieval_traces" USING btree ("project_id", "created_at");
CREATE INDEX "memory_outcomes_project_created_idx" ON "memory_outcomes" USING btree ("project_id", "created_at");
