export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface Point {
  x: number;
  y: number;
}

export function screenToWorld(point: Point, bounds: Point, viewport: Viewport): Point {
  return {
    x: (point.x - bounds.x - viewport.x) / viewport.zoom,
    y: (point.y - bounds.y - viewport.y) / viewport.zoom,
  };
}

export function positionFromPointer(pointer: Point, offset: Point): Point {
  return { x: pointer.x - offset.x, y: pointer.y - offset.y };
}

export function zoomAtPoint(viewport: Viewport, point: Point, zoom: number): Viewport {
  return {
    x: point.x - (point.x - viewport.x) * (zoom / viewport.zoom),
    y: point.y - (point.y - viewport.y) * (zoom / viewport.zoom),
    zoom,
  };
}
