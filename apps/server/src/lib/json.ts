/**
 * 规范化 JSON + 内容寻址哈希。
 * 用于 artifact_versions.content_hash：相同语义内容得到相同哈希。
 */
import { createHash } from "node:crypto";

/**
 * 递归把对象 key 按字典序排序后转回对象。
 * 目的：消除 {a:1,b:2} 与 {b:2,a:1} 这类顺序差异，让 JSON.stringify 输出稳定。
 * 不做类型归一化（数字 1 与字符串 "1" 仍被视为不同），这由上游业务保证。
 */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  }
  return value;
}

/** 输出规范化的 JSON 字符串（key 排序 + 递归）。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

/**
 * 计算 artifact 版本内容哈希：SHA-256(canonicalJson({ payload, input_refs }))。
 * 入参顺序固定为 { payload, input_refs } 避免调用方传参顺序影响哈希。
 */
export function contentHash(payload: Record<string, unknown>, inputRefs: unknown[]): string {
  return createHash("sha256").update(canonicalJson({ payload, input_refs: inputRefs })).digest("hex");
}
