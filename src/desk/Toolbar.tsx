import { Brain, Hand, Image, Redo2, Undo2 } from "lucide-react";

export function DeskToolbar({
  canUndo,
  canRedo,
  onHand,
  onUndo,
  onRedo,
  onImage,
  memoryCount,
  memoryVisible,
  onToggleMemory,
}: {
  canUndo: boolean;
  canRedo: boolean;
  onHand: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onImage: () => void;
  /** 记忆条目数；onToggleMemory 存在时才渲染记忆开关 */
  memoryCount?: number;
  memoryVisible?: boolean;
  onToggleMemory?: () => void;
}) {
  return (
    <div className="desk-toolbar" role="toolbar" aria-label="创作工具">
      <button type="button" title="漫游（清除选择）" aria-label="漫游" onClick={onHand}>
        <Hand size={16} />
      </button>
      <span className="tb-sep" />
      <button type="button" title="撤销" aria-label="撤销" disabled={!canUndo} onClick={onUndo}>
        <Undo2 size={16} />
      </button>
      <button type="button" title="重做" aria-label="重做" disabled={!canRedo} onClick={onRedo}>
        <Redo2 size={16} />
      </button>
      <span className="tb-sep" />
      <button type="button" title="图片" aria-label="图片" onClick={onImage}>
        <Image size={16} />
      </button>
      {onToggleMemory && (
        <>
          <span className="tb-sep" />
          <button
            type="button"
            className={memoryVisible ? "tb-active" : undefined}
            title={memoryVisible ? "隐藏设计笔记" : "显示设计笔记"}
            aria-label="设计笔记"
            aria-pressed={memoryVisible}
            onClick={onToggleMemory}
          >
            <Brain size={16} />
            {memoryCount !== undefined && memoryCount > 0 && (
              <span className="tb-badge">{memoryCount}</span>
            )}
          </button>
        </>
      )}
    </div>
  );
}
