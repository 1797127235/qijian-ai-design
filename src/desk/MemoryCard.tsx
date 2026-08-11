import { EyeOff, RefreshCw } from "lucide-react";
import { useRef, useState, type CSSProperties, type MutableRefObject } from "react";
import type { ProjectMemoryState } from "../lib/api";
import type { Viewport } from "./geometry";
import { groupMemoryEntries, type MemoryCardLayout } from "./memory";

/**
 * 画布上的项目记忆汇总卡：只读、可拖（拖 header）、可隐藏。
 * 渲染在 .desk-stage 内（世界坐标），不是 DeskObject —— 不参与连线/框选/Minimap。
 */
export function MemoryCard({
  memory,
  loadFailed,
  layout,
  viewportRef,
  onLayoutChange,
  onHide,
  onRefresh,
}: {
  memory: ProjectMemoryState | undefined;
  /** 上次请求失败：正文显示失败态 + 重试入口（区别于「载入中」） */
  loadFailed: boolean;
  layout: MemoryCardLayout;
  /** 拖动换算：屏幕位移 ÷ 当前 zoom = 世界位移 */
  viewportRef: MutableRefObject<Viewport>;
  onLayoutChange: (layout: MemoryCardLayout) => void;
  onHide: () => void;
  onRefresh: () => void;
}) {
  /** 拖动中的临时位置；松手才 commit 到 onLayoutChange（避免拖动期间狂写 localStorage） */
  const [dragPos, setDragPos] = useState<{ x: number; y: number }>();
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number }>();

  const startDrag = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    e.stopPropagation();
    e.preventDefault();
    drag.current = { sx: e.clientX, sy: e.clientY, ox: layout.x, oy: layout.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const moveDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    e.stopPropagation();
    const zoom = viewportRef.current.zoom || 1;
    setDragPos({ x: d.ox + (e.clientX - d.sx) / zoom, y: d.oy + (e.clientY - d.sy) / zoom });
  };

  const endDrag = (e: React.PointerEvent) => {
    if (!drag.current) return;
    e.stopPropagation();
    drag.current = undefined;
    if (dragPos) onLayoutChange({ ...layout, x: dragPos.x, y: dragPos.y });
    setDragPos(undefined);
  };

  const sections = memory ? groupMemoryEntries(memory) : [];
  const count = memory ? Object.keys(memory.entries).length : 0;
  const pos = dragPos ?? layout;

  return (
    <div
      className="desk-memory-card"
      style={{ left: pos.x, top: pos.y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <header
        className="desk-memory-head"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className="desk-memory-title">设计笔记</span>
        {memory && (
          <span className="desk-memory-rev">
            r{memory.revision} · {count} 条
          </span>
        )}
        <button
          type="button"
          title="刷新"
          aria-label="刷新设计笔记"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onRefresh}
        >
          <RefreshCw size={13} />
        </button>
        <button
          type="button"
          title="隐藏设计笔记"
          aria-label="隐藏设计笔记"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onHide}
        >
          <EyeOff size={14} />
        </button>
      </header>
      <div className="desk-memory-body">
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
          <p className="desk-memory-empty">助手还没有为这个项目留下笔记。</p>
        )}
        {sections.map((section, i) => (
          <section
            key={section.family}
            className="desk-memory-section reveal"
            style={{ "--i": i } as CSSProperties}
          >
            <h3>{section.label}</h3>
            {section.entries.map((en) => (
              <div key={en.stableKey} className="desk-memory-entry">
                <p className="desk-memory-summary">{en.summary}</p>
                {en.body.trim() && en.body.trim() !== en.summary.trim() && (
                  <p className="desk-memory-detail">{en.body}</p>
                )}
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
