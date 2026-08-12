/**
 * artifact.name 任务：图像成功后的「软」展示名生成。
 *
 * 设计约束（见 ADR 0014 / runbook）：
 * - 命名失败不得把图像任务或批次改成 failed；
 * - 写回必须带 generation_token + name_version，防迟到结果覆盖用户改名；
 * - replace 成功后 force=true，可覆盖旧 model 名，永不覆盖 source=user。
 */
import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../config.js";
import type { ArtifactService } from "../services/artifact-service.js";
import {
  heuristicDisplayNameFromPrompt,
  suggestArtifactDisplayName,
} from "../services/artifact-display-namer.js";
import type { ArtifactNameTaskV1 } from "./types.js";
import { TaskStore } from "./task-store.js";

/** 单次 handle 内调用文本 API 的最大次数（含首次）。 */
const NAME_ATTEMPTS = 3;
/** 重试间隔基数（ms），实际为 RETRY_DELAY_MS * attempt。 */
const RETRY_DELAY_MS = 400;

export class ArtifactNameTaskService {
  constructor(
    private readonly store: TaskStore,
    private readonly artifacts: ArtifactService,
    private readonly config: Pick<ServerConfig, "textEndpoint" | "textApiKey" | "textModel">,
  ) {}

  /**
   * 入队一条命名任务（不执行 LLM）。
   * 无 TEXT 配置时仍可入队：handle 走 prompt 启发式 + source=system。
   * @returns task_id；用户已命名 / 无可覆盖名 / 空意图时返回 undefined。
   */
  async submit(input: {
    artifactId: string;
    namingInput: string;
    /** true：replace 成功后允许覆盖现有 model 名 */
    force?: boolean;
    parentDisplayName?: string;
  }): Promise<string | undefined> {
    if (!input.namingInput.trim()) return undefined;
    // 在事务里抬升 name_version 并签发 generation_token；user 名则直接拒绝 prepare
    const prepared = await this.artifacts.prepareModelDisplayName(input.artifactId, input.force);
    if (!prepared) return undefined;

    const taskId = randomUUID();
    const payload: ArtifactNameTaskV1 = {
      schema_version: 1,
      kind: "artifact.name",
      project_id: prepared.projectId,
      task_id: taskId,
      artifact_id: prepared.artifactId,
      artifact_version_id: prepared.artifactVersionId,
      name_version: prepared.nameVersion,
      generation_token: prepared.generationToken,
      display_name_source: prepared.displayNameSource,
      naming_input: formatNamingInput(input.namingInput, input.parentDisplayName),
      force: input.force,
    };
    // 与生图相同：PG accept + outbox，由 dispatcher 投递 BullMQ
    await this.store.accept({ payload, taskKind: "artifact_name" });
    return taskId;
  }

  /**
   * Worker 执行体。始终应能被 finalize 为 succeeded：
   * - LLM 名 → source=model；启发式 → source=system
   * - 两者皆无 → applied=false, reason=provider_no_valid_name
   * - token/用户挡写 → applied=false, reason=token_or_user_blocked
   * - 写库成功 → applied=true
   * 禁止在此 throw 导致「图像已成功但 name task failed」误伤批次观测（除非配置缺失等硬错误）。
   */
  async handle(task: ArtifactNameTaskV1) {
    const llmName = await this.suggestWithRetry(task.naming_input);
    const heuristic = llmName ? undefined : heuristicDisplayNameFromPrompt(task.naming_input);
    const name = llmName ?? heuristic;
    if (!name) {
      console.warn(
        `[artifact.name] provider_no_valid_name artifact=${task.artifact_id} model=${this.config.textModel ?? "?"}`,
      );
      return softNameResult(task.artifact_id, null, "provider_no_valid_name");
    }
    const writeSource = llmName ? "model" : "system";
    if (!llmName) {
      console.warn(
        `[artifact.name] heuristic_fallback artifact=${task.artifact_id} name=${name}`,
      );
    }
    const applied = await this.artifacts.applyGeneratedDisplayName({
      artifactId: task.artifact_id,
      name,
      nameVersion: task.name_version,
      generationToken: task.generation_token,
      displayNameSource: task.display_name_source,
      writeSource,
      force: task.force,
    });
    if (!applied) {
      console.warn(`[artifact.name] token_or_user_blocked artifact=${task.artifact_id} name=${name}`);
    }
    return softNameResult(
      task.artifact_id,
      name,
      applied ? (llmName ? "applied" : "heuristic_applied") : "token_or_user_blocked",
      applied,
    );
  }

  /** 带短退避的文本起名；全部失败返回 undefined。 */
  private async suggestWithRetry(namingInput: string): Promise<string | undefined> {
    if (!this.config.textEndpoint || !this.config.textApiKey) return undefined;
    for (let attempt = 1; attempt <= NAME_ATTEMPTS; attempt++) {
      const name = await suggestArtifactDisplayName(this.config, namingInput);
      if (name) return name;
      if (attempt < NAME_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
    return undefined;
  }
}

/** 可选附上父卡话题，帮助模型在衍生图时保持空间一致性。 */
function formatNamingInput(namingInput: string, parentDisplayName?: string): string {
  return parentDisplayName
    ? `参考话题：${parentDisplayName}\n意图：${namingInput}`
    : namingInput;
}

function softNameResult(
  artifactId: string,
  displayName: string | null,
  reason: "applied" | "heuristic_applied" | "provider_no_valid_name" | "token_or_user_blocked",
  applied = false,
) {
  return { artifactId, displayName, applied, reason };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
