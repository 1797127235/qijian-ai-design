/** 面板可选比例；"auto" = 不传 size（上游默认） */
export const IMAGE_SIZE_OPTIONS = [
  { value: "auto", label: "自动" },
  { value: "1:1", label: "1:1" },
  { value: "3:2", label: "3:2" },
  { value: "2:3", label: "2:3" },
  { value: "4:3", label: "4:3" },
  { value: "3:4", label: "3:4" },
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
] as const;

export type ImageSizeOption = (typeof IMAGE_SIZE_OPTIONS)[number]["value"];

export function sizeSummaryLabel(size: string): string {
  const hit = IMAGE_SIZE_OPTIONS.find((o) => o.value === size);
  return hit?.label ?? size;
}
