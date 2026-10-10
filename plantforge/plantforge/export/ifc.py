"""IFC export (open BIM, ISO 16739) using IfcOpenShell.

Lines become IfcDistributionSystem groups; pipes, fittings and valves become
IfcPipeSegment / IfcPipeFitting / IfcValve with IfcDistributionPort connection
points linked by IfcRelConnectsPorts, so the exported model stays "intelligent"
(connected) in any IFC tool: Bonsai (BlenderBIM), FreeCAD, Navisworks, Solibri...
"""

from __future__ import annotations

import math
from pathlib import Path

from ..catalog import default_catalog
from ..connectivity import Connectivity, analyse
from ..geom import Box, Cylinder, Frustum, Sphere, TorusArc, Vec3, X_AXIS, Z_AXIS, any_perpendicular
from ..model import ELBOW, FLANGE, GASKET, NOZZLE, PIPE, TEE, VALVE, Component, Project

ELEMENT_CLASS = {
    PIPE: ("IfcPipeSegment", "RIGIDSEGMENT", None),
    ELBOW: ("IfcPipeFitting", "BEND", None),
    TEE: ("IfcPipeFitting", "JUNCTION", None),
    FLANGE: ("IfcPipeFitting", "USERDEFINED", "FLANGE"),
    GASKET: ("IfcPipeFitting", "USERDEFINED", "GASKET"),
}
VALVE_TYPE = {"gate": "ISOLATING", "globe": "REGULATING", "check": "CHECK"}
EQUIPMENT_CLASS = {
    "pump": ("IfcPump", "NOTDEFINED"),
    "vessel": ("IfcTank", "VESSEL"),
    "drum": ("IfcTank", "VESSEL"),
    "tank": ("IfcTank", "STORAGE"),
    "exchanger": ("IfcHeatExchanger", "SHELLANDTUBE"),
}


def _require_ifcopenshell():
    try:
        import ifcopenshell  # noqa: F401
        import ifcopenshell.api  # noqa: F401
    except ImportError as exc:  # pragma: no cover - depends on environment
        raise ImportError("IFC export needs IfcOpenShell: pip install ifcopenshell") from exc


class _Geo:
    """Builds IFC swept solids in model coordinates."""

    def __init__(self, f, angle_scale: float):
        self.f = f
        self.angle_scale = angle_scale  # radians -> project plane angle unit

    def p3(self, v: Vec3):
        return self.f.createIfcCartesianPoint([float(v.x), float(v.y), float(v.z)])

    def d3(self, v: Vec3):
        return self.f.createIfcDirection([float(v.x), float(v.y), float(v.z)])

    def ax(self, loc: Vec3, z: Vec3, x: Vec3):
        return self.f.createIfcAxis2Placement3D(self.p3(loc), self.d3(z), self.d3(x))

    def origin2d(self, x: float = 0.0, y: float = 0.0):
        return self.f.createIfcAxis2Placement2D(self.f.createIfcCartesianPoint([float(x), float(y)]), None)

    def circle(self, r: float, x: float = 0.0, y: float = 0.0):
        return self.f.createIfcCircleProfileDef("AREA", None, self.origin2d(x, y), float(r))

    def cylinder(self, s: Cylinder):
        u = s.axis
        return self.f.createIfcExtrudedAreaSolid(
            self.circle(s.radius), self.ax(s.a, u, any_perpendicular(u)), self.d3(Z_AXIS), (s.b - s.a).length()
        )

    def box(self, s: Box):
        size = s.hi - s.lo
        prof = self.f.createIfcRectangleProfileDef("AREA", None, self.origin2d(size.x / 2, size.y / 2), size.x, size.y)
        return self.f.createIfcExtrudedAreaSolid(prof, self.ax(s.lo, Z_AXIS, X_AXIS), self.d3(Z_AXIS), size.z)

    def _revolve(self, profile, placement, angle: float):
        axis = self.f.createIfcAxis1Placement(self.p3(Vec3(0, 0, 0)), self.d3(Vec3(0, 1, 0)))
        return self.f.createIfcRevolvedAreaSolid(profile, placement, axis, angle * self.angle_scale)

    def frustum(self, s: Frustum):
        # Trapezoid in the local XY plane (local Y = cone axis) revolved about local Y.
        u, x = s.axis, any_perpendicular(s.axis)
        h = (s.b - s.a).length()
        pts = [(0.0, 0.0), (s.ra, 0.0), (s.rb, h), (0.0, h), (0.0, 0.0)]
        poly = self.f.createIfcPolyline([self.f.createIfcCartesianPoint([float(a), float(b)]) for a, b in pts])
        prof = self.f.createIfcArbitraryClosedProfileDef("AREA", None, poly)
        return self._revolve(prof, self.ax(s.a, x.cross(u), x), 2 * math.pi)

    def torus(self, s: TorusArc):
        # Circle at (R, 0) in the local XY plane revolved about local Y (= arc normal).
        x = (s.start - s.center).normalized()
        y = s.normal
        return self._revolve(self.circle(s.radius, s.bend_radius, 0.0), self.ax(s.center, x.cross(y), x), s.angle)

    def sphere(self, s: Sphere):
        return self.f.createIfcSphere(self.ax(s.center, Z_AXIS, X_AXIS), s.radius)

    def item(self, s):
        return {
            Cylinder: self.cylinder,
            Box: self.box,
            Frustum: self.frustum,
            TorusArc: self.torus,
            Sphere: self.sphere,
        }[type(s)](s)


