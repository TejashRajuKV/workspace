// World ↔ screen coordinate conversion. The camera defines which slice of
// the (practically unbounded) world plane is visible:
//   screenX = (worldX - cameraX) * zoom
//   worldX  = screenX / zoom + cameraX

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 8;

export function worldToScreen(cam, wx, wy) {
  return { x: (wx - cam.x) * cam.zoom, y: (wy - cam.y) * cam.zoom };
}

export function screenToWorld(cam, sx, sy) {
  return { x: sx / cam.zoom + cam.x, y: sy / cam.zoom + cam.y };
}

// Zoom keeping the world point under the cursor anchored in place.
export function zoomCameraAt(cam, sx, sy, factor) {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.zoom * factor));
  const world = screenToWorld(cam, sx, sy);
  return { zoom, x: world.x - sx / zoom, y: world.y - sy / zoom };
}

export function panCamera(cam, dxScreen, dyScreen) {
  return { ...cam, x: cam.x - dxScreen / cam.zoom, y: cam.y - dyScreen / cam.zoom };
}
