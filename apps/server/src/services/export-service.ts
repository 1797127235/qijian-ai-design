import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactSnapshot } from "../domain/types.js";
import { HttpError } from "../lib/errors.js";
import type { ArtifactService } from "./artifact-service.js";
import type { DeskStateService } from "./desk-state-service.js";
import type { FileStorage } from "./file-storage.js";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function artifactSection(artifact: ArtifactSnapshot): string {
  const title = {
    design_brief: "客户需求",
    space_map: "空间地图",
    understanding_note: "项目理解",
    design_directions: "设计方向",
    effect_image: "空间效果",
    proposal_package: "提案包",
  }[artifact.artifactType];
  const image = typeof artifact.payload.url === "string" ? `<img src="${escapeHtml(artifact.payload.url)}" alt="${title}">` : "";
  return `<section><h2>${title}</h2>${image}<pre>${escapeHtml(JSON.stringify(artifact.payload, null, 2))}</pre></section>`;
}

export class ExportService {
  constructor(
    private readonly desks: DeskStateService,
    private readonly artifacts: ArtifactService,
    private readonly files: FileStorage,
  ) {}

  async export(projectId: string) {
    const snapshot = await this.desks.snapshot(projectId);
    const order = new Map(snapshot.deskState.objects.map((object, index) => [object.artifact_id, index]));
    const included = snapshot.artifacts
      .filter((artifact) => artifact.artifactType !== "proposal_package" && (artifact.status === "confirmed" || (artifact.artifactType === "effect_image" && artifact.payload.adopted === true)))
      .sort((left, right) => (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER));
    if (included.length === 0) throw new HttpError(422, "没有已确认或已采用的内容可导出");

    const dir = await mkdtemp(join(tmpdir(), "qijian-export-"));
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
      @page{size:A4;margin:0}html,body{margin:0;background:#fff;color:#252522}body{font:14px/1.65 system-ui}section{width:210mm;height:297mm;padding:16mm;overflow:hidden;break-before:page}section:first-of-type{break-before:auto}.cover{display:flex;align-items:flex-end;background:#f1eee6}.cover h1{font-size:32px;margin:0 0 20mm}h2{font-size:19px;border-bottom:1px solid #bbb;padding-bottom:6px}img{max-width:100%;max-height:210mm;object-fit:contain}pre{white-space:pre-wrap;font:12px/1.55 ui-monospace;background:#f4f3ef;padding:12px}
    </style></head><body><section class="cover"><h1>${escapeHtml(snapshot.project.name)}</h1></section>${included.map(artifactSection).join("")}</body></html>`;
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
    try {
      const page = await browser.newPage({ viewport: { width: 1240, height: 1754 }, deviceScaleFactor: 1 });
      await page.setContent(html, { waitUntil: "networkidle" });
      const pdfPath = join(dir, "proposal.pdf");
      await page.pdf({ path: pdfPath, format: "A4", printBackground: true });
      const sections = page.locator("section");
      const imagePaths: string[] = [];
      for (let index = 0; index < await sections.count(); index += 1) {
        const imagePath = join(dir, `page-${index + 1}.png`);
        await sections.nth(index).screenshot({ path: imagePath });
        imagePaths.push(imagePath);
      }
      const pdf = await this.files.put(projectId, "proposal.pdf", "application/pdf", await readFile(pdfPath));
      const images = await Promise.all(imagePaths.map(async (path, index) => this.files.put(projectId, `page-${index + 1}.png`, "image/png", await readFile(path))));
      const versionRefs = included.map((artifact) => ({ artifact_id: artifact.id, version_id: artifact.versionId }));
      const record = await this.artifacts.create(projectId, "proposal_package", {
        payload: { pdf_file: pdf, image_files: images, version_refs: versionRefs },
        inputRefs: versionRefs,
        status: "confirmed",
        createdBy: "agent",
        changeReason: "导出提案包",
      });
      return { artifactId: record.artifact.id, pdfUrl: pdf.url, imageUrls: images.map((image) => image.url), versionRefs };
    } finally {
      await browser.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
}
