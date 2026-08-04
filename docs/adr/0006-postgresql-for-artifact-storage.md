# 使用 PostgreSQL 存储 Artifact 与项目关系

Artifact 需要不可变版本、结构化内容、项目归属和后续的协作查询。我们从 MVP 起使用 PostgreSQL，而不是先用 SQLite；后端使用 FastAPI、SQLAlchemy 和 Alembic 管理 API、数据模型和迁移，避免在真实项目试用阶段进行高风险数据库迁移。

**Status:** accepted

**Considered Options**

- SQLite：启动更快，但并发、部署和后续迁移会成为真实协作场景的负担。
- 浏览器 IndexedDB：适合离线缓存，不适合成为项目事实来源。

