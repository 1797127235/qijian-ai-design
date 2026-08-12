import { PanelLeftClose, RefreshCw } from "lucide-react";
import { useState, type CSSProperties } from "react";
import type { ProjectMemoryEntry, ProjectMemoryState } from "../lib/api";
import {
  formatMemoryRelativeTime,
  groupMemoryEntries,
  latestMemoryUpdatedAt,
} from "./memory";

/**
 * 画布左缘停靠的「设计笔记」卡：屏幕坐标 HUD（与 Minimap 同层），不随画布缩放。
 * collapsed 时收成一条书脊，悬浮/聚焦书脊临时展开，点头部的收起钮钉回收起态；
 * 工具栏 Brain 开关负责整体显隐（hidden）。不参与连线/框选/Minimap。
 */
export function MemoryCard({
  memory,
  loadFailed,
  collapsed,
  onExpand,
  onCollapse,
  onRefresh,
}: {
  memory: ProjectMemoryState | undefined;
  /** 上次请求失败：正文显示失败态 + 重试入口（区别于「载入中」） */
  loadFailed: boolean;
  collapsed: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  onRefresh: () => void;
}) {
  const sections = memory ? groupMemoryEntries(memory) : [];
  const count = memory ? Object.keys(memory.entries).length : 0;
  /** 点「收起」后指针往往还压在卡片上：抑制悬浮预览，直到指针离开或主动碰书脊 */
  const [peekSuppressed, setPeekSuppressed] = useState(false);
  const updatedAt = memory ? latestMemoryUpdatedAt(memory) : undefined;
  const meta = [
    count > 0 ? `${count} 条` : "",
    updatedAt ? formatMemoryRelativeTime(updatedAt) : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className="desk-memory-dock"
      data-collapsed={collapsed}
      data-peek={peekSuppressed ? "off" : "on"}
      onPointerLeave={() => setPeekSuppressed(false)}
    >
      <button
        type="button"
        className="desk-memory-spine"
        aria-expanded={!collapsed}
        title="展开设计笔记"
        onClick={onExpand}
        onPointerEnter={() => setPeekSuppressed(false)}
        onFocus={() => setPeekSuppressed(false)}
        tabIndex={collapsed ? 0 : -1}
      >
        <span className="desk-memory-spine-label">设计笔记</span>
        {count > 0 && <span className="desk-memory-spine-count">{count}</span>}
      </button>
      <article
        className="desk-memory-card"
        aria-hidden={collapsed}
        aria-label="设计笔记"
        onWheel={(e) => e.stopPropagation()}
        onPointerDown={(e) => {
          // 只拦左键：中键平移画布照常穿过卡片区域
          if (e.button === 0) e.stopPropagation();
        }}
      >
        <header className="desk-memory-head">
          <span className="desk-memory-title">设计笔记</span>
          {meta && <span className="desk-memory-meta">{meta}</span>}
          <button
            type="button"
            title="刷新"
            aria-label="刷新设计笔记"
            onClick={onRefresh}
          >
            <RefreshCw size={13} />
          </button>
          <button
            type="button"
            title="收起设计笔记"
            aria-label="收起设计笔记"
            onClick={(e) => {
              setPeekSuppressed(true);
              // 收起后按钮仍持焦会让 :focus-within 把卡片顶开，主动失焦
              e.currentTarget.blur();
              onCollapse();
            }}
          >
            <PanelLeftClose size={14} />
          </button>
        </header>
        <div className="desk-memory-body" tabIndex={0} aria-label="设计笔记内容">
          {!memory && loadFailed && (
            <p className="desk-memory-empty">
              笔记加载失败。
              <button type="button" className="desk-memory-retry" onClick={onRefresh}>
                重试
              </button>
            </p>
          )}
          {!memory && !loadFailed && <p className="desk-memory-empty">载入中…</p>}
          {memory && sections.length === 0 && (
            <p className="desk-memory-empty">
              还没有笔记。和助手聊过几轮后，这里会记下项目要点。
            </p>
          )}
          {sections.map((section, i) => (
            <section
              key={section.family}
              className="desk-memory-section reveal"
              style={{ "--i": i } as CSSProperties}
            >
              <h3>{section.label}</h3>
              {section.entries.map((en) => (
                <MemoryEntryView key={en.stableKey} entry={en} />
              ))}
            </section>
          ))}
        </div>
      </article>
    </div>
  );
}

/**
 * 单条笔记：只展示 summary（面向设计师的散文）；
 * body 是助手自用的结构化细节，不进卡片。
 */
function MemoryEntryView({ entry }: { entry: ProjectMemoryEntry }) {
  return (
    <div className="desk-memory-entry">
      <p className="desk-memory-summary">{entry.summary}</p>
    </div>
  );
}
