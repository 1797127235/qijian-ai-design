import { useEffect, useRef, useState } from "react";
import { Badge, GateBar, Spinner, TaskState } from "../components/ui";
import {
  api,
  versionedOf,
  type CanvasLayoutNode,
  type CanvasLayoutPayload,
  type ProposalCanvasPayload,
  type SpaceMapPayload,
  type SpaceProposalPayload,
  type SpaceRegion,
  type UpstreamVersionRefs,
  type Versioned,
} from "../lib/api";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function bboxOf(polygon: Array<{ x: number; y: number }>) {
  const xs = polygon.map((p) => p.x);
  const ys = polygon.map((p) => p.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

export function CanvasScreen({
  projectId,
  spaceMap,
  canvas,
  proposals,
  layout,
  directionTitle,
  upstream,
  floorPlanFileId,
  onSpaceMap,
  onCanvas,
  onProposals,
  onLayout,
}: {
  projectId: string;
  spaceMap?: Versioned<SpaceMapPayload>;
  canvas?: Versioned<ProposalCanvasPayload>;
  proposals: Array<Versioned<SpaceProposalPayload>>;
  layout?: CanvasLayoutPayload;
  directionTitle?: string;
  upstream?: UpstreamVersionRefs;
  floorPlanFileId?: string;
  onSpaceMap: (v: Versioned<SpaceMapPayload>) => void;
  onCanvas: (v: Versioned<ProposalCanvasPayload>) => void;
  onProposals: (v: Array<Versioned<SpaceProposalPayload>>) => void;
  onLayout: (l: CanvasLayoutPayload) => void;
}) {
  if (!spaceMap || spaceMap.status !== "confirmed") {
    if (!floorPlanFileId || !upstream) {
      return <TaskState title="缺少创建空间地图的输入" detail="需要已确认的设计方向、方案约束包与户型图纸，才能创建空间地图。" />;
    }
    return (
      <SpaceMapSetup
        projectId={projectId}
        spaceMap={spaceMap}
        upstream={upstream}
        floorPlanFileId={floorPlanFileId}
        onDone={onSpaceMap}
      />
    );
  }
  if (!canvas) {
    return (
      <CreateCanvasGate
        projectId={projectId}
        spaceMap={spaceMap}
        directionTitle={directionTitle}
        onDone={onCanvas}
      />
    );
  }
  return (
    <CanvasView
      projectId={projectId}
      spaceMap={spaceMap}
      canvas={canvas}
      proposals={proposals}
      layout={layout}
      directionTitle={directionTitle}
      floorPlanFileId={floorPlanFileId}
      onProposals={onProposals}
      onLayout={onLayout}
    />
  );
}

/* ── 第一步：空间地图创建 / 校正 ── */

function SpaceMapSetup({
  projectId,
  spaceMap,
  upstream,
  floorPlanFileId,
  onDone,
}: {
  projectId: string;
  spaceMap?: Versioned<SpaceMapPayload>;
  upstream: UpstreamVersionRefs;
  floorPlanFileId: string;
  onDone: (v: Versioned<SpaceMapPayload>) => void;
}) {
  const [regions, setRegions] = useState<SpaceRegion[]>(spaceMap?.payload.spaces ?? []);
  const [draw, setDraw] = useState<{ x: number; y: number; w: number; h: number }>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [imgFailed, setImgFailed] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ x: number; y: number }>();

  const norm = (e: React.PointerEvent) => {
    const rect = stageRef.current!.getBoundingClientRect();
    return { x: clamp01((e.clientX - rect.left) / rect.width), y: clamp01((e.clientY - rect.top) / rect.height) };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest(".smap-region")) return;
    const p = norm(e);
    dragStart.current = p;
    setDraw({ x: p.x, y: p.y, w: 0, h: 0 });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragStart.current) return;
    const p = norm(e);
    const s = dragStart.current;
    setDraw({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
  };
  const onPointerUp = () => {
    dragStart.current = undefined;
    if (draw && draw.w * draw.h >= 0.0004) {
      const { x, y, w, h } = draw;
      setRegions((cur) => [
        ...cur,
        {
          space_id: `space-${Date.now().toString(36)}`,
          name: `空间 ${cur.length + 1}`,
          use: "待填写用途",
          polygon: [
            { x, y },
            { x: x + w, y },
            { x: x + w, y: y + h },
            { x, y: y + h },
          ],
          is_key_space: cur.length === 0,
          designer_confirmed: false,
        },
      ]);
    }
    setDraw(undefined);
  };

  const update = (spaceId: string, patch: Partial<SpaceRegion>) =>
    setRegions((cur) => cur.map((r) => (r.space_id === spaceId ? { ...r, ...patch } : r)));
  const remove = (spaceId: string) => setRegions((cur) => cur.filter((r) => r.space_id !== spaceId));

  const save = async (status: "draft" | "confirmed") => {
    setError(undefined);
    if (regions.length === 0) {
      setError("请先在图纸上拖出至少一个空间区域。");
      return;
    }
    if (status === "confirmed" && !regions.some((r) => r.is_key_space)) {
      setError("确认前请至少标记一个关键空间（★）。");
      return;
    }
    setSaving(true);
    try {
      const payload: SpaceMapPayload = {
        schema_version: "home_v1",
        source_file_id: floorPlanFileId,
        page_index: 0,
        upstream,
        spaces: regions.map((r) => (status === "confirmed" ? { ...r, designer_confirmed: true } : r)),
        relationships: spaceMap?.payload.relationships ?? [],
      };
      const saved = spaceMap
        ? await api.saveSpaceMap(spaceMap.artifactId, payload, status)
        : await api.createSpaceMap(projectId, payload, status);
      const v = versionedOf(saved);
      if (v) onDone(v);
    } catch (e) {
      setError(e instanceof Error ? e.message : "暂时无法保存空间地图。");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page wide smap">
      <div className="canvas-hud" style={{ position: "absolute" }}>
        <span className="hud-pill accent">第 1 步 · 空间地图</span>
        <span className="hud-pill">在户型图上拖出空间区域，逐项命名并标记关键空间</span>
      </div>
      <div className="smap-grid">
        <div className="smap-stage-wrap">
          {imgFailed ? (
            <TaskState title="图纸无法直接预览" detail="该图纸可能是 PDF。请查看原始文件后，在此按比例标注空间区域。" />
          ) : (
            <div
              ref={stageRef}
              className="smap-stage"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <img src={api.fileContentUrl(floorPlanFileId)} alt="户型图纸" draggable={false} onError={() => setImgFailed(true)} />
              {regions.map((r) => {
                const b = bboxOf(r.polygon);
                return (
                  <div
                    key={r.space_id}
                    className={`smap-region ${r.is_key_space ? "key" : ""}`}
                    style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }}
                  >
                    {r.name}{r.is_key_space ? " ★" : ""}
                  </div>
                );
              })}
              {draw && (
                <div
                  className="smap-draw"
                  style={{ left: `${draw.x * 100}%`, top: `${draw.y * 100}%`, width: `${draw.w * 100}%`, height: `${draw.h * 100}%` }}
                />
              )}
            </div>
          )}
        </div>

        <aside className="smap-side">
          <p className="eyebrow">空间区域 · {regions.length}</p>
          {error && <p className="error-text" role="alert">{error}</p>}
          <div className="smap-list">
            {regions.map((r) => (
              <div className="card" key={r.space_id} style={{ padding: 12 }}>
                <label className="field" style={{ marginBottom: 8 }}>
                  <span>空间名称</span>
                  <input className="input" style={{ minHeight: 36 }} value={r.name} onChange={(e) => update(r.space_id, { name: e.target.value })} />
                </label>
                <label className="field" style={{ marginBottom: 8 }}>
                  <span>用途</span>
                  <input className="input" style={{ minHeight: 36 }} value={r.use} onChange={(e) => update(r.space_id, { use: e.target.value })} />
                </label>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <button
                    type="button"
                    className={`btn ${r.is_key_space ? "primary" : "secondary"}`}
                    style={{ minHeight: 30, padding: "5px 10px", fontSize: 12 }}
                    aria-pressed={r.is_key_space}
                    onClick={() => update(r.space_id, { is_key_space: !r.is_key_space })}
                  >
                    {r.is_key_space ? "★ 关键空间" : "☆ 设为关键"}
                  </button>
                  <button type="button" className="btn ghost" style={{ minHeight: 30, padding: "5px 8px", fontSize: 12 }} onClick={() => remove(r.space_id)}>
                    删除
                  </button>
                </div>
              </div>
            ))}
            {regions.length === 0 && <p className="mono">在左侧图纸上按住拖动，框出第一个空间。</p>}
          </div>
          <GateBar note="确认后空间地图锁定，提案画布将继承此版本。">
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="btn secondary" disabled={saving} onClick={() => void save("draft")}>保存草稿</button>
              <button type="button" className="btn primary" disabled={saving} data-state={saving ? "loading" : undefined} onClick={() => void save("confirmed")}>
                {saving ? <><Spinner /> 正在确认…</> : "确认空间地图 →"}
              </button>
            </div>
          </GateBar>
        </aside>
      </div>
    </div>
  );
}

