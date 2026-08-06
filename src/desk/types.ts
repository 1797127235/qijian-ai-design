export type Tone = "site" | "wood" | "cloth" | "green";

export interface Direction {
  id: string;
  title: string;
  concept: string;
  chips: string[];
  tone?: Tone;
}

export type DeskObject =
  | { id: string; kind: "note"; x: number; y: number; rot: number; status: "draft" | "confirmed"; who: string; text: string }
  | { id: string; kind: "direction_set"; x: number; y: number; rot: number; status: "draft" | "confirmed"; directions: Direction[] }
  | { id: string; kind: "effect_image"; x: number; y: number; rot: number; status: "draft" | "confirmed"; url: string }
  | { id: string; kind: "sticky_note"; x: number; y: number; rot: number; status: "draft" | "confirmed"; text: string }
  | { id: string; kind: "canvas_image"; x: number; y: number; rot: number; status: "draft" | "confirmed"; url: string };

export type ChatItem =
  | { id: string; role: "user" | "agent"; text: string; attachments?: import("../lib/api").ChatAttachment[] }
  | { id: string; role: "activity"; text: string };
