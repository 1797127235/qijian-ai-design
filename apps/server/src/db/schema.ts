/**
 * Drizzle schema —— PostgreSQL 表结构。
 *
 * 设计要点：
 *  - 所有外键级联删除：删除项目时连带 artifacts/chats/files/jobs 一起清
 *  - 复合唯一索引：thread 内只能有一个 running 的 chat_run（互斥保证）
 *  - desk_state 单行表：以 project_id 为主键，1:1 持有 layout/connections/viewport
 *  - artifact_versions 不可变：每次写新 row、artifacts.current_version_id 指针移动
 *    → 历史可回放，UI 看到的就是「当前指针指向的版本」
 */
import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, serial, text, timestamp, unique, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { CreatedBy, DeskConnection, DeskLayoutObject, DeskViewport } from "../domain/types.js";

/** 设计项目：根实体，所有其他表通过 project_id 关联。 */
export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  /** 人看封面（派生缓存）：指向 stored_files 里的 desk-cover.png；null = 未渲染/无 ready 图 */
  coverFileId: uuid("cover_file_id").references((): AnyPgColumn => storedFiles.id, { onDelete: "set null" }),
  /** 封面渲染依据的 desk revision（revisionOf(snapshot)）；相同则跳过重复渲染 */
  coverRevision: text("cover_revision"),
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

/**
 * 聊天消息：按 thread 组织。
 *  - sequence 是 thread 内单调递增序号（serial），用于稳定排序
 *  - external_id 用来幂等：前端用同一 external_id 重发时数据库 UNIQUE 约束保证不重复
 *  - run_id 软关联到 chat_run（运行结束后保留）
 */
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

/**
 * 一次 Agent 运行（一条 user_message 触发一次 run）。
 *  - status 用 partial unique index 约束「同一 thread 同时只能一个 running」
 *    → 客户端点停止时把 running 改 stopped 即可解锁
 */
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
    /** LangSmith root run id（H7） */
    smithRunId: text("smith_run_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("chat_runs_thread_status_idx").on(table.threadId, table.status),
    index("chat_runs_project_status_idx").on(table.projectId, table.status),
    // partial unique：仅当 status='running' 时唯一，保证互斥
    uniqueIndex("chat_runs_thread_running_unique").on(table.threadId).where(sql`${table.status} = 'running'`),
  ],
);

/**
 * Agent 工具调用记录：每次 LLM 触发一个工具就记一行。
 *  - tool_call_id 来自 LLM 输出（用于把工具 result 回填到 LLM 对话）
 *  - cost 是 provider 报告的 token/费用信息，可选
 */
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

/**
 * Artifact：项目级「事实/判断/交付」的可审阅记录。
 *  - current_version_id 是指针，指向 artifact_versions 的某一行
 *  - 不存 payload；payload 在 artifact_versions（版本不可变 + 指针可改）
 */
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

/**
 * Artifact 版本：append-only。
 *  - (artifact_id, versionNo) 唯一，版本号单调递增
 *  - content_hash 用 canonicalJson(payload) + inputRefs 算 SHA-256（lib/json.ts）
 *    → 内容寻址，相同 payload 复用同一版本（未来可优化）
 *  - status 仅为元数据，无流程关卡（见 domain/types ArtifactStatus 注释）
 */
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

/**
 * 桌面状态：单行表（每个项目一行），存储布局/连接/视口。
 *  - objects/connections/viewport 都是 jsonb，整存整取
 *  - 视口默认值是经验值（中央略偏左上、缩放 0.62）让首次打开不会跳到原点
 */
export const deskStates = pgTable("desk_state", {
  projectId: uuid("project_id").primaryKey().references(() => projects.id, { onDelete: "cascade" }),
  objects: jsonb("objects").$type<DeskLayoutObject[]>().notNull().default(sql`'[]'::jsonb`),
  connections: jsonb("connections").$type<DeskConnection[]>().notNull().default(sql`'[]'::jsonb`),
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

/**
 * 消息↔文件附件：多对多 + 顺序。
 *  - position 让附件能稳定重排
 *  - 两个 unique：防止同 message/file 重复、防止 position 冲突
 */
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

/**
 * Agent 异步任务（job）：生命周期长于单次 tool_call 时使用。
 *  - 工具受理时 insert 一行 accepted，工具执行中 running，最终 succeeded/failed/cancelled/interrupted
 *  - 「受理立即返回」是核心：HTTP 不用等生成，前端通过 WS 事件流订阅进度
 *  - 启动时扫 running 状态并标 interrupted（防止上次进程崩溃留下的幽灵任务）
 *  - artifact_id 软关联到产物：成功后写新 artifact 拿到 id 回填
 */
export const agentJobs = pgTable(
  "agent_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    /** 面板生图可无 thread；Agent 工具路径必填 */
    threadId: uuid("thread_id").references(() => chatThreads.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => chatRuns.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    status: text("status")
      .$type<"accepted" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted">()
      .notNull()
      .default("accepted"),
    input: jsonb("input").$type<unknown>().notNull().default(sql`'{}'::jsonb`),
    result: jsonb("result").$type<unknown>(),
    artifactId: uuid("artifact_id"),
    error: text("error"),
    /** H7 LangSmith 关联 */
    traceRootId: text("trace_root_id"),
    traceParentId: text("trace_parent_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("agent_jobs_project_status_idx").on(table.projectId, table.status),
    index("agent_jobs_project_created_idx").on(table.projectId, table.createdAt),
    index("agent_jobs_run_status_idx").on(table.runId, table.status),
  ],
);

/**
 * 图片画面描述缓存（Caption）：可重算、不进 artifact payload。
 *  - 键：project_id + file_id + content_hash + analyzer_version
 *  - content_hash 必须等于 stored_files 字节 hash
 *  - 读时三者匹配才 hit；否则 miss/stale，省略文本
 */
export const imageCaptions = pgTable(
  "image_captions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    fileId: uuid("file_id").notNull().references(() => storedFiles.id, { onDelete: "cascade" }),
    contentHash: text("content_hash").notNull(),
    analyzerVersion: text("analyzer_version").notNull(),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("image_captions_identity_unique").on(
      table.projectId,
      table.fileId,
      table.contentHash,
      table.analyzerVersion,
    ),
    index("image_captions_project_file_idx").on(table.projectId, table.fileId),
  ],
);
