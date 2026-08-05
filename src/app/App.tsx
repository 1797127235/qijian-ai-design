import { useCallback, useEffect, useRef, useState } from "react";
import { api, connectChat, type ArtifactSnapshot, type ChatConnectionStatus, type ChatThread, type DeskSnapshot, type ProjectSummary } from "../lib/api";
import { Desk } from "../desk/Desk";
import { DeskObjectView } from "../desk/nodes";
import { ChatPanel } from "../desk/ChatPanel";
import { Home } from "../desk/Home";
import { SpaceMapSetup } from "../desk/SpaceMapSetup";
import { mapSnapshot } from "../desk/map";
import type { ChatItem, DeskObject } from "../desk/types";

let seq = 0;
const nextId = () => `m-${Date.now().toString(36)}-${(seq++).toString(36)}`;

const toolActivityLabel = (toolName: string) => ({
  move_object: "移动物件",
  place_object: "摆放物件",
  create_understanding_notes: "创建理解便签",
  create_direction_set: "创建设计方向",
  generate_effect_image: "生成效果图",
  adopt_variant: "采用效果图",
  discard_variant: "弃用效果图",
  edit_payload: "修改内容",
  confirm_artifact: "确认内容",
  export_package: "导出提案包",
}[toolName] ?? toolName);

