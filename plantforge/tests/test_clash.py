import math

import pytest

from plantforge.clash import gjk_distance
from plantforge.geom import Box, Cylinder, Frustum, Sphere, TorusArc, Vec3


def V(*c):
    return Vec3(*map(float, c))


@pytest.mark.parametrize(
    "a, b, expected",
    [
        (Sphere(V(0, 0, 0), 5), Sphere(V(10, 10, 10), 5), math.sqrt(300) - 10),
        (Box(V(0, 0, 0), V(1, 1, 1)), Box(V(3, 0, 0), V(4, 1, 1)), 2.0),
        (Box(V(0, 0, 0), V(1, 1, 1)), Box(V(2, 2, 2), V(3, 3, 3)), math.sqrt(3)),
        (Cylinder(V(0, 0, 0), V(0, 0, 100), 10), Cylinder(V(50, 0, 0), V(50, 0, 100), 15), 25.0),
        (Cylinder(V(0, 0, 0), V(100, 0, 0), 10), Cylinder(V(50, -50, 40), V(50, 50, 40), 15), 15.0),
        (Cylinder(V(0, 0, 0), V(0, 0, 10), 5), Sphere(V(0, 0, 30), 5), 15.0),
        (Frustum(V(0, 0, 0), V(0, 0, 10), 10, 2), Sphere(V(0, 0, 20), 3), 7.0),
        (Cylinder(V(0, 0, 0), V(100, 0, 0), 10), Box(V(-10, -10, 25), V(110, 10, 40)), 15.0),
    ],
)
def test_gjk_separated(a, b, expected):
    d, pa, pb = gjk_distance(a, b)
    assert d == pytest.approx(expected, abs=0.01)
    assert (pb - pa).length() == pytest.approx(expected, abs=0.02)


@pytest.mark.parametrize(
    "a, b",
    [
        (Cylinder(V(0, 0, 0), V(100, 0, 0), 10), Cylinder(V(50, -50, 0), V(50, 50, 0), 10)),
        (Box(V(0, 0, 0), V(10, 10, 10)), Sphere(V(5, 5, 5), 1)),
        (Cylinder(V(0, 0, 0), V(100, 0, 0), 10), Box(V(40, -5, -5), V(60, 5, 5))),
    ],
)
def test_gjk_intersecting(a, b):
    assert gjk_distance(a, b)[0] == 0.0


def test_torus_chords_enclose_the_tube():
    arc = TorusArc(V(0, 0, 0), V(100, 0, 0), V(0, 0, 1), math.pi / 2, 10)
    assert arc.end.isclose(V(0, 100, 0), 1e-9)
    # A point on the outside of the tube at mid-arc must be inside some chord cylinder.
    mid = V(math.cos(math.pi / 4), math.sin(math.pi / 4), 0) * 109.9
    probe = Sphere(mid, 0.01)
    assert min(gjk_distance(part, probe)[0] for part in arc.convex_parts()) == 0.0
