/**
 * 应用壳（P0 拆分后）：
 *  - URL 路由 home | desk
 *  - 项目列表 CRUD（useProjects）
 *  - 桌面 snapshot 的加载与刷新（供 DeskWorkbench 渲染）
 *
 * 不负责：聊天 WS、选中、生图、inpaint —— 全在 DeskWorkbench。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type DeskSnapshot } from "../lib/api";
import { Home } from "../desk/Home";
import { validateCanvasImageFile } from "../desk/attachments";
import { mapConnections, mapSnapshot } from "../desk/map";
import type { DeskConnection, DeskObject } from "../desk/types";
import { DeskWorkbench } from "./DeskWorkbench";
import { useProjects } from "./useProjects";

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
  const projectsApi = useProjects();
  const [snapshot, setSnapshot] = useState<DeskSnapshot>();
  const [objects, setObjects] = useState<DeskObject[]>([]);
  const [connections, setConnections] = useState<DeskConnection[]>([]);
  /** Home 创建时带入的首条文案/附件，交给 ChatPanel 后清空。 */
  const [composerHandoff, setComposerHandoff] = useState<{ text?: string; files?: File[] }>();
  const activeProjectRef = useRef<string>();
  /** 丢弃过期 refresh：快速切项目时旧请求不得覆盖新桌面。 */
  const refreshSequence = useRef(0);
  const hasAttachmentDraftRef = useRef(false);
  /** popstate 与 confirm 取消离开时，阻止二次处理 history.forward。 */
  const skipHistoryRef = useRef(false);
  const bootstrappedRef = useRef(false);

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

  useEffect(() => {
    if (view.mode === "home") void projectsApi.loadProjects();
  }, [view.mode, projectsApi.loadProjects]);

  const resetToHome = useCallback(() => {
    activeProjectRef.current = undefined;
    hasAttachmentDraftRef.current = false;
    setComposerHandoff(undefined);
    refreshSequence.current += 1;
    setSnapshot(undefined);
    setObjects([]);
    setConnections([]);
    setView({ mode: "home" });
  }, []);

  const openProject = useCallback(
    async (nextProjectId: string, options?: { initialText?: string; initialFiles?: File[]; history?: "push" | "replace" | "none" }) => {
      const historyMode = options?.history ?? "push";
      activeProjectRef.current = nextProjectId;
      setComposerHandoff(options?.initialText || options?.initialFiles?.length
        ? { text: options.initialText, files: options.initialFiles }
        : undefined);
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
      await refreshDesk(nextProjectId).catch(() => undefined);
    },
    [refreshDesk],
  );

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

  /**
   * 新建项目：图片直接落桌为首个 canvas_image；
   * PDF 等非图附件走对话 handoff（首条消息附件）。
   */
  const createProject = useCallback(
    async (input: { name: string; files?: File[]; prompt?: string }) => {
      const project = await api.createProject(input.name);
      const files = input.files ?? [];
      const images = files.filter((file) => validateCanvasImageFile(file) === undefined);
      const others = files.filter((file) => validateCanvasImageFile(file) !== undefined);
      await openProject(project.id, { initialText: input.prompt, initialFiles: others });
      for (const [index, file] of images.entries()) {
        try {
          const stored = await api.uploadFile(project.id, file);
          await api.createArtifact(project.id, {
            artifactType: "canvas_image",
            payload: { file_id: stored.id },
            inputRefs: [{ file_id: stored.id }],
            clientOpId: crypto.randomUUID(),
            layout: { kind: "canvas_image", x: 60 + index * 32, y: 60 + index * 32, rot: 0 },
          });
        } catch {
          // 单个文件失败不阻断进入项目；用户可稍后拖放补上
        }
      }
      if (images.length > 0) await refreshDesk(project.id).catch(() => undefined);
    },
    [openProject, refreshDesk],
  );

  const renameProject = useCallback(async (project: { id: string }, name: string) => {
    const updated = await projectsApi.renameProject(project, name);
    if (!updated) return;
    setSnapshot((cur) => (cur && cur.project.id === project.id
      ? { ...cur, project: { ...cur.project, name: updated.name, updatedAt: updated.updatedAt } }
      : cur));
  }, [projectsApi]);

  if (view.mode === "home") {
    return (
      <div className="app-shell">
        <Home
          projects={projectsApi.projects}
          error={projectsApi.homeError}
          onOpen={(p) => void openProject(p.id)}
          onCreate={createProject}
          onRename={renameProject}
          onDelete={projectsApi.deleteProject}
        />
      </div>
    );
  }

  return (
    <DeskWorkbench
      projectId={view.projectId}
      snapshot={snapshot}
      objects={objects}
      connections={connections}
      setObjects={setObjects}
      refreshDesk={refreshDesk}
      activeProjectRef={activeProjectRef}
      composerHandoff={composerHandoff}
      setComposerHandoff={setComposerHandoff}
      hasAttachmentDraftRef={hasAttachmentDraftRef}
      onProjectRenamed={(pid, name) => {
        setSnapshot((cur) => (cur && cur.project.id === pid ? { ...cur, project: { ...cur.project, name } } : cur));
        projectsApi.setProjects((cur) => cur.map((p) => (p.id === pid ? { ...p, name } : p)));
      }}
      onRenameProject={renameProject}
      onLeave={() => { leaveProject(); }}
    />
  );
}
