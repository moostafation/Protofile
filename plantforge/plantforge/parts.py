"""Part builders: turn spec + catalog data into placed components (ports + shapes).

These play the role of SP3D "part classes / symbols": given a size and the
placement, they produce the connection points and the graphic primitives.
"""

from __future__ import annotations

import math

from .geom import Cylinder, Frustum, TorusArc, Vec3, any_perpendicular
from .model import BW, ELBOW, FL, FLANGE, GASKET, PIPE, TEE, VALVE, Component, Port
from .spec import PipingSpec


def make_pipe(spec: PipingSpec, nps: str, tag: str, a: Vec3, b: Vec3) -> Component:
    data, description = spec.pipe(nps)
    u = (b - a).normalized()
    length = (b - a).length()
    return Component(
        tag=tag,
        kind=PIPE,
        nps=nps,
        ports=[Port("P1", a, -u, BW, nps), Port("P2", b, u, BW, nps)],
        shapes=[Cylinder(a, b, data.od / 2)],
        description=description,
        props={
            "length": length,
            "schedule": data.schedule,
            "od": data.od,
            "wall": data.wall,
            "weight_kg": data.weight_per_m * length / 1000.0,
        },
    )


def make_elbow(
    spec: PipingSpec,
    nps: str,
    tag: str,
    vertex: Vec3,
    d_in: Vec3,
    d_out: Vec3,
    angle_deg: float,
    tangent: float,
    variant: str,
) -> Component:
    """Elbow whose tangent lines intersect at ``vertex``.

    ``tangent`` is the centre-to-end dimension; the bend radius is derived from it
    so that the arc exactly meets both tangent points.
    """
    od = spec.catalog.od(nps)
    theta = math.radians(angle_deg)
    start = vertex - d_in * tangent
    end = vertex + d_out * tangent
    radius = tangent / math.tan(theta / 2)
    inward = (d_out - d_in * d_in.dot(d_out)).normalized()
    center = start + inward * radius
    normal = ((start - center).normalized()).cross(d_in).normalized()
    key = "elbow45" if variant == "45 LR" else "elbow90"
    description = spec.bw_description(key, nps)
    if variant.startswith("90 LR trimmed"):
        description = description.replace("ELBOW 90 LR", f"ELBOW 90 LR TRIMMED TO {angle_deg:g} DEG")
    return Component(
        tag=tag,
        kind=ELBOW,
        nps=nps,
        ports=[Port("P1", start, -d_in, BW, nps), Port("P2", end, d_out, BW, nps)],
        shapes=[TorusArc(center, start, normal, theta, od / 2)],
        description=description,
        skey=spec.part(key).skey,
        props={
            "angle": angle_deg,
            "variant": variant,
            "bend_radius": radius,
            "center_to_end": tangent,
            "vertex": vertex,
            "schedule": spec.schedule(nps),
        },
    )


def make_tee(spec: PipingSpec, nps: str, tag: str, center: Vec3, d: Vec3, branch: Vec3) -> Component:
    od = spec.catalog.od(nps)
    c = spec.catalog.tee(nps)
    p1, p2, br = center - d * c, center + d * c, center + branch * c
    return Component(
        tag=tag,
        kind=TEE,
        nps=nps,
        ports=[Port("P1", p1, -d, BW, nps), Port("P2", p2, d, BW, nps), Port("BR", br, branch, BW, nps)],
        shapes=[Cylinder(p1, p2, od / 2), Cylinder(center, br, od / 2)],
        description=spec.bw_description("tee", nps),
        skey=spec.part("tee").skey,
        props={"center": center, "center_to_end": c, "schedule": spec.schedule(nps)},
    )


def make_flange(spec: PipingSpec, nps: str, tag: str, weld: Vec3, face: Vec3) -> Component:
    """Weld-neck flange from its weld end to its raised-face contact surface."""
    fl = spec.flange(nps)
    od = spec.catalog.od(nps)
    u = (face - weld).normalized()
    back = face - u * (fl.tf + fl.rf_height)  # back face of the flange ring
    rf_start = face - u * fl.rf_height
    return Component(
        tag=tag,
        kind=FLANGE,
        nps=nps,
        ports=[Port("WELD", weld, -u, BW, nps), Port("FACE", face, u, FL, nps)],
        shapes=[
            Frustum(weld, back, od / 2, fl.hub_dia / 2),
            Cylinder(back, rf_start, fl.o / 2),
            Cylinder(rf_start, face, fl.rf_dia / 2),
        ],
        description=f"{spec.part('flange').description}, SCH {spec.schedule(nps)} BORE",
        skey=spec.part("flange").skey,
        props={"rating": spec.rating, "length": fl.length},
    )


def make_gasket(spec: PipingSpec, nps: str, tag: str, a: Vec3, b: Vec3) -> Component:
    fl = spec.flange(nps)
    u = (b - a).normalized()
    ring_od = fl.bc - fl.bolt_dia_mm  # outer centring ring sits inside the bolts
    return Component(
        tag=tag,
        kind=GASKET,
        nps=nps,
        ports=[Port("P1", a, -u, FL, nps), Port("P2", b, u, FL, nps)],
        shapes=[Cylinder(a, b, ring_od / 2)],
        description=spec.part("gasket").description,
        props={
            "thickness": (b - a).length(),
            "rating": spec.rating,
            "bolts": fl.bolts,
            "bolt_dia": fl.bolt_dia,
        },
    )


def make_valve(
    spec: PipingSpec,
    nps: str,
    tag: str,
    valve_type: str,
    a: Vec3,
    b: Vec3,
    stem: Vec3,
) -> Component:
    """Flanged valve between its two flange faces, with a simplified body and operator."""
    length, rule = spec.valve(valve_type, nps)
    fl = spec.flange(nps)
    u = (b - a).normalized()
    c = (a + b) * 0.5
    o = fl.o
    t = min(fl.tf, length / 4)
    shapes = [
        Cylinder(a, a + u * t, o / 2),
        Frustum(a + u * t, c, 0.42 * o, 0.12 * o),
        Frustum(c, b - u * t, 0.12 * o, 0.42 * o),
        Cylinder(b - u * t, b, o / 2),
    ]
    if valve_type in ("gate", "globe"):
        height = 1.6 * o
        wheel_r = 0.5 * o
        top = c + stem * height
        start = top + any_perpendicular(stem) * wheel_r
        shapes += [
            Cylinder(c, c + stem * (0.6 * o), 0.18 * o),  # bonnet
            Cylinder(c, top, 0.05 * o),  # stem
            TorusArc(top, start, stem, 2 * math.pi, 0.03 * o),  # handwheel
        ]
    else:
        shapes.append(Cylinder(c, c + stem * (0.35 * o), 0.25 * o))  # cover
    return Component(
        tag=tag,
        kind=VALVE,
        nps=nps,
        ports=[Port("P1", a, -u, FL, nps), Port("P2", b, u, FL, nps)],
        shapes=shapes,
        description=rule.description,
        skey=rule.skey,
        props={"valve_type": valve_type, "face_to_face": length, "rating": spec.rating, "stem": stem},
    )
