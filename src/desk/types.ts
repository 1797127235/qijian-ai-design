export type Tone = "site" | "wood" | "cloth" | "green";

export interface Space {
  id: string;
  name: string;
  key: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Direction {
  id: string;
  title: string;
  concept: string;
  chips: string[];
  tone?: Tone;
}

export type DeskObject =
  | { id: string; kind: "brief"; x: number; y: number; rot: number; status: "draft" | "confirmed"; text: string; files: string[] }
  | { id: string; kind: "plan"; x: number; y: number; rot: number; w: number; status: "draft" | "confirmed"; sourceFileId?: string; spaces: Space[] }
  | { id: string; kind: "note"; x: number; y: number; rot: number; status: "draft" | "confirmed"; spaceId: string; who: string; text: string }
  | { id: string; kind: "direction_set"; x: number; y: number; rot: number; status: "draft" | "confirmed"; directions: Direction[]; selectedId?: string }
  | { id: string; kind: "effect_image"; x: number; y: number; rot: number; status: "draft" | "confirmed"; spaceId: string; url: string; adopted: boolean }
  | { id: string; kind: "setup"; x: number; y: number; rot: number };

export type ChatItem =
  | { id: string; role: "user" | "agent"; text: string }
  | { id: string; role: "activity"; text: string };
