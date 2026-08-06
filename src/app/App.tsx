import { useCallback, useEffect, useRef, useState } from "react";
import { api, type DeskSnapshot, type ProjectSummary } from "../lib/api";
import { Desk } from "../desk/Desk";
import { DeskObjectView } from "../desk/nodes";
import { DeskToolbar } from "../desk/Toolbar";
import { CANVAS_IMAGE_ACCEPT } from "../desk/attachments";
import { ChatPanel } from "../desk/ChatPanel";
import { Home } from "../desk/Home";
import { mapSnapshot } from "../desk/map";
import type { DeskObject } from "../desk/types";
import type { Viewport } from "../desk/geometry";
import { nextId } from "./ids";
import { useChatSession } from "./useChatSession";
import { useDeskActions } from "./useDeskActions";
import { useDeskHistory } from "./useDeskHistory";
import { useDeskPlacement } from "./useDeskPlacement";

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
  const [selectedId, setSelectedId] = useState<string>();
  const viewportRef = useRef<Viewport>({ x: 40, y: 20, zoom: 0.62 });
  const imagePickerRef = useRef<HTMLInputElement>(null);
  const desk = useDeskActions({
    projectId,
    snapshot,
    activeProjectRef,
    refreshDesk,
    setChatItems: chat.setChatItems,
    setObjects,
  });
  const pushCanvasError = useCallback(
    (message: string) => {
      chat.setChatItems((cur) => [...cur, { id: nextId(), role: "agent", text: message }]);
    },
    [chat.setChatItems],
  );
  const history = useDeskHistory({ projectId, enqueue: desk.enqueue, refreshDesk, onError: pushCanvasError });
  const placement = useDeskPlacement({
    projectId,
    snapshot,
    objects,
    selectedId,
    setSelectedId,
    enqueue: desk.enqueue,
    history,
    refreshDesk,
    onError: pushCanvasError,
    viewportRef,
  });

  useEffect(() => {
    setSelectedId(undefined);
  }, [projectId]);

  useEffect(() => {
    if (selectedId && !objects.some((item) => item.id === selectedId)) setSelectedId(undefined);
  }, [objects, selectedId]);

  const onMoveEnd = useCallback(
    (id: string, from: { x: number; y: number }, to: { x: number; y: number }) => {
      desk.onMoveEnd(id, from, to);
      if (Math.round(from.x) !== Math.round(to.x) || Math.round(from.y) !== Math.round(to.y)) {
        history.record({ type: "move", artifactId: id, from, to });
      }
    },
    [desk.onMoveEnd, history.record],
  );

  const onViewportChange = useCallback(
    (viewport: Viewport) => {
      viewportRef.current = viewport;
      desk.onViewportChange(viewport);
    },
    [desk.onViewportChange],
  );

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      const element = target as HTMLElement | null;
      return Boolean(element && (element.isContentEditable || element.closest("input, textarea, select, [contenteditable=true]")));
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        placement.deleteSelected();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) history.redo();
        else history.undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        history.redo();
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      placement.addImageFiles(files);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("paste", onPaste);
    };
  }, [placement.deleteSelected, placement.addImageFiles, history.undo, history.redo]);

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
      setView({ mode: "desk", projectId: nextProjectId });
      const nextPath = pathForView({ mode: "desk", projectId: nextProjectId });
      if (historyMode !== "none" && window.location.pathname !== nextPath) {
        const state = { view: "desk", projectId: nextProjectId };
        if (historyMode === "replace") window.history.replaceState(state, "", nextPath);
        else window.history.pushState(state, "", nextPath);
      }
      try {
        await refreshDesk(nextProjectId);
        if (activeProjectRef.current !== nextProjectId) return;
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

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="seal-box">砌</span>
        <div className="brand">砌间<small>QIJIAN AI DESIGN</small></div>
        <button type="button" className="back-btn" onClick={() => leaveProject()}>← 项目列表</button>
        <span className="proj-name">{snapshot?.project.name}</span>
      </header>
      <div className="workbench">
        <Desk
          key={deskProjectId}
          objects={objects}
          initialViewport={deskSnapshot?.deskState.viewport}
          onMove={desk.onMove}
          onMoveEnd={onMoveEnd}
          onViewportChange={onViewportChange}
          focusRequest={desk.focusRequest}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onDropFiles={placement.addImageFiles}
          overlay={
            <DeskToolbar
              canUndo={history.canUndo}
              canRedo={history.canRedo}
              onHand={() => setSelectedId(undefined)}
              onUndo={history.undo}
              onRedo={history.redo}
              onText={placement.addStickyNote}
              onImage={() => imagePickerRef.current?.click()}
            />
          }
          renderObject={(obj) => (
            <DeskObjectView
              obj={obj}
              editing={placement.editingId === obj.id}
              onStartEdit={placement.startEdit}
              onCommitText={placement.commitText}
            />
          )}
        />
        <input
          ref={imagePickerRef}
          type="file"
          multiple
          accept={CANVAS_IMAGE_ACCEPT}
          className="sr-only"
          onChange={(e) => {
            placement.addImageFiles(Array.from(e.currentTarget.files ?? []));
            e.currentTarget.value = "";
          }}
        />
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
