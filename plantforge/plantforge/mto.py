"""Material take-off (bill of materials) generated from the model."""

from __future__ import annotations

import csv
import io
from collections import OrderedDict
from dataclasses import dataclass

from .catalog import nps_value
from .connectivity import Connectivity, analyse
from .model import ELBOW, FLANGE, GASKET, PIPE, TEE, VALVE, Project

KIND_ORDER = [PIPE, ELBOW, TEE, FLANGE, GASKET, VALVE, "BOLTING"]


@dataclass
class MtoRow:
    kind: str
    nps: str
    description: str
    quantity: float
    unit: str
    weight_kg: float | None = None
    spec: str = ""


@dataclass
class Mto:
    rows: list[MtoRow]
    weld_count: int
    weld_inch_dia: float

    def to_csv(self) -> str:
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["Item", "Spec", "NPS", "Description", "Qty", "Unit", "Weight (kg)"])
        for n, r in enumerate(self.rows, 1):
            qty = f"{r.quantity:.2f}" if r.unit == "m" else f"{r.quantity:.0f}"
            weight = "" if r.weight_kg is None else f"{r.weight_kg:.1f}"
            w.writerow([n, r.spec, r.nps, r.description, qty, r.unit, weight])
        w.writerow([])
        w.writerow(["", "", "", "Butt welds", self.weld_count, "EA", ""])
        w.writerow(["", "", "", "Butt welds (inch-dia)", f"{self.weld_inch_dia:g}", "in-dia", ""])
        return buf.getvalue()

    def to_text(self) -> str:
        lines = [f"{'#':>3}  {'KIND':<8} {'NPS':>6}  {'QTY':>9} {'UNIT':<5} DESCRIPTION"]
        for n, r in enumerate(self.rows, 1):
            qty = f"{r.quantity:.2f}" if r.unit == "m" else f"{r.quantity:.0f}"
            lines.append(f"{n:>3}  {r.kind:<8} {r.nps:>6}  {qty:>9} {r.unit:<5} {r.description}")
        lines.append(f"     Butt welds: {self.weld_count}  ({self.weld_inch_dia:g} inch-dia)")
        return "\n".join(lines)


def material_takeoff(project: Project, lines: list[str] | None = None, conn: Connectivity | None = None) -> Mto:
    """Aggregate the model (or the given line numbers) into an MTO."""
    wanted = set(lines) if lines else set(project.lines)
    groups: "OrderedDict[tuple, MtoRow]" = OrderedDict()

    def add(kind, spec, nps, description, qty, unit, weight=None):
        key = (kind, spec, nps, description, unit)
        row = groups.get(key)
        if row is None:
            groups[key] = MtoRow(kind, nps, description, qty, unit, weight, spec)
        else:
            row.quantity += qty
            if weight is not None:
                row.weight_kg = (row.weight_kg or 0.0) + weight

    for number, line in project.lines.items():
        if number not in wanted:
            continue
        for c in line.components:
            if c.kind == PIPE:
                add(PIPE, line.spec, c.nps, c.description, c.props["length"] / 1000.0, "m", c.props["weight_kg"])
            elif c.kind in (ELBOW, TEE, FLANGE, GASKET, VALVE):
                add(c.kind, line.spec, c.nps, c.description, 1, "EA")
                if c.kind == GASKET:  # one bolt set per flanged joint
                    bolting = f"STUD BOLT SET {c.props['bolts']} x {c.props['bolt_dia']}\" DIA, LENGTH PER ASME B16.5"
                    add("BOLTING", line.spec, c.nps, bolting, 1, "SET")

    rows = sorted(groups.values(), key=lambda r: (KIND_ORDER.index(r.kind), nps_value(r.nps), r.description))
    conn = conn or analyse(project)
    welds = [
        j for j in conn.welds if j.a.group in wanted or j.b.group in wanted
    ]
    return Mto(rows=rows, weld_count=len(welds), weld_inch_dia=sum(nps_value(j.pa.nps) for j in welds))
