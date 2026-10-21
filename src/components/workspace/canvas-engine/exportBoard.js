// Board export: PNG, single-page PDF and canvas JSON.

import { objectBounds } from "@/shared/canvasOps";
import { useBoard, boardRefs } from "@/state/board";

export function boardBounds(objects) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const obj of objects.values()) {
    const b = objectBounds(obj);
    if (!b) continue;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  if (!isFinite(minX)) return { x: 0, y: 0, w: 800, h: 600 };
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function slug(name) {
  return (
    String(name || "board")
      .normalize("NFKD")
      .replace(/[^\w.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "board"
  );
}

export async function renderBoardCanvas(scale = 2) {
  const renderer = boardRefs.renderer;
  if (!renderer) throw new Error("The board is not ready yet");
  const objects = useBoard.getState().objects;
  const arr = [...objects.values()];
  if (!arr.length) throw new Error("Add something to the board first");
  await renderer.preloadImages(arr);
  return renderer.snapshot(arr, boardBounds(objects), scale);
}

export async function exportBoardPNG(name) {
  const canvas = await renderBoardCanvas(2);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not encode the image");
  downloadBlob(blob, `${slug(name)}.png`);
}

export async function exportBoardPDF(name) {
  const canvas = await renderBoardCanvas(2);
  const jpegUrl = canvas.toDataURL("image/jpeg", 0.92);
  const base64 = jpegUrl.slice(jpegUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const jpeg = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) jpeg[i] = binary.charCodeAt(i);
  const pdf = buildPdf(jpeg, canvas.width, canvas.height);
  downloadBlob(new Blob([pdf], { type: "application/pdf" }), `${slug(name)}.pdf`);
}

export function exportBoardJSON(name) {
  const state = useBoard.getState();
  const objects = [...state.objects.values()].map((o) => ({
    id: o.id,
    type: o.type,
    z: o.z,
    payload: o.payload,
  }));
  const json = JSON.stringify(
    {
      format: "infinite-workspace.canvas",
      version: 1,
      boardVersion: state.lastVersion,
      exportedAt: new Date().toISOString(),
      objects,
    },
    null,
    2
  );
  downloadBlob(new Blob([json], { type: "application/json" }), `${slug(name)}.canvas.json`);
}

// Minimal single-page PDF that embeds a JPEG using DCTDecode.
function buildPdf(jpeg, width, height) {
  const enc = new TextEncoder();
  const chunks = [];
  let length = 0;
  const push = (data) => {
    const bytes = typeof data === "string" ? enc.encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  const offsets = [0];
  const startObj = (n) => {
    offsets[n] = length;
    push(`${n} 0 obj\n`);
  };
  const endObj = () => push("endobj\n");

  push("%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n");

  startObj(1);
  push("<< /Type /Catalog /Pages 2 0 R >>\n");
  endObj();

  startObj(2);
  push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>\n");
  endObj();

  startObj(3);
  push(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
      `/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>\n`
  );
  endObj();

  const content = `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`;
  startObj(4);
  push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\n`);
  endObj();

  startObj(5);
  push(
    `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`
  );
  push(jpeg);
  push("\nendstream\n");
  endObj();

  const xref = length;
  let table = "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) table += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
