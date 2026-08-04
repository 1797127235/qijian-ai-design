import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderKanban, Moon, PanelLeftClose, PanelLeftOpen, Plus, Sun, Trash2 } from "lucide-react";
import { Badge } from "../components/ui";
import {
  api,
  versionedOf,
  type AiTask,
  type Artifact,
  type CanvasLayoutPayload,
  type ConstraintModuleId,
  type DesignBriefPayload,
  type DesignDirectionsPayload,
  type DesignSystemPayload,
  type ProjectSummary,
  type ProjectUnderstandingPayload,
  type ProposalCanvasPayload,
  type SpaceMapPayload,
  type SpaceProposalPayload,
  type StoredFile,
  type Versioned,
} from "../lib/api";
import { BriefScreen, NewProjectForm } from "../screens/Brief";
import { UnderstandingScreen } from "../screens/Understanding";
import { DirectionsScreen } from "../screens/Directions";
import { ConstraintsScreen } from "../screens/Constraints";
import { CanvasScreen } from "../screens/Canvas";
import { PackageScreen } from "../screens/Package";

type Stage = "brief" | "understanding" | "directions" | "constraints" | "canvas" | "package";
type TaskKey = "understanding" | "directions" | "constraints" | "module";

const stages: Array<{ id: Stage; label: string; num: string }> = [
  { id: "brief", label: "设计 Brief", num: "01" },
  { id: "understanding", label: "项目理解", num: "02" },
  { id: "directions", label: "方向集", num: "03" },
  { id: "constraints", label: "约束包", num: "04" },
  { id: "canvas", label: "提案画布", num: "05" },
  { id: "package", label: "提案包", num: "06" },
];

const typeLabels = { home: "家装", commercial: "工装", landscape: "景观" } as const;
const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