/* ── 第二步：创建提案画布 ── */

function CreateCanvasGate({
  projectId,
  spaceMap,
  directionTitle,
  onDone,
}: {
  projectId: string;
  spaceMap: Versioned<SpaceMapPayload>;
  directionTitle?: string;
  onDone: (v: Versioned<ProposalCanvasPayload>) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const keySpaces = spaceMap.payload.spaces.filter((s) => s.is_key_space);

  const create = async () => {
    setCreating(true);
    setError(undefined);
    try {
      const created = await api.createProposalCanvas(projectId, {
        schema_version: "home_v1",
        title: directionTitle ? `${directionTitle} · 提案画布` : "提案画布",
        branch_id: "main",
        space_map_artifact_id: spaceMap.artifactId,
        space_map_version_id: spaceMap.versionId,
        upstream: spaceMap.payload.upstream,
        key_space_ids: keySpaces.map((s) => s.space_id),
      });
      const v = versionedOf(created);
      if (v) onDone(v);
    } catch (e) {
      setError(e instanceof Error ? e.message : "暂时无法创建提案画布。");
      setCreating(false);
    }
  };

  return (
    <div className="page">
      <p className="eyebrow">提案画布 · 第 2 步</p>
      <h1 className="h-display">空间地图已确认</h1>
      <p className="lede">提案画布将绑定空间地图、设计方向与方案约束包版本，并在关键空间下组织空间提案卡。</p>
      <div className="card" style={{ padding: 18, marginTop: 20 }}>
        <span className="mono" style={{ letterSpacing: "0.1em" }}>关键空间 · {keySpaces.length}</span>
        <div className="chips" style={{ marginTop: 10 }}>
          {keySpaces.map((s) => <span className="chip" key={s.space_id}>{s.name}</span>)}
        </div>
      </div>
      {error && <p className="error-text" role="alert" style={{ marginTop: 12 }}>{error}</p>}
      <GateBar note="创建后可在画布上为每个关键空间建立空间提案卡。">
        <button type="button" className="btn primary" disabled={creating} data-state={creating ? "loading" : undefined} onClick={() => void create()}>
          {creating ? <><Spinner /> 正在创建…</> : "创建提案画布 →"}
        </button>
      </GateBar>
    </div>
  );
}

/* ── 第三步：画布视图（提案卡 + 布局） ── */

function CanvasView({
  projectId,
  spaceMap,
  canvas,
  proposals,
  layout,
  directionTitle,
  floorPlanFileId,
  onProposals,
  onLayout,
}: {
  projectId: string;
  spaceMap: Versioned<SpaceMapPayload>;
  canvas: Versioned<ProposalCanvasPayload>;
  proposals: Array<Versioned<SpaceProposalPayload>>;
  layout?: CanvasLayoutPayload;
  directionTitle?: string;
  floorPlanFileId?: string;
  onProposals: (v: Array<Versioned<SpaceProposalPayload>>) => void;
  onLayout: (l: CanvasLayoutPayload) => void;
}) {
  const [viewport, setViewport] = useState(layout?.viewport ?? { x: 0, y: 0, zoom: 1 });
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>(() => {
    const map: Record<string, { x: number; y: number }> = {};
    layout?.nodes.forEach((n) => { map[n.artifact_id] = { x: n.x, y: n.y }; });
    return map;
  });
  const [panning, setPanning] = useState(false);
  const [savingLayout, setSavingLayout] = useState(false);
  const [error, setError] = useState<string>();
  const [draftFor, setDraftFor] = useState<string>();
  const pan = useRef({ x: 0, y: 0, vx: 0, vy: 0 });
  const nodeDrag = useRef<{ id: string; ox: number; oy: number }>();

  useEffect(() => {
    setPositions((cur) => {
      const next = { ...cur };
      proposals.forEach((p, i) => {
        if (!next[p.artifactId]) next[p.artifactId] = { x: 480, y: 70 + i * 330 };
      });
      return next;
    });
  }, [proposals]);

  const spaceName = (id: string) => spaceMap.payload.spaces.find((s) => s.space_id === id)?.name ?? id;
  const missingKeySpaces = canvas.payload.key_space_ids.filter((id) => !proposals.some((p) => p.payload.space_id === id));

  const persistLayout = async (nextPositions: Record<string, { x: number; y: number }>, nextViewport = viewport) => {
    setSavingLayout(true);
    try {
      const nodes: CanvasLayoutNode[] = proposals.map((p, i) => ({
        layout_node_id: `node-${p.artifactId.slice(0, 8)}`,
        artifact_id: p.artifactId,
        node_type: "space_proposal",
        x: Math.round(nextPositions[p.artifactId]?.x ?? 480),
        y: Math.round(nextPositions[p.artifactId]?.y ?? 70 + i * 330),
        width: 330,
        height: 300,
        z_index: i + 1,
      }));
      const payload: CanvasLayoutPayload = {
        viewport: nextViewport,
        nodes,
        visible_layers: layout?.visible_layers ?? ["floor_plan", "spaces", "relationships", "assets"],
        narrative_order: proposals.map((p) => p.artifactId),
      };
      const saved = await api.saveCanvasLayout(canvas.artifactId, payload);
      onLayout(saved.payload);
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : "布局保存失败");
    } finally {
      setSavingLayout(false);
    }
  };

  const startPan = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest(".node")) return;
    setPanning(true);
    pan.current = { x: e.clientX, y: e.clientY, vx: viewport.x, vy: viewport.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const movePan = (e: React.PointerEvent) => {
    if (!panning) return;
    setViewport((v) => ({ ...v, x: pan.current.vx + e.clientX - pan.current.x, y: pan.current.vy + e.clientY - pan.current.y }));
  };
  const endPan = () => {
    if (!panning) return;
    setPanning(false);
    void persistLayout(positions);
  };

  const startNodeDrag = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    const pos = positions[id] ?? { x: 0, y: 0 };
    nodeDrag.current = { id, ox: e.clientX / viewport.zoom - pos.x, oy: e.clientY / viewport.zoom - pos.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const moveNodeDrag = (e: React.PointerEvent) => {
    if (!nodeDrag.current) return;
    const { id, ox, oy } = nodeDrag.current;
    setPositions((cur) => ({ ...cur, [id]: { x: e.clientX / viewport.zoom - ox, y: e.clientY / viewport.zoom - oy } }));
  };
  const endNodeDrag = () => {
    if (!nodeDrag.current) return;
    nodeDrag.current = undefined;
    void persistLayout(positions);
  };

  return (
    <div
      className={`canvas-wrap ${panning ? "panning" : ""}`}
      onPointerDown={startPan}
      onPointerMove={(e) => { movePan(e); moveNodeDrag(e); }}
      onPointerUp={() => { endPan(); endNodeDrag(); }}
      onPointerCancel={() => { endPan(); endNodeDrag(); }}
    >
      <div className="canvas-hud">
        <span className="hud-pill">空间地图 · 已确认</span>
        <span className="hud-pill">约束包 · 继承中</span>
        {directionTitle && <span className="hud-pill accent">方向 · {directionTitle}</span>}
        {savingLayout && <span className="hud-pill">布局保存中…</span>}
      </div>
      <div className="branch-tabs">
        <button type="button" className="branch on">主分支</button>
        <button type="button" className="branch" disabled title="画布分支将在后续版本开放">+ 新分支</button>
      </div>
      {error && <p className="error-text" role="alert" style={{ position: "absolute", top: 54, left: 16, zIndex: 10 }}>{error}</p>}

      <div className="canvas-stage" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`, width: 1200, height: 800 }}>
        <div className="map-frame">
          {floorPlanFileId && <img src={api.fileContentUrl(floorPlanFileId)} alt="户型图纸" draggable={false} />}
          {spaceMap.payload.spaces.map((s) => {
            const b = bboxOf(s.polygon);
            return (
              <div
                className={`map-node ${s.is_key_space ? "key" : ""}`}
                key={s.space_id}
                style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }}
              >
                {s.name}{s.is_key_space ? " ★" : ""}
              </div>
            );
          })}
        </div>

        {proposals.map((p) => {
          const pos = positions[p.artifactId] ?? { x: 480, y: 70 };
          return (
            <div className="node" key={p.artifactId} style={{ left: pos.x, top: pos.y, width: 330 }}>
              <div
                className="node-head"
                style={{ cursor: "grab", touchAction: "none" }}
                onPointerDown={(e) => startNodeDrag(e, p.artifactId)}
              >
                <span className="t">{p.payload.title}</span>
                <Badge tone={p.payload.review_status === "current" ? "soft" : "tbc"}>
                  {p.payload.review_status === "current" ? "关键空间" : "待复核"}
                </Badge>
              </div>
              <div className="node-body">
                <div className="k">目标</div>
                {p.payload.objective}
                {p.payload.inherited_constraint_ids.length > 0 && (
                  <div style={{ marginTop: 8 }}><Badge tone="soft">{p.payload.inherited_constraint_ids.length} 条继承约束</Badge></div>
                )}
                {p.payload.prohibited_content.length > 0 && (
                  <div style={{ marginTop: 6 }}><Badge tone="ban">禁 · {p.payload.prohibited_content.length}</Badge></div>
                )}
              </div>
            </div>
          );
        })}

        {missingKeySpaces.map((spaceId, i) => (
          <div className="node missing" key={spaceId} style={{ left: 480, top: 70 + (proposals.length + i) * 330, width: 330 }}>
            {draftFor === spaceId ? (
              <ProposalDraftForm
                spaceName={spaceName(spaceId)}
                onCancel={() => setDraftFor(undefined)}
                onCreate={async (fields) => {
                  const created = await api.createSpaceProposal(projectId, {
                    schema_version: "home_v1",
                    proposal_canvas_artifact_id: canvas.artifactId,
                    proposal_canvas_version_id: canvas.versionId,
                    space_map_artifact_id: spaceMap.artifactId,
                    space_map_version_id: spaceMap.versionId,
                    space_id: spaceId,
                    title: fields.title || `${spaceName(spaceId)} · 提案`,
                    objective: fields.objective,
                    usage_scenario: fields.usage_scenario,
                    spatial_strategy: fields.spatial_strategy,
                    image_focus: fields.image_focus,
                    suggested_views: fields.suggested_views.split(/[、,，;；]/).map((s) => s.trim()).filter(Boolean).slice(0, 6),
                    materials_and_furniture: [],
                    lighting_language: [],
                    inherited_constraint_ids: [],
                    prohibited_content: [],
                    review_status: "needs_review",
                  });
                  const v = versionedOf(created);
                  if (v) {
                    const next = [...proposals, v];
                    onProposals(next);
                    setDraftFor(undefined);
                    void persistLayout({ ...positions, [v.artifactId]: { x: 480, y: 70 + proposals.length * 330 } });
                  }
                }}
              />
            ) : (
              <button type="button" className="node-add" onClick={() => setDraftFor(spaceId)}>
                ＋ {spaceName(spaceId)} · 创建空间提案卡
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="canvas-tools">
        <button type="button" className="btn" aria-label="缩小" onClick={() => setViewport((v) => ({ ...v, zoom: Math.max(0.4, v.zoom - 0.1) }))}>−</button>
        <span className="mono" style={{ alignSelf: "center", padding: "0 6px" }}>{Math.round(viewport.zoom * 100)}%</span>
        <button type="button" className="btn" aria-label="放大" onClick={() => setViewport((v) => ({ ...v, zoom: Math.min(2, v.zoom + 0.1) }))}>＋</button>
        <button type="button" className="btn" onClick={() => { setViewport({ x: 0, y: 0, zoom: 1 }); void persistLayout(positions, { x: 0, y: 0, zoom: 1 }); }}>复位</button>
      </div>
    </div>
  );
}

function ProposalDraftForm({
  spaceName,
  onCreate,
  onCancel,
}: {
  spaceName: string;
  onCreate: (fields: { title: string; objective: string; usage_scenario: string; spatial_strategy: string; image_focus: string; suggested_views: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [fields, setFields] = useState({ title: "", objective: "", usage_scenario: "", spatial_strategy: "", image_focus: "", suggested_views: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const set = (k: keyof typeof fields) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setFields((cur) => ({ ...cur, [k]: e.target.value }));

  const submit = async () => {
    setError(undefined);
    if (!fields.objective || !fields.usage_scenario || !fields.spatial_strategy || !fields.image_focus || !fields.suggested_views.trim()) {
      setError("请填写目标、使用场景、空间策略、画面焦点与建议视角。");
      return;
    }
    setSubmitting(true);
    try {
      await onCreate(fields);
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败");
      setSubmitting(false);
    }
  };

  return (
    <div className="node-body" style={{ padding: 14 }}>
      <p className="eyebrow" style={{ marginBottom: 10 }}>{spaceName} · 空间提案卡</p>
      {error && <p className="error-text" role="alert" style={{ marginBottom: 8 }}>{error}</p>}
      <label className="field" style={{ marginBottom: 8 }}><span>标题（可选）</span>
        <input className="input" style={{ minHeight: 34 }} value={fields.title} onChange={set("title")} placeholder={`${spaceName} · 提案`} /></label>
      <label className="field" style={{ marginBottom: 8 }}><span>空间目标</span>
        <textarea className="textarea" style={{ minHeight: 56 }} value={fields.objective} onChange={set("objective")} /></label>
      <label className="field" style={{ marginBottom: 8 }}><span>使用场景</span>
        <textarea className="textarea" style={{ minHeight: 48 }} value={fields.usage_scenario} onChange={set("usage_scenario")} /></label>
      <label className="field" style={{ marginBottom: 8 }}><span>空间策略</span>
        <textarea className="textarea" style={{ minHeight: 56 }} value={fields.spatial_strategy} onChange={set("spatial_strategy")} /></label>
      <label className="field" style={{ marginBottom: 8 }}><span>画面焦点</span>
        <input className="input" style={{ minHeight: 34 }} value={fields.image_focus} onChange={set("image_focus")} /></label>
      <label className="field" style={{ marginBottom: 10 }}><span>建议视角（顿号分隔）</span>
        <input className="input" style={{ minHeight: 34 }} value={fields.suggested_views} onChange={set("suggested_views")} placeholder="如：从玄关看向客厅、阳台反打" /></label>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className="btn ghost" style={{ minHeight: 32 }} onClick={onCancel} disabled={submitting}>取消</button>
        <button type="button" className="btn primary" style={{ minHeight: 32 }} disabled={submitting} data-state={submitting ? "loading" : undefined} onClick={() => void submit()}>
          {submitting ? <><Spinner /> 创建中…</> : "创建提案卡"}
        </button>
      </div>
    </div>
  );
}
