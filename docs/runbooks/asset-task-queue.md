# Asset Task Queue Runbook

## Responsibilities

- PostgreSQL is the business and audit source of truth (`agent_jobs`, batches, events, artifacts).
- Redis/BullMQ only stores **rebuildable** scheduling state. Product UI reads task/batch state from PostgreSQL.
- API: outbox dispatcher + event wake poller + HTTP. Worker: `npm run dev:worker` (or production equivalent).
- Runtime is **BullMQ-only**. There is no `ASYNC_JOB_BACKEND=legacy` path.

## Task kinds

| kind | Role | Failure policy |
|------|------|----------------|
| `image.generate` | Hard delivery (pixels) | failed / needs_review as appropriate |
| `artifact.name` | Soft display name after image success | Always soft: no valid name → task **succeeded** with `applied=false`; never flips image/batch to failed |

Batch `total` counts **image** tasks only. Name tasks are internal; image success + name soft-miss still allows batch success (surface naming miss in summary if needed).

## Bull Board

- Default URL: `http://localhost:8787/admin/queues` (`BULL_BOARD_PATH`).
- **Local:** may run without credentials; board is **read-only** unless both `BULL_BOARD_USERNAME` and `BULL_BOARD_PASSWORD` are set **and** `BULL_BOARD_READ_ONLY=false`.
- **Production / shared hosts:** set both credentials. Prefer keep `BULL_BOARD_READ_ONLY=true` unless operators need retry/remove. Never expose the board on a public URL without Basic Auth.
- Board shows Redis queue state only; for business status query PostgreSQL.

## Image generate retry (ADR 0015)

- **Auto-retry (≤3, exponential backoff):** clear rate limit / provider 5xx / connect-failed-before-send.
- **Fail once:** validation, unknown model, auth/config missing.
- **`needs_review` (no auto re-generate):** timeout / ambiguous network / `provider_pending` / lost claim / reconciler lost Redis job while running.
- Current gateways are **sync** and **do not** honor Idempotency-Key or expose job query APIs (2026-08-10 probe). Do not invent “query then resume” until that changes.
- Env: `TASK_IMAGE_MAX_ATTEMPTS` (default 3), `TASK_IMAGE_BACKOFF_MS` (default 2000).
- BullMQ job `attempts` stays 1; business attempts live on `generation_operations.attempt`.

## Outbox dead letter

- Dispatcher claims `task_queue_outbox` and `queue.add`s into Redis. Transient Redis errors: `releaseOutbox` with exponential backoff (`TASK_OUTBOX_BACKOFF_MS`, cap 60s).
- After **`TASK_OUTBOX_MAX_ATTEMPTS`** (default **20**) failed enqueues:
  - outbox → `failed`
  - `agent_jobs` → `failed` with error `outbox enqueue exhausted after N attempts: …`
  - pending image artifact best-effort cleared (`pending: false` + error) so the desk leaves “generating”
  - log: `[bullmq] outbox dead-letter task=…`
- Stale **claim** reclaim (dispatcher crash) does **not** increment attempts.
- Reconciler requeue of missing Redis jobs does **not** use this counter (separate path).
- **No auto-revive.** After Redis is healthy, operator may re-accept a **new** task, or manually set outbox back to `pending` + clear task `failed` only if they understand double-enqueue risk. Prefer new user/agent generate.

## Recovery

1. If Redis is unavailable, accepted tasks remain in `task_queue_outbox`; dispatcher retries until max attempts, then dead-letter (above). Do not delete outbox rows.
2. If a dispatcher dies after claiming a row, reconciler returns stale claims to `pending`.
3. If an accepted task has no Redis Job, reconciler requeues it. A **running** task with a missing/failed/completed Job becomes `needs_review`; never blindly re-call the image provider.
4. Provider timeout with unknown acceptance → `needs_review`. Manual retry = **new billable generate** until gateway supports idempotency/async jobs.
5. Completed/failed BullMQ jobs retained 7 days. PostgreSQL task events remain the audit log.
6. Check dead letters: `task_queue_outbox.status = 'failed'` and `agent_jobs.error LIKE 'outbox enqueue exhausted%'`.

## Deploy notes

- Do not delete PostgreSQL task/audit rows during deploy.
- Redis can be flushed only if outbox/reconciler can rebuild scheduling (prefer not to flush in prod).
- After Worker/API restart: run reconciler once (API boot already does); check `needs_review` and outbox depth.
