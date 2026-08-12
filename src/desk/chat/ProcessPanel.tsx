import { useEffect, useState } from "react";
import type { ProcessSnapshot } from "../types";
import { processTitle, toolLine, toolSteps } from "./process-summary";

/** 模型 thinking 原文常带段首/段尾空行，pre-wrap 会忠实渲染成大段空白，这里归一化 */
function tidyThinking(text: string): string {
  return text.trim().replace(/\n{3,}/g, "\n\n");
}

/** 折叠只一行「思考了 Ns ›」；展开按真实时间线渲染思考段与工具调用 */
export function ProcessPanel({ process }: { process: ProcessSnapshot }) {
  const [open, setOpen] = useState(false);
  const [, setTick] = useState(0);
  const running = process.status === "running";

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  // 新一轮过程开始时收回展开，避免上一轮展开态残留
  useEffect(() => {
    setOpen(false);
  }, [process.startedAt]);

  const canExpand = process.steps.length > 0;
  if (!running && !canExpand) return null;

  const failed = process.status === "failed" || toolSteps(process).some((t) => t.status === "failed");

  return (
    <div className="process-inline">
      <button
        type="button"
        className={`process-inline-toggle ${running ? "is-running" : ""} ${failed && !running ? "is-failed" : ""}`}
        aria-expanded={open}
        disabled={!canExpand}
        onClick={() => canExpand && setOpen((v) => !v)}
      >
        <span>{processTitle(process)}</span>
        {canExpand && (
          <span className="process-inline-chevron" aria-hidden="true">{open ? "˄" : "›"}</span>
        )}
      </button>

      {open && (
        <div className="process-inline-body">
          {process.steps.map((step) =>
            step.kind === "thinking" ? (
              <p key={step.id} className="process-inline-thinking">{tidyThinking(step.text)}</p>
            ) : (
              <div key={step.id} className={`process-inline-tool process-inline-tool-${step.status}`}>
                <span className="process-inline-tool-dot" aria-hidden="true" />
                <span>{toolLine(step)}</span>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
