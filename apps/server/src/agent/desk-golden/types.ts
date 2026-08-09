/** 黄金任务夹具 schema（L-A 装配层）。 */
export type GoldenDeskRef = "s1" | "empty" | null | Record<string, unknown>;

export type GoldenExpect = {
  codes?: string[];
  textIncludes?: string[];
  textExcludes?: string[];
  hasBlocks?: Array<"DESK_CONTEXT" | "FOCUS" | "INSPECT" | "RESOLUTION">;
  noBlocks?: Array<"DESK_CONTEXT" | "FOCUS" | "INSPECT" | "RESOLUTION">;
  labelsUnique?: boolean;
  inspectIncluded?: string[];
  inspectExcluded?: string[];
  inspectSkipped?: Array<{ artifactId: string; reason: string }>;
  /** report.dropped 须包含的条目（如 inspect:id:over_budget） */
  reportDroppedIncludes?: string[];
  /** report.modes 须包含 */
  reportModesIncludes?: Array<"survey" | "focus" | "inspect" | "resolution">;
  resolution?: {
    unique?: boolean;
    resolvedIds?: string[];
    candidateIds?: string[];
  };
  focusMentions?: string[];
  note?: string;
};

export type GoldenTask = {
  id: string;
  title: string;
  desk: GoldenDeskRef;
  fileNames?: "s1" | Record<string, string>;
  /** 预加载 caption（file_id → text），模拟 cache hit */
  captions?: Record<string, string>;
  /**
   * 历史对话里曾出现的 artifact id（仅文档/断言用）。
   * 装配器不得接收此列表；runner 用它做 C1：当前 Survey 不得含这些 id。
   */
  historyDeskMentions?: string[];
  selection: string[];
  userText: string;
  expect: GoldenExpect;
};
