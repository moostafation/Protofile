"""Piping Component File (PCF) export.

PCF is the de-facto neutral format for piping isometrics: ISOGEN and most
open/commercial isometric generators read it. One file is written per line.
Coordinates use X = East, Y = North, Z = Up in millimetres; bore is the DN.
"""

from __future__ import annotations

from ..catalog import default_catalog
from ..geom import Vec3
from ..model import ELBOW, FLANGE, GASKET, PIPE, TEE, VALVE, Component, Pipeline, Project

PCF_KEYWORD = {PIPE: "PIPE", ELBOW: "ELBOW", TEE: "TEE", FLANGE: "FLANGE", GASKET: "GASKET", VALVE: "VALVE"}


def _pt(keyword: str, p: Vec3, bore: float) -> str:
    return f"    {keyword:<14}{p.x:.4f} {p.y:.4f} {p.z:.4f} {bore:.4f}"


def item_code(c: Component, spec: str) -> str:
    extra = ""
    if c.kind == ELBOW:
        extra = f"-{c.props['angle']:g}"
    elif c.kind == VALVE:
        extra = f"-{c.props['valve_type'].upper()}"
    return f"{spec}-{c.kind}{extra}-{c.nps.replace('/', '_')}"


def line_to_pcf(project: Project, line: Pipeline) -> str:
    bore = float(default_catalog().dn(line.nps))
    out = [
        "ISOGEN-FILES ISOGEN.FLS",
        "UNITS-BORE MM",
        "UNITS-CO-ORDS MM",
        "UNITS-WEIGHT KGS",
        "UNITS-BOLT-DIA MM",
        "UNITS-BOLT-LENGTH MM",
        f"PIPELINE-REFERENCE {line.number}",
        f"    PROJECT-IDENTIFIER {project.name}",
        f"    AREA {project.area}" if project.area else None,
        f"    PIPING-SPEC {line.spec}",
    ]
    out = [o for o in out if o is not None]
    materials: dict[str, str] = {}
    prev_end: Vec3 | None = None
    for c in line.components:
        kw = PCF_KEYWORD.get(c.kind)
        if kw is None:
            continue
        out.append(kw)
        p_ports = [p for p in c.ports if p.name != "BR"]
        if prev_end is not None and p_ports[-1].position.isclose(prev_end, 0.05):
            p_ports.reverse()  # write END-POINTs in flow direction
        for p in p_ports:
            out.append(_pt("END-POINT", p.position, bore))
        prev_end = p_ports[-1].position
        if c.kind == ELBOW:
            out.append(_pt("CENTRE-POINT", c.props["vertex"], bore))
            out.append(f"    ANGLE {c.props['angle'] * 100:.0f}")
        elif c.kind == TEE:
            out.append(_pt("CENTRE-POINT", c.props["center"], bore))
            out.append(_pt("BRANCH1-POINT", c.port("BR").position, bore))
        if c.skey:
            out.append(f"    SKEY {c.skey}")
        out.append(f"    COMPONENT-IDENTIFIER {c.tag}")
        code = item_code(c, line.spec)
        materials[code] = c.description
        out.append(f"    ITEM-CODE {code}")
        if c.kind == PIPE:
            out.append(f"    WEIGHT {c.props['weight_kg']:.2f}")
    out.append("MATERIALS")
    for code, desc in materials.items():
        out.append(f"ITEM-CODE {code}")
        out.append(f"    DESCRIPTION {desc}")
    return "\n".join(out) + "\n"
