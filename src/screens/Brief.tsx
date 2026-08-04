import { useState, type FormEvent } from "react";
import { Badge, GateBar, Seal, Spinner } from "../components/ui";
import type { DesignBriefPayload, ProjectSummary, StoredFile } from "../lib/api";

const typeLabels = { home: "家装", commercial: "工装", landscape: "景观" } as const;

export function BriefScreen({
  project,
  brief,
  files,
  onNext,
}: {
  project: ProjectSummary;
  brief: DesignBriefPayload | undefined;
  files: StoredFile[];
  onNext: () => void;
}) {
  const needs = brief?.needs ? brief.needs.split(/[;；\n]/).filter(Boolean) : [];
  return (
    <div className="page">
      <p className="eyebrow">Design Brief · 已保存</p>
      <h1 className="h-display">{project.name}</h1>
      <p className="lede">结构化共识：目标、使用者、预算、功能需求与风格偏好。Brief 是所有后续 AI 产出的事实起点。</p>

      <div className="split">
        <div>
          <div className="fact">
            <span className="mono" style={{ display: "block", marginBottom: 7, letterSpacing: "0.1em", textTransform: "uppercase" }}>项目类型 / 面积</span>
            <div className="val"><strong>{typeLabels[project.project_type]}</strong>{project.area_sqm ? ` · ${project.area_sqm} ㎡` : " · 面积待补充"}</div>
          </div>
          <div className="fact">
            <span className="mono" style={{ display: "block", marginBottom: 7, letterSpacing: "0.1em", textTransform: "uppercase" }}>使用者</span>
            <div className="val">{brief?.household || "未记录"}</div>
          </div>
          <div className="fact">
            <span className="mono" style={{ display: "block", marginBottom: 7, letterSpacing: "0.1em", textTransform: "uppercase" }}>预算</span>
            <div className="val"><strong>{brief?.budget || "未记录"}</strong></div>
          </div>
          <div className="fact">
            <span className="mono" style={{ display: "block", marginBottom: 7, letterSpacing: "0.1em", textTransform: "uppercase" }}>功能需求与硬约束</span>
            {needs.length > 1 ? (
              <div className="chips">{needs.map((n) => <span className="chip" key={n}>{n.trim()}</span>)}</div>
            ) : (
              <div className="val">{brief?.needs || "未记录"}</div>
            )}
          </div>
          <div className="fact">
            <span className="mono" style={{ display: "block", marginBottom: 7, letterSpacing: "0.1em", textTransform: "uppercase" }}>风格偏好</span>
            <div className="val">{brief?.style || "未记录"} <span className="mono" style={{ display: "block", marginTop: 4 }}>参考图仅表达色彩 / 材料 / 氛围倾向，不改变空间事实</span></div>
          </div>
        </div>

        <aside className="card u-card">
          <h2 className="h-card">资料清单</h2>
          <p className="mono" style={{ marginTop: 4 }}>{files.length} 个文件</p>
          <hr className="hr" style={{ margin: "14px 0" }} />
          {files.length === 0 && <p className="mono">暂无已上传资料。</p>}
          {files.map((f) => (
            <div className="u-item ok" key={f.id}>
              <span className="dot" aria-hidden="true" />
              <div>{f.original_filename}<span className="mono" style={{ display: "block" }}>{f.media_type}</span></div>
            </div>
          ))}
        </aside>
      </div>

      <GateBar note="确认门已通过的项目才能生成项目理解卡。确认记录写入 Artifact，可被后续步骤引用。">
        <Seal>✓ Brief 已确认</Seal>
        <button type="button" className="btn primary" onClick={onNext}>查看项目理解 →</button>
      </GateBar>
    </div>
  );
}

