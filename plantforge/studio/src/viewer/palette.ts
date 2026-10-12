// Colours and finishes of the 3D view, close to a plant design system's representation rules:
// pipes coloured per line, valves red, steel in structural orange, equipment in painted greys and blues,
// concrete, yellow handrails and guards.

import * as THREE from "three";

/** Pipe colours (by line). */
export const LINE_COLORS = ["#e8be2f", "#36a852", "#2f8ad8", "#e0762a", "#1fb0a3", "#9a62d4", "#d9476a", "#93ba26"];

export interface FinishDef {
  color: string;
  metalness?: number;
  roughness?: number;
}

export const FINISHES: Record<string, FinishDef> = {
  // equipment
  shell: { color: "#a9b8c7", metalness: 0.25, roughness: 0.5 },
  skirt: { color: "#8f9ba7", metalness: 0.2, roughness: 0.6 },
  channel: { color: "#8b9db0", metalness: 0.3, roughness: 0.45 },
  saddle: { color: "#6e7883", metalness: 0.25, roughness: 0.6 },
  tankshell: { color: "#d6dbe0", metalness: 0.15, roughness: 0.55 },
  roof: { color: "#9ea7b0", metalness: 0.2, roughness: 0.6 },
  seam: { color: "#b9c1c8", metalness: 0.2, roughness: 0.6 },
  nozzle: { color: "#97a8b9", metalness: 0.35, roughness: 0.45 },
  casing: { color: "#2d68a6", metalness: 0.35, roughness: 0.4 },
  motor: { color: "#3f7d61", metalness: 0.3, roughness: 0.45 },
  base: { color: "#4a5158", metalness: 0.3, roughness: 0.55 },
  guard: { color: "#e5b020", metalness: 0.2, roughness: 0.5 },
  // structures and access
  steel: { color: "#c0662a", metalness: 0.2, roughness: 0.55 },
  ibeam: { color: "#c0662a", metalness: 0.2, roughness: 0.55 },
  grating: { color: "#7a838b", metalness: 0.35, roughness: 0.75 },
  rail: { color: "#e6b82a", metalness: 0.2, roughness: 0.5 },
  concrete: { color: "#a9a59c", metalness: 0, roughness: 0.95 },
  concrete8: { color: "#a9a59c", metalness: 0, roughness: 0.95 },
  // piping
  bolt: { color: "#3c4046", metalness: 0.75, roughness: 0.32 },
  nut: { color: "#4a4f56", metalness: 0.75, roughness: 0.32 },
  gasket: { color: "#25282b", metalness: 0.1, roughness: 0.8 },
  valve: { color: "#b9302a", metalness: 0.35, roughness: 0.4 },
  wheel: { color: "#d8392d", metalness: 0.3, roughness: 0.45 },
  support: { color: "#5d6771", metalness: 0.3, roughness: 0.55 },
};

export const STATUS_COLORS: Record<string, string> = { Working: "#8e9aa6", "In Review": "#e8a317", Approved: "#2fb36a", Rejected: "#e0483f" };

/** E3D-like backgrounds: graduated navy (default), black, light grey. */
export type Background = "navy" | "black" | "light";

export function backgroundTexture(kind: Background): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 512;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, 512);
  if (kind === "navy") {
    grad.addColorStop(0, "#43597a");
    grad.addColorStop(0.55, "#1c2a3d");
    grad.addColorStop(1, "#070b11");
  } else if (kind === "black") {
    grad.addColorStop(0, "#14181d");
    grad.addColorStop(1, "#000000");
  } else {
    grad.addColorStop(0, "#f4f6f8");
    grad.addColorStop(1, "#c3ccd5");
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 512);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
