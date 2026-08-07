import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type DeskSnapshot, type ProjectSummary } from "../lib/api";
import { Desk } from "../desk/Desk";
import { DeskObjectView } from "../desk/nodes";
import { DeskToolbar } from "../desk/Toolbar";
import { PromptPanel } from "../desk/PromptPanel";
import { CANVAS_IMAGE_ACCEPT } from "../desk/attachments";
import { ChatPanel } from "../desk/ChatPanel";
import { Home } from "../desk/Home";
import { mapConnections, mapSnapshot } from "../desk/map";
import type { DeskConnection, DeskObject } from "../desk/types";
import type { Viewport } from "../desk/geometry";
import { nextId } from "./ids";
import { createGenerateHistoryGate } from "./recordGenerateOnce";
import { useChatSession } from "./useChatSession";
import { useDeskActions } from "./useDeskActions";
import { useDeskGenerate } from "./useDeskGenerate";
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

  const [connections, setConnections] = useState<DeskConnection[]>([]);
  const refreshDesk = useCallback(async (projectId: string) => {
    const sequence = ++refreshSequence.current;
    const snap = await api.desk(projectId);
    if (activeProjectRef.current === projectId && refreshSequence.current === sequence) {
      setSnapshot(snap);
      setObjects(mapSnapshot(snap));
      setConnections(mapConnections(snap));
    }
    return snap;
  }, []);

  const generateGate = useMemo(() => createGenerateHistoryGate(), []);
  const historyRecordRef = useRef<(op: import("./useDeskHistory").DeskHistoryOp) => void>(() => undefined);

  const onDeskObjectChanged = useCallback((pid: string, artifactId: string | undefined, snap: DeskSnapshot) => {
    if (!artifactId) return;
    const art = snap.artifacts.find((a) => a.id === artifactId);
    if (!art || art.artifactType !== "effect_image") return;
    // 仅新建 pending/刚落桌时记 history；重试版本前进不记（gate 同 id 也会挡）
    const object = snap.deskState.objects.find((o) => o.artifact_id === artifactId);
    const connection = snap.deskState.connections.find((c) => c.to === artifactId);
    if (!object || !connection) return;
    generateGate.tryRecord(
      artifactId,
      (op) => historyRecordRef.current(op),
      {
        artifactId,
        artifactType: "effect_image",
        payload: art.payload,
        inputRefs: art.inputRefs,
        layout: { kind: object.kind, x: object.x, y: object.y, rot: object.rot, w: object.w },
      },
      connection,
    );
  }, [generateGate]);

  const chat = useChatSession({ activeProjectRef, refreshDesk, onDeskObjectChanged });
  const projectId = view.mode === "desk" ? view.projectId : undefined;
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedConnectionId, setSelectedConnectionId] = useState<string>();
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
  historyRecordRef.current = history.record;
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
  const gen = useDeskGenerate({ projectId, history, refreshDesk, onError: pushCanvasError, generateGate });

  useEffect(() => {
    setSelectedId(undefined);
    setSelectedConnectionId(undefined);
    generateGate.reset();
    gen.closePanel();
  }, [projectId, generateGate]);

  const createConnection = useCallback(
    (from: string, to: string) => {
      if (!projectId) return;
      void desk.enqueue(async () => {
        try {
          const { connection } = await api.createConnection(projectId, { from, to, clientOpId: crypto.randomUUID() });
          history.record({ type: "place_connection", connection });
        } catch (error) {
          pushCanvasError(`连线失败：${error instanceof Error ? error.message : "未知错误"}`);
        }
        await refreshDesk(projectId).catch(() => undefined);
      });
    },
    [projectId, desk, history, pushCanvasError, refreshDesk],
  );

  const deleteConnection = useCallback(
    (connectionId: string) => {
      if (!projectId) return;
      const connection = connections.find((c) => c.id === connectionId);
      void desk.enqueue(async () => {
        try {
          await api.deleteConnection(projectId, connectionId);
          if (connection) history.record({ type: "remove_connection", connection });
          setSelectedConnectionId((cur) => (cur === connectionId ? undefined : cur));
        } catch (error) {
          pushCanvasError(`删除连线失败：${error instanceof Error ? error.message : "未知错误"}`);
        }
        await refreshDesk(projectId).catch(() => undefined);
      });
    },
    [projectId, connections, desk, history, pushCanvasError, refreshDesk],
  );

  const panelSource = useMemo(
    () => (gen.panelSourceId ? objects.find((o) => o.id === gen.panelSourceId) : undefined),
    [gen.panelSourceId, objects],
  );
  const panelRefs = useMemo(() => {
    if (!panelSource) return [];
    const inbound = connections.filter((c) => c.to === panelSource.id).map((c) => c.from);
    return objects.filter((o) => inbound.includes(o.id));
  }, [panelSource, connections, objects]);

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

  // 全局键盘/粘贴监听：handler 用 ref 持有最新值，effect 只订阅一次（避免 selectedConnectionId 等频繁变 dep）
  const keydownHandlersRef = useRef({
    deleteSelected: placement.deleteSelected,
    deleteConnection: (id: string) => deleteConnection(id),
    undo: history.undo,
    redo: history.redo,
    selectedConnectionId: undefined as string | undefined,
    addImageFiles: placement.addImageFiles,
  });
  keydownHandlersRef.current.deleteSelected = placement.deleteSelected;
  keydownHandlersRef.current.deleteConnection = deleteConnection;
  keydownHandlersRef.current.undo = history.undo;
  keydownHandlersRef.current.redo = history.redo;
  keydownHandlersRef.current.selectedConnectionId = selectedConnectionId;
  keydownHandlersRef.current.addImageFiles = placement.addImageFiles;

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      const element = target as HTMLElement | null;
      return Boolean(element && (element.isContentEditable || element.closest("input, textarea, select, [contenteditable=true]")));
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const handlers = keydownHandlersRef.current;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (handlers.selectedConnectionId) handlers.deleteConnection(handlers.selectedConnectionId);
        else handlers.deleteSelected();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) handlers.redo();
        else handlers.undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        handlers.redo();
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      keydownHandlersRef.current.addImageFiles(files);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("paste", onPaste);
    };
  }, []);

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
  const reconnectChat = chat.reconnectChat;
  const setChatConnection = chat.setConnection;
  const setChatBusy = chat.setBusy;
  const setChatItems = chat.setChatItems;

  // 用 Set 查表避免每次物件变化都做 O(n) some 扫描（rerender-dependencies + js-set-map-lookups）
  const objectIds = useMemo(() => new Set(objects.map((o) => o.id)), [objects]);
  const connectionIds = useMemo(() => new Set(connections.map((c) => c.id)), [connections]);

  useEffect(() => {
    if (selectedId && !objectIds.has(selectedId)) setSelectedId(undefined);
  }, [objectIds, selectedId]);

  useEffect(() => {
    if (selectedConnectionId && !connectionIds.has(selectedConnectionId)) setSelectedConnectionId(undefined);
  }, [connectionIds, selectedConnectionId]);

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
    setConnections([]);
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
      setConnections([]);
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

  // 仅卸载时关 WS；依赖稳定，避免 HMR 重跑 effect 时反复 close 却不重连
  useEffect(() => () => {
    closeChat();
    clearViewportTimer();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount-only cleanup
  }, []);

  // 桌面页且已加载过线程：掉成 disconnected 时重绑 WS（后端热重启），不清消息
  // 要求 activeChatThreadId：避免与首次 bindProjectChat 抢跑
  useEffect(() => {
    if (view.mode !== "desk") return;
    if (chat.connection !== "disconnected") return;
    if (!chat.activeChatThreadId) return;
    const projectId = view.projectId;
    if (!projectId || activeProjectRef.current !== projectId) return;
    const timer = window.setTimeout(() => {
      if (activeProjectRef.current !== projectId) return;
      reconnectChat(projectId);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [view, chat.connection, chat.activeChatThreadId, reconnectChat]);

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
        <img className="brand-mark" src="/brand-mark.svg" alt="Qijian" width={30} height={30} />
        <div className="brand">砌间<small>QIJIAN AI DESIGN</small></div>
        <button type="button" className="back-btn" onClick={() => leaveProject()}>← 项目列表</button>
        <span className="proj-name">{snapshot?.project.name}</span>
      </header>
      <div className="workbench">
        <Desk
          key={deskProjectId}
          objects={objects}
          connections={connections}
          initialViewport={deskSnapshot?.deskState.viewport}
          onMove={desk.onMove}
          onMoveEnd={onMoveEnd}
          onViewportChange={onViewportChange}
          focusRequest={desk.focusRequest}
          selectedId={selectedId}
          selectedConnectionId={selectedConnectionId}
          onSelect={(id, opts) => {
            setSelectedId(id);
            setSelectedConnectionId(undefined);
            const openPanel = opts?.panel !== false;
            if (id && openPanel) gen.openPanel(id);
            else if (!id) gen.closePanel();
            // 右键 panel:false：保持当前面板状态（若点的是别的物件则关掉旧面板）
            else if (id && !openPanel && gen.panelSourceId && gen.panelSourceId !== id) gen.closePanel();
          }}
          onSelectConnection={(id) => {
            setSelectedConnectionId(id);
            // 仅在选中某条连线时清掉物件选中；id 为空表示“取消连线选中”，勿动物件选中
            if (id) {
              setSelectedId(undefined);
              gen.closePanel();
            }
          }}
          onDropFiles={placement.addImageFiles}
          onDeleteObject={placement.deleteObject}
          onCreateConnection={createConnection}
          onDeleteConnection={deleteConnection}
          overlay={
            <DeskToolbar
              canUndo={history.canUndo}
              canRedo={history.canRedo}
              onHand={() => {
                setSelectedId(undefined);
                setSelectedConnectionId(undefined);
                gen.closePanel();
              }}
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
              onRetryGenerate={(id) => {
                // id 是失败卡本身；真实参考源从连入边 from 解析，不能再当 source 新建一张
                const target = objects.find((item) => item.id === id);
                if (!target || target.kind !== "effect_image") return;
                const inbound = connections.find((c) => c.to === id);
                const sourceArtifactId = inbound?.from ?? id;
                void gen.generate({
                  sourceArtifactId,
                  targetArtifactId: id,
                  prompt: target.prompt ?? "",
                });
              }}
            />
          )}
        >
          {panelSource && (
            <PromptPanel
              source={panelSource}
              references={panelRefs}
              busy={gen.busySourceId === panelSource.id}
              onGenerate={(prompt) => void gen.generate({ sourceArtifactId: panelSource.id, prompt })}
              onClose={gen.closePanel}
            />
          )}
        </Desk>
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
          // 画布 selectedId → 对话 chip；× 清除选中并关掉生图面板
          selectedObject={selectedId ? objects.find((item) => item.id === selectedId) : undefined}
          onClearSelection={() => {
            setSelectedId(undefined);
            gen.closePanel();
          }}
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
