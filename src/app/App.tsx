import { useCallback, useEffect, useRef, useState } from "react";
import { api, connectChat, type ArtifactSnapshot, type DeskSnapshot, type ProjectSummary } from "../lib/api";
import { Desk } from "../desk/Desk";
import { DeskObjectView } from "../desk/nodes";
import { ChatPanel, type PendingApproval } from "../desk/ChatPanel";
import { Home } from "../desk/Home";
import { SpaceMapSetup } from "../desk/SpaceMapSetup";
import { mapSnapshot } from "../desk/map";
import type { ChatItem, DeskObject } from "../desk/types";

let seq = 0;
const nextId = () => `m-${Date.now().toString(36)}-${(seq++).toString(36)}`;

function BriefSetup({ onSave }: { onSave: (text: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <div className="note-card brief-card brief-setup obj">
      <span className="pin" />
      <span className="who">客户说 · Brief · 待补写</span>
      <textarea
        className="brief-edit"
        rows={4}
        value={text}
        placeholder="客户是谁、预算、想要什么、痛点是什么"
        onChange={(e) => setText(e.target.value)}
      />
      <button
        type="button"
        className="mini-btn primary"
        disabled={saving || !text.trim()}
        onClick={() => {
          setSaving(true);
          void onSave(text.trim()).finally(() => setSaving(false));
        }}
      >
        {saving ? "保存中…" : "钉到桌面上"}
      </button>
    </div>
  );
}

export function App() {
  const [view, setView] = useState<{ mode: "home" } | { mode: "desk"; projectId: string }>({ mode: "home" });
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [homeError, setHomeError] = useState<string>();

  const [snapshot, setSnapshot] = useState<DeskSnapshot>();
  const [objects, setObjects] = useState<DeskObject[]>([]);
  const [chatItems, setChatItems] = useState<ChatItem[]>([]);
  const [streaming, setStreaming] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingApproval>();
  const [setupOpen, setSetupOpen] = useState(false);
  const [floorPlanFileId, setFloorPlanFileId] = useState<string>();
  const chatRef = useRef<ReturnType<typeof connectChat>>();
  const streamBuf = useRef("");

  const loadProjects = useCallback(async () => {
    try {
      setProjects(await api.listProjects());
    } catch (e) {
      setHomeError(e instanceof Error ? e.message : "无法加载项目列表");
    }
  }, []);

  useEffect(() => {
    if (view.mode === "home") void loadProjects();
  }, [view.mode, loadProjects]);

  const refreshDesk = useCallback(async (projectId: string) => {
    const snap = await api.desk(projectId);
    setSnapshot(snap);
    setObjects(mapSnapshot(snap));
    return snap;
  }, []);

  const openProject = useCallback(
    async (projectId: string) => {
      chatRef.current?.close();
      setChatItems([]);
      setStreaming(undefined);
      setPending(undefined);
      setSetupOpen(false);
      setView({ mode: "desk", projectId });
      try {
        const snap = await refreshDesk(projectId);
        const plan = snap.artifacts.find((a) => a.artifactType === "space_map");
        setFloorPlanFileId(typeof plan?.payload.source_file_id === "string" ? plan.payload.source_file_id : undefined);
        setSetupOpen(!plan);
        const chat = connectChat(projectId, (event) => {
          if (event.type === "agent_event") {
            const inner = event.event;
            if (inner.type === "message_update" && inner.assistantMessageEvent?.type === "text_delta" && inner.assistantMessageEvent.delta) {
              streamBuf.current += inner.assistantMessageEvent.delta;
              setStreaming(streamBuf.current);
            }
            if (inner.type === "message_end" || inner.type === "agent_end") {
              if (streamBuf.current) {
                setChatItems((cur) => [...cur, { id: nextId(), role: "agent", text: streamBuf.current }]);
                streamBuf.current = "";
                setStreaming(undefined);
              }
              setBusy(false);
            }
            if (inner.type === "agent_start") setBusy(true);
            if (inner.type === "tool_execution_start" && inner.toolName) {
              setChatItems((cur) => [...cur.filter((it) => it.role !== "activity"), { id: nextId(), role: "activity", text: `正在执行：${inner.toolName}` }]);
            }
            if (inner.type === "tool_execution_end") {
              setChatItems((cur) => cur.filter((it) => it.role !== "activity"));
            }
            return;
          }
          if (event.type === "approval_request") {
            setPending({ approvalId: event.approvalId, description: event.description });
            return;
          }
          if (event.type === "approval_resolved") {
            setPending(undefined);
            return;
          }
          if (event.type === "object_changed") {
            void refreshDesk(projectId);
            return;
          }
          if (event.type === "error") {
            setChatItems((cur) => [...cur, { id: nextId(), role: "agent", text: `出错了：${event.message}` }]);
            setBusy(false);
          }
        });
        chatRef.current = chat;
      } catch (e) {
        setChatItems([{ id: nextId(), role: "agent", text: `打开项目失败：${e instanceof Error ? e.message : "未知错误"}` }]);
      }
    },
    [refreshDesk],
  );

  useEffect(() => () => chatRef.current?.close(), []);

  const createProject = useCallback(
    async (input: { name: string }) => {
      const project = await api.createProject(input.name);
      setFloorPlanFileId(undefined);
      await openProject(project.id);
    },
    [openProject],
  );

  const deleteProject = useCallback(async (project: ProjectSummary) => {
    try {
      await api.deleteProject(project.id);
      setProjects((cur) => cur.filter((p) => p.id !== project.id));
    } catch (e) {
      setHomeError(e instanceof Error ? e.message : "删除失败");
    }
  }, []);

  const projectId = view.mode === "desk" ? view.projectId : undefined;

  const artifactOf = useCallback(
    (id: string): ArtifactSnapshot | undefined => snapshot?.artifacts.find((a) => a.id === id),
    [snapshot],
  );

  const onMove = useCallback((id: string, x: number, y: number) => {
    setObjects((cur) => cur.map((o) => (o.id === id ? { ...o, x, y } : o)));
  }, []);

  const onMoveEnd = useCallback(
    (id: string, x: number, y: number) => {
      if (!projectId) return;
      void api.moveObject(projectId, id, { x: Math.round(x), y: Math.round(y) }).catch(() => undefined);
    },
    [projectId],
  );

  const persistViewport = useRef<number>();
  const onViewportChange = useCallback(
    (viewport: { x: number; y: number; zoom: number }) => {
      if (!projectId) return;
      window.clearTimeout(persistViewport.current);
      persistViewport.current = window.setTimeout(() => {
        void api.setViewport(projectId, viewport).catch(() => undefined);
      }, 800);
    },
    [projectId],
  );

  const withRefresh = useCallback(
    async (fn: () => Promise<unknown>) => {
      if (!projectId) return;
      try {
        await fn();
        await refreshDesk(projectId);
      } catch (e) {
        setChatItems((cur) => [...cur, { id: nextId(), role: "agent", text: `操作失败：${e instanceof Error ? e.message : "未知错误"}` }]);
      }
    },
    [projectId, refreshDesk],
  );

  const onConfirm = useCallback(
    (artifactId: string) => withRefresh(() => api.confirmArtifact(artifactId)),
    [withRefresh],
  );

  const onSelectDirection = useCallback(
    (artifactId: string, directionId: string) =>
      withRefresh(async () => {
        const artifact = artifactOf(artifactId);
        if (!artifact) return;
        await api.appendVersion(artifactId, { ...artifact.payload, selected_direction_id: directionId });
      }),
    [artifactOf, withRefresh],
  );

  const onAdopt = useCallback(
    (artifactId: string, adopted: boolean) =>
      withRefresh(async () => {
        const artifact = artifactOf(artifactId);
        if (!artifact) return;
        await api.appendVersion(artifactId, { ...artifact.payload, adopted });
      }),
    [artifactOf, withRefresh],
  );

  const onSaveBrief = useCallback(
    (artifactId: string, text: string) =>
      withRefresh(async () => {
        const artifact = artifactOf(artifactId);
        if (!artifact || !text) return;
        await api.appendVersion(artifactId, { ...artifact.payload, text });
      }),
    [artifactOf, withRefresh],
  );

  const sendChat = useCallback(
    (text: string) => {
      setChatItems((cur) => [...cur, { id: nextId(), role: "user", text }]);
      setBusy(true);
      chatRef.current?.prompt(text);
    },
    [],
  );

  const togglePermission = useCallback(() => {
    if (!projectId || !snapshot) return;
    const next = snapshot.project.permission === "ask" ? "auto" : "ask";
    void api.setPermission(projectId, next).then(() => refreshDesk(projectId)).catch(() => undefined);
  }, [projectId, snapshot, refreshDesk]);

  const exportPackage = useCallback(() => {
    if (!projectId) return;
    setBusy(true);
    void api
      .exportPackage(projectId)
      .then((result) => {
        setChatItems((cur) => [
          ...cur,
          { id: nextId(), role: "agent", text: result.pdfUrl ? `提案包已导出：${result.pdfUrl}` : "提案包已导出。" },
        ]);
      })
      .catch((e) => setChatItems((cur) => [...cur, { id: nextId(), role: "agent", text: `导出失败：${e instanceof Error ? e.message : "未知错误"}` }]))
      .finally(() => setBusy(false));
  }, [projectId]);

  if (view.mode === "home") {
    return (
      <div className="app-shell">
        <header className="topbar">
          <span className="seal-box">砌</span>
          <div className="brand">砌间<small>QIJIAN AI DESIGN</small></div>
        </header>
        <Home
          projects={projects}
          error={homeError}
          onOpen={(p) => void openProject(p.id)}
          onCreate={createProject}
          onDelete={deleteProject}
        />
      </div>
    );
  }

  const direction = objects.find((o) => o.kind === "direction_set" && o.status === "confirmed" && o.selectedId);
  const planObj = objects.find((o) => o.kind === "plan");
  const briefObj = objects.find((o) => o.kind === "brief");

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="seal-box">砌</span>
        <div className="brand">砌间<small>QIJIAN AI DESIGN</small></div>
        <button type="button" className="back-btn" onClick={() => setView({ mode: "home" })}>← 项目列表</button>
        <span className="proj-name">{snapshot?.project.name}</span>
        <div className="top-right">
          {direction?.kind === "direction_set" && (
            <span className="pill acc">方向 · {direction.directions.find((d) => d.id === direction.selectedId)?.title}</span>
          )}
          <button type="button" className="export-btn" onClick={exportPackage}>导出提案包</button>
        </div>
      </header>
      <div className="workbench">
        <Desk
          objects={objects}
          initialViewport={snapshot?.deskState.viewport}
          onMove={onMove}
          onMoveEnd={onMoveEnd}
          onViewportChange={onViewportChange}
          renderObject={(obj) => (
            <DeskObjectView obj={obj} handlers={{ onConfirm, onSelectDirection, onAdopt, onSaveBrief, onRedrawPlan: () => setSetupOpen(true) }} />
          )}
        />
        {projectId && !briefObj && (
          <BriefSetup
            onSave={async (text) => {
              await withRefresh(() =>
                api.createArtifact(projectId, {
                  artifactType: "design_brief",
                  payload: { text, files: [] },
                  layout: { kind: "brief", x: 60, y: 70, rot: -1.5 },
                }),
              );
            }}
          />
        )}
        {setupOpen && projectId && (
          <SpaceMapSetup
            projectId={projectId}
            initialFileId={floorPlanFileId ?? (planObj?.kind === "plan" ? planObj.sourceFileId : undefined)}
            existingSpaces={planObj?.kind === "plan" ? planObj.spaces : undefined}
            onCancel={planObj ? () => setSetupOpen(false) : undefined}
            onSave={async (payload) => {
              await withRefresh(async () => {
                const existing = planObj && artifactOf(planObj.id);
                if (existing) {
                  await api.appendVersion(existing.id, payload);
                } else {
                  await api.createArtifact(projectId, {
                    artifactType: "space_map",
                    payload,
                    layout: { kind: "plan", x: 420, y: 90, w: 640 },
                  });
                }
              });
              setSetupOpen(false);
            }}
          />
        )}
        <ChatPanel
          items={chatItems}
          streaming={streaming}
          busy={busy}
          permission={snapshot?.project.permission ?? "ask"}
          pending={pending}
          onTogglePermission={togglePermission}
          onSend={sendChat}
          onApprove={() => pending && chatRef.current?.respondApproval(pending.approvalId, true)}
          onReject={() => pending && chatRef.current?.respondApproval(pending.approvalId, false)}
        />
      </div>
    </div>
  );
}
