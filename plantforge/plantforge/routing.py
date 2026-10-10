"""Spec-driven pipe routing.

Given a polyline of centre-line points, the router places elbows at every turn,
end assemblies (flanges, gaskets) at the ends, inline items (valves, tees) at
requested stations, and fills the remaining gaps with pipe - all sized from the
piping spec and catalog. Anything that does not fit raises :class:`RoutingError`
with a message a designer can act on.
"""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Iterable, Sequence

from .catalog import CatalogError, normalize_nps
from .geom import Vec3, Z_AXIS, X_AXIS, angle_between, format_enu, vec
from .model import Component, Pipeline
from .parts import make_elbow, make_flange, make_gasket, make_pipe, make_tee, make_valve
from .spec import PipingSpec, SpecError

TOL = 0.5  # mm: positional tolerance for fits and overlaps
COLLINEAR = 1e-7  # rad: legs closer than this to straight are merged
MIN_TURN = 1.0  # deg: smaller turns are rejected rather than given a sliver elbow
VALVE_TYPES = ("gate", "globe", "check")


class RoutingError(ValueError):
    pass


class End(str, Enum):
    OPEN = "open"  # plain pipe end at the point
    BUTTWELD = "buttweld"  # pipe welds to a fitting at the point (e.g. a tee branch)
    FLANGED = "flanged"  # weld-neck flange whose face is at the point
    NOZZLE = "nozzle"  # gasket + weld-neck flange mating an equipment nozzle face at the point


@dataclass
class Inline:
    """An item placed on a leg. ``station`` is the distance from the leg start to the item centre."""

    type: str  # gate | globe | check | tee
    leg: int
    station: float
    id: str = ""
    branch: Sequence[float] | None = None  # tee branch direction
    stem: Sequence[float] | None = None  # valve stem direction


@dataclass
class _Leg:
    start: Vec3
    end: Vec3

    @property
    def length(self) -> float:
        return (self.end - self.start).length()

    @property
    def d(self) -> Vec3:
        return (self.end - self.start).normalized()

    def at(self, s: float) -> Vec3:
        return self.start + self.d * s


@dataclass
class _Slot:
    s0: float
    s1: float
    label: str
    build: Callable[[], list[Component]] | None = None
    sort_key: int = 1


@dataclass
class _Tags:
    counts: dict = field(default_factory=lambda: defaultdict(int))
    used: set = field(default_factory=set)

    def next(self, prefix: str) -> str:
        while True:
            self.counts[prefix] += 1
            tag = f"{prefix}{self.counts[prefix]}"
            if tag not in self.used:
                self.used.add(tag)
                return tag

    def claim(self, tag: str, line: str) -> str:
        if tag in self.used:
            raise RoutingError(f"{line}: duplicate item id {tag!r}")
        self.used.add(tag)
        return tag


def route_line(
    spec: PipingSpec,
    number: str,
    nps: str | int | float,
    points: Iterable[Sequence[float]],
    *,
    start: End | str = End.OPEN,
    end: End | str = End.OPEN,
    inline: Iterable[Inline] = (),
    start_dir: Sequence[float] | None = None,
    end_dir: Sequence[float] | None = None,
    start_ref: str = "",
    end_ref: str = "",
    fluid: str = "",
) -> Pipeline:
    """Route one line. ``start_dir``/``end_dir`` force the first/last leg direction (nozzles, tees)."""
    start, end = End(start), End(end)
    try:
        nps = normalize_nps(nps)
        spec.pipe(nps)  # size must be allowed by the spec
    except (CatalogError, SpecError) as exc:
        raise RoutingError(f"{number}: {exc}") from None

    pts = [vec(p) for p in points]
    legs, remap = _build_legs(number, pts)
    _check_direction(number, legs[0].d, start_dir, "first leg", start_ref or "start")
    _check_direction(number, legs[-1].d, end_dir, "last leg", end_ref or "end")

    try:
        return _route(spec, number, nps, pts, legs, remap, start, end, list(inline), start_ref, end_ref, fluid)
    except (CatalogError, SpecError) as exc:
        raise RoutingError(f"{number}: {exc}") from None


