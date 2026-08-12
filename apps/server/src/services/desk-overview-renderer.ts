/**
 * 桌面总览拼图：按 pose 排布缩略 + alias 角标 + 选中描边 + 连线。
 * 纯渲染；读盘/超时由 look_at_desk 负责。
 */
import { createCanvas, loadImage, type Image } from "@napi-rs/canvas";

export const OVERVIEW_CANVAS_EDGE = 1024;
export const OVERVIEW_MAX_TILES = 20;
export const OVERVIEW_THUMB_MAX = 128;
export const OVERVIEW_PAD = 48;
export const OVERVIEW_MIME = "image/png";

export type OverviewTileInput = {
  id: string;
  alias: string;
  label: string;
  lifecycle: "empty" | "pending" | "failed" | "ready";
  x: number;
  y: number;
  /** 可选世界宽；缺省用默认卡片宽 */
  w?: number;
  /** ready 时的缩略解码源；失败则灰块 */
  imageBytes?: Uint8Array | Buffer | null;
  highlighted?: boolean;
};

export type OverviewEdgeInput = {
  fromId: string;
  toId: string;
};

export type OverviewRenderInput = {
  tiles: OverviewTileInput[];
  edges?: OverviewEdgeInput[];
  canvasEdge?: number;
  maxTiles?: number;
  /**
   * 渲染风格：agent（默认，A01 角标 + 选中描边，供 look_at_desk）；
   * human（无角标/无高亮、连线更淡，供人看的项目封面）。
   */
  style?: "agent" | "human";
};

export type OverviewRenderResult = {
  png: Buffer;
  mimeType: typeof OVERVIEW_MIME;
  tileCount: number;
  includedIds: string[];
  omittedIds: string[];
  width: number;
  height: number;
};

const DEFAULT_CARD_W = 220;
const DEFAULT_CARD_H = 160;

type Placed = OverviewTileInput & {
  tw: number;
  th: number;
  cx: number;
  cy: number;
  left: number;
  top: number;
  img?: Image | null;
};

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * 将世界坐标 tiles 画成一张 PNG。
 * 无 ready 真图 tile 时仍可渲染灰块；调用方若要求「整工具失败」应在调用前过滤。
 */
