/**
 * 多生图网关：每个 provider 有独立 endpoint/key/models。
 * 面板选 model → 按 model 找到所属 provider 再请求。
 *
 * 约定：model id **全局唯一**；跨网关重复时先注册的 provider 生效，启动时 warn。
 * 用户选定 model 时，文生图与 edits 使用同一 model id（多数 OpenAI 兼容网关如此）。
 * 未指定 model 时：文生图用 models[0]，edits 用 editModel ?? models[0]。
 * Agent / 面板均可传 model；未知 id 禁止静默回落主站（unknown_model）。
 * 口语差异（空格/下划线/大小写）经 normalize 对齐到 allowlist 中的规范 id。
 */

/**
 * 用于 allowlist 比对的宽松键：小写 + 去掉空白/连字符/下划线等分隔符。
 * 使「gpt image2」「gpt-image2」「gpt-image-2」对齐为同一键 gptimage2。
 */
export function normalizeImageModelKey(id: string): string {
  return id.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * 将用户/Agent 给出的 model 字符串对齐到 allowlist 规范 id。
 *  - 未传 / 空串 → undefined（调用方走默认）
 *  - 命中（精确或 normalize 后）→ 规范 id
 *  - 未命中 → null（调用方应 fail / 400，禁止 fallback）
 */
export function matchImageModelId(
  requested: string | undefined,
  knownIds: readonly string[],
): string | undefined | null {
  const raw = requested?.trim();
  if (!raw) return undefined;
  if (knownIds.includes(raw)) return raw;
  const key = normalizeImageModelKey(raw);
  for (const id of knownIds) {
    if (normalizeImageModelKey(id) === key) return id;
  }
  return null;
}

export interface ImageProviderConfig {
  id: string;
  /** 展示用；缺省 = id */
  label: string;
  /** OpenAI 兼容 /images/generations 完整 URL */
  endpoint: string;
  apiKey: string;
  models: string[];
  /** 未指定 model 且走 edits 时的默认；缺省 models[0] */
  editModel?: string;
}

export interface ImageModelChoice {
  id: string;
  providerId: string;
  providerLabel: string;
}

/** 从 generations URL 推导 edits URL。 */
export function editsEndpointFrom(generationsUrl: string): string {
  if (generationsUrl.includes("/images/edits")) return generationsUrl;
  if (generationsUrl.includes("/images/generations")) {
    return generationsUrl.replace("/images/generations", "/images/edits");
  }
  return generationsUrl.endsWith("/") ? `${generationsUrl}images/edits` : `${generationsUrl}/images/edits`;
}

/**
 * 组装 provider 列表。
 *  - 主站：IMAGE_API_URL + IMAGE_API_KEY + IMAGE_MODEL + IMAGE_MODEL_OPTIONS
 *  - 附加：IMAGE_PROVIDER_2_URL / _KEY / _MODELS / _ID / _LABEL（可扩 3…）
 */
export function loadImageProviders(env: NodeJS.ProcessEnv): ImageProviderConfig[] {
  const providers: ImageProviderConfig[] = [];

  const primaryUrl = env.IMAGE_API_URL?.trim();
  const primaryKey = env.IMAGE_API_KEY?.trim();
  if (primaryUrl && primaryKey) {
    const defaultModel = env.IMAGE_MODEL?.trim() || "grok-imagine-image-quality";
    const models = parseModelList(env.IMAGE_MODEL_OPTIONS, defaultModel, [
      "grok-imagine-image",
      "grok-imagine-image-pro",
      "grok-imagine-image-quality",
    ]);
    providers.push({
      id: env.IMAGE_PROVIDER_ID?.trim() || "primary",
      label: env.IMAGE_PROVIDER_LABEL?.trim() || "Primary",
      endpoint: primaryUrl,
      apiKey: primaryKey,
      models,
      editModel: env.IMAGE_EDIT_MODEL?.trim() || defaultModel,
    });
  }

  for (const n of [2, 3, 4, 5] as const) {
    const url = env[`IMAGE_PROVIDER_${n}_URL`]?.trim();
    const key = env[`IMAGE_PROVIDER_${n}_KEY`]?.trim();
    if (!url || !key) continue;
    const id = env[`IMAGE_PROVIDER_${n}_ID`]?.trim() || `provider-${n}`;
    const label = env[`IMAGE_PROVIDER_${n}_LABEL`]?.trim() || id;
    const modelsRaw = env[`IMAGE_PROVIDER_${n}_MODELS`]?.trim();
    const models = parseModelList(modelsRaw, modelsRaw?.split(",")[0]?.trim() || "default", []);
    if (models.length === 0) continue;
    providers.push({
      id,
      label,
      endpoint: normalizeGenerationsUrl(url),
      apiKey: key,
      models,
      editModel: env[`IMAGE_PROVIDER_${n}_EDIT_MODEL`]?.trim() || models[0],
    });
  }

  return providers;
}

/** 保证指向 generations（用户若只给 /v1 也补全）。 */
export function normalizeGenerationsUrl(url: string): string {
  const u = url.replace(/\/+$/, "");
  if (u.includes("/images/generations")) return u;
  if (u.includes("/images/edits")) return u.replace("/images/edits", "/images/generations");
  if (/\/v\d+$/.test(u)) return `${u}/images/generations`;
  return `${u}/images/generations`;
}

/** 逗号列表 + 默认 model 去重保序；env 空时拼 builtins。 */
export function parseModelList(raw: string | undefined, defaultModel: string, builtins: string[] = []): string[] {
  const fromEnv = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const list = fromEnv.length > 0 ? fromEnv : [defaultModel, ...builtins];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [defaultModel, ...list]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** model id → provider；同名 model 以先注册的 provider 为准。 */
export function buildModelIndex(providers: ImageProviderConfig[]): Map<string, ImageProviderConfig> {
  const map = new Map<string, ImageProviderConfig>();
  for (const p of providers) {
    for (const m of p.models) {
      if (!map.has(m)) map.set(m, p);
    }
  }
  return map;
}

/** 跨 provider 重复的 model id（先注册者生效）。 */
export function findDuplicateModelIds(
  providers: ImageProviderConfig[],
): Array<{ model: string; providerIds: string[] }> {
  const owners = new Map<string, string[]>();
  for (const p of providers) {
    for (const m of p.models) {
      const list = owners.get(m) ?? [];
      list.push(p.id);
      owners.set(m, list);
    }
  }
  return [...owners.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([model, providerIds]) => ({ model, providerIds }));
}

/** 启动时打印重复 model 警告；可注入 log 便于测试。 */
export function warnDuplicateImageModels(
  providers: ImageProviderConfig[],
  log: (msg: string) => void = (msg) => console.warn(msg),
): void {
  for (const { model, providerIds } of findDuplicateModelIds(providers)) {
    log(
      `[image] model id "${model}" 出现在多个网关 (${providerIds.join(", ")})；`
      + `全局唯一约定下仅先注册的「${providerIds[0]}」生效`,
    );
  }
}

export function listModelChoices(providers: ImageProviderConfig[]): ImageModelChoice[] {
  const out: ImageModelChoice[] = [];
  for (const [id, provider] of buildModelIndex(providers)) {
    out.push({ id, providerId: provider.id, providerLabel: provider.label });
  }
  return out;
}

export type ImageRoute =
  | { ok: true; provider: ImageProviderConfig; model: string }
  | { ok: false; reason: "no_providers" | "unknown_model"; model?: string };

/**
 * 解析请求应走的网关与 model。
 *  - 用户指定且在索引中：该 provider + 同一 model id（文生/edits 一致）
 *  - 用户指定但不在索引：unknown_model（调用方应 400，禁止静默回落）
 *  - 未指定：主站；文生 models[0]，edits editModel ?? models[0]
 */
export function resolveImageRoute(
  providers: ImageProviderConfig[],
  requestedModel: string | undefined,
  forEdit: boolean,
): ImageRoute {
  if (providers.length === 0) return { ok: false, reason: "no_providers" };
  const index = buildModelIndex(providers);
  const primary = providers[0];
  const id = requestedModel?.trim();
  if (id) {
    let provider = index.get(id);
    let model = id;
    if (!provider) {
      const key = normalizeImageModelKey(id);
      for (const [mid, p] of index) {
        if (normalizeImageModelKey(mid) === key) {
          provider = p;
          model = mid;
          break;
        }
      }
    }
    if (!provider) return { ok: false, reason: "unknown_model", model: id };
    return { ok: true, provider, model };
  }
  const fallbackModel = forEdit
    ? (primary.editModel ?? primary.models[0])
    : primary.models[0];
  return { ok: true, provider: primary, model: fallbackModel };
}
