/** Agent 工具注册入口：按稳定顺序组装当前项目可用的全部工具。 */
import type { ToolDependencies } from "./shared.js";
import { createToolContext } from "./shared.js";
import { createReadDeskTool } from "./read-desk.js";
import { createPlaceObjectTool } from "./place-object.js";
import { createMoveObjectTool } from "./move-object.js";
import { createUnderstandingNotesTool } from "./create-understanding-notes.js";
import { createDirectionSetTool } from "./create-direction-set.js";
import { createEffectImageTool } from "./generate-effect-image.js";
import { createAdoptVariantTool } from "./adopt-variant.js";
import { createDiscardVariantTool } from "./discard-variant.js";
import { createEditPayloadTool } from "./edit-payload.js";
import { createConfirmArtifactTool } from "./confirm-artifact.js";
import { createExportPackageTool } from "./export-package.js";

export function createDeskTools(projectId: string, dependencies: ToolDependencies) {
  const context = createToolContext(projectId, dependencies);
  return [
    createReadDeskTool(context),
    createPlaceObjectTool(context),
    createMoveObjectTool(context),
    createUnderstandingNotesTool(context),
    createDirectionSetTool(context),
    createEffectImageTool(context),
    createAdoptVariantTool(context),
    createDiscardVariantTool(context),
    createEditPayloadTool(context),
    createConfirmArtifactTool(context),
    createExportPackageTool(context),
  ];
}

export type { ToolDependencies } from "./shared.js";