def _route(spec, number, nps, pts, legs, remap, start, end, inline, start_ref, end_ref, fluid) -> Pipeline:
    cat = spec.catalog
    tags = _Tags()
    line = Pipeline(number=number, spec=spec.name, nps=nps, points=pts, start_ref=start_ref, end_ref=end_ref, fluid=fluid)
    fl_len = spec.flange(nps).length if (start in (End.FLANGED, End.NOZZLE) or end in (End.FLANGED, End.NOZZLE) or inline) else 0.0
    gasket = spec.gasket_thickness

    # -- elbows at every turn ---------------------------------------------------
    bends: dict[int, tuple[str, float, float]] = {}
    for k in range(1, len(legs)):
        angle = math.degrees(angle_between(legs[k - 1].d, legs[k].d))
        bends[k] = _select_elbow(number, cat, nps, angle, legs[k].start)

    slots: list[list[_Slot]] = [[] for _ in legs]
    for k, (variant, angle, tangent) in bends.items():
        label = f"{variant} elbow at {format_enu(legs[k].start)}"
        slots[k - 1].append(_Slot(legs[k - 1].length - tangent, legs[k - 1].length, label, sort_key=2))
        slots[k].append(_Slot(0.0, tangent, label, sort_key=0))

    # -- end assemblies -----------------------------------------------------------
    first, last = legs[0], legs[-1]

    def start_assembly() -> list[Component]:
        if start is End.FLANGED:
            return [make_flange(spec, nps, tags.next("F"), first.at(fl_len), first.at(0.0))]
        return [
            make_gasket(spec, nps, tags.next("G"), first.at(0.0), first.at(gasket)),
            make_flange(spec, nps, tags.next("F"), first.at(gasket + fl_len), first.at(gasket)),
        ]

    def end_assembly() -> list[Component]:
        L = last.length
        if end is End.FLANGED:
            return [make_flange(spec, nps, tags.next("F"), last.at(L - fl_len), last.at(L))]
        return [
            make_flange(spec, nps, tags.next("F"), last.at(L - gasket - fl_len), last.at(L - gasket)),
            make_gasket(spec, nps, tags.next("G"), last.at(L - gasket), last.at(L)),
        ]

    allowance = {End.OPEN: 0.0, End.BUTTWELD: 0.0, End.FLANGED: fl_len, End.NOZZLE: gasket + fl_len}
    if allowance[start]:
        slots[0].append(_Slot(0.0, allowance[start], f"{start.value} end", start_assembly, sort_key=0))
    if allowance[end]:
        L = last.length
        slots[-1].append(_Slot(L - allowance[end], L, f"{end.value} end", end_assembly, sort_key=2))

    # -- inline items -------------------------------------------------------------
    for item in inline:
        if item.leg not in remap:
            raise RoutingError(f"{number}: {item.type} refers to leg {item.leg}, but the route has {len(remap)} legs")
        k, offset = remap[item.leg]
        leg = legs[k]
        s = offset + float(item.station)
        if item.type == "tee":
            slots[k].append(_tee_slot(spec, number, nps, leg, s, item, tags))
        elif item.type in VALVE_TYPES:
            slots[k].append(_valve_slot(spec, number, nps, leg, s, item, tags, fl_len, gasket))
        else:
            raise RoutingError(f"{number}: unknown inline item type {item.type!r} (use {', '.join(VALVE_TYPES)} or tee)")

    # -- fill legs with pipe ----------------------------------------------------
    for i, leg in enumerate(legs):
        L = leg.length
        ordered = sorted(slots[i], key=lambda sl: (sl.s0, sl.sort_key))
        for sl in ordered:
            if sl.s0 < -TOL or sl.s1 > L + TOL:
                raise RoutingError(
                    f"{number}: {sl.label} does not fit on leg {i} ({format_enu(leg.start)} -> "
                    f"{format_enu(leg.end)}, length {L:.0f} mm; needs {sl.s0:.0f}..{sl.s1:.0f})"
                )
        for a, b in zip(ordered, ordered[1:]):
            if b.s0 < a.s1 - TOL:
                raise RoutingError(
                    f"{number}: {a.label} and {b.label} overlap by {a.s1 - b.s0:.0f} mm on leg {i} "
                    f"({format_enu(leg.start)} -> {format_enu(leg.end)})"
                )
        cursor = 0.0
        for sl in ordered:
            _fill(spec, line, nps, leg, i, cursor, sl.s0, tags)
            if sl.build:
                line.components.extend(sl.build())
            cursor = sl.s1
        _fill(spec, line, nps, leg, i, cursor, L, tags)
        if i + 1 < len(legs):
            variant, angle, tangent = bends[i + 1]
            line.components.append(
                make_elbow(spec, nps, tags.next("E"), legs[i + 1].start, leg.d, legs[i + 1].d, angle, tangent, variant)
            )

    for c in line.components:
        c.group = number
    return line


def _fill(spec, line: Pipeline, nps, leg: _Leg, i: int, s0: float, s1: float, tags: _Tags) -> None:
    gap = s1 - s0
    if gap <= TOL:
        return
    pipe = make_pipe(spec, nps, tags.next("P"), leg.at(s0), leg.at(s1))
    line.components.append(pipe)
    if gap < spec.min_pipe_length:
        line.warnings.append(
            f"{line.number}: short pipe {pipe.tag} = {gap:.0f} mm on leg {i} "
            f"(spec {spec.name} minimum {spec.min_pipe_length:.0f} mm)"
        )


