import { useCallback, useEffect, useRef, useState } from "react";
import { api, type DeskSnapshot, type ProjectSummary } from "../lib/api";
import { Desk } from "../desk/Desk";
import { DeskObjectView } from "../desk/nodes";
import { ChatPanel } from "../desk/ChatPanel";
import { Home } from "../desk/Home";
import { SpaceMapSetup } from "../desk/SpaceMapSetup";
import { mapSnapshot } from "../desk/map";
import type { DeskObject } from "../desk/types";
import { nextId } from "./ids";
import { useChatSession } from "./useChatSession";
import { useDeskActions } from "./useDeskActions";

type AppView = { mode: "home" } | { mode: "desk"; projectId: string };

const PROJECT_PATH = /^\/p\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

function viewFromPath(pathname: string): AppView {
  const match = pathname.match(PROJECT_PATH);
  return match ? { mode: "desk", projectId: match[1] } : { mode: "home" };
}

function pathForView(next: AppView) {
  return next.mode === "home" ? "/" : `/p/${next.projectId}`;
}

export function App() {
  const [view, setView] = useState<AppView>(() => viewFromPath(window.location.pathname));
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [homeError, setHomeError] = useState<string>();
  const [snapshot, setSnapshot] = useState<DeskSnapshot>();
  const [objects, setObjects] = useState<DeskObject[]>([]);
  const [setupOpen, setSetupOpen] = useState(false);
  const [floorPlanFileId, setFloorPlanFileId] = useState<string>();
  const [composerHandoff, setComposerHandoff] = useState<{ text?: string; files?: File[] }>();
  const activeProjectRef = useRef<string>();
  const refreshSequence = useRef(0);
  const hasAttachmentDraftRef = useRef(false);
  const skipHistoryRef = useRef(false);
  const bootstrappedRef = useRef(false);

  const refreshDesk = useCallback(async (projectId: string) => {
    const sequence = ++refreshSequence.current;
    const snap = await api.desk(projectId);
    if (activeProjectRef.current === projectId && refreshSequence.current === sequence) {
      setSnapshot(snap);
      setObjects(mapSnapshot(snap));
    }
    return snap;
  }, []);

  const chat = useChatSession({ activeProjectRef, refreshDesk });
  const projectId = view.mode === "desk" ? view.projectId : undefined;
  const desk = useDeskActions({
    projectId,
    snapshot,
    activeProjectRef,
    refreshDesk,
    setChatItems: chat.setChatItems,
    setObjects,
  });

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

  useEffect(() => {
    if (chat.focusFromAgent) desk.setFocusRequest(chat.focusFromAgent);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to agent focus events
  }, [chat.focusFromAgent]);

  const closeChat = chat.closeChat;
  const resetChatUi = chat.resetChatUi;
  const clearViewportTimer = desk.clearViewportTimer;
  const bindProjectChat = chat.bindProjectChat;
  const setChatConnection = chat.setConnection;
  const setChatBusy = chat.setBusy;
  const setChatItems = chat.setChatItems;

  const resetToHome = useCallback(() => {
    activeProjectRef.current = undefined;
    hasAttachmentDraftRef.current = false;
    setComposerHandoff(undefined);
    refreshSequence.current += 1;
    closeChat();
    resetChatUi();
    clearViewportTimer();
    setSnapshot(undefined);
    setObjects([]);
    setSetupOpen(false);
    setView({ mode: "home" });
  }, [clearViewportTimer, closeChat, resetChatUi]);

  const openProject = useCallback(
    async (nextProjectId: string, options?: { initialText?: string; initialFiles?: File[]; history?: "push" | "replace" | "none" }) => {
      const historyMode = options?.history ?? "push";
      activeProjectRef.current = nextProjectId;
      setComposerHandoff(options?.initialText || options?.initialFiles?.length
        ? { text: options.initialText, files: options.initialFiles }
        : undefined);
      clearViewportTimer();
      setSnapshot(undefined);
      setObjects([]);
      setSetupOpen(false);
      setFloorPlanFileId(undefined);
      setView({ mode: "desk", projectId: nextProjectId });
      const nextPath = pathForView({ mode: "desk", projectId: nextProjectId });
      if (historyMode !== "none" && window.location.pathname !== nextPath) {
        const state = { view: "desk", projectId: nextProjectId };
        if (historyMode === "replace") window.history.replaceState(state, "", nextPath);
        else window.history.pushState(state, "", nextPath);
      }
      try {
        const snap = await refreshDesk(nextProjectId);
        if (activeProjectRef.current !== nextProjectId) return;
        const plan = snap.artifacts.find((a) => a.artifactType === "space_map");
        setFloorPlanFileId(typeof plan?.payload.source_file_id === "string" ? plan.payload.source_file_id : undefined);
        await bindProjectChat(nextProjectId);
      } catch (e) {
        if (activeProjectRef.current !== nextProjectId) return;
        setChatConnection("disconnected");
        setChatBusy(false);
        setChatItems([{ id: nextId(), role: "agent", text: `打开项目失败：${e instanceof Error ? e.message : "未知错误"}` }]);
      }
    },
    [bindProjectChat, clearViewportTimer, refreshDesk, setChatBusy, setChatConnection, setChatItems],
  );

  useEffect(() => () => {
    closeChat();
    clearViewportTimer();
  }, [closeChat, clearViewportTimer]);

  const leaveProject = useCallback((options?: { history?: "push" | "none" }) => {
    if (hasAttachmentDraftRef.current && !window.confirm("当前消息还有未发送的附件。离开后将丢弃这些附件，是否继续？")) return false;
    resetToHome();
    if ((options?.history ?? "push") === "push" && window.location.pathname !== "/") {
      window.history.pushState({ view: "home" }, "", "/");
    }
    return true;
  }, [resetToHome]);

  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    const initial = viewFromPath(window.location.pathname);
    if (initial.mode === "desk") {
      void openProject(initial.projectId, { history: "replace" });
    } else if (window.location.pathname !== "/") {
      window.history.replaceState({ view: "home" }, "", "/");
    }
  }, [openProject]);

  useEffect(() => {
    const onPopState = () => {
      if (skipHistoryRef.current) {
        skipHistoryRef.current = false;
        return;
      }
      const next = viewFromPath(window.location.pathname);
      if (next.mode === "home") {
        if (hasAttachmentDraftRef.current && !window.confirm("当前消息还有未发送的附件。离开后将丢弃这些附件，是否继续？")) {
          skipHistoryRef.current = true;
          window.history.forward();
          return;
        }
        resetToHome();
        return;
      }
      if (activeProjectRef.current !== next.projectId) {
        void openProject(next.projectId, { history: "none" });
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [openProject, resetToHome]);

  const createProject = useCallback(
    async (input: { name: string; files?: File[]; prompt?: string }) => {
      const project = await api.createProject(input.name);
      setFloorPlanFileId(undefined);
      await openProject(project.id, { initialText: input.prompt, initialFiles: input.files });
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

  const exportPackage = useCallback(() => {
    if (!projectId) return;
    setChatBusy(true);
    void api
      .exportPackage(projectId)
      .then((result) => {
        setChatItems((cur) => [
          ...cur,
          { id: nextId(), role: "agent", text: result.pdfUrl ? `提案包已导出：${result.pdfUrl}` : "提案包已导出。" },
        ]);
      })
      .catch((e) => setChatItems((cur) => [...cur, { id: nextId(), role: "agent", text: `导出失败：${e instanceof Error ? e.message : "未知错误"}` }]))
      .finally(() => setChatBusy(false));
  }, [projectId, setChatBusy, setChatItems]);

  if (view.mode === "home") {
    return (
      <div className="app-shell">
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

  const deskProjectId = view.projectId;
  const deskSnapshot = snapshot?.project.id === deskProjectId ? snapshot : undefined;
  const direction = objects.find((o) => o.kind === "direction_set" && o.status === "confirmed" && o.selectedId);
  const planObj = objects.find((o) => o.kind === "plan");

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="seal-box">砌</span>
        <div className="brand">砌间<small>QIJIAN AI DESIGN</small></div>
        <button type="button" className="back-btn" onClick={() => leaveProject()}>← 项目列表</button>
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
          key={deskProjectId}
          objects={objects}
          initialViewport={deskSnapshot?.deskState.viewport}
          onMove={desk.onMove}
          onMoveEnd={desk.onMoveEnd}
          onViewportChange={desk.onViewportChange}
          focusRequest={desk.focusRequest}
          renderObject={(obj) => (
            <DeskObjectView
              obj={obj}
              handlers={{
                onConfirm: desk.onConfirm,
                onSelectDirection: desk.onSelectDirection,
                onAdopt: desk.onAdopt,
                onRedrawPlan: () => setSetupOpen(true),
              }}
            />
          )}
        >
          {deskSnapshot && setupOpen && (
            <div className="obj obj-setup" style={{ left: 420, top: 90 }}>
              <SpaceMapSetup
                projectId={deskProjectId}
                initialFileId={floorPlanFileId ?? (planObj?.kind === "plan" ? planObj.sourceFileId : undefined)}
                existingSpaces={planObj?.kind === "plan" ? planObj.spaces : undefined}
                onCancel={() => setSetupOpen(false)}
                onSave={async (payload) => {
                  const saved = await desk.withRefresh(async () => {
                    const existing = planObj && desk.artifactOf(planObj.id);
                    const inputRefs = typeof payload.source_file_id === "string" ? [{ file_id: payload.source_file_id }] : [];
                    if (existing) {
                      await api.appendVersion(existing.id, payload, inputRefs);
                    } else {
                      await api.createArtifact(deskProjectId, {
                        artifactType: "space_map",
                        payload,
                        inputRefs,
                        layout: { kind: "plan", x: 420, y: 90, w: 640 },
                      });
                    }
                  });
                  if (!saved) throw new Error("空间地图未保存，请检查错误后重试");
                  setSetupOpen(false);
                }}
              />
            </div>
          )}
        </Desk>
        <ChatPanel
          projectId={deskProjectId}
          items={chat.chatItems}
          streaming={chat.streaming}
          busy={chat.busy}
          connection={chat.connection}
          threads={chat.chatThreads}
          activeThreadId={chat.activeChatThreadId}
          threadChanging={chat.threadChanging}
          initialText={composerHandoff?.text}
          initialFiles={composerHandoff?.files}
          submissionOutcome={chat.submissionOutcome}
          onSend={chat.sendChat}
          onStop={chat.stopChat}
          onNewThread={() => void chat.createChatThread()}
          onSelectThread={(threadId) => void chat.selectChatThread(threadId)}
          onDeleteThread={(threadId) => void chat.deleteChatThread(threadId)}
          onInitialFilesConsumed={() => setComposerHandoff(undefined)}
          onDraftStateChange={(hasDraft) => { hasAttachmentDraftRef.current = hasDraft; }}
        />
      </div>
    </div>
  );
}
