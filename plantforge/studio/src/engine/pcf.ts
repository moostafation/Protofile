// Piping Component File (PCF), one per line: the neutral input for ISOGEN and other isometric tools.

import { catalog } from "./catalog";
import type { LineResult, Model } from "./compute";
import type { Comp } from "./model";
import { V3, isClose } from "./vec";

const KW: Record<string, string> = { PIPE: "PIPE", ELBOW: "ELBOW", TEE: "TEE", FLANGE: "FLANGE", GASKET: "GASKET", VALVE: "VALVE" };

const pt = (kw: string, p: V3, bore: number) => `    ${kw.padEnd(14)}${p[0].toFixed(4)} ${p[1].toFixed(4)} ${p[2].toFixed(4)} ${bore.toFixed(4)}`;

export function itemCode(c: Comp, spec: string): string {
  const extra = c.kind === "ELBOW" ? `-${c.props.angle}` : c.kind === "VALVE" ? `-${String(c.props.valveType).toUpperCase()}` : "";
  return `${spec}-${c.kind}${extra}-${c.nps.replace("/", "_")}`;
}

export function linePcf(model: Model, line: LineResult): string {
  const bore = catalog.dn(line.doc.nps);
  const p = model.doc.project;
  const out = [
    "ISOGEN-FILES ISOGEN.FLS",
    "UNITS-BORE MM",
    "UNITS-CO-ORDS MM",
    "UNITS-WEIGHT KGS",
    "UNITS-BOLT-DIA MM",
    "UNITS-BOLT-LENGTH MM",
    `PIPELINE-REFERENCE ${line.doc.number}`,
    `    PROJECT-IDENTIFIER ${p.name}`,
    ...(p.area ? [`    AREA ${p.area}`] : []),
    `    PIPING-SPEC ${line.doc.spec}`,
  ];
  const materials = new Map<string, string>();
  let prev: V3 | null = null;
  for (const c of line.comps) {
    if (c.kind === "SUPPORT") {
      out.push("SUPPORT", pt("CO-ORDS", c.props.at, bore), `    SKEY 01HG`, `    COMPONENT-IDENTIFIER ${c.tag}`);
      continue;
    }
    const kw = KW[c.kind];
    if (!kw) continue;
    out.push(kw);
    const ports = c.ports.filter((x) => x.name !== "BR");
    if (prev && isClose(ports[ports.length - 1].pos, prev, 0.05)) ports.reverse();
    for (const x of ports) out.push(pt("END-POINT", x.pos, bore));
    prev = ports[ports.length - 1].pos;
    if (c.kind === "ELBOW") out.push(pt("CENTRE-POINT", c.props.vertex, bore), `    ANGLE ${Math.round(c.props.angle * 100)}`);
    if (c.kind === "TEE") out.push(pt("CENTRE-POINT", c.props.center, bore), pt("BRANCH1-POINT", c.ports[2].pos, bore));
    if (c.skey) out.push(`    SKEY ${c.skey}`);
    out.push(`    COMPONENT-IDENTIFIER ${c.tag}`);
    const code = itemCode(c, line.doc.spec);
    materials.set(code, c.desc);
    out.push(`    ITEM-CODE ${code}`);
    if (c.kind === "PIPE") out.push(`    WEIGHT ${c.props.weight.toFixed(2)}`);
  }
  out.push("MATERIALS");
  for (const [code, desc] of materials) out.push(`ITEM-CODE ${code}`, `    DESCRIPTION ${desc}`);
  return out.join("\n") + "\n";
}