def _build_legs(number: str, pts: list[Vec3]) -> tuple[list[_Leg], dict[int, tuple[int, float]]]:
    if len(pts) < 2:
        raise RoutingError(f"{number}: a route needs at least two points")
    legs: list[_Leg] = []
    remap: dict[int, tuple[int, float]] = {}
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        if (b - a).length() < TOL:
            raise RoutingError(f"{number}: leg {i} has zero length at {format_enu(a)}")
        d = (b - a).normalized()
        if legs:
            turn = angle_between(legs[-1].d, d)
            if turn < COLLINEAR:
                remap[i] = (len(legs) - 1, legs[-1].length)
                legs[-1] = _Leg(legs[-1].start, b)
                continue
            if turn > math.pi - COLLINEAR:
                raise RoutingError(f"{number}: route doubles back on itself at {format_enu(a)}")
        remap[i] = (len(legs), 0.0)
        legs.append(_Leg(a, b))
    return legs, remap


def _check_direction(number: str, actual: Vec3, required, what: str, ref: str) -> None:
    if required is None:
        return
    req = vec(required).normalized()
    if actual.dot(req) < 1 - 1e-9:
        raise RoutingError(
            f"{number}: {what} must run along ({req.x:g}, {req.y:g}, {req.z:g}) to connect to {ref}, "
            f"but runs along ({actual.x:.3g}, {actual.y:.3g}, {actual.z:.3g})"
        )


def _select_elbow(number: str, cat, nps: str, angle: float, where: Vec3) -> tuple[str, float, float]:
    if abs(angle - 90.0) <= 0.01:
        return "90 LR", 90.0, cat.elbow90_lr(nps)
    if abs(angle - 45.0) <= 0.01:
        return "45 LR", 45.0, cat.elbow45_lr(nps)
    if MIN_TURN <= angle < 90.0:
        angle = round(angle, 2)
        return f"90 LR trimmed {angle:g}", angle, cat.elbow90_lr(nps) * math.tan(math.radians(angle) / 2)
    if angle < MIN_TURN:
        raise RoutingError(f"{number}: {angle:.2f} deg turn at {format_enu(where)} is too small for an elbow - align the points")
    raise RoutingError(
        f"{number}: {angle:.1f} deg turn at {format_enu(where)} exceeds 90 deg - add an intermediate point"
    )


def _valve_slot(spec, number, nps, leg: _Leg, s: float, item: Inline, tags: _Tags, fl_len: float, gasket: float) -> _Slot:
    length, _ = spec.valve(item.type, nps)
    d = leg.d
    stem = _stem_direction(number, d, item)
    total = 2 * fl_len + 2 * gasket + length
    s0 = s - total / 2
    tag = tags.claim(item.id, number) if item.id else tags.next("V")

    def build() -> list[Component]:
        a = s0 + fl_len + gasket
        b = a + length
        return [
            make_flange(spec, nps, tags.next("F"), leg.at(s0), leg.at(s0 + fl_len)),
            make_gasket(spec, nps, tags.next("G"), leg.at(s0 + fl_len), leg.at(a)),
            make_valve(spec, nps, tag, item.type, leg.at(a), leg.at(b), stem),
            make_gasket(spec, nps, tags.next("G"), leg.at(b), leg.at(b + gasket)),
            make_flange(spec, nps, tags.next("F"), leg.at(s0 + total), leg.at(b + gasket)),
        ]

    return _Slot(s0, s0 + total, f"{item.type} valve {tag} at station {item.station:g}", build)


def _tee_slot(spec, number, nps, leg: _Leg, s: float, item: Inline, tags: _Tags) -> _Slot:
    if item.branch is None:
        raise RoutingError(f"{number}: tee at station {item.station:g} needs a branch direction")
    branch = vec(item.branch).normalized()
    if abs(branch.dot(leg.d)) > 1e-6:
        raise RoutingError(f"{number}: tee branch must be perpendicular to the run")
    c = spec.catalog.tee(nps)
    tag = tags.claim(item.id, number) if item.id else tags.next("T")
    return _Slot(
        s - c,
        s + c,
        f"tee {tag} at station {item.station:g}",
        lambda: [make_tee(spec, nps, tag, leg.at(s), leg.d, branch)],
    )


def _stem_direction(number: str, d: Vec3, item: Inline) -> Vec3:
    if item.stem is not None:
        stem = vec(item.stem).normalized()
        if abs(stem.dot(d)) > 1e-6:
            raise RoutingError(f"{number}: valve stem must be perpendicular to the pipe")
        return stem
    if abs(d.dot(Z_AXIS)) < 0.99:  # horizontal-ish pipe: stem up
        return (Z_AXIS - d * d.dot(Z_AXIS)).normalized()
    return (X_AXIS - d * d.dot(X_AXIS)).normalized()  # vertical pipe: stem east
