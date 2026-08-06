import type { DeskConnection, DeskObject } from "./types";
import { bezierPath, sourceAnchor, targetAnchor } from "./connection-geometry";

export function ConnectionsLayer({
  objects,
  connections,
  selectedId,
  preview,
  onSelect,
  onContextMenu,
}: {
  objects: DeskObject[];
  connections: DeskConnection[];
  selectedId?: string;
  preview?: { x1: number; y1: number; x2: number; y2: number };
  onSelect?: (id: string) => void;
  onContextMenu?: (id: string, e: React.MouseEvent) => void;
}) {
  const byId = new Map(objects.map((o) => [o.id, o]));
  return (
    <svg className="desk-connections" style={{ overflow: "visible", position: "absolute", left: 0, top: 0, width: 1, height: 1 }}>
      {connections.map((c) => {
        const from = byId.get(c.from);
        const to = byId.get(c.to);
        if (!from || !to) return null;
        const a = sourceAnchor(from);
        const b = targetAnchor(to);
        const d = bezierPath(a.x, a.y, b.x, b.y);
        const active = selectedId === c.id;
        return (
          <g key={c.id}>
            <path className="conn-hit" d={d} fill="none" stroke="transparent" strokeWidth={16} style={{ cursor: "pointer" }}
              onClick={(e) => { e.stopPropagation(); onSelect?.(c.id); }}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu?.(c.id, e); }}
            />
            <path d={d} fill="none" stroke={active ? "var(--color-accent)" : "var(--color-hairline-strong)"}
              strokeWidth={active ? 3 : 2} style={{ pointerEvents: "none" }} />
          </g>
        );
      })}
      {preview && (
        <path
          d={bezierPath(preview.x1, preview.y1, preview.x2, preview.y2)}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth={2}
          strokeDasharray="5,5"
          style={{ pointerEvents: "none" }}
        />
      )}
    </svg>
  );
}
