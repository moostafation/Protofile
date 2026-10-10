"""Exports that depend on optional packages (IfcOpenShell, ezdxf)."""

from pathlib import Path

import pytest

from plantforge import load_project

DEMO = Path(__file__).resolve().parents[1] / "examples" / "demo_plant.toml"


@pytest.fixture(scope="module")
def project():
    return load_project(DEMO)


def test_ifc_export_is_valid_and_connected(project, tmp_path):
    ifcopenshell = pytest.importorskip("ifcopenshell")
    import ifcopenshell.geom

    from plantforge.export.ifc import export_ifc

    path = export_ifc(project, tmp_path / "model.ifc")
    f = ifcopenshell.open(str(path))
    n_line_parts = sum(len(l.components) for l in project.lines.values())
    parts = f.by_type("IfcPipeSegment") + f.by_type("IfcPipeFitting") + f.by_type("IfcValve")
    assert len(parts) == n_line_parts
    assert len(f.by_type("IfcDistributionSystem")) == 4
    assert f.by_type("IfcPump") and f.by_type("IfcTank")
    assert f.by_type("IfcRelConnectsPorts")

    settings = ifcopenshell.geom.settings()
    settings.set("use-world-coords", True)
    for el in f.by_type("IfcProduct"):
        if el.Representation:
            ifcopenshell.geom.create_shape(settings, el)  # raises if any solid is invalid

    # Elbow geometry must bend toward the outlet (checks the revolve direction).
    elbow = project.find('4"-P-1001-A1A/E1')
    ifc_elbow = next(e for e in f.by_type("IfcPipeFitting") if e.Name == elbow.uid)
    verts = ifcopenshell.geom.create_shape(settings, ifc_elbow).geometry.verts
    ys, zs = [v * 1000 for v in verts[1::3]], [v * 1000 for v in verts[2::3]]
    start, end, r = elbow.port("P1").position, elbow.port("P2").position, elbow.shapes[0].radius
    # Runs up (+Z) from `start`, turns north (+Y) and ends at `end`.
    assert min(ys) == pytest.approx(start.y - r, abs=1)
    assert max(ys) == pytest.approx(end.y, abs=1)
    assert min(zs) == pytest.approx(start.z, abs=1)
    assert max(zs) == pytest.approx(end.z + r, abs=1)


def test_isometric_dxf(project, tmp_path):
    ezdxf = pytest.importorskip("ezdxf")
    from plantforge.export.iso import write_isometrics

    paths = write_isometrics(project, tmp_path)
    assert len(paths) == 4
    doc = ezdxf.readfile(str(paths[0]))
    texts = [t.dxf.text for t in doc.modelspace().query("TEXT")]
    assert any(t.startswith("LINE 4\"-P-1001-A1A") for t in texts)
    assert "BILL OF MATERIALS" in texts
