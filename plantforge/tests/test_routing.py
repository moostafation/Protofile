import math

import pytest

from plantforge import End, Inline, RoutingError, Vec3, load_spec, route_line
from plantforge.model import ELBOW, FLANGE, GASKET, PIPE, TEE, VALVE


@pytest.fixture(scope="module")
def spec():
    return load_spec("A1A")


def kinds(line):
    return [c.kind for c in line.components]


def assert_continuous(line):
    """Consecutive components (in flow order) must share a connection point."""
    comps = line.components
    for a, b in zip(comps, comps[1:]):
        shared = any(pa.position.isclose(pb.position, 1e-6) for pa in a.ports for pb in b.ports)
        assert shared, f"gap between {a.tag} and {b.tag}"


def test_single_elbow_route(spec):
    line = route_line(spec, "L1", 4, [(0, 0, 0), (2000, 0, 0), (2000, 1500, 0)])
    assert kinds(line) == [PIPE, ELBOW, PIPE]
    p1, elbow, p2 = line.components
    assert p1.props["length"] == pytest.approx(2000 - 152)
    assert p2.props["length"] == pytest.approx(1500 - 152)
    assert elbow.port("P1").position.isclose(Vec3(1848, 0, 0))
    assert elbow.port("P2").position.isclose(Vec3(2000, 152, 0))
    assert elbow.props["bend_radius"] == pytest.approx(152)
    arc = elbow.shapes[0]
    assert arc.end.isclose(elbow.port("P2").position, 1e-6)
    assert_continuous(line)


def test_centreline_length_is_conserved(spec):
    pts = [(0, 0, 0), (3000, 0, 0), (3000, 2000, 0), (3000, 2000, 3000)]
    line = route_line(spec, "L1", 6, pts, start="flanged", end="flanged", inline=[Inline("gate", 0, 1500)])
    straight = sum(
        (c.ports[1].position - c.ports[0].position).length() for c in line.components if c.kind != ELBOW
    )
    elbows = sum(2 * c.props["center_to_end"] for c in line.by_kind(ELBOW))
    assert straight + elbows == pytest.approx(3000 + 2000 + 3000)
    assert_continuous(line)


def test_flanged_valve_assembly(spec):
    line = route_line(spec, "L1", 4, [(0, 0, 0), (2000, 0, 0)], inline=[Inline("gate", 0, 1000)])
    assert kinds(line) == [PIPE, FLANGE, GASKET, VALVE, GASKET, FLANGE, PIPE]
    valve = line.by_kind(VALVE)[0]
    centre = (valve.ports[0].position + valve.ports[1].position) * 0.5
    assert centre.isclose(Vec3(1000, 0, 0), 1e-6)
    assert valve.props["face_to_face"] == 229
    assert valve.props["stem"].isclose(Vec3(0, 0, 1))  # horizontal pipe: stem up
    assert_continuous(line)


def test_nozzle_end_adds_gasket_and_flange(spec):
    line = route_line(spec, "L1", 4, [(0, 0, 0), (0, 0, 1000)], start=End.NOZZLE, end=End.OPEN, start_dir=(0, 0, 1))
    assert kinds(line) == [GASKET, FLANGE, PIPE]
    assert line.components[0].port("P1").position.isclose(Vec3(0, 0, 0))


def test_45_and_trimmed_elbows(spec):
    line = route_line(spec, "L1", 4, [(0, 0, 0), (1000, 0, 0), (2000, 1000, 0), (2000 + 1000 * math.cos(math.radians(75)) + 1000, 1000 + 1000 * math.sin(math.radians(75)), 0)])
    e1, e2 = line.by_kind(ELBOW)
    assert e1.props["variant"] == "45 LR" and e1.props["center_to_end"] == 64
    assert e2.props["variant"].startswith("90 LR trimmed")
    assert "TRIMMED" in e2.description
    assert_continuous(line)


def test_tee_on_run(spec):
    line = route_line(spec, "L1", 4, [(0, 0, 0), (2000, 0, 0)], inline=[Inline("tee", 0, 1000, id="T9", branch=(0, 1, 0))])
    tee = line.by_kind(TEE)[0]
    assert tee.tag == "T9"
    assert tee.port("BR").position.isclose(Vec3(1000, 105, 0))


def test_collinear_points_are_merged(spec):
    line = route_line(spec, "L1", 4, [(0, 0, 0), (1000, 0, 0), (2500, 0, 0)], inline=[Inline("gate", 1, 500)])
    assert kinds(line) == [PIPE, FLANGE, GASKET, VALVE, GASKET, FLANGE, PIPE]
    valve = line.by_kind(VALVE)[0]
    assert ((valve.ports[0].position + valve.ports[1].position) * 0.5).isclose(Vec3(1500, 0, 0), 1e-6)


def test_short_pipe_warning(spec):
    line = route_line(spec, "L1", 4, [(0, 0, 0), (1000, 0, 0), (1000, 152 + 152 + 30, 0), (2000, 334, 0)])
    assert any("short pipe" in w for w in line.warnings)


@pytest.mark.parametrize(
    "points, inline, message",
    [
        ([(0, 0, 0), (1000, 0, 0), (1000, 200, 0), (2000, 200, 0)], [], "overlap"),
        ([(0, 0, 0), (1000, 0, 0)], [Inline("gate", 0, 100)], "does not fit"),
        ([(0, 0, 0), (1000, 0, 0), (0, 500, 0)], [], "exceeds 90"),
        ([(0, 0, 0), (1000, 0, 0), (0, 0, 0)], [], "doubles back"),
        ([(0, 0, 0), (0, 0, 0)], [], "zero length"),
        ([(0, 0, 0), (1000, 0, 0)], [Inline("tee", 0, 500, branch=(1, 0, 0))], "perpendicular"),
        ([(0, 0, 0), (1000, 0, 0)], [Inline("gate", 3, 500)], "leg 3"),
    ],
)
def test_routing_errors(spec, points, inline, message):
    with pytest.raises(RoutingError, match=message):
        route_line(spec, "L1", 4, points, inline=inline)


def test_direction_must_match_connection(spec):
    with pytest.raises(RoutingError, match="first leg must run along"):
        route_line(spec, "L1", 4, [(0, 0, 0), (1000, 0, 0)], start="nozzle", start_dir=(0, 0, 1), start_ref="P-1/N1")


def test_size_not_in_spec(spec):
    with pytest.raises(RoutingError, match="NPS 30"):
        route_line(spec, "L1", 30, [(0, 0, 0), (1000, 0, 0)])
