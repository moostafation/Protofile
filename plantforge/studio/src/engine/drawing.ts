// 2D drawing model shared by the SVG renderer (on screen / download) and the DXF writer (AutoCAD).

export type P2 = readonly [number, number];

export type Prim =
  | { t: "line"; a: P2; b: P2; layer: string; w?: number }
  | { t: "poly"; pts: P2[]; layer: string; closed?: boolean; fill?: boolean; w?: number }
  | { t: "circle"; c: P2; r: number; layer: string; fill?: boolean }
  | { t: "text"; p: P2; s: string; h: number; layer: string; rot?: number; anchor?: "start" | "middle" | "end"; bold?: boolean };

export interface Drawing {
  title: string;
  width: number;
  height: number;
  prims: Prim[];
}

export const LAYERS: Record<string, { dxf: number; css: string }> = {
  PIPE: { dxf: 7, css: "iso-pipe" },
  SYMBOL: { dxf: 1, css: "iso-sym" },
  DIM: { dxf: 3, css: "iso-dim" },
  TEXT: { dxf: 7, css: "iso-txt" },
  FRAME: { dxf: 8, css: "iso-frame" },
  WELD: { dxf: 2, css: "iso-weld" },
  SUPPORT: { dxf: 4, css: "iso-sup" },
  NOTE: { dxf: 5, css: "iso-note" },
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** SVG with layer classes. `standalone` embeds paper colours for a file download. */
export function toSvg(d: Drawing, standalone = false): string {
  const H = d.height;
  const y = (v: number) => (H - v).toFixed(2);
  const parts: string[] = [];
  for (const p of d.prims) {
    const cls = LAYERS[p.layer]?.css ?? "iso-txt";
    if (p.t === "line") parts.push(`<line class="${cls}" x1="${p.a[0].toFixed(2)}" y1="${y(p.a[1])}" x2="${p.b[0].toFixed(2)}" y2="${y(p.b[1])}"${p.w ? ` stroke-width="${p.w}"` : ""}/>`);
    else if (p.t === "poly")
      parts.push(
        `<${p.closed || p.fill ? "polygon" : "polyline"} class="${cls}${p.fill ? " iso-fill" : ""}" points="${p.pts.map((q) => `${q[0].toFixed(2)},${y(q[1])}`).join(" ")}"${p.w ? ` stroke-width="${p.w}"` : ""}/>`,
      );
    else if (p.t === "circle") parts.push(`<circle class="${cls}${p.fill ? " iso-fill" : ""}" cx="${p.c[0].toFixed(2)}" cy="${y(p.c[1])}" r="${p.r}"/>`);
    else {
      const rot = p.rot ? ` transform="rotate(${(-p.rot).toFixed(2)} ${p.p[0].toFixed(2)} ${y(p.p[1])})"` : "";
      parts.push(
        `<text class="${cls}" x="${p.p[0].toFixed(2)}" y="${y(p.p[1])}" font-size="${p.h}" text-anchor="${p.anchor ?? "start"}"${p.bold ? ' font-weight="600"' : ""}${rot}>${esc(p.s)}</text>`,
      );
    }
  }
  const style = standalone
    ? `<style>line,polyline,polygon,circle{stroke:#111;fill:none;stroke-width:.25;stroke-linecap:round;stroke-linejoin:round}.iso-fill{fill:#111}.iso-pipe{stroke-width:.7}.iso-dim{stroke:#2a5d8f}.iso-frame{stroke:#555}.iso-sup{stroke:#1f6f5c}text{font-family:'IBM Plex Mono',Consolas,monospace;fill:#111;stroke:none!important}text.iso-dim{fill:#2a5d8f}text.iso-note{fill:#8a3b12}text.iso-sup{fill:#1f6f5c}</style><rect width="${d.width}" height="${d.height}" fill="#fff"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${d.width} ${d.height}" class="iso-sheet">${style}${parts.join("")}</svg>`;
}

/** Minimal AutoCAD R12 DXF (opens in AutoCAD, BricsCAD, LibreCAD, ezdxf). */
export function toDxf(d: Drawing): string {
  const o: (string | number)[] = [];
  const g = (code: number, v: string | number) => o.push(code, typeof v === "number" ? Number(v.toFixed(4)) : v);
  g(0, "SECTION"), g(2, "HEADER"), g(9, "$ACADVER"), g(1, "AC1009"), g(9, "$INSUNITS"), g(70, 4), g(0, "ENDSEC");
  g(0, "SECTION"), g(2, "TABLES"), g(0, "TABLE"), g(2, "LAYER"), g(70, Object.keys(LAYERS).length);
  for (const [name, l] of Object.entries(LAYERS)) g(0, "LAYER"), g(2, name), g(70, 0), g(62, l.dxf), g(6, "CONTINUOUS");
  g(0, "ENDTAB"), g(0, "ENDSEC");
  g(0, "SECTION"), g(2, "ENTITIES");
  for (const p of d.prims) {
    if (p.t === "line") g(0, "LINE"), g(8, p.layer), g(10, p.a[0]), g(20, p.a[1]), g(30, 0), g(11, p.b[0]), g(21, p.b[1]), g(31, 0);
    else if (p.t === "circle") g(0, "CIRCLE"), g(8, p.layer), g(10, p.c[0]), g(20, p.c[1]), g(30, 0), g(40, p.r);
    else if (p.t === "poly") {
      if (p.fill && p.pts.length >= 3 && p.pts.length <= 4) {
        const q = p.pts.length === 3 ? [p.pts[0], p.pts[1], p.pts[2], p.pts[2]] : [p.pts[0], p.pts[1], p.pts[3], p.pts[2]];
        g(0, "SOLID"), g(8, p.layer);
        q.forEach((v, i) => (g(10 + i, v[0]), g(20 + i, v[1]), g(30 + i, 0)));
      } else {
        g(0, "POLYLINE"), g(8, p.layer), g(66, 1), g(70, p.closed ? 1 : 0), g(10, 0), g(20, 0), g(30, 0);
        for (const v of p.pts) g(0, "VERTEX"), g(8, p.layer), g(10, v[0]), g(20, v[1]), g(30, 0);
        g(0, "SEQEND"), g(8, p.layer);
      }
    } else {
      const h = { start: 0, middle: 1, end: 2 }[p.anchor ?? "start"];
      g(0, "TEXT"), g(8, p.layer), g(10, p.p[0]), g(20, p.p[1]), g(30, 0), g(40, p.h), g(1, p.s), g(50, p.rot ?? 0);
      if (h) g(72, h), g(11, p.p[0]), g(21, p.p[1]), g(31, 0);
    }
  }
  g(0, "ENDSEC"), g(0, "EOF");
  const lines: string[] = [];
  for (let i = 0; i < o.length; i += 2) lines.push(String(o[i]).padStart(3, " "), String(o[i + 1]));
  return lines.join("\r\n") + "\r\n";
}
