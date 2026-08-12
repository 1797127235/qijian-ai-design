/**
 * 首页项目列表状态（与桌面工作台解耦）。
 * rename 成功返回 updated 行，便于 App 同步当前打开项目的顶栏名。
 */
import { useCallback, useState } from "react";
import { api, type ProjectSummary } from "../lib/api";

export function useProjects() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [homeError, setHomeError] = useState<string>();

  const loadProjects = useCallback(async () => {
    try {
      setProjects(await api.listProjects());
    } catch (e) {
      setHomeError(e instanceof Error ? e.message : "无法加载项目列表");
    }
  }, []);

  const deleteProject = useCallback(async (project: ProjectSummary) => {
    try {
      await api.deleteProject(project.id);
      setProjects((cur) => cur.filter((p) => p.id !== project.id));
    } catch (e) {
      setHomeError(e instanceof Error ? e.message : "删除失败");
    }
  }, []);

  /** 改名后按 updatedAt 重排，保证「最近」列表顺序与服务端一致。 */
  const renameProject = useCallback(async (project: { id: string }, name: string) => {
    try {
      const updated = await api.renameProject(project.id, name);
      setProjects((cur) =>
        cur.map((p) => (p.id === project.id ? updated : p))
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
      );
      return updated;
    } catch (e) {
      setHomeError(e instanceof Error ? e.message : "改名失败");
      return undefined;
    }
  }, []);

  return {
    projects,
    setProjects,
    homeError,
    setHomeError,
    loadProjects,
    deleteProject,
    renameProject,
  };
}
