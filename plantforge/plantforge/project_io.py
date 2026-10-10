"""Load a plant model from a human-editable TOML file.

See ``examples/demo_plant.toml`` for the format. Lines may start or end at an
equipment nozzle (``"P-101A/N2"``) or start at a tee on another line
(``"tee:T1"``); the router then checks that the route leaves in the right
direction and adds the gasket/flange or weld automatically.
"""

from __future__ import annotations

import tomllib
from pathlib import Path

from .catalog import CatalogError, default_catalog, normalize_nps
from .geom import Box, Cylinder, Vec3, vec
from .model import TEE, Component, Project, add_nozzle, make_equipment
from .routing import End, Inline, RoutingError, route_line
from .spec import PipingSpec, load_spec


class ProjectError(ValueError):
    pass


def load_project(path: str | Path) -> Project:
    path = Path(path)
    with open(path, "rb") as fh:
        data = tomllib.load(fh)
    return build_project(data, base_dir=path.parent)


def build_project(data: dict, base_dir: Path | None = None) -> Project:
    meta = data.get("project", {})
    project = Project(
        name=meta.get("name", "Untitled"),
        plant=meta.get("plant", ""),
        area=meta.get("area", ""),
        unit=meta.get("unit", ""),
    )
    catalog = default_catalog()
    specs: dict[str, PipingSpec] = {}

    def spec_for(name: str) -> PipingSpec:
        if name not in specs:
            candidate = (base_dir / f"{name}.toml") if base_dir else None
            specs[name] = load_spec(str(candidate) if candidate and candidate.exists() else name, catalog)
        return specs[name]

    for eq in data.get("equipment", []):
        _load_equipment(project, eq, catalog)

    pending = list(data.get("lines", []))
    tees: dict[str, Component] = {}
    # Lines that branch off a tee must be routed after the line that owns the tee.
    while pending:
        progressed = False
        for raw in list(pending):
            ref = raw.get("from", "")
            if ref.startswith("tee:") and ref[4:] not in tees:
                continue
            line = _route(project, raw, spec_for, tees)
            project.add_line(line)
            for c in line.components:
                if c.kind == TEE:
                    if c.tag in tees:
                        raise ProjectError(f"tee id {c.tag!r} is used on more than one line")
                    tees[c.tag] = c
            pending.remove(raw)
            progressed = True
        if not progressed:
            missing = ", ".join(sorted({r["from"] for r in pending}))
            raise ProjectError(f"unresolved tee references: {missing}")
    return project


def _load_equipment(project: Project, eq: dict, catalog) -> None:
    tag = eq["tag"]
    shapes = []
    for s in eq.get("shapes", []):
        kind = s.get("type")
        if kind == "box":
            shapes.append(Box(vec(s["min"]), vec(s["max"])))
        elif kind == "cylinder":
            shapes.append(Cylinder(vec(s["a"]), vec(s["b"]), float(s["diameter"]) / 2))
        else:
            raise ProjectError(f"{tag}: unknown shape type {kind!r} (use box or cylinder)")
    equipment = make_equipment(tag, eq.get("kind", "equipment"), shapes, eq.get("description", ""))
    rating = eq.get("rating", "CL150")
    for n in eq.get("nozzles", []):
        try:
            nps = normalize_nps(n["nps"])
            fl = catalog.flange(nps, n.get("rating", rating))
            add_nozzle(
                equipment,
                n["name"],
                vec(n["position"]),
                vec(n["direction"]),
                nps,
                od=catalog.od(nps),
                flange_od=fl.o,
                flange_thickness=fl.tf + fl.rf_height,
                projection=float(n.get("projection", 200.0)),
                rating=fl.rating,
            )
        except CatalogError as exc:
            raise ProjectError(f"{tag}/{n.get('name')}: {exc}") from None
    project.add_equipment(equipment)


def _route(project: Project, raw: dict, spec_for, tees: dict[str, Component]):
    number = raw["number"]
    spec = spec_for(raw["spec"])
    nps = normalize_nps(raw["nps"])
    points: list[Vec3] = [vec(p) for p in raw.get("points", [])]
    start, end = End(raw.get("start", "open")), End(raw.get("end", "open"))
    start_dir = end_dir = None
    start_ref, end_ref = raw.get("from", ""), raw.get("to", "")

    if start_ref:
        port, start = _resolve(project, start_ref, tees, number)
        if port.nps != nps:
            raise ProjectError(f"{number}: line is NPS {nps} but {start_ref} is NPS {port.nps} (reducers are not supported yet)")
        points.insert(0, port.position)
        start_dir = port.direction
    if end_ref:
        if end_ref.startswith("tee:"):
            raise ProjectError(f"{number}: a line can only start at a tee branch")
        port, end = _resolve(project, end_ref, tees, number)
        if port.nps != nps:
            raise ProjectError(f"{number}: line is NPS {nps} but {end_ref} is NPS {port.nps} (reducers are not supported yet)")
        points.append(port.position)
        end_dir = -port.direction

    inline = [
        Inline(
            type=i["type"],
            leg=int(i["leg"]),
            station=float(i["station"]),
            id=i.get("id", ""),
            branch=i.get("branch"),
            stem=i.get("stem"),
        )
        for i in raw.get("inline", [])
    ]
    try:
        return route_line(
            spec,
            number,
            nps,
            points,
            start=start,
            end=end,
            inline=inline,
            start_dir=start_dir,
            end_dir=end_dir,
            start_ref=start_ref,
            end_ref=end_ref,
            fluid=raw.get("fluid", ""),
        )
    except RoutingError as exc:
        raise ProjectError(str(exc)) from None


def _resolve(project: Project, ref: str, tees: dict[str, Component], number: str):
    if ref.startswith("tee:"):
        tee = tees[ref[4:]]
        return tee.port("BR"), End.BUTTWELD
    try:
        return project.nozzle(ref).port("FACE"), End.NOZZLE
    except KeyError as exc:
        raise ProjectError(f"{number}: {exc.args[0]}") from None
