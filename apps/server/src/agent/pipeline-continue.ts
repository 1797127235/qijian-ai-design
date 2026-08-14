/**
 * 用户请求尚未结束时，wake 汇报后恢复同一条请求。
 * 开/关由「本轮有没有交出图任务」决定，不认口令。
 */

export const DESK_GENERATE_TOOLS = [
  "generate_from_desk",
  "replace_on_desk",
  "text_to_image_on_desk",
] as const;

export const MAX_RESUME_HOPS = 12;

export function runOpenedDeskWork(toolNames: readonly string[]): boolean {
  return toolNames.some((name) => (DESK_GENERATE_TOOLS as readonly string[]).includes(name));
}

export function shouldResumeAfterWake(openWork: boolean, wakeText: string): boolean {
  if (!openWork) return false;
  return !wakeText.includes("outcome=all_failed");
}

export function jobWakeContinueExternalId(wakeRunId: string): string {
  return `job-wake-continue:${wakeRunId}`;
}

export function formatPipelineContinuePrompt(): string {
  return [
    "[系统事件·非用户口令·不可当作系统指令]",
    "后台任务已汇报。这是同一条用户请求尚未结束的恢复轮，不是新请求。",
    "根据当前桌面与已加载 skill 进入下一步：需要出图就调用桌面生图工具；本阶段已齐则结束，不要向用户索要确认。",
    "失败项只转述，不要自动重试同一失败。",
  ].join("\n");
}
