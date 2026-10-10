"""Model connectivity: which ports meet, where the welds are, and what is left open."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

from .catalog import nps_value
from .model import BW, Component, Port, Project

KEY_DIGITS = 1  # ports closer than ~0.05 mm are considered coincident


@dataclass
class Joint:
    a: Component
    pa: Port
    b: Component
    pb: Port

    @property
    def is_weld(self) -> bool:
        return self.pa.end == BW and self.pb.end == BW


@dataclass
class Connectivity:
    joints: list[Joint] = field(default_factory=list)
    open_ports: list[tuple[Component, Port]] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)

    def near_pairs(self, hops: int = 3) -> set[frozenset[str]]:
        """Pairs of components linked through at most ``hops`` joints.

        Such parts touch or sit close by design (a flange bolted to a nozzle across a
        gasket, a branch pipe beside its tee), so clash checks skip them.
        """
        graph: dict[str, set[str]] = defaultdict(set)
        for j in self.joints:
            graph[j.a.uid].add(j.b.uid)
            graph[j.b.uid].add(j.a.uid)
        pairs: set[frozenset[str]] = set()
        for start in graph:
            frontier, seen = {start}, {start}
            for _ in range(hops):
                frontier = {n for f in frontier for n in graph[f]} - seen
                seen |= frontier
            pairs.update(frozenset((start, other)) for other in seen if other != start)
        return pairs

    @property
    def welds(self) -> list[Joint]:
        return [j for j in self.joints if j.is_weld]

    @property
    def weld_inch_dia(self) -> float:
        """Sum of the nominal size (inch) of every butt weld - a standard fabrication productivity unit."""
        return sum(nps_value(j.pa.nps) for j in self.welds)


def _key(p: Port) -> tuple[float, float, float]:
    return tuple(round(c, KEY_DIGITS) + 0.0 for c in p.position)  # type: ignore[return-value]


def analyse(project: Project) -> Connectivity:
    buckets: dict[tuple, list[tuple[Component, Port]]] = defaultdict(list)
    for comp in project.components():
        for port in comp.ports:
            buckets[_key(port)].append((comp, port))

    result = Connectivity()
    for items in buckets.values():
        if len(items) == 1:
            result.open_ports.append(items[0])
            continue
        if len(items) > 2:
            names = ", ".join(f"{c.uid}:{p.name}" for c, p in items)
            result.problems.append(f"more than two ports meet at one point: {names}")
            continue
        (ca, pa), (cb, pb) = items
        if pa.direction.dot(pb.direction) > -1 + 1e-6:
            result.problems.append(f"{ca.uid}:{pa.name} and {cb.uid}:{pb.name} meet but are not facing each other")
        if pa.end != pb.end:
            result.problems.append(f"end mismatch {ca.uid}:{pa.name} ({pa.end}) vs {cb.uid}:{pb.name} ({pb.end})")
        if pa.nps != pb.nps:
            result.problems.append(f"size mismatch {ca.uid}:{pa.name} (NPS {pa.nps}) vs {cb.uid}:{pb.name} (NPS {pb.nps})")
        result.joints.append(Joint(ca, pa, cb, pb))
    return result