export function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectSummary>();
  const [stage, setStage] = useState<Stage>("brief");
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [brief, setBrief] = useState<Versioned<DesignBriefPayload>>();
  const [understanding, setUnderstanding] = useState<Versioned<ProjectUnderstandingPayload>>();
  const [directions, setDirections] = useState<Versioned<DesignDirectionsPayload>>();
  const [constraints, setConstraints] = useState<Versioned<DesignSystemPayload>>();
  const [spaceMap, setSpaceMap] = useState<Versioned<SpaceMapPayload>>();
  const [proposalCanvas, setProposalCanvas] = useState<Versioned<ProposalCanvasPayload>>();
  const [spaceProposals, setSpaceProposals] = useState<Array<Versioned<SpaceProposalPayload>>>([]);
  const [layout, setLayout] = useState<CanvasLayoutPayload>();
  const [floorPlanFileId, setFloorPlanFileId] = useState<string>();
  const [tasks, setTasks] = useState<Partial<Record<TaskKey, AiTask>>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [mode, setMode] = useState<"editor" | "new">("editor");
  const [navOpen, setNavOpen] = useState(false);
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    document.documentElement.dataset.theme = theme === "dark" ? "dark" : "";
  }, [theme]);

  const loadProjects = useCallback(async () => {
    try {
      setProjects(await api.listProjects());
    } catch (e) {
      setError(errMsg(e, "无法加载项目列表"));
    }
  }, []);

  const deleteProject = async (project: ProjectSummary) => {
    if (!window.confirm(`确定删除项目「${project.name}」？项目理解、设计方向和上传资料都会被永久删除。`)) return;
    try {
      await api.deleteProject(project.id);
      setProjects((cur) => {
        const next = cur.filter((p) => p.id !== project.id);
        if (activeProject?.id === project.id) {
          setActiveProject(undefined);
          if (next[0]) void openProject(next[0]);
        }
        return next;
      });
    } catch (e) {
      setError(errMsg(e, "暂时无法删除项目"));
    }
  };

  useEffect(() => { void loadProjects(); }, [loadProjects]);

  const openProject = useCallback(async (project: ProjectSummary) => {
    setError(undefined);
    setActiveProject(project);
    setMode("editor");
    setTasks({});
    setNavOpen(false);
    try {
      const [artifacts, projectFiles] = await Promise.all([
        api.projectArtifacts(project.id),
        api.projectFiles(project.id).catch(() => [] as StoredFile[]),
      ]);
      setFiles(projectFiles);
      const byType = <T,>(type: string) => {
        const matches = artifacts.filter((a) => a.artifact_type === type);
        const preferred = matches.find((a) => a.current_version?.status === "confirmed") ?? matches[0];
        return versionedOf(preferred as Artifact<T> | undefined);
      };
      const allByType = <T,>(type: string) =>
        artifacts
          .filter((a) => a.artifact_type === type)
          .map((a) => versionedOf(a as Artifact<T>))
          .filter((v): v is Versioned<T> => Boolean(v));

      setBrief(byType<DesignBriefPayload>("design_brief"));
      const briefRaw = artifacts.find((a) => a.artifact_type === "design_brief");
      setFloorPlanFileId(briefRaw?.current_version?.input_refs.find((r) => r.role === "floor_plan")?.file_id);
      const und = byType<ProjectUnderstandingPayload>("project_understanding");
      const dirs = byType<DesignDirectionsPayload>("design_directions");
      const cons = byType<DesignSystemPayload>("design_system");
      setUnderstanding(und);
      setDirections(dirs);
      setConstraints(cons);
      setSpaceMap(byType<SpaceMapPayload>("space_map"));
      const canvas = byType<ProposalCanvasPayload>("proposal_canvas");
      setProposalCanvas(canvas);
      setSpaceProposals(allByType<SpaceProposalPayload>("space_proposal"));
      if (canvas) {
        const canvasLayout = await api.canvasLayout(canvas.artifactId).catch(() => null);
        setLayout(canvasLayout?.payload);
      } else {
        setLayout(undefined);
      }
      setStage(
        cons?.status === "confirmed" ? "canvas"
          : cons ? "constraints"
            : dirs ? "directions"
              : und ? "understanding"
                : "brief",
      );
    } catch (e) {
      setError(errMsg(e, "无法打开项目"));
    }
  }, []);

  useEffect(() => {
    if (!activeProject && projects[0]) void openProject(projects[0]);
  }, [projects, activeProject, openProject]);

  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  useEffect(() => {
    const pending = Object.values(tasks).some((t) => t && ["pending", "running"].includes(t.status));
    if (!pending) return;
    const timer = window.setInterval(async () => {
      const entries = Object.entries(tasksRef.current) as Array<[TaskKey, AiTask]>;
      for (const [key, task] of entries) {
        if (!task || !["pending", "running"].includes(task.status)) continue;
        try {
          const updated = await api.task(task.id);
          setTasks((cur) => ({ ...cur, [key]: updated }));
          if (updated.status === "succeeded" && updated.output_artifact_id) {
            if (key === "understanding") setUnderstanding(versionedOf(await api.artifact<ProjectUnderstandingPayload>(updated.output_artifact_id)));
            if (key === "directions") setDirections(versionedOf(await api.artifact<DesignDirectionsPayload>(updated.output_artifact_id)));
            if (key === "constraints") setConstraints(versionedOf(await api.artifact<DesignSystemPayload>(updated.output_artifact_id)));
          }
        } catch (e) {
          setError(errMsg(e, "任务状态读取失败"));
        }
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [tasks]);

  const retry = async (key: TaskKey) => {
    const task = tasks[key];
    if (!task) return;
    setError(undefined);
    try {
      setTasks((cur) => ({ ...cur, [key]: undefined }));
      const retried = await api.retryTask(task.id);
      setTasks((cur) => ({ ...cur, [key]: retried }));
    } catch (e) {
      setError(errMsg(e, "暂时无法重试"));
    }
  };

  const withSaving = async (fn: () => Promise<void>) => {
    setSaving(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(errMsg(e, "暂时无法保存"));
    } finally {
      setSaving(false);
    }
  };

  const unlocked = useMemo(() => {
    const set = new Set<Stage>(["brief"]);
    if (understanding || tasks.understanding) set.add("understanding");
    if (directions || tasks.directions) set.add("directions");
    if (constraints || tasks.constraints) set.add("constraints");
    if (constraints?.status === "confirmed") {
      set.add("canvas");
      set.add("package");
    }
    return set;
  }, [understanding, directions, constraints, tasks]);

  const activeIndex = stages.findIndex((s) => s.id === stage);
  const goStage = (s: Stage) => {
    if (unlocked.has(s)) {
      setStage(s);
      setNavOpen(false);
    }
  };
  const startNew = () => {
    setMode("new");
    setNavOpen(false);
  };

  return (
    <div className={`app ${sideCollapsed ? "side-collapsed" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <button type="button" className="sidebar-toggle" aria-label="打开项目列表" aria-expanded={navOpen} onClick={() => setNavOpen((v) => !v)}>☰</button>
          <span className="brand-seal" aria-hidden="true">砌</span>
          <div>
            <div className="brand-name">砌间</div>
            <div className="brand-sub">QIJIAN AI DESIGN</div>
          </div>
          <button
            type="button"
            className="side-toggle"
            aria-label={sideCollapsed ? "展开项目列表" : "收起项目列表"}
            aria-expanded={!sideCollapsed}
            title={sideCollapsed ? "展开项目列表" : "收起项目列表"}
            onClick={() => setSideCollapsed((v) => !v)}
          >
            {sideCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
          </button>
        </div>
        <nav className="flow" aria-label="设计流程">
          {stages.map((s, i) => {
            const locked = mode === "new" || !activeProject || !unlocked.has(s.id);
            const isActive = mode === "editor" && stage === s.id;
            const passed = !locked && i < activeIndex;
            return (
              <button
                type="button"
                key={s.id}
                className={`flow-step ${isActive ? "active" : ""} ${locked ? "gated" : passed ? "passed" : ""}`}
                disabled={locked}
                aria-current={isActive ? "step" : undefined}
                onClick={() => goStage(s.id)}
              >
                <span className="gate-dot" aria-hidden="true" />
                {s.num} · {s.label}
              </button>
            );
          })}
        </nav>
        <div className="crumb">
          {activeProject && mode === "editor" && <b>{activeProject.name}</b>}
          <button type="button" className="side-new" onClick={startNew}>＋ 新项目</button>
        </div>
      </header>

      <div className="workspace">
        <aside className={`sidebar ${navOpen ? "open" : ""}`} aria-label="项目列表">
          <div className="side-rail">
            <button type="button" className="rail-item rail-brand" title="展开项目列表" aria-label="展开项目列表" onClick={() => setSideCollapsed(false)}>
              <span className="brand-seal" aria-hidden="true">砌</span>
            </button>
            <button type="button" className="rail-item" title="新建设计项目" aria-label="新建设计项目" onClick={startNew}><Plus size={16} /></button>
            <button type="button" className="rail-item" title="项目列表" aria-label="展开项目列表" onClick={() => setSideCollapsed(false)}><FolderKanban size={16} /></button>
            <span className="rail-spacer" />
            <button
              type="button"
              className="rail-item"
              title={theme === "light" ? "深色模式" : "浅色模式"}
              aria-label={theme === "light" ? "切换到深色模式" : "切换到浅色模式"}
              onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
            >
              {theme === "light" ? <Moon size={15} /> : <Sun size={15} />}
            </button>
          </div>
          <div className="side-head">
            <h4>设计项目</h4>
            <button type="button" className="side-new" onClick={startNew}>＋ 新建</button>
          </div>
          <div className="side-scroll">
            {projects.map((p) => (
              <div className="proj-wrap" key={p.id}>
                <button
                  type="button"
                  className={`proj ${p.id === activeProject?.id && mode === "editor" ? "active" : ""}`}
                  onClick={() => void openProject(p)}
                >
                  <div className="t">{p.name}</div>
                  <div className="m">{typeLabels[p.project_type]}{p.area_sqm ? ` · ${p.area_sqm} ㎡` : " · 面积待补充"}</div>
                  {p.id === activeProject?.id && mode === "editor" && <span className="s"><Badge tone="ok">当前项目</Badge></span>}
                </button>
                <button
                  type="button"
                  className="proj-del"
                  aria-label={`删除项目 ${p.name}`}
                  title={`删除项目 ${p.name}`}
                  onClick={() => void deleteProject(p)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            {projects.length === 0 && <p className="mono" style={{ padding: "8px 10px" }}>暂无项目</p>}
          </div>
          <div className="side-foot">
            <span>项目默认私有</span>
            <button type="button" className="theme-toggle" onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}>
              {theme === "light" ? "深色模式" : "浅色模式"}
            </button>
          </div>
        </aside>
        {navOpen && <button type="button" className="scrim" aria-label="关闭项目列表" onClick={() => setNavOpen(false)} />}

        <main className="main">
          {mode === "new" && (
            <NewProjectForm
              onCancel={() => setMode("editor")}
              onCreated={async (input) => {
                const created = await api.createProjectWithBrief(input);
                const summary: ProjectSummary = {
                  id: created.projectId,
                  name: input.name,
                  project_type: input.projectType,
                  area_sqm: input.areaSqm != null ? String(input.areaSqm) : null,
                  updated_at: new Date().toISOString(),
                };
                setProjects((cur) => [summary, ...cur.filter((p) => p.id !== summary.id)]);
                const task = await api.createUnderstandingTask(created.projectId, created.briefArtifactId);
                setActiveProject(summary);
                setMode("editor");
                setBrief(undefined);
                setUnderstanding(undefined);
                setDirections(undefined);
                setConstraints(undefined);
                setProposalCanvas(undefined);
                setSpaceMap(undefined);
                setSpaceProposals([]);
                setLayout(undefined);
                setFiles([]);
                setTasks({ understanding: task });
                setStage("understanding");
              }}
            />
          )}

          {mode === "editor" && !activeProject && (
            <div className="page">
              <p className="eyebrow">砌间 · Qijian AI Design</p>
              <h1 className="h-display">从 Brief 到提案包</h1>
              <p className="lede">选择一个项目继续设计，或从一个新项目开始。</p>
              <div style={{ marginTop: 24 }}>
                <button type="button" className="btn primary" onClick={startNew}>＋ 新建设计项目</button>
              </div>
              {error && <p className="error-text" role="alert" style={{ marginTop: 12 }}>{error}</p>}
            </div>
          )}

          {mode === "editor" && activeProject && stage === "brief" && brief && (
            <BriefScreen project={activeProject} brief={brief.payload} files={files} onNext={() => goStage("understanding")} />
          )}

          {mode === "editor" && activeProject && stage === "understanding" && (
            <UnderstandingScreen
              task={tasks.understanding}
              understanding={understanding}
              error={error}
              saving={saving}
              onRetry={() => void retry("understanding")}
              onGenerateDirections={() => {
                if (!activeProject || !understanding) return;
                void (async () => {
                  try {
                    const task = await api.createDirectionsTask(activeProject.id, understanding.artifactId);
                    setTasks((cur) => ({ ...cur, directions: task }));
                    setDirections(undefined);
                    setStage("directions");
                  } catch (e) {
                    setError(errMsg(e, "暂时无法生成设计方向"));
                  }
                })();
              }}
              onSave={(payload, status) => withSaving(async () => {
                if (!understanding) return;
                setUnderstanding(versionedOf(await api.saveUnderstanding(understanding.artifactId, payload, status)));
              })}
            />
          )}

          {mode === "editor" && activeProject && stage === "directions" && (
            <DirectionsScreen
              task={tasks.directions}
              directions={directions}
              sharedFacts={understanding?.payload.project_and_household_summary.project_summary ?? ""}
              error={error}
              saving={saving}
              onRetry={() => void retry("directions")}
              onSave={(payload, status) => withSaving(async () => {
                if (!directions) return;
                const saved = versionedOf(await api.saveDirections(directions.artifactId, payload, status));
                setDirections(saved);
                if (status === "confirmed") {
                  const task = await api.createDesignSystemTask(activeProject.id, directions.artifactId);
                  setTasks((cur) => ({ ...cur, constraints: task }));
                  setConstraints(undefined);
                  setStage("constraints");
                }
              })}
            />
          )}

          {mode === "editor" && activeProject && stage === "constraints" && (
            <ConstraintsScreen
              task={tasks.constraints}
              constraints={constraints}
              error={error}
              saving={saving}
              moduleTask={tasks.module}
              onRetry={() => void retry("constraints")}
              onRegenerateModule={(moduleId: ConstraintModuleId) => {
                if (!constraints) return;
                void (async () => {
                  try {
                    const task = await api.createModuleTask(activeProject.id, constraints.artifactId, moduleId);
                    setTasks((cur) => ({ ...cur, module: task }));
                  } catch (e) {
                    setError(errMsg(e, "暂时无法重新生成该模块"));
                  }
                })();
              }}
              onSave={(payload, status) => withSaving(async () => {
                if (!constraints) return;
                const saved = versionedOf(await api.saveDesignSystem(constraints.artifactId, payload, status));
                setConstraints(saved);
                if (status === "confirmed") setStage("canvas");
              })}
            />
          )}

          {mode === "editor" && activeProject && stage === "canvas" && (
            <div className="page wide">
              <CanvasScreen
                projectId={activeProject.id}
                spaceMap={spaceMap}
                canvas={proposalCanvas}
                proposals={spaceProposals}
                layout={layout}
                directionTitle={directions?.payload.cards.find((c) => c.direction_id === directions.payload.selected_direction_id)?.title}
                floorPlanFileId={floorPlanFileId}
                upstream={
                  directions && constraints
                    ? {
                        design_direction_artifact_id: directions.artifactId,
                        design_direction_version_id: directions.versionId,
                        design_system_artifact_id: constraints.artifactId,
                        design_system_version_id: constraints.versionId,
                      }
                    : undefined
                }
                onSpaceMap={setSpaceMap}
                onCanvas={(v) => {
                  setProposalCanvas(v);
                  void api.canvasLayout(v.artifactId).then((l) => setLayout(l?.payload)).catch(() => setLayout(undefined));
                }}
                onProposals={setSpaceProposals}
                onLayout={setLayout}
              />
            </div>
          )}

          {mode === "editor" && activeProject && stage === "package" && (
            <PackageScreen projectName={activeProject.name} directions={directions} constraints={constraints} />
          )}
        </main>
      </div>
    </div>
  );
}
