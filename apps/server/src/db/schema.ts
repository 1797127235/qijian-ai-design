import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, serial, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { CreatedBy, DeskLayoutObject, DeskViewport } from "../domain/types.js";

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const chatThreads = pgTable(
  "chat_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("新对话"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("chat_threads_project_updated_idx").on(table.projectId, table.updatedAt)],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id").notNull().references(() => chatThreads.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    sequence: serial("sequence").notNull(),
    role: text("role").$type<"user" | "assistant">().notNull(),
    text: text("text").notNull(),
    externalId: text("external_id"),
    runId: uuid("run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("chat_messages_external_id_unique").on(table.externalId),
    index("chat_messages_project_sequence_idx").on(table.projectId, table.sequence),
    index("chat_messages_thread_idx").on(table.threadId),
  ],
);

export const chatRuns = pgTable(
  "chat_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id").notNull().references(() => chatThreads.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    userMessageId: uuid("user_message_id").notNull().references(() => chatMessages.id, { onDelete: "cascade" }).unique(),
    ownerId: text("owner_id").notNull(),
    status: text("status").$type<"running" | "completed" | "failed" | "stopped" | "interrupted">().notNull().default("running"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("chat_runs_thread_status_idx").on(table.threadId, table.status),
    index("chat_runs_project_status_idx").on(table.projectId, table.status),
    uniqueIndex("chat_runs_thread_running_unique").on(table.threadId).where(sql`${table.status} = 'running'`),
  ],
);

export const chatToolCalls = pgTable(
  "chat_tool_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => chatRuns.id, { onDelete: "cascade" }),
    toolCallId: text("tool_call_id").notNull(),
    toolName: text("tool_name").notNull(),
    status: text("status").$type<"running" | "succeeded" | "failed" | "interrupted">().notNull().default("running"),
    args: jsonb("args").$type<unknown>().notNull().default(sql`'{}'::jsonb`),
    result: jsonb("result").$type<unknown>(),
    error: text("error"),
    cost: jsonb("cost").$type<unknown>(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    unique("chat_tool_calls_run_call_unique").on(table.runId, table.toolCallId),
    index("chat_tool_calls_run_status_idx").on(table.runId, table.status),
  ],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    artifactType: text("artifact_type").notNull(),
    currentVersionId: uuid("current_version_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("artifacts_project_idx").on(table.projectId), index("artifacts_type_idx").on(table.artifactType)],
);

export const artifactVersions = pgTable(
  "artifact_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    artifactId: uuid("artifact_id").notNull().references(() => artifacts.id, { onDelete: "cascade" }),
    versionNo: integer("version_no").notNull(),
    status: text("status").notNull().default("draft"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    inputRefs: jsonb("input_refs").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    createdBy: text("created_by").$type<CreatedBy>().notNull(),
    changeReason: text("change_reason"),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("artifact_versions_number_unique").on(table.artifactId, table.versionNo),
    index("artifact_versions_artifact_idx").on(table.artifactId),
  ],
);

export const deskStates = pgTable("desk_state", {
  projectId: uuid("project_id").primaryKey().references(() => projects.id, { onDelete: "cascade" }),
  objects: jsonb("objects").$type<DeskLayoutObject[]>().notNull().default(sql`'[]'::jsonb`),
  viewport: jsonb("viewport").$type<DeskViewport>().notNull().default(sql`'{"x":40,"y":20,"zoom":0.62}'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const storedFiles = pgTable(
  "stored_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    originalFilename: text("original_filename").notNull(),
    mediaType: text("media_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    contentHash: text("content_hash").notNull(),
    objectKey: text("object_key").notNull().unique(),
    pageCount: integer("page_count"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("stored_files_project_idx").on(table.projectId)],
);

export const chatMessageAttachments = pgTable(
  "chat_message_attachments",
  {
    messageId: uuid("message_id").notNull().references(() => chatMessages.id, { onDelete: "cascade" }),
    fileId: uuid("file_id").notNull().references(() => storedFiles.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (table) => [
    unique("chat_message_attachments_message_file_unique").on(table.messageId, table.fileId),
    unique("chat_message_attachments_message_position_unique").on(table.messageId, table.position),
    index("chat_message_attachments_file_idx").on(table.fileId),
  ],
);
