/**
 * 桌面工作台：
 *  - useChatSession：WS + 线程 + 过程时间线
 *  - 画布选中 / 连线 / 放置 / 撤销 / 面板生图 / 局部重绘 / 大图
 *
 * 输入：App 持有的 snapshot/objects；输出：用户交互 → api + refreshDesk。
 * 不负责：项目列表、URL 路由。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Brush, Trash2, Upload } from "lucide-react";
import { api, type DeskSnapshot } from "../lib/api";
import { Desk } from "../desk/Desk";
import { DeskObjectView } from "../desk/nodes";
import { DeskToolbar } from "../desk/Toolbar";
import { ImageLightbox } from "../desk/ImageLightbox";
import { PromptPanel } from "../desk/PromptPanel";
import { CANVAS_IMAGE_ACCEPT } from "../desk/attachments";
import { ChatPanel } from "../desk/ChatPanel";
import { InpaintDialog, type InpaintSource } from "../desk/InpaintDialog";
import { useExitTransition } from "../desk/useExitTransition";
import type { DeskConnection, DeskObject } from "../desk/types";
import type { Viewport } from "../desk/geometry";
import { nextId } from "./ids";
import { createGenerateHistoryGate } from "./recordGenerateOnce";
import { useChatSession } from "./useChatSession";
import { useDeskActions } from "./useDeskActions";
import { useDeskGenerate } from "./useDeskGenerate";
import { useDeskHistory } from "./useDeskHistory";
import { useDeskPlacement } from "./useDeskPlacement";

export function DeskWorkbench({
  projectId,
  snapshot,
  objects,
  connections,
  setObjects,
  refreshDesk,
  activeProjectRef,
  composerHandoff,
  setComposerHandoff,
  hasAttachmentDraftRef,
  onProjectRenamed,
  onRenameProject,
  onLeave,
}: {
  projectId: string;
  snapshot?: DeskSnapshot;
  objects: DeskObject[];
  connections: DeskConnection[];
  setObjects: React.Dispatch<React.SetStateAction<DeskObject[]>>;
  refreshDesk: (projectId: string) => Promise<DeskSnapshot>;
  activeProjectRef: MutableRefObject<string | undefined>;
  composerHandoff?: {
    id: string;
    text?: string;
    files?: File[];
    selectedArtifactIds?: string[];
    autoSend?: boolean;
  };
  setComposerHandoff: (v: {
    id: string;
    text?: string;
    files?: File[];
    selectedArtifactIds?: string[];
    autoSend?: boolean;
  } | undefined) => void;
  hasAttachmentDraftRef: MutableRefObject<boolean>;
  onProjectRenamed: (projectId: string, name: string) => void;
  onRenameProject: (project: { id: string }, name: string) => Promise<void>;
  onLeave: () => void;
}) {
  const generateGate = useMemo(() => createGenerateHistoryGate(), []);
  // history 实例在下方才创建；object_changed 可能更早到，用 ref 桥接避免 TDZ / 循环 deps
  const historyRecordRef = useRef<(op: import("./useDeskHistory").DeskHistoryOp) => void>(() => undefined);
  const historyPatchFillRef = useRef<(artifactId: string, to: { payload: Record<string, unknown>; inputRefs?: unknown[] }) => void>(() => undefined);

  /**
   * Agent / 面板落桌后的 history：
   *  - 终态填回：patch fill_version 的 to，便于 redo
   *  - 新建 effect：gate 按 artifactId 去重，避免面板与 Agent 双记
   *  - 多参考 = 多条连线，redo 必须全量恢复 edgeConnections
   */
  const onDeskObjectChanged = useCallback((pid: string, artifactId: string | undefined, snap: DeskSnapshot) => {
    void pid;
    if (!artifactId) return;
    const art = snap.artifacts.find((a) => a.id === artifactId);
    if (!art) return;
    if (art.artifactType === "canvas_image" || art.artifactType === "effect_image") {
      const pending = art.payload.pending === true;
      if (!pending) {
        historyPatchFillRef.current(artifactId, { payload: art.payload, inputRefs: art.inputRefs });
      }
    }
    if (art.artifactType !== "effect_image") return;
    const object = snap.deskState.objects.find((o) => o.artifact_id === artifactId);
    const edgeConnections = snap.deskState.connections.filter((c) => c.to === artifactId);
    if (!object || edgeConnections.length === 0) return;
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
      edgeConnections,
    );
  }, [generateGate]);

  const chat = useChatSession({
    activeProjectRef,
    refreshDesk,
    onDeskObjectChanged,
    onProjectRenamed,
  });

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string>();
  const [lightboxUrl, setLightboxUrl] = useState<string>();
  const lightbox = useExitTransition(lightboxUrl, 120);
  const [inpaintSourceId, setInpaintSourceId] = useState<string>();
  const [topbarRenaming, setTopbarRenaming] = useState(false);
  const viewportRef = useRef<Viewport>({ x: 40, y: 20, zoom: 0.62 });
  const imagePickerRef = useRef<HTMLInputElement>(null);
  const imageUploadTargetRef = useRef<string>();
  const boundProjectRef = useRef<string>();

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
  historyPatchFillRef.current = history.patchLatestFill;

  const placement = useDeskPlacement({
    projectId,
    snapshot,
    objects,
    selectedIds,
    setSelectedIds,
    enqueue: desk.enqueue,
    history,
    refreshDesk,
    onError: pushCanvasError,
    viewportRef,
  });
  const gen = useDeskGenerate({ projectId, history, refreshDesk, onError: pushCanvasError, generateGate });

  // 每个 projectId 只 bind 一次；StrictMode 双挂载靠 boundProjectRef 挡住重复拉历史
  useEffect(() => {
    if (boundProjectRef.current === projectId) return;
    boundProjectRef.current = projectId;
    void chat.bindProjectChat(projectId);
    return () => {
      chat.closeChat();
      desk.clearViewportTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bind once per projectId
  }, [projectId]);

  // 后端热重启后 WS 变 disconnected：保留消息，只重建连接
  useEffect(() => {
    if (chat.connection !== "disconnected") return;
    if (!chat.activeChatThreadId) return;
    if (activeProjectRef.current !== projectId) return;
    const timer = window.setTimeout(() => {
      if (activeProjectRef.current !== projectId) return;
      chat.reconnectChat(projectId);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [chat.connection, chat.activeChatThreadId, chat.reconnectChat, projectId, activeProjectRef]);

  useEffect(() => {
    const seedIds = composerHandoff?.selectedArtifactIds;
    setSelectedIds(seedIds?.length ? seedIds : []);
    setSelectedConnectionId(undefined);
    setTopbarRenaming(false);
    setInpaintSourceId(undefined);
    generateGate.reset();
    gen.closePanel();
  }, [projectId, generateGate]);

  const createConnection = useCallback(
    (from: string, to: string) => {
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

  const onResizeEnd = useCallback(
    (id: string, from: { x: number; y: number; w: number }, to: { x: number; y: number; w: number }) => {
      desk.onResizeEnd(id, from, to);
      if (
        Math.round(from.x) !== Math.round(to.x)
        || Math.round(from.y) !== Math.round(to.y)
        || Math.round(from.w) !== Math.round(to.w)
      ) {
        history.record({ type: "resize", artifactId: id, from, to });
      }
    },
    [desk.onResizeEnd, history.record],
  );

  const onViewportChange = useCallback(
    (viewport: Viewport) => {
      viewportRef.current = viewport;
      desk.onViewportChange(viewport);
    },
    [desk.onViewportChange],
  );

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

  useEffect(() => {
    if (chat.focusFromAgent) desk.setFocusRequest(chat.focusFromAgent);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to agent focus events
  }, [chat.focusFromAgent]);

  const objectIds = useMemo(() => new Set(objects.map((o) => o.id)), [objects]);
  const connectionIds = useMemo(() => new Set(connections.map((c) => c.id)), [connections]);

  useEffect(() => {
    setSelectedIds((cur) => {
      const next = cur.filter((id) => objectIds.has(id));
      return next.length === cur.length ? cur : next;
    });
  }, [objectIds]);

  useEffect(() => {
    if (selectedConnectionId && !connectionIds.has(selectedConnectionId)) setSelectedConnectionId(undefined);
  }, [connectionIds, selectedConnectionId]);

  const deskSnapshot = snapshot?.project.id === projectId ? snapshot : undefined;

  const commitTopbarRename = (next: string) => {
    setTopbarRenaming(false);
    const trimmed = next.trim();
    if (!trimmed || !deskSnapshot || trimmed === deskSnapshot.project.name) return;
    void onRenameProject(deskSnapshot.project, trimmed);
  };

  const inpaintSource = objects.find((o) => o.id === inpaintSourceId);
  const inpaintReady = inpaintSource
    && (inpaintSource.kind === "canvas_image" || inpaintSource.kind === "effect_image")
    && inpaintSource.url
    ? (inpaintSource as InpaintSource)
    : undefined;

  return (
    <div className="app-shell">
      <header className="topbar">
        <img className="brand-mark" src="/brand-mark.svg" alt="Qijian" width={30} height={30} />
        <div className="brand">砌间</div>
        <button type="button" className="back-btn" onClick={onLeave}>← 项目列表</button>
        {topbarRenaming && deskSnapshot ? (
          <input
            className="proj-name-input"
            autoFocus
            defaultValue={deskSnapshot.project.name}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTopbarRename(e.currentTarget.value);
              if (e.key === "Escape") setTopbarRenaming(false);
            }}
            onBlur={(e) => commitTopbarRename(e.currentTarget.value)}
          />
        ) : (
          <span
            className="proj-name proj-name-editable"
            title="点击改名"
            onClick={() => deskSnapshot && setTopbarRenaming(true)}
          >
            {deskSnapshot?.project.name}
          </span>
        )}
      </header>
      <div className="workbench">
        <Desk
          key={projectId}
          objects={objects}
          connections={connections}
          initialViewport={deskSnapshot?.deskState.viewport}
          onMove={desk.onMove}
          onMoveEnd={onMoveEnd}
          onResize={desk.onResize}
          onResizeEnd={onResizeEnd}
          onViewportChange={onViewportChange}
          focusRequest={desk.focusRequest}
          selectedIds={selectedIds}
          selectedConnectionId={selectedConnectionId}
          onSelect={(id, opts) => {
            setSelectedConnectionId(undefined);
            if (!id) {
              setSelectedIds([]);
              gen.closePanel();
              setInpaintSourceId(undefined);
              return;
            }
            if (opts?.toggle) {
              setSelectedIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
              gen.closePanel();
              setInpaintSourceId(undefined);
              return;
            }
            setSelectedIds([id]);
            if (inpaintSourceId !== id) setInpaintSourceId(undefined);
            const openPanel = opts?.panel !== false;
            if (openPanel) gen.openPanel(id);
            else if (gen.panelSourceId && gen.panelSourceId !== id) gen.closePanel();
          }}
          onMarqueeSelect={(ids) => {
            setSelectedConnectionId(undefined);
            setSelectedIds(ids);
            gen.closePanel();
            setInpaintSourceId(undefined);
          }}
          onSelectConnection={(id) => {
            setSelectedConnectionId(id);
            if (id) {
              setSelectedIds([]);
              gen.closePanel();
            }
          }}
          onDeleteConnection={deleteConnection}
          onDropFiles={placement.addImageFiles}
          onCreateConnection={createConnection}
          onConnectStart={gen.closePanel}
          onObjectDoubleClick={(obj) => {
            if ((obj.kind === "canvas_image" || obj.kind === "effect_image") && obj.url) {
              setLightboxUrl(obj.url);
            }
          }}
          overlay={
            <DeskToolbar
              canUndo={history.canUndo}
              canRedo={history.canRedo}
              onHand={() => {
                setSelectedIds([]);
                setSelectedConnectionId(undefined);
                gen.closePanel();
              }}
              onUndo={history.undo}
              onRedo={history.redo}
              onImage={placement.addImagePlaceholder}
            />
          }
          renderNodeToolbar={(obj) => (
            <>
              {obj.kind === "canvas_image" && !obj.url && !obj.pending && (
                <button
                  type="button"
                  onClick={() => {
                    imageUploadTargetRef.current = obj.id;
                    imagePickerRef.current?.click();
                  }}
                >
                  <Upload size={14} />
                  上传图片
                </button>
              )}
              {(obj.kind === "canvas_image" || obj.kind === "effect_image") && obj.url && !obj.pending && (
                <button
                  type="button"
                  onClick={() => {
                    gen.closePanel();
                    setInpaintSourceId(obj.id);
                  }}
                >
                  <Brush size={14} />
                  局部重绘
                </button>
              )}
              <button type="button" className="danger" onClick={() => placement.deleteObject(obj.id)}>
                <Trash2 size={14} />
                删除
              </button>
            </>
          )}
          renderObject={(obj) => (
            <DeskObjectView
              obj={obj}
              onRetryGenerate={(id) => {
                const target = objects.find((item) => item.id === id);
                if (!target || (target.kind !== "effect_image" && target.kind !== "canvas_image")) return;
                const inbound = connections.find((c) => c.to === id);
                void gen.generate({
                  sourceArtifactId: inbound?.from ?? id,
                  targetArtifactId: id,
                  prompt: target.userPrompt ?? target.prompt ?? "",
                  region: target.region,
                  referenceFileId: target.referenceFileId,
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
              onGenerate={(prompt, opts) => {
                const fillBack = panelSource.kind === "canvas_image" && !panelSource.url;
                const prev = fillBack
                  ? deskSnapshot?.artifacts.find((a) => a.id === panelSource.id)
                  : undefined;
                void gen.generate({
                  sourceArtifactId: panelSource.id,
                  prompt,
                  size: opts?.size,
                  model: opts?.model,
                  ...(fillBack
                    ? {
                      targetArtifactId: panelSource.id,
                      fillBack: true,
                      previousPayload: prev?.payload ?? {},
                      previousInputRefs: prev?.inputRefs,
                    }
                    : {}),
                });
              }}
              onClose={gen.closePanel}
            />
          )}
        </Desk>
        <input
          ref={imagePickerRef}
          type="file"
          accept={CANVAS_IMAGE_ACCEPT}
          className="sr-only"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            const targetId = imageUploadTargetRef.current;
            imageUploadTargetRef.current = undefined;
            if (file && targetId) placement.uploadImageToObject(targetId, file);
            e.currentTarget.value = "";
          }}
        />
        {lightbox.rendered && (
          <ImageLightbox url={lightbox.rendered} closing={lightbox.closing} onClose={() => setLightboxUrl(undefined)} />
        )}
        {inpaintReady && inpaintSourceId && (
          <InpaintDialog
            projectId={projectId}
            source={inpaintReady}
            busy={gen.busySourceId === inpaintSourceId}
            onSubmit={({ prompt, referenceFileId, region }) => {
              void gen.generate({
                sourceArtifactId: inpaintSourceId,
                prompt,
                region,
                referenceFileId,
              });
              setInpaintSourceId(undefined);
            }}
            onCancel={() => setInpaintSourceId(undefined)}
          />
        )}
        <ChatPanel
          projectId={projectId}
          items={chat.chatItems}
          streaming={chat.streaming}
          busy={chat.busy}
          connection={chat.connection}
          threads={chat.chatThreads}
          activeThreadId={chat.activeChatThreadId}
          threadChanging={chat.threadChanging}
          handoffId={composerHandoff?.id}
          initialText={composerHandoff?.text}
          initialFiles={composerHandoff?.files}
          autoSend={composerHandoff?.autoSend}
          seedSelectedArtifactIds={composerHandoff?.selectedArtifactIds}
          submissionOutcome={chat.submissionOutcome}
          selectedObjects={selectedIds
            .map((id) => objects.find((item) => item.id === id))
            .filter((item): item is NonNullable<typeof item> => Boolean(item))}
          onClearSelection={(id) => {
            if (id) {
              setSelectedIds((cur) => cur.filter((x) => x !== id));
              if (gen.panelSourceId === id) gen.closePanel();
              return;
            }
            setSelectedIds([]);
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
