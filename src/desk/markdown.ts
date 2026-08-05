const safeProtocols = new Set(["http:", "https:", "mailto:"]);

export function safeMarkdownUrl(url: string): string {
  if (url.startsWith("//")) return "";
  if (url.startsWith("#") || (url.startsWith("/") && !url.startsWith("//"))) return url;
  try {
    const parsed = new URL(url, "https://qijian.invalid");
    return safeProtocols.has(parsed.protocol) ? url : "";
  } catch {
    return "";
  }
}
