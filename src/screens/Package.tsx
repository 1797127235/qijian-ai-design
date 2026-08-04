import { Badge, Seal } from "../components/ui";
import type { DesignDirectionsPayload, DesignSystemPayload, Versioned } from "../lib/api";

const tocRows = ["封面", "设计方向", "关键空间效果图", "情绪板", "设计说明", "空间策略"];

export function PackageScreen({
  projectName,
  directions,
  constraints,
}: {
  projectName: string;
  directions?: Versioned<DesignDirectionsPayload>;
  constraints?: Versioned<DesignSystemPayload>;
}) {
  const dir = directions?.payload.cards.find((c) => c.direction_id === directions.payload.selected_direction_id);
  const hardConstraints = constraints?.payload.modules.flatMap((m) => m.items).filter((i) => i.strength === "hard") ?? [];

  return (
    <div className="package-scroll">
      <div className="sheet">
        <p className="eyebrow">提案包 · 第一次客户沟通</p>
        <h1 className="h-display">{projectName}</h1>
        <p className="sub">{dir ? `设计方向 · ${dir.title}` : "设计方向待确认"}</p>

        <div className="toc">
          {tocRows.map((row, i) => (
            <div className="toc-row" key={row}>
              <span>{row}</span>
              <span className="n">{String(i + 1).padStart(2, "0")}</span>
            </div>
          ))}
        </div>

        <div className="gallery">
          <div className="g ph ph-wood" data-ph="效果图占位" role="img" aria-label="客厅效果图占位" />
          <div className="g ph ph-green" data-ph="效果图占位" role="img" aria-label="餐厨效果图占位" />
          <div className="g ph ph-cloth" data-ph="效果图占位" role="img" aria-label="主卧效果图占位" />
        </div>

        {dir && <p className="body">{dir.concept}</p>}

        {hardConstraints.length > 0 && (
          <>
            <p className="eyebrow" style={{ marginTop: 26 }}>空间策略 · 硬约束</p>
            <p className="body" style={{ marginTop: 0 }}>
              {hardConstraints.slice(0, 4).map((c) => c.text).join("；")}。
            </p>
          </>
        )}

        {dir && (
          <div className="chips">
            {dir.materials_and_colors.map((m) => <span className="chip" key={m}>{m}</span>)}
            <Badge tone={constraints?.status === "confirmed" ? "ok" : "tbc"}>
              {constraints?.status === "confirmed" ? "约束包 · 已确认" : "约束包 · 待确认"}
            </Badge>
          </div>
        )}

        <div className="sheet-foot">
          <span className="mono">提案包由确认的 Artifact 组合而成，不重新生成。</span>
          <Seal pending disabled>客户确认门 · 待客户确认</Seal>
        </div>
      </div>
    </div>
  );
}
