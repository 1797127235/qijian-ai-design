import type { DeskConnection, DeskObject } from "./types";
import {
  bezierMid,
  bezierPath,
  type ConnSide,
  routeAnchors,
} from "./connection-geometry";

export function ConnectionsLayer({
  objects,
  connections,
  selectedId,
  preview,
  onSelect,
  onDelete,
}: {
  objects: DeskObject[];
  connections: DeskConnection[];
  selectedId?: string;
  preview?: { x1: number; y1: number; x2: number; y2: number; fromSide?: ConnSide; toSide?: ConnSide };
  onSelect?: (id: string) => void;
  onDelete?: (id: string) => void;
}) {
  const byId = new Map(objects.map((o) => [o.id, o]));
  return (
    <svg className="desk-connections" style={{ overflow: "visible", position: "absolute", left: 0, top: 0, width: 1, height: 1 }}>
      <defs>
        <marker
          id="conn-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-hairline-strong)" />
        </marker>
        <marker
          id="conn-arrow-active"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-accent)" />
        </marker>
      </defs>
      {connections.map((c) => {
        const from = byId.get(c.from);
        const to = byId.get(c.to);
        if (!from || !to) return null;
        const { fromSide, toSide, start: a, end: b } = routeAnchors(from, to);
        const d = bezierPath(a.x, a.y, b.x, b.y, fromSide, toSide);
        const active = selectedId === c.id;
        return (
          <g key={c.id}>
            <path
              className="conn-hit"
              d={d}
              fill="none"
              stroke="transparent"
              strokeWidth={16}
              style={{ cursor: "pointer" }}
              onPointerDown={(e) => {
                e.stopPropagation();
                if (e.button !== 0) return;
                onSelect?.(c.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onDelete?.(c.id);
              }}
            />
            <path
              d={d}
              fill="none"
              stroke={active ? "var(--color-accent)" : "var(--color-hairline-strong)"}
              strokeWidth={active ? 3 : 2}
              markerEnd={active ? "url(#conn-arrow-active)" : "url(#conn-arrow)"}
              style={{ pointerEvents: "none" }}
            />
            {active && onDelete && (() => {
              const mid = bezierMid(a.x, a.y, b.x, b.y, fromSide, toSide);
              return (
                <g
                  className="conn-delete"
                  transform={`translate(${mid.x}, ${mid.y})`}
                  style={{ cursor: "pointer" }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    if (e.button !== 0) return;
                    onDelete(c.id);
                  }}
                >
                  <circle r={9} fill="var(--color-card)" stroke="var(--color-hairline-strong)" strokeWidth={1.5} />
                  <path d="M -3.5 -3.5 L 3.5 3.5 M 3.5 -3.5 L -3.5 3.5" stroke="var(--color-ink)" strokeWidth={1.5} strokeLinecap="round" />
                </g>
              );
            })()}
          </g>
        );
      })}
      {preview && (
        <path
          d={bezierPath(
            preview.x1,
            preview.y1,
            preview.x2,
            preview.y2,
            preview.fromSide ?? "right",
            preview.toSide ?? "left",
          )}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth={2}
          strokeDasharray="5,5"
          markerEnd="url(#conn-arrow-active)"
          style={{ pointerEvents: "none" }}
        />
      )}
    </svg>
  );
}