export function App() {
  const [view, setView] = useState<{ mode: "home" } | { mode: "desk"; projectId: string }>({ mode: "home" });
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [homeError, setHomeError] = useState<string>();

  const [snapshot, setSnapshot] = useState<DeskSnapshot>();
  const [objects, setObjects] = useState<DeskObject[]>([]);
  const [chatItems, setChatItems] = useState<ChatItem[]>([]);
  const [chatThreads, setChatThreads] = useState<ChatThread[]>([]);
  const [activeChatThreadId, setActiveChatThreadId] = useState<string>();
  const [threadChanging, setThreadChanging] = useState(false);
  const [streaming, setStreaming] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState<ChatConnectionStatus>("disconnected");
  const [focusRequest, setFocusRequest] = useState<{ id: string; token: number }>();
  const [setupOpen, setSetupOpen] = useState(false);
  const [floorPlanFileId, setFloorPlanFileId] = useState<string>();
  const chatRef = useRef<ReturnType<typeof connectChat>>();
  const streamBuf = useRef("");
  const activeProjectRef = useRef<string>();
  const activeChatThreadRef = useRef<string>();
  const activeToolsRef = useRef(new Map<string, string>());
  const refreshSequence = useRef(0);
  const threadLoadSequence = useRef(0);
  const persistViewport = useRef<number>();
  const viewportSaveFailed = useRef(false);

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
    const sequence = ++refreshSequence.current;
    const snap = await api.desk(projectId);
    if (activeProjectRef.current === projectId && refreshSequence.current === sequence) {
      setSnapshot(snap);
      setObjects(mapSnapshot(snap));
    }
    return snap;
  }, []);

  const openProject = useCallback(
    async (projectId: string) => {
      chatRef.current?.close();
      activeProjectRef.current = projectId;
      refreshSequence.current += 1;
      threadLoadSequence.current += 1;
      window.clearTimeout(persistViewport.current);
      viewportSaveFailed.current = false;
      setSnapshot(undefined);
      setObjects([]);
      setChatItems([]);
      setChatThreads([]);
      setActiveChatThreadId(undefined);
      activeChatThreadRef.current = undefined;
      setThreadChanging(false);
      setStreaming(undefined);
      streamBuf.current = "";
      activeToolsRef.current.clear();
      setBusy(false);
      setConnection("connecting");
      setFocusRequest(undefined);
      setSetupOpen(false);
      setFloorPlanFileId(undefined);
      setView({ mode: "desk", projectId });
      try {
        const [snap, threads] = await Promise.all([refreshDesk(projectId), api.chatThreads(projectId)]);
        if (activeProjectRef.current !== projectId) return;
        const activeThread = threads[0];
        if (!activeThread) throw new Error("项目没有可用的对话线程");
        const history = await api.chatHistory(projectId, activeThread.id);
        if (activeProjectRef.current !== projectId) return;
        setChatThreads(threads);
        setActiveChatThreadId(activeThread.id);
        activeChatThreadRef.current = activeThread.id;
        setChatItems(history.messages.map((message) => ({
          id: message.id,
          role: message.role === "assistant" ? "agent" : "user",
          text: message.text,
        })));
        const plan = snap.artifacts.find((a) => a.artifactType === "space_map");
        setFloorPlanFileId(typeof plan?.payload.source_file_id === "string" ? plan.payload.source_file_id : undefined);
        setSetupOpen(!plan);
        const chat = connectChat(projectId, (event) => {
          if (activeProjectRef.current !== projectId) return;
          if (event.type === "agent_event") {
            const inner = event.event;
            if (inner.threadId && inner.threadId !== activeChatThreadRef.current) return;
            if (inner.type === "message_update" && inner.assistantMessageEvent?.type === "text_delta" && inner.assistantMessageEvent.delta) {
              streamBuf.current += inner.assistantMessageEvent.delta;
              setStreaming(streamBuf.current);
            }
            if (inner.type === "agent_start") setBusy(true);
            if (inner.type === "agent_settled") {
              activeToolsRef.current.clear();
              setChatItems((cur) => cur.filter((it) => it.role !== "activity"));
              setBusy(false);
            }
            if (inner.type === "tool_execution_start" && inner.toolName) {
              const toolCallId = inner.toolCallId ?? `${inner.toolName}-${activeToolsRef.current.size}`;
              activeToolsRef.current.set(toolCallId, toolActivityLabel(inner.toolName));
              setChatItems((cur) => [
                ...cur.filter((it) => it.role !== "activity"),
                { id: "active-tools", role: "activity", text: `正在执行：${[...activeToolsRef.current.values()].join("、")}` },
              ]);
            }
            if (inner.type === "tool_execution_end") {
              if (inner.toolCallId) activeToolsRef.current.delete(inner.toolCallId);
              else activeToolsRef.current.clear();
              setChatItems((cur) => activeToolsRef.current.size === 0
                ? cur.filter((it) => it.role !== "activity")
                : [
                    ...cur.filter((it) => it.role !== "activity"),
                    { id: "active-tools", role: "activity", text: `正在执行：${[...activeToolsRef.current.values()].join("、")}` },
                  ]);
            }
            return;
          }
          if (event.type === "chat_message") {
            if (event.message.threadId !== activeChatThreadRef.current) return;
            if (event.message.role === "assistant") {
              streamBuf.current = "";
              setStreaming(undefined);
            }
            setChatItems((cur) => cur.some((item) => item.id === event.message.id)
              ? cur
              : [...cur, {
                  id: event.message.id,
                  role: event.message.role === "assistant" ? "agent" : "user",
                  text: event.message.text,
                }]);
            if (event.message.role === "user") {
              setChatThreads((current) => current.map((thread) => thread.id === event.message.threadId
                ? {
                    ...thread,
                    title: thread.title === "新对话" ? event.message.text.replace(/\s+/g, " ").slice(0, 28) : thread.title,
                    updatedAt: event.message.createdAt,
                  }
                : thread));
            }
            return;
          }
          if (event.type === "agent_stopped") {
            if (event.threadId !== activeChatThreadRef.current) return;
            activeToolsRef.current.clear();
            setChatItems((cur) => cur.filter((it) => it.role !== "activity"));
            setBusy(false);
            return;
          }
          if (event.type === "object_changed") {
            if (event.artifactId) {
              setFocusRequest({ id: event.artifactId, token: Date.now() });
            }
            void refreshDesk(projectId).catch((e) => {
              if (activeProjectRef.current !== projectId) return;
              setChatItems((cur) => [...cur, { id: nextId(), role: "agent", text: `画布刷新失败：${e instanceof Error ? e.message : "未知错误"}` }]);
            });
            return;
          }
          if (event.type === "error") {
            activeToolsRef.current.clear();
            streamBuf.current = "";
            setStreaming(undefined);
            setChatItems((cur) => [
              ...cur.filter((item) => item.role !== "activity"),
              { id: nextId(), role: "agent", text: `出错了：${event.message}` },
            ]);
            setBusy(false);
          }
        }, setConnection);
        chatRef.current = chat;
      } catch (e) {
        if (activeProjectRef.current !== projectId) return;
        setConnection("disconnected");
        setBusy(false);
        setChatItems([{ id: nextId(), role: "agent", text: `打开项目失败：${e instanceof Error ? e.message : "未知错误"}` }]);
      }
    },
    [refreshDesk],
  );

  useEffect(() => () => {
    chatRef.current?.close();
    window.clearTimeout(persistViewport.current);
  }, []);

  const leaveProject = useCallback(() => {
    activeProjectRef.current = undefined;
    refreshSequence.current += 1;
    threadLoadSequence.current += 1;
    chatRef.current?.close();
    chatRef.current = undefined;
    window.clearTimeout(persistViewport.current);
    setSnapshot(undefined);
    setObjects([]);
    setChatThreads([]);
    setActiveChatThreadId(undefined);
    activeChatThreadRef.current = undefined;
    setThreadChanging(false);
    setConnection("disconnected");
    setBusy(false);
    setSetupOpen(false);
    setView({ mode: "home" });
  }, []);

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
      void api.moveObject(projectId, id, { x: Math.round(x), y: Math.round(y) }).catch((e) => {
        if (activeProjectRef.current !== projectId) return;
        setChatItems((cur) => [...cur, { id: nextId(), role: "agent", text: `位置保存失败：${e instanceof Error ? e.message : "未知错误"}` }]);
        void refreshDesk(projectId).catch(() => undefined);
      });
    },
    [projectId, refreshDesk],
  );

  const onViewportChange = useCallback(
    (viewport: { x: number; y: number; zoom: number }) => {
      if (!projectId || snapshot?.project.id !== projectId) return;
      window.clearTimeout(persistViewport.current);
      persistViewport.current = window.setTimeout(() => {
        void api
          .setViewport(projectId, viewport)
          .then(() => {
            viewportSaveFailed.current = false;
          })
          .catch((e) => {
            if (activeProjectRef.current !== projectId) return;
            if (!viewportSaveFailed.current) {
              setChatItems((cur) => [...cur, { id: nextId(), role: "agent", text: `视口保存失败：${e instanceof Error ? e.message : "未知错误"}` }]);
            }
            viewportSaveFailed.current = true;
            void refreshDesk(projectId).catch(() => undefined);
          });
      }, 800);
    },
    [projectId, refreshDesk, snapshot?.project.id],
  );

  const withRefresh = useCallback(
    async (fn: () => Promise<unknown>) => {
      if (!projectId) return false;
      try {
        await fn();
        await refreshDesk(projectId);
        return activeProjectRef.current === projectId;
      } catch (e) {
        setChatItems((cur) => [...cur, { id: nextId(), role: "agent", text: `操作失败：${e instanceof Error ? e.message : "未知错误"}` }]);
        return false;
      }
    },
    [projectId, refreshDesk],
  );

  const onConfirm = useCallback(
    async (artifactId: string) => {
      if (await withRefresh(() => api.confirmArtifact(artifactId))) {
        setFocusRequest({ id: artifactId, token: Date.now() });
      }
    },
    [withRefresh],
  );

  const onSelectDirection = useCallback(
    async (artifactId: string, directionId: string) => {
      const saved = await withRefresh(async () => {
        const artifact = artifactOf(artifactId);
        if (!artifact) return;
        await api.appendVersion(artifactId, { ...artifact.payload, selected_direction_id: directionId });
      });
      if (saved) {
        setFocusRequest({ id: artifactId, token: Date.now() });
      }
    },
    [artifactOf, withRefresh],
  );

  const onAdopt = useCallback(
    async (artifactId: string, adopted: boolean) => {
      const saved = await withRefresh(async () => {
        const artifact = artifactOf(artifactId);
        if (!artifact) return;
        await api.appendVersion(artifactId, { ...artifact.payload, adopted });
      });
      if (saved) {
        setFocusRequest({ id: artifactId, token: Date.now() });
      }
    },
    [artifactOf, withRefresh],
  );

  const sendChat = useCallback(
    (text: string) => {
      const threadId = activeChatThreadRef.current;
      if (connection !== "connected" || busy || !threadId) return;
      if (!chatRef.current?.prompt(text, threadId, nextId())) {
        setChatItems((cur) => [...cur, { id: nextId(), role: "agent", text: "消息未发送，请等待连接恢复后重试。" }]);
        return;
      }
      setBusy(true);
    },
    [busy, connection],
  );

  const stopChat = useCallback(() => {
    const threadId = activeChatThreadRef.current;
    if (!busy || connection !== "connected" || !threadId) return;
    if (!chatRef.current?.stop(threadId)) {
      setChatItems((cur) => [...cur, { id: nextId(), role: "agent", text: "停止指令未发送，请等待连接恢复后重试。" }]);
    }
  }, [busy, connection]);

  const selectChatThread = useCallback(async (threadId: string) => {
    const currentProjectId = activeProjectRef.current;
    if (!currentProjectId || threadId === activeChatThreadRef.current || busy || threadChanging) return;
    const sequence = ++threadLoadSequence.current;
    setThreadChanging(true);
    try {
      const history = await api.chatHistory(currentProjectId, threadId);
      if (activeProjectRef.current !== currentProjectId || threadLoadSequence.current !== sequence) return;
      activeChatThreadRef.current = threadId;
      setActiveChatThreadId(threadId);
      streamBuf.current = "";
      setStreaming(undefined);
      activeToolsRef.current.clear();
      setChatItems(history.messages.map((message) => ({
        id: message.id,
        role: message.role === "assistant" ? "agent" : "user",
        text: message.text,
      })));
    } catch (error) {
      setChatItems((current) => [...current, {
        id: nextId(),
        role: "agent",
        text: `切换对话失败：${error instanceof Error ? error.message : "未知错误"}`,
      }]);
    } finally {
      if (threadLoadSequence.current === sequence) setThreadChanging(false);
    }
  }, [busy, threadChanging]);

  const createChatThread = useCallback(async () => {
    const currentProjectId = activeProjectRef.current;
    if (!currentProjectId || busy || threadChanging) return;
    setThreadChanging(true);
    try {
      const thread = await api.createChatThread(currentProjectId);
      if (activeProjectRef.current !== currentProjectId) return;
      activeChatThreadRef.current = thread.id;
      setActiveChatThreadId(thread.id);
      setChatThreads((current) => [thread, ...current]);
      streamBuf.current = "";
      setStreaming(undefined);
      activeToolsRef.current.clear();
      setChatItems([]);
    } catch (error) {
      setChatItems((current) => [...current, {
        id: nextId(),
        role: "agent",
        text: `新建对话失败：${error instanceof Error ? error.message : "未知错误"}`,
      }]);
    } finally {
      setThreadChanging(false);
    }
  }, [busy, threadChanging]);

  const deleteChatThread = useCallback(async (threadId: string) => {
    const currentProjectId = activeProjectRef.current;
    if (!currentProjectId || busy || threadChanging) return;
    const sequence = ++threadLoadSequence.current;
    setThreadChanging(true);
    try {
      await api.deleteChatThread(currentProjectId, threadId);
      if (activeProjectRef.current !== currentProjectId || threadLoadSequence.current !== sequence) return;
      let remaining = chatThreads.filter((thread) => thread.id !== threadId);
      setChatThreads(remaining);
      if (threadId !== activeChatThreadRef.current) return;

      let nextThread = remaining[0];
      if (!nextThread) {
        nextThread = await api.createChatThread(currentProjectId);
        remaining = [nextThread];
        setChatThreads(remaining);
      }
      const history = await api.chatHistory(currentProjectId, nextThread.id);
      if (activeProjectRef.current !== currentProjectId || threadLoadSequence.current !== sequence) return;
      activeChatThreadRef.current = nextThread.id;
      setActiveChatThreadId(nextThread.id);
      streamBuf.current = "";
      setStreaming(undefined);
      activeToolsRef.current.clear();
      setChatItems(history.messages.map((message) => ({
        id: message.id,
        role: message.role === "assistant" ? "agent" : "user",
        text: message.text,
      })));
    } catch (error) {
      setChatItems((current) => [...current, {
        id: nextId(),
        role: "agent",
        text: `删除对话失败：${error instanceof Error ? error.message : "未知错误"}`,
      }]);
    } finally {
      if (threadLoadSequence.current === sequence) setThreadChanging(false);
    }
  }, [busy, chatThreads, threadChanging]);

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

  const deskProjectId = view.projectId;
  const deskSnapshot = snapshot?.project.id === deskProjectId ? snapshot : undefined;
  const direction = objects.find((o) => o.kind === "direction_set" && o.status === "confirmed" && o.selectedId);
  const planObj = objects.find((o) => o.kind === "plan");

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="seal-box">砌</span>
        <div className="brand">砌间<small>QIJIAN AI DESIGN</small></div>
        <button type="button" className="back-btn" onClick={leaveProject}>← 项目列表</button>
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
          onMove={onMove}
          onMoveEnd={onMoveEnd}
          onViewportChange={onViewportChange}
          focusRequest={focusRequest}
          renderObject={(obj) => (
            <DeskObjectView obj={obj} handlers={{ onConfirm, onSelectDirection, onAdopt, onRedrawPlan: () => setSetupOpen(true) }} />
          )}
        >
          {deskSnapshot && setupOpen && (
            <div className="obj obj-setup" style={{ left: 420, top: 90 }}>
              <SpaceMapSetup
                projectId={deskProjectId}
                initialFileId={floorPlanFileId ?? (planObj?.kind === "plan" ? planObj.sourceFileId : undefined)}
                existingSpaces={planObj?.kind === "plan" ? planObj.spaces : undefined}
                onCancel={planObj ? () => setSetupOpen(false) : undefined}
                onSave={async (payload) => {
                  const saved = await withRefresh(async () => {
                    const existing = planObj && artifactOf(planObj.id);
                    if (existing) {
                      await api.appendVersion(existing.id, payload);
                    } else {
                      await api.createArtifact(deskProjectId, {
                        artifactType: "space_map",
                        payload,
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
          items={chatItems}
          streaming={streaming}
          busy={busy}
          connection={connection}
          threads={chatThreads}
          activeThreadId={activeChatThreadId}
          threadChanging={threadChanging}
          onSend={sendChat}
          onStop={stopChat}
          onNewThread={() => void createChatThread()}
          onSelectThread={(threadId) => void selectChatThread(threadId)}
          onDeleteThread={(threadId) => void deleteChatThread(threadId)}
        />
      </div>
    </div>
  );
}