def export_ifc(project: Project, path: str | Path, schema: str = "IFC4", conn: Connectivity | None = None) -> Path:
    _require_ifcopenshell()
    import ifcopenshell.guid
    import ifcopenshell.api.aggregate as aggregate
    import ifcopenshell.api.context as context
    import ifcopenshell.api.project as ifc_project
    import ifcopenshell.api.pset as pset
    import ifcopenshell.api.root as root
    import ifcopenshell.api.system as system
    import ifcopenshell.api.unit as unit
    import ifcopenshell.util.unit as util_unit

    conn = conn or analyse(project)
    cat = default_catalog()
    f = ifc_project.create_file(version=schema)
    ifc_proj = root.create_entity(f, ifc_class="IfcProject", name=project.name)
    mm = unit.add_si_unit(f, unit_type="LENGTHUNIT", prefix="MILLI")
    rad = unit.add_si_unit(f, unit_type="PLANEANGLEUNIT")
    unit.assign_unit(f, units=[mm, rad])
    angle_scale = 1.0 / util_unit.calculate_unit_scale(f, "PLANEANGLEUNIT")

    model_ctx = context.add_context(f, context_type="Model")
    body_ctx = context.add_context(
        f, context_type="Model", context_identifier="Body", target_view="MODEL_VIEW", parent=model_ctx
    )
    geo = _Geo(f, angle_scale)
    world = f.createIfcLocalPlacement(None, geo.ax(Vec3(0, 0, 0), Z_AXIS, X_AXIS))

    site = root.create_entity(f, ifc_class="IfcSite", name=project.plant or project.name)
    building = root.create_entity(f, ifc_class="IfcBuilding", name=project.unit or project.area or "Unit")
    storey = root.create_entity(f, ifc_class="IfcBuildingStorey", name="EL +0")
    for el in (site, building, storey):
        el.ObjectPlacement = world
    aggregate.assign_object(f, products=[site], relating_object=ifc_proj)
    aggregate.assign_object(f, products=[building], relating_object=site)
    aggregate.assign_object(f, products=[storey], relating_object=building)

    elements: dict[str, object] = {}  # component uid -> IFC element
    ports: dict[tuple[str, str], object] = {}  # (component uid, port name) -> IfcDistributionPort

    def shape_rep(shapes):
        items = [geo.item(s) for s in shapes]
        return f.createIfcProductDefinitionShape(
            None, None, [f.createIfcShapeRepresentation(body_ctx, "Body", "SweptSolid", items)]
        )

    def add_ports(el, comp: Component):
        for p in comp.ports:
            port = system.add_port(f, element=el)
            port.Name = p.name if comp.kind != NOZZLE else comp.tag
            port.PredefinedType = "PIPE"
            port.FlowDirection = "SOURCEANDSINK"
            port.ObjectPlacement = f.createIfcLocalPlacement(
                world, geo.ax(p.position, p.direction, any_perpendicular(p.direction))
            )
            ports[(comp.uid, p.name)] = port

    def add_pset(el, values: dict):
        ps = pset.add_pset(f, product=el, name="PlantForge_Common")
        pset.edit_pset(f, pset=ps, properties={k: v for k, v in values.items() if v not in (None, "")})

    contained = []
    for eq in project.equipment.values():
        cls, ptype = EQUIPMENT_CLASS.get(eq.kind.lower(), ("IfcBuildingElementProxy", None))
        el = root.create_entity(f, ifc_class=cls, predefined_type=ptype, name=eq.tag)
        el.Description = eq.description or None
        el.ObjectPlacement = world
        el.Representation = shape_rep([s for c in eq.components() for s in c.shapes])
        for noz in eq.nozzles.values():
            add_ports(el, noz)
            elements[noz.uid] = el
        elements[eq.body.uid] = el
        add_pset(el, {"Tag": eq.tag, "Kind": eq.kind})
        contained.append(el)

    for line in project.lines.values():
        sys_el = system.add_system(f, ifc_class="IfcDistributionSystem")
        sys_el.Name = line.number
        sys_el.Description = f"Spec {line.spec}, NPS {line.nps}" + (f", {line.fluid}" if line.fluid else "")
        members = []
        for c in line.components:
            if c.kind == VALVE:
                cls, ptype, otype = "IfcValve", VALVE_TYPE.get(c.props["valve_type"], "NOTDEFINED"), None
            else:
                cls, ptype, otype = ELEMENT_CLASS[c.kind]
            el = root.create_entity(f, ifc_class=cls, predefined_type=ptype, name=f"{line.number}/{c.tag}")
            if otype:
                el.ObjectType = otype
            el.Description = c.description
            el.Tag = c.tag
            el.ObjectPlacement = world
            el.Representation = shape_rep(c.shapes)
            add_ports(el, c)
            add_pset(
                el,
                {
                    "LineNumber": line.number,
                    "Spec": line.spec,
                    "NPS": c.nps,
                    "DN": cat.dn(c.nps),
                    "Schedule": c.props.get("schedule"),
                    "Length": round(c.props["length"], 1) if c.kind == PIPE else None,
                    "Angle": c.props.get("angle"),
                    "SKEY": c.skey,
                },
            )
            elements[c.uid] = el
            members.append(el)
            contained.append(el)
        if members:
            system.assign_system(f, products=members, system=sys_el)

    # Created directly: the API helper would rewrite the shared world placement.
    f.createIfcRelContainedInSpatialStructure(ifcopenshell.guid.new(), None, None, None, contained, storey)

    for j in conn.joints:
        pa, pb = ports.get((j.a.uid, j.pa.name)), ports.get((j.b.uid, j.pb.name))
        if pa is not None and pb is not None:
            system.connect_port(f, pa, pb)

    out = Path(path)
    f.write(str(out))
    return out