export function NewProjectForm({
  onCreated,
  onCancel,
}: {
  onCreated: (input: {
    name: string; projectType: "home" | "commercial" | "landscape"; areaSqm?: number;
    household: string; budget: string; needs: string; style: string;
    sourceFile: File; referenceFiles: File[];
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [projectType, setProjectType] = useState<"home" | "commercial" | "landscape">("home");
  const [area, setArea] = useState("");
  const [household, setHousehold] = useState("");
  const [budget, setBudget] = useState("");
  const [needs, setNeeds] = useState("");
  const [style, setStyle] = useState("");
  const [sourceFile, setSourceFile] = useState<File | undefined>();
  const [referenceFiles, setReferenceFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    if (!sourceFile) {
      setError("请先上传一张户型图或图纸 PDF，再生成项目理解卡。");
      return;
    }
    setSubmitting(true);
    try {
      await onCreated({
        name, projectType,
        areaSqm: area.trim() ? Number(area) : undefined,
        household, budget, needs, style, sourceFile, referenceFiles,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "暂时无法保存，请稍后重试。");
      setSubmitting(false);
    }
  };

  return (
    <div className="page">
      <p className="eyebrow">新建设计项目</p>
      <h1 className="h-display">先说说这个项目</h1>
      <p className="lede">上传一份户型资料，告诉我们这次设计要解决什么。AI 会先整理成一张可校对的项目理解卡，不会直接替你做决定。</p>

      <form className="split" onSubmit={submit}>
        <div>
          <div className="fact">
            <span className="mono" style={{ display: "block", marginBottom: 7, letterSpacing: "0.1em", textTransform: "uppercase" }}>项目类型</span>
            <div className="chips" role="group" aria-label="项目类型">
              {(["home", "commercial", "landscape"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`btn ${projectType === t ? "primary" : "secondary"}`}
                  style={{ minHeight: 34, padding: "6px 14px", fontSize: 13 }}
                  aria-pressed={projectType === t}
                  onClick={() => setProjectType(t)}
                >{typeLabels[t]}</button>
              ))}
            </div>
          </div>
          <label className="field fact"><span>项目名称</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="如「滨江壹品 12-2」" required data-state={error && !name ? "error" : undefined} />
            <span className="helper" /></label>
          <label className="field fact"><span>建筑面积（㎡）</span>
            <input className="input" value={area} onChange={(e) => setArea(e.target.value)} inputMode="numeric" placeholder="如 128" />
            <span className="helper" /></label>
          <label className="field fact"><span>使用者</span>
            <input className="input" value={household} onChange={(e) => setHousehold(e.target.value)} placeholder="谁会使用这个空间？" />
            <span className="helper" /></label>
          <label className="field fact"><span>预期预算</span>
            <input className="input" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="例如：35–50 万" />
            <span className="helper" /></label>
          <label className="field fact"><span>功能需求与硬约束</span>
            <textarea className="textarea" value={needs} onChange={(e) => setNeeds(e.target.value)} rows={4} placeholder="描述需要解决的功能与不可变更的条件" required />
            <span className="helper" /></label>
          <label className="field fact"><span>喜欢的氛围与参考方向</span>
            <textarea className="textarea" value={style} onChange={(e) => setStyle(e.target.value)} rows={3} placeholder="描述希望呈现的空间感受" />
            <span className="helper" /></label>
        </div>

        <aside className="side-stack">
          <div className="card u-card">
            <h2 className="h-card">项目资料</h2>
            <p className="mono" style={{ margin: "4px 0 14px" }}>户型图 / 图纸 PDF 为必需</p>
            <label className="field"><span>户型资料</span>
              <input className="input" type="file" accept=".pdf,.png,.jpg,.jpeg" style={{ padding: 9 }} onChange={(e) => setSourceFile(e.target.files?.[0])} />
              <span className={`helper ${error && !sourceFile ? "error" : ""}`}>{sourceFile ? `已选择：${sourceFile.name}` : "支持 JPG / PNG / PDF，单个文件不超过 20MB"}</span>
            </label>
            <label className="field" style={{ marginTop: 14 }}><span>参考图（可选，最多 5 张）</span>
              <input className="input" type="file" accept="image/png,image/jpeg" multiple style={{ padding: 9 }}
                onChange={(e) => setReferenceFiles((cur) => [...cur, ...Array.from(e.target.files || [])].slice(0, 5))} />
              <span className="helper">{referenceFiles.length ? `已选择 ${referenceFiles.length} 张 · 只影响色彩、材料和氛围语言` : "只影响色彩、材料和氛围语言"}</span>
            </label>
          </div>
          <div className="gate-bar" style={{ marginTop: 0, flexDirection: "column", alignItems: "stretch", gap: 14 }}>
            {error && <span className="error-text" role="alert">{error}</span>}
            <span className="note">提交后生成项目 Brief，并立即开始整理项目理解卡。</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="btn ghost" onClick={onCancel} disabled={submitting}>取消</button>
              <button type="submit" className="btn primary" disabled={submitting} data-state={submitting ? "loading" : undefined}>
                {submitting ? <><Spinner /> 正在保存…</> : "生成项目理解卡 →"}
              </button>
            </div>
          </div>
        </aside>
      </form>
    </div>
  );
}
