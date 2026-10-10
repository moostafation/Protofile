"""The plant model: equipment, nozzles, pipelines and their components.

Everything placed in the model is a :class:`Component` with ports (connection
points) and shapes (geometry primitives). Keeping a single representation lets
the clash checker, viewer, MTO and exporters treat pipes, fittings, valves and
equipment uniformly.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterator

from .geom import AABB, Cylinder, Primitive, Vec3, shapes_aabb

# Port end types
BW = "BW"  # butt-weld
FL = "FL"  # flange face

# Component kinds
PIPE = "PIPE"
ELBOW = "ELBOW"
TEE = "TEE"
FLANGE = "FLANGE"
GASKET = "GASKET"
VALVE = "VALVE"
NOZZLE = "NOZZLE"
EQUIPMENT = "EQUIPMENT"


@dataclass
class Port:
    name: str
    position: Vec3
    direction: Vec3  # unit vector pointing OUT of the component
    end: str  # BW or FL
    nps: str


@dataclass
class Component:
    tag: str
    kind: str
    nps: str
    ports: list[Port]
    shapes: list[Primitive]
    description: str = ""
    skey: str = ""
    props: dict = field(default_factory=dict)
    group: str = ""  # owning line number or equipment tag

    @property
    def uid(self) -> str:
        return f"{self.group}/{self.tag}"

    def port(self, name: str) -> Port:
        for p in self.ports:
            if p.name == name:
                return p
        raise KeyError(f"{self.uid} has no port {name!r}")

    def aabb(self) -> AABB | None:
        return shapes_aabb(self.shapes)


@dataclass
class Equipment:
    tag: str
    kind: str  # pump, vessel, exchanger, ... (free text, mapped to IFC classes on export)
    body: Component
    nozzles: dict[str, Component] = field(default_factory=dict)
    description: str = ""

    def components(self) -> list[Component]:
        return [self.body, *self.nozzles.values()]


@dataclass
class Pipeline:
    """One line number routed as a single run (branches are separate lines)."""

    number: str
    spec: str
    nps: str
    points: list[Vec3]
    components: list[Component] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    start_ref: str = ""  # e.g. "P-101A/N2" or "tee:T1"
    end_ref: str = ""
    fluid: str = ""

    def by_kind(self, kind: str) -> list[Component]:
        return [c for c in self.components if c.kind == kind]

    @property
    def pipe_length(self) -> float:
        return sum(c.props["length"] for c in self.by_kind(PIPE))


@dataclass
class Project:
    name: str
    plant: str = ""
    area: str = ""
    unit: str = ""
    equipment: dict[str, Equipment] = field(default_factory=dict)
    lines: dict[str, Pipeline] = field(default_factory=dict)

    def add_equipment(self, eq: Equipment) -> None:
        if eq.tag in self.equipment:
            raise ValueError(f"duplicate equipment tag {eq.tag}")
        self.equipment[eq.tag] = eq

    def add_line(self, line: Pipeline) -> None:
        if line.number in self.lines:
            raise ValueError(f"duplicate line number {line.number}")
        self.lines[line.number] = line

    def components(self) -> Iterator[Component]:
        for eq in self.equipment.values():
            yield from eq.components()
        for line in self.lines.values():
            yield from line.components

    def nozzle(self, ref: str) -> Component:
        """Look up ``"EQUIP-TAG/NOZZLE"``."""
        tag, _, name = ref.partition("/")
        try:
            return self.equipment[tag].nozzles[name]
        except KeyError:
            raise KeyError(f"unknown nozzle reference {ref!r} (expected EQUIPMENT/NOZZLE)") from None

    def find(self, uid: str) -> Component:
        for c in self.components():
            if c.uid == uid:
                return c
        raise KeyError(uid)


def make_equipment(
    tag: str,
    kind: str,
    shapes: list[Primitive],
    description: str = "",
) -> Equipment:
    body = Component(tag="BODY", kind=EQUIPMENT, nps="", ports=[], shapes=shapes, description=description, group=tag)
    return Equipment(tag=tag, kind=kind, body=body, description=description)


def add_nozzle(
    eq: Equipment,
    name: str,
    position: Vec3,
    direction: Vec3,
    nps: str,
    *,
    od: float,
    flange_od: float,
    flange_thickness: float,
    projection: float = 200.0,
    rating: str = "",
) -> Component:
    """Add a flanged nozzle. ``position`` is the flange face, ``direction`` points out of the equipment."""
    d = direction.normalized()
    base = position - d * projection
    neck_end = position - d * flange_thickness
    nozzle = Component(
        tag=name,
        kind=NOZZLE,
        nps=nps,
        ports=[Port("FACE", position, d, FL, nps)],
        shapes=[Cylinder(base, neck_end, od / 2), Cylinder(neck_end, position, flange_od / 2)],
        description=f"NOZZLE {name} NPS {nps} {rating}".strip(),
        props={"projection": projection, "rating": rating},
        group=eq.tag,
    )
    eq.nozzles[name] = nozzle
    return nozzle
