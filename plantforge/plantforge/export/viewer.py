"""Self-contained HTML 3D model-review page (three.js, loaded from a CDN)."""

from __future__ import annotations

import json
from pathlib import Path

from ..catalog import default_catalog
from ..clash import Clash, find_clashes
from ..connectivity import Connectivity, analyse
from ..geom import Box, Cylinder, Frustum, Sphere, TorusArc, format_enu
from ..model import ELBOW, EQUIPMENT, FLANGE, GASKET, NOZZLE, PIPE, TEE, VALVE, Component, Project
from ..mto import Mto, material_takeoff

TEMPLATE = Path(__file__).with_name("viewer_template.html")
M = 0.001  # the viewer works in metres


def _m(v) -> list[float]:
    return [round(c * M, 4) for c in v]


def _shape(s) -> dict:
    if isinstance(s, Cylinder):
        return {"t": "cyl", "a": _m(s.a), "b": _m(s.b), "r": round(s.radius * M, 4)}
    if isinstance(s, Frustum):
        return {"t": "fru", "a": _m(s.a), "b": _m(s.b), "ra": round(s.ra * M, 4), "rb": round(s.rb * M, 4)}
    if isinstance(s, Box):
        return {"t": "box", "lo": _m(s.lo), "hi": _m(s.hi)}
    if isinstance(s, TorusArc):
        closed = s.angle >= 6.283
        pts = s.centerline(24 if closed else 12)
        if closed:
            pts = pts[:-1]
        return {"t": "tor", "pts": [_m(p) for p in pts], "r": round(s.radius * M, 4), "closed": closed}
    if isinstance(s, Sphere):
        return {"t": "sph", "c": _m(s.center), "r": round(s.radius * M, 4)}
    raise TypeError(type(s))


def _display(c: Component, spec: str) -> list[list[str]]:
    p = c.props
    rows: list[list[str]] = []
    if c.nps:
        rows.append(["Size", f'NPS {c.nps}" (DN {default_catalog().dn(c.nps)})'])
    if spec:
        rows.append(["Spec", spec])
    if c.kind == PIPE:
        rows += [
            ["Length", f"{p['length']:.0f} mm"],
            ["Schedule", p["schedule"]],
            ["OD x wall", f"{p['od']:g} x {p['wall']:g} mm"],
            ["Weight", f"{p['weight_kg']:.1f} kg"],
        ]
    elif c.kind == ELBOW:
        rows += [
            ["Type", p["variant"]],
            ["Angle", f"{p['angle']:g} deg"],
            ["Centre to end", f"{p['center_to_end']:.1f} mm"],
            ["Bend radius", f"{p['bend_radius']:.1f} mm"],
            ["Intersection", format_enu(p["vertex"])],
        ]
    elif c.kind == TEE:
        rows += [["Centre to end", f"{p['center_to_end']:g} mm"], ["Centre", format_enu(p["center"])]]
    elif c.kind == FLANGE:
        rows += [["Rating", p["rating"]], ["Face to weld end", f"{p['length']:.1f} mm"]]
    elif c.kind == GASKET:
        rows += [["Thickness", f"{p['thickness']:g} mm"], ["Bolting", f"{p['bolts']} x {p['bolt_dia']}\" studs"]]
    elif c.kind == VALVE:
        stem = p["stem"]
        rows += [
            ["Valve type", p["valve_type"]],
            ["Face to face", f"{p['face_to_face']:g} mm"],
            ["Rating", p["rating"]],
            ["Stem direction", f"({stem.x:g}, {stem.y:g}, {stem.z:g})"],
        ]
    elif c.kind == NOZZLE:
        rows += [["Rating", p.get("rating", "")], ["Projection", f"{p.get('projection', 0):g} mm"]]
    if c.skey:
        rows.append(["SKEY", c.skey])
    return rows


