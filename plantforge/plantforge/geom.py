"""Dependency-free 3D geometry used across PlantForge.

Plant convention: X = East, Y = North, Z = Elevation (up). Units are millimetres.

The primitives here are the "graphic outputs" of parts (like symbol outputs in
SP3D): every component and equipment item is described as a list of them, and
the viewer, the IFC exporter and the clash checker all consume the same list.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable, NamedTuple, Sequence

EPS = 1e-9


class Vec3(NamedTuple):
    x: float
    y: float
    z: float

    def __add__(self, o: Sequence[float]) -> "Vec3":  # type: ignore[override]
        return Vec3(self.x + o[0], self.y + o[1], self.z + o[2])

    def __sub__(self, o: Sequence[float]) -> "Vec3":
        return Vec3(self.x - o[0], self.y - o[1], self.z - o[2])

    def __mul__(self, k: float) -> "Vec3":  # type: ignore[override]
        return Vec3(self.x * k, self.y * k, self.z * k)

    __rmul__ = __mul__  # type: ignore[assignment]

    def __truediv__(self, k: float) -> "Vec3":
        return Vec3(self.x / k, self.y / k, self.z / k)

    def __neg__(self) -> "Vec3":
        return Vec3(-self.x, -self.y, -self.z)

    def dot(self, o: Sequence[float]) -> float:
        return self.x * o[0] + self.y * o[1] + self.z * o[2]

    def cross(self, o: Sequence[float]) -> "Vec3":
        return Vec3(
            self.y * o[2] - self.z * o[1],
            self.z * o[0] - self.x * o[2],
            self.x * o[1] - self.y * o[0],
        )

    def length(self) -> float:
        return math.sqrt(self.dot(self))

    def normalized(self) -> "Vec3":
        n = self.length()
        if n < EPS:
            raise ValueError("cannot normalise a zero-length vector")
        return self / n

    def isclose(self, o: Sequence[float], tol: float = 1e-6) -> bool:
        return (self - o).length() <= tol

    def rounded(self, nd: int = 3) -> "Vec3":
        return Vec3(round(self.x, nd) + 0.0, round(self.y, nd) + 0.0, round(self.z, nd) + 0.0)

    def tolist(self) -> list[float]:
        return [self.x, self.y, self.z]


ORIGIN = Vec3(0.0, 0.0, 0.0)
X_AXIS = Vec3(1.0, 0.0, 0.0)
Y_AXIS = Vec3(0.0, 1.0, 0.0)
Z_AXIS = Vec3(0.0, 0.0, 1.0)


def vec(p: Iterable[float]) -> Vec3:
    x, y, z = (float(c) for c in p)
    return Vec3(x, y, z)


def any_perpendicular(u: Vec3) -> Vec3:
    """A unit vector perpendicular to ``u`` (deterministic)."""
    ref = Z_AXIS if abs(u.z) < 0.9 else X_AXIS
    return u.cross(ref).normalized()


def rotate(v: Vec3, axis: Vec3, angle: float) -> Vec3:
    """Rodrigues rotation of ``v`` about unit ``axis`` by ``angle`` radians (right-hand)."""
    c, s = math.cos(angle), math.sin(angle)
    return v * c + axis.cross(v) * s + axis * (axis.dot(v) * (1.0 - c))


def angle_between(u: Vec3, v: Vec3) -> float:
    c = max(-1.0, min(1.0, u.normalized().dot(v.normalized())))
    return math.acos(c)


def format_enu(p: Vec3) -> str:
    """Human readable plant coordinate, e.g. ``E 1200 N 300 EL +3500``."""
    return f"E {p.x:.0f} N {p.y:.0f} EL {p.z:+.0f}"


# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AABB:
    lo: Vec3
    hi: Vec3

    def overlaps(self, o: "AABB", margin: float = 0.0) -> bool:
        return (
            self.lo.x - margin <= o.hi.x
            and o.lo.x - margin <= self.hi.x
            and self.lo.y - margin <= o.hi.y
            and o.lo.y - margin <= self.hi.y
            and self.lo.z - margin <= o.hi.z
            and o.lo.z - margin <= self.hi.z
        )

    def union(self, o: "AABB") -> "AABB":
        return AABB(
            Vec3(min(self.lo.x, o.lo.x), min(self.lo.y, o.lo.y), min(self.lo.z, o.lo.z)),
            Vec3(max(self.hi.x, o.hi.x), max(self.hi.y, o.hi.y), max(self.hi.z, o.hi.z)),
        )

    @property
    def center(self) -> Vec3:
        return (self.lo + self.hi) * 0.5


def _disc_extent(axis: Vec3, r: float) -> Vec3:
    # Half-extent along each world axis of a disc of radius r with normal ``axis``.
    return Vec3(
        r * math.sqrt(max(0.0, 1.0 - axis.x * axis.x)),
        r * math.sqrt(max(0.0, 1.0 - axis.y * axis.y)),
        r * math.sqrt(max(0.0, 1.0 - axis.z * axis.z)),
    )


def _disc_support(center: Vec3, axis: Vec3, r: float, d: Vec3) -> Vec3:
    perp = d - axis * d.dot(axis)
    n = perp.length()
    if n < EPS:
        return center
    return center + perp * (r / n)


@dataclass(frozen=True)
class Cylinder:
    """Solid right circular cylinder from ``a`` to ``b``."""

    a: Vec3
    b: Vec3
    radius: float

    @property
    def axis(self) -> Vec3:
        return (self.b - self.a).normalized()

    def aabb(self) -> AABB:
        e = _disc_extent(self.axis, self.radius)
        lo = Vec3(min(self.a.x, self.b.x), min(self.a.y, self.b.y), min(self.a.z, self.b.z)) - e
        hi = Vec3(max(self.a.x, self.b.x), max(self.a.y, self.b.y), max(self.a.z, self.b.z)) + e
        return AABB(lo, hi)

    def support(self, d: Vec3) -> Vec3:
        u = self.axis
        end = self.b if d.dot(u) > 0 else self.a
        return _disc_support(end, u, self.radius, d)

    def convex_parts(self) -> list:
        return [self]


@dataclass(frozen=True)
class Frustum:
    """Truncated cone from ``a`` (radius ``ra``) to ``b`` (radius ``rb``)."""

    a: Vec3
    b: Vec3
    ra: float
    rb: float

    @property
    def axis(self) -> Vec3:
        return (self.b - self.a).normalized()

    def aabb(self) -> AABB:
        u = self.axis
        ea, eb = _disc_extent(u, self.ra), _disc_extent(u, self.rb)
        b1 = AABB(self.a - ea, self.a + ea)
        return b1.union(AABB(self.b - eb, self.b + eb))

    def support(self, d: Vec3) -> Vec3:
        u = self.axis
        pa = _disc_support(self.a, u, self.ra, d)
        pb = _disc_support(self.b, u, self.rb, d)
        return pa if pa.dot(d) >= pb.dot(d) else pb

    def convex_parts(self) -> list:
        return [self]


@dataclass(frozen=True)
class Box:
    """Axis-aligned box."""

    lo: Vec3
    hi: Vec3

    def aabb(self) -> AABB:
        return AABB(self.lo, self.hi)

    def support(self, d: Vec3) -> Vec3:
        return Vec3(
            self.hi.x if d.x > 0 else self.lo.x,
            self.hi.y if d.y > 0 else self.lo.y,
            self.hi.z if d.z > 0 else self.lo.z,
        )

    def convex_parts(self) -> list:
        return [self]


@dataclass(frozen=True)
class Sphere:
    center: Vec3
    radius: float

    def aabb(self) -> AABB:
        r = Vec3(self.radius, self.radius, self.radius)
        return AABB(self.center - r, self.center + r)

    def support(self, d: Vec3) -> Vec3:
        n = d.length()
        if n < EPS:
            return self.center
        return self.center + d * (self.radius / n)

    def convex_parts(self) -> list:
        return [self]


@dataclass(frozen=True)
class TorusArc:
    """Swept circle along a circular arc (elbows, handwheels).

    ``start`` is the arc start on the centre-line, ``normal`` the rotation axis
    (right-hand rule) and ``angle`` the swept angle in radians.
    """

    center: Vec3
    start: Vec3
    normal: Vec3
    angle: float
    radius: float

    @property
    def bend_radius(self) -> float:
        return (self.start - self.center).length()

    @property
    def end(self) -> Vec3:
        return self.center + rotate(self.start - self.center, self.normal, self.angle)

    def centerline(self, segments: int = 16) -> list[Vec3]:
        r0 = self.start - self.center
        return [
            self.center + rotate(r0, self.normal, self.angle * i / segments)
            for i in range(segments + 1)
        ]

    def convex_parts(self, segments: int | None = None) -> list:
        """Chord cylinders, inflated by the arc sagitta so they enclose the torus."""
        if segments is None:
            segments = max(2, math.ceil(self.angle / (math.pi / 8)))
        pts = self.centerline(segments)
        half = self.angle / segments / 2.0
        r = self.radius + self.bend_radius * (1.0 - math.cos(half))  # inflate by the sagitta
        ext = r * math.tan(half)  # overlap at interior joints closes the wedge on the outside of the bend
        parts = []
        for i in range(segments):
            a, b = pts[i], pts[i + 1]
            u = (b - a).normalized()
            if i > 0 or self.angle >= 2 * math.pi - 1e-9:
                a = a - u * ext
            if i < segments - 1 or self.angle >= 2 * math.pi - 1e-9:
                b = b + u * ext
            parts.append(Cylinder(a, b, r))
        return parts

    def aabb(self) -> AABB:
        parts = self.convex_parts()
        box = parts[0].aabb()
        for p in parts[1:]:
            box = box.union(p.aabb())
        return box


Primitive = Cylinder | Frustum | Box | Sphere | TorusArc


def shapes_aabb(shapes: Iterable[Primitive]) -> AABB | None:
    box: AABB | None = None
    for s in shapes:
        b = s.aabb()
        box = b if box is None else box.union(b)
    return box
