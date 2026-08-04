import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import type { CreatedBy, DeskLayoutObject, DeskViewport, PermissionMode } from "../domain/types.js";

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  permission: text("permission").$type<PermissionMode>().notNull().default("ask"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("stored_files_project_idx").on(table.projectId)],
);
