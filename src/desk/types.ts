export type DeskObject =
  | { id: string; kind: "sticky_note"; x: number; y: number; rot: number; status: "draft" | "confirmed"; text: string }
  | { id: string; kind: "canvas_image"; x: number; y: number; rot: number; status: "draft" | "confirmed"; url: string }
  | {
      id: string;
      kind: "effect_image";
      x: number;
      y: number;
      rot: number;
      status: "draft" | "confirmed";
      url?: string;
      pending?: boolean;
      error?: string;
      prompt?: string;
    };

export type DeskConnection = { id: string; from: string; to: string };

export type ChatItem =
  | { id: string; role: "user" | "agent"; text: string; attachments?: import("../lib/api").ChatAttachment[] }
  | { id: string; role: "activity"; text: string };
