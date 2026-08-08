/**
 * 兼容出口：桌面感知实现迁至 desk-context.ts。
 * 既有 import 路径保持可用。
 */
export {
  MAX_DESK_STATUS_OBJECTS,
  DESK_GRID_CELL,
  MAX_INSPECT_IMAGES,
  buildDeskStatusBlock,
  deskFileIds,
  selectedVisualFileIds,
  planInspectSelection,
  formatInspectBlock,
  formatFocusBlock,
  resolveDeskReferences,
  assembleDeskContext,
  compileDeskObjects,
  lifecycleOf,
  revisionOf,
  type DeskContextOptions as DeskStatusOptions,
  type DeskContextOptions,
  type InspectIncluded,
  type InspectSkipped,
  type InspectPlan,
  type InspectImageRef,
  type ReferenceResolution,
  type AssembledDeskContext,
  type DeskObjectView,
} from "./desk-context.js";