def build_viewer_data(
    project: Project,
    conn: Connectivity | None = None,
    clashes: list[Clash] | None = None,
    mto: Mto | None = None,
) -> dict:
    conn = conn or analyse(project)
    clashes = find_clashes(project, conn=conn) if clashes is None else clashes
    mto = mto or material_takeoff(project, conn=conn)

    components = []
    for eq in project.equipment.values():
        for c in eq.components():
            components.append(
                {
                    "uid": c.uid,
                    "tag": c.tag,
                    "kind": c.kind,
                    "line": "",
                    "description": c.description or eq.description or eq.kind,
                    "display": [["Equipment", eq.tag], ["Kind", eq.kind]] + _display(c, "")
                    if c.kind == EQUIPMENT
                    else _display(c, ""),
                    "ports": [{"name": p.name, "end": p.end, "at": format_enu(p.position)} for p in c.ports],
                    "shapes": [_shape(s) for s in c.shapes],
                }
            )
    for line in project.lines.values():
        for c in line.components:
            components.append(
                {
                    "uid": c.uid,
                    "tag": c.tag,
                    "kind": c.kind,
                    "line": line.number,
                    "description": c.description,
                    "display": [["Line", line.number]] + _display(c, line.spec),
                    "ports": [{"name": p.name, "end": p.end, "at": format_enu(p.position)} for p in c.ports],
                    "shapes": [_shape(s) for s in c.shapes],
                }
            )

    pipe_kg = sum(c.props["weight_kg"] for line in project.lines.values() for c in line.by_kind(PIPE))
    warnings = [w for line in project.lines.values() for w in line.warnings]
    return {
        "project": {"name": project.name, "plant": project.plant, "area": project.area, "unit": project.unit},
        "stats": {
            "lines": len(project.lines),
            "components": len(components),
            "welds": len(conn.welds),
            "inch_dia": round(conn.weld_inch_dia, 1),
            "pipe_m": sum(line.pipe_length for line in project.lines.values()) / 1000.0,
            "pipe_kg": pipe_kg,
        },
        "lines": [
            {
                "number": line.number,
                "spec": line.spec,
                "nps": line.nps,
                "fluid": line.fluid,
                "from": line.start_ref,
                "to": line.end_ref,
                "length_m": line.pipe_length / 1000.0,
                "components": [c.uid for c in line.components],
            }
            for line in project.lines.values()
        ],
        "equipment": [
            {
                "tag": eq.tag,
                "kind": eq.kind,
                "description": eq.description,
                "body": eq.body.uid,
                "components": [c.uid for c in eq.components()],
            }
            for eq in project.equipment.values()
        ],
        "components": components,
        "clashes": [
            {
                "a": c.a,
                "b": c.b,
                "distance": c.distance,
                "hard": c.hard,
                "point": _m(c.point),
                "at": format_enu(c.point),
            }
            for c in clashes
        ],
        "mto": [
            {"kind": r.kind, "nps": r.nps, "qty": r.quantity, "unit": r.unit, "description": r.description}
            for r in mto.rows
        ],
        "checks": {
            "problems": conn.problems,
            "warnings": warnings,
            "open_ends": [{"uid": c.uid, "port": p.name, "at": format_enu(p.position)} for c, p in conn.open_ports],
        },
    }


def render_viewer(project: Project, *, standalone: bool = True, title: str | None = None, **kwargs) -> str:
    """Return the review page. ``standalone`` adds the document wrapper for opening the file directly."""
    data = json.dumps(build_viewer_data(project, **kwargs), separators=(",", ":"))
    data = data.replace("</", "<\\/")  # keep the JSON from closing its <script> element
    title = title or f"{project.name} Model Review"
    page = TEMPLATE.read_text(encoding="utf-8")
    page = page.replace("__PF_TITLE__", _html_escape(title)).replace("__PF_DATA__", data)
    if standalone:
        page = (
            '<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
            f"{page}\n</html>\n"
        )
    return page


def write_viewer(project: Project, path: str | Path, **kwargs) -> Path:
    out = Path(path)
    out.write_text(render_viewer(project, **kwargs), encoding="utf-8")
    return out


def _html_escape(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
