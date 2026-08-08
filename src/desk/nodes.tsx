import type { CSSProperties } from "react";
import { ImagePlus } from "lucide-react";
import type { DeskObject } from "./types";
import { NODE_SIZE } from "./connection-geometry";

/** 与 connection-geometry 一致：渲染服从固定几何，避免锚点/框选错位。 */
const IMAGE_BOX: CSSProperties = {
  width: NODE_SIZE.canvas_image.w,
  height: NODE_SIZE.canvas_image.h,
  boxSizing: "border-box",
  padding: 0,
  overflow: "hidden",
};

const IMAGE_STYLE: CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
  borderRadius: 2,
  display: "block",
  pointerEvents: "none",
};

/** 图片卡四态：生成中 / 失败 / 空占位 / 有图。canvas_image 与 effect_image 共用。 */
function ImageCard({
  obj,
  label,
  onRetryGenerate,
}: {
  obj: DeskObject & { kind: "canvas_image" | "effect_image" };
  label: string;
  onRetryGenerate?: (id: string) => void;
}) {
  if (obj.pending) {
    return (
      <div className="photo fx-single effect-pending" style={IMAGE_BOX}>
        <div className="effect-spinner" />
        <span>生成中</span>
      </div>
    );
  }
  if (obj.error || (obj.kind === "effect_image" && !obj.url)) {
    return (
      <div className="photo fx-single effect-error" style={IMAGE_BOX}>
        <span>{obj.error ?? "生成失败"}</span>
        {onRetryGenerate && (
          <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => onRetryGenerate(obj.id)}>
            重试
          </button>
        )}
      </div>
    );
  }
  if (!obj.url) {
    return (
      <div className="image-card image-card-empty" style={IMAGE_BOX}>
        <div className="image-card-placeholder">
          <ImagePlus size={26} strokeWidth={1.2} />
          <span>上传图片，或连接参考后生成</span>
        </div>
      </div>
    );
  }
  return (
    <div className="image-card" style={IMAGE_BOX} title="双击查看大图">
      <img
        src={obj.url}
        alt={label}
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
        style={IMAGE_STYLE}
      />
    </div>
  );
}

/** 展示层：只呈现物件。图片双击由 Desk 识别。 */
export function DeskObjectView({
  obj,
  onRetryGenerate,
}: {
  obj: DeskObject;
  onRetryGenerate?: (id: string) => void;
}) {
  switch (obj.kind) {
    case "canvas_image":
      return <ImageCard obj={obj} label="图片" onRetryGenerate={onRetryGenerate} />;

    case "effect_image":
      return <ImageCard obj={obj} label="效果图" onRetryGenerate={onRetryGenerate} />;
  }
}
