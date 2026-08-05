import { useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { api } from "../lib/api";

type PreviewState =
  | { kind: "loading" }
  | { kind: "image"; url: string }
  | { kind: "pdf" }
  | { kind: "error"; message: string };

export function FloorPlanPreview({ fileId, alt = "户型图纸" }: { fileId: string; alt?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<PreviewState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    let loadingTask: PDFDocumentLoadingTask | undefined;
    let disposed = false;

    void (async () => {
      try {
        setState({ kind: "loading" });
        const response = await fetch(api.fileUrl(fileId), { signal: controller.signal });
        if (!response.ok) throw new Error(`户型文件加载失败（${response.status}）`);
        const blob = await response.blob();
        if (disposed) return;

        if (blob.type === "application/pdf") {
          const pdfjs = await import("pdfjs-dist");
          pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
          loadingTask = pdfjs.getDocument({ data: await blob.arrayBuffer() });
          const document = await loadingTask.promise;
          const page = await document.getPage(1);
          const viewport = page.getViewport({ scale: 1.5 });
          const canvas = canvasRef.current;
          if (!canvas || disposed) return;
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          await page.render({ canvas, viewport }).promise;
          if (!disposed) setState({ kind: "pdf" });
          return;
        }

        if (!blob.type.startsWith("image/")) throw new Error("户型文件不是受支持的图片或 PDF");
        objectUrl = URL.createObjectURL(blob);
        setState({ kind: "image", url: objectUrl });
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        setState({ kind: "error", message: error instanceof Error ? error.message : "户型文件加载失败" });
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      void loadingTask?.destroy();
    };
  }, [fileId]);

  return (
    <div className="floor-plan-preview">
      <canvas ref={canvasRef} aria-label={alt} style={{ display: state.kind === "pdf" ? "block" : "none" }} />
      {state.kind === "image" && <img src={state.url} alt={alt} draggable={false} />}
      {state.kind === "loading" && <div className="plan-preview-status">正在加载户型图…</div>}
      {state.kind === "error" && <div className="plan-preview-status error-text">{state.message}</div>}
    </div>
  );
}
