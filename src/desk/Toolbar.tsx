import { Hand, Image, Redo2, Type, Undo2 } from "lucide-react";

export function DeskToolbar({
  canUndo,
  canRedo,
  onHand,
  onUndo,
  onRedo,
  onText,
  onImage,
}: {
  canUndo: boolean;
  canRedo: boolean;
  onHand: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onText: () => void;
  onImage: () => void;
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
      <button type="button" title="文字" aria-label="文字" onClick={onText}>
        <Type size={16} />
      </button>
      <button type="button" title="图片" aria-label="图片" onClick={onImage}>
        <Image size={16} />
      </button>
    </div>
  );
}