export async function renderDeskOverview(input: OverviewRenderInput): Promise<OverviewRenderResult> {
  const edge = input.canvasEdge ?? OVERVIEW_CANVAS_EDGE;
  const maxTiles = input.maxTiles ?? OVERVIEW_MAX_TILES;
  const human = input.style === "human";
  const ordered = input.tiles.slice();
  const included = ordered.slice(0, maxTiles);
  const omittedIds = ordered.slice(maxTiles).map((t) => t.id);

  if (included.length === 0) {
    const canvas = createCanvas(edge, edge);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#f4f1ea";
    ctx.fillRect(0, 0, edge, edge);
    ctx.fillStyle = "#888";
    ctx.font = "24px sans-serif";
    ctx.fillText("empty desk", 40, 60);
    const png = canvas.toBuffer("image/png");
    return {
      png,
      mimeType: OVERVIEW_MIME,
      tileCount: 0,
      includedIds: [],
      omittedIds,
      width: edge,
      height: edge,
    };
  }

  const placed: Placed[] = [];
  for (const tile of included) {
    const tw = tile.w && tile.w > 0 ? tile.w : DEFAULT_CARD_W;
    const th = Math.round(DEFAULT_CARD_H * (tw / DEFAULT_CARD_W));
    let img: Image | null = null;
    if (tile.imageBytes && tile.imageBytes.byteLength > 0) {
      try {
        img = await loadImage(Buffer.from(tile.imageBytes));
      } catch {
        img = null;
      }
    }
    placed.push({
      ...tile,
      tw,
      th,
      cx: tile.x + tw / 2,
      cy: tile.y + th / 2,
      left: tile.x,
      top: tile.y,
      img,
    });
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of placed) {
    minX = Math.min(minX, p.left);
    minY = Math.min(minY, p.top);
    maxX = Math.max(maxX, p.left + p.tw);
    maxY = Math.max(maxY, p.top + p.th);
  }
  const worldW = Math.max(1, maxX - minX);
  const worldH = Math.max(1, maxY - minY);
  const pad = OVERVIEW_PAD;
  const scale = Math.min((edge - pad * 2) / worldW, (edge - pad * 2) / worldH);
  const ox = (edge - worldW * scale) / 2 - minX * scale;
  const oy = (edge - worldH * scale) / 2 - minY * scale;

  const toScreen = (x: number, y: number) => ({
    x: ox + x * scale,
    y: oy + y * scale,
  });

  const canvas = createCanvas(edge, edge);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#f7f4ed";
  ctx.fillRect(0, 0, edge, edge);

  // 点阵背景
  ctx.fillStyle = "#d9d2c5";
  for (let gx = 16; gx < edge; gx += 24) {
    for (let gy = 16; gy < edge; gy += 24) {
      ctx.beginPath();
      ctx.arc(gx, gy, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const byId = new Map(placed.map((p) => [p.id, p]));
  const edges = input.edges ?? [];
  ctx.strokeStyle = human ? "rgba(80, 90, 110, 0.28)" : "rgba(80, 90, 110, 0.55)";
  ctx.lineWidth = 2;
  for (const e of edges) {
    const a = byId.get(e.fromId);
    const b = byId.get(e.toId);
    if (!a || !b) continue;
    const p1 = toScreen(a.cx, a.cy);
    const p2 = toScreen(b.cx, b.cy);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  }

  for (const p of placed) {
    const tl = toScreen(p.left, p.top);
    const tw = Math.max(28, p.tw * scale);
    const th = Math.max(24, p.th * scale);
    const thumbEdge = clamp(Math.min(tw, th) * 0.92, 24, OVERVIEW_THUMB_MAX);
    const ix = tl.x + (tw - thumbEdge) / 2;
    const iy = tl.y + (th - thumbEdge) / 2;
    // human 风格忽略 highlighted：选中高亮是 agent 会话语义，人看封面不需要
    const highlighted = human ? false : Boolean(p.highlighted);

    // 卡片底
    ctx.fillStyle = highlighted ? "rgba(255, 255, 255, 0.98)" : "rgba(255, 255, 255, 0.92)";
    ctx.strokeStyle = highlighted ? "#2563eb" : "rgba(0,0,0,0.12)";
    ctx.lineWidth = highlighted ? 3 : 1;
    roundRect(ctx, tl.x, tl.y, tw, th, 6);
    ctx.fill();
    ctx.stroke();

    if (p.img) {
      const iw = p.img.width || 1;
      const ih = p.img.height || 1;
      const s = Math.min(thumbEdge / iw, thumbEdge / ih);
      const dw = iw * s;
      const dh = ih * s;
      ctx.drawImage(p.img, ix + (thumbEdge - dw) / 2, iy + (thumbEdge - dh) / 2, dw, dh);
    } else {
      ctx.fillStyle = lifecycleFill(p.lifecycle);
      ctx.fillRect(ix, iy, thumbEdge, thumbEdge);
      ctx.fillStyle = "#444";
      ctx.font = `${Math.max(10, Math.floor(thumbEdge / 8))}px sans-serif`;
      ctx.fillText(p.lifecycle, ix + 4, iy + thumbEdge / 2);
    }

    // alias 角标（仅 agent：对话编号对应；人看封面没有 alias 概念）
    if (!human) {
      const badge = p.alias;
      ctx.font = "bold 12px sans-serif";
      const bw = Math.max(28, ctx.measureText(badge).width + 10);
      const bh = 18;
      ctx.fillStyle = highlighted ? "#2563eb" : "#1f2937";
      roundRect(ctx, tl.x + 4, tl.y + 4, bw, bh, 4);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.fillText(badge, tl.x + 9, tl.y + 17);
    }
  }

  const png = canvas.toBuffer("image/png");
  return {
    png,
    mimeType: OVERVIEW_MIME,
    tileCount: placed.length,
    includedIds: placed.map((p) => p.id),
    omittedIds,
    width: edge,
    height: edge,
  };
}

function lifecycleFill(life: OverviewTileInput["lifecycle"]): string {
  switch (life) {
    case "pending":
      return "#e8e0c8";
    case "failed":
      return "#f0d0d0";
    case "empty":
      return "#e5e5e5";
    default:
      return "#ddd8ce";
  }
}

function roundRect(
  ctx: { beginPath(): void; moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void; closePath(): void },
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}
