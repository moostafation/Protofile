"""Interference (clash) detection.

Every shape is reduced to convex parts (elbows/handwheels become chord cylinders
that enclose the torus) and the minimum distance between parts is computed with
the GJK algorithm. Components linked through a few joints are skipped, and
components of the same line or equipment are not checked against each other.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations

from .connectivity import Connectivity, analyse
from .geom import AABB, Vec3
from .model import Component, Project


@dataclass
class Clash:
    a: str
    b: str
    distance: float  # 0.0 = touching or overlapping
    point: Vec3  # approximate location
    hard: bool  # True: physical interference; False: inside the clearance zone only


def _solve(m: list[list[float]], rhs: list[float]) -> list[float] | None:
    """Gaussian elimination with partial pivoting; None when (near-)singular."""
    n = len(rhs)
    a = [row[:] + [rhs[i]] for i, row in enumerate(m)]
    scale = max((abs(v) for row in m for v in row), default=1.0) or 1.0
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(a[r][col]))
        if abs(a[piv][col]) < 1e-12 * scale:
            return None
        a[col], a[piv] = a[piv], a[col]
        for r in range(col + 1, n):
            f = a[r][col] / a[col][col]
            for c in range(col, n + 1):
                a[r][c] -= f * a[col][c]
    x = [0.0] * n
    for r in range(n - 1, -1, -1):
        x[r] = (a[r][n] - sum(a[r][c] * x[c] for c in range(r + 1, n))) / a[r][r]
    return x


def _closest_on_simplex(pts: list[Vec3]) -> tuple[Vec3, list[float], list[int]]:
    """Closest point to the origin on the convex hull of up to four points (brute-force Johnson)."""
    best: tuple[float, Vec3, list[float], list[int]] | None = None
    n = len(pts)
    for mask in range(1, 1 << n):
        idx = [i for i in range(n) if mask >> i & 1]
        p0 = pts[idx[0]]
        if len(idx) == 1:
            lam = [1.0]
            v = p0
        else:
            d = [pts[i] - p0 for i in idx[1:]]
            g = [[di.dot(dj) for dj in d] for di in d]
            mu = _solve(g, [-di.dot(p0) for di in d])
            if mu is None:
                continue
            lam = [1.0 - sum(mu), *mu]
            if min(lam) < -1e-12:
                continue
            v = p0
            for k, di in enumerate(d):
                v = v + di * mu[k]
        dist = v.dot(v)
        if best is None or dist < best[0] - 1e-18:
            best = (dist, v, lam, idx)
    assert best is not None
    return best[1], best[2], best[3]


def gjk_distance(sa, sb, max_iter: int = 100, tol: float = 1e-4) -> tuple[float, Vec3, Vec3]:
    """Minimum distance between two convex shapes exposing ``support(d)``.

    Returns ``(distance, point_on_a, point_on_b)``; distance is 0.0 when they intersect.
    """
    da = sa.support(Vec3(1.0, 0.0, 0.0))
    db = sb.support(Vec3(-1.0, 0.0, 0.0))
    simplex = [(da - db, da, db)]
    v = da - db
    lam = [1.0]
    for _ in range(max_iter):
        vv = v.dot(v)
        if vv < 1e-12:
            break
        pa, pb = sa.support(-v), sb.support(v)
        w = pa - pb
        if vv - v.dot(w) <= tol * vv ** 0.5:
            break
        if any(w.isclose(s[0], 1e-9) for s in simplex):
            break
        simplex.append((w, pa, pb))
        v, lam, idx = _closest_on_simplex([s[0] for s in simplex])
        simplex = [simplex[i] for i in idx]
        keep = [k for k, l in enumerate(lam) if l > 1e-12]
        simplex = [simplex[k] for k in keep]
        lam = [lam[k] for k in keep]
        if len(simplex) == 4:  # origin enclosed by a tetrahedron
            v = Vec3(0.0, 0.0, 0.0)
            break
    total = sum(lam) or 1.0
    pa = pb = Vec3(0.0, 0.0, 0.0)
    for (_, a, b), l in zip(simplex, lam):
        pa = pa + a * (l / total)
        pb = pb + b * (l / total)
    dist = v.length()
    return (0.0 if dist < 1e-6 else dist), pa, pb


@dataclass
class _Item:
    comp: Component
    parts: list
    box: AABB


def find_clashes(
    project: Project, clearance: float = 0.0, conn: Connectivity | None = None, hops: int = 3
) -> list[Clash]:
    """Check every pair of components from different lines/equipment.

    ``clearance`` (mm) also reports pairs closer than this as soft clashes. Parts
    linked through at most ``hops`` joints are part of the same connection and skipped.
    """
    conn = conn or analyse(project)
    linked = conn.near_pairs(hops)
    items = []
    for comp in project.components():
        parts = [p for s in comp.shapes for p in s.convex_parts()]
        box = comp.aabb()
        if parts and box is not None:
            items.append(_Item(comp, parts, box))

    clashes: list[Clash] = []
    for x, y in combinations(items, 2):
        if x.comp.group == y.comp.group:
            continue
        if not x.box.overlaps(y.box, clearance):
            continue
        if frozenset((x.comp.uid, y.comp.uid)) in linked:
            continue
        best: tuple[float, Vec3, Vec3] | None = None
        for pa in x.parts:
            for pb in y.parts:
                if not pa.aabb().overlaps(pb.aabb(), clearance):
                    continue
                res = gjk_distance(pa, pb)
                if best is None or res[0] < best[0]:
                    best = res
                if best[0] == 0.0:
                    break
            if best is not None and best[0] == 0.0:
                break
        if best is not None and best[0] <= clearance:
            dist, pa_, pb_ = best
            clashes.append(Clash(x.comp.uid, y.comp.uid, dist, (pa_ + pb_) * 0.5, hard=dist == 0.0))
    clashes.sort(key=lambda c: (not c.hard, c.distance, c.a, c.b))
    return clashes
