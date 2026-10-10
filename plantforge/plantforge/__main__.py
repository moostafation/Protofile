"""Command line: ``python -m plantforge build examples/demo_plant.toml -o out``."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from .clash import find_clashes
from .connectivity import analyse
from .geom import format_enu
from .mto import material_takeoff
from .project_io import ProjectError, load_project
from .spec import SpecError


def _safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name.replace('"', "in")).strip("_")


def _report(project, conn, clashes) -> str:
    out = [f"PlantForge check report - {project.name}", ""]
    out.append(f"Clashes ({len(clashes)}):")
    for c in clashes:
        kind = "HARD" if c.hard else f"CLEARANCE {c.distance:.0f} mm"
        out.append(f"  [{kind}] {c.a} <-> {c.b} near {format_enu(c.point)}")
    out.append("")
    out.append(f"Open ends ({len(conn.open_ports)}):")
    out += [f"  {c.uid}:{p.name} at {format_enu(p.position)}" for c, p in conn.open_ports]
    out.append("")
    warnings = [w for line in project.lines.values() for w in line.warnings] + conn.problems
    out.append(f"Warnings ({len(warnings)}):")
    out += [f"  {w}" for w in warnings]
    return "\n".join(out) + "\n"


def cmd_build(args) -> int:
    project = load_project(args.model)
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    conn = analyse(project)
    clashes = find_clashes(project, clearance=args.clearance, conn=conn)
    mto = material_takeoff(project, conn=conn)
    written = []

    from .export.pcf import line_to_pcf
    from .export.viewer import write_viewer

    written.append(write_viewer(project, out / "model.html", conn=conn, clashes=clashes, mto=mto))
    (out / "mto.csv").write_text(mto.to_csv(), encoding="utf-8")
    written.append(out / "mto.csv")
    for number, line in project.lines.items():
        path = out / "pcf" / f"{_safe(number)}.pcf"
        path.parent.mkdir(exist_ok=True)
        path.write_text(line_to_pcf(project, line), encoding="utf-8")
        written.append(path)
    (out / "report.txt").write_text(_report(project, conn, clashes), encoding="utf-8")
    written.append(out / "report.txt")

    if not args.no_ifc:
        try:
            from .export.ifc import export_ifc

            written.append(export_ifc(project, out / "model.ifc", conn=conn))
        except ImportError as exc:
            print(f"note: IFC skipped ({exc})", file=sys.stderr)
    if not args.no_iso:
        try:
            from .export.iso import write_isometrics

            written += write_isometrics(project, out / "iso")
        except ImportError as exc:
            print(f"note: isometric DXF skipped ({exc})", file=sys.stderr)

    print(mto.to_text())
    print()
    print(_report(project, conn, clashes))
    print("Written:")
    for w in written:
        print(f"  {w}")
    return 2 if (args.fail_on_clash and any(c.hard for c in clashes)) else 0


def cmd_check(args) -> int:
    project = load_project(args.model)
    conn = analyse(project)
    clashes = find_clashes(project, clearance=args.clearance, conn=conn)
    print(_report(project, conn, clashes))
    return 2 if any(c.hard for c in clashes) or conn.problems else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="plantforge", description="Spec-driven plant & piping design engine")
    sub = parser.add_subparsers(dest="command", required=True)

    b = sub.add_parser("build", help="route the model and write viewer, MTO, PCF, IFC and isometrics")
    b.add_argument("model", help="project TOML file")
    b.add_argument("-o", "--output", default="out", help="output folder (default: out)")
    b.add_argument("--clearance", type=float, default=0.0, help="also report items closer than this (mm)")
    b.add_argument("--no-ifc", action="store_true", help="skip IFC export")
    b.add_argument("--no-iso", action="store_true", help="skip isometric DXF export")
    b.add_argument("--fail-on-clash", action="store_true", help="exit with code 2 when hard clashes exist")
    b.set_defaults(func=cmd_build)

    c = sub.add_parser("check", help="route the model and report clashes, open ends and warnings")
    c.add_argument("model")
    c.add_argument("--clearance", type=float, default=0.0)
    c.set_defaults(func=cmd_check)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (ProjectError, SpecError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
