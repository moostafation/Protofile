from pathlib import Path

import pytest

from plantforge import ProjectError, analyse, build_project, find_clashes, load_project, material_takeoff
from plantforge.__main__ import main
from plantforge.export.pcf import line_to_pcf
from plantforge.export.viewer import build_viewer_data, render_viewer
from plantforge.model import NOZZLE, TEE

DEMO = Path(__file__).resolve().parents[1] / "examples" / "demo_plant.toml"


@pytest.fixture(scope="module")
def project():
    return load_project(DEMO)


def test_demo_loads(project):
    assert list(project.lines) == ['4"-P-1001-A1A', '4"-P-1002-A1A', '6"-P-1003-A1A', '6"-P-1004-A1A']
    assert set(project.equipment) == {"P-101A", "V-101"}


def test_demo_connectivity(project):
    conn = analyse(project)
    assert conn.problems == []
    # Only the three free flanged ends are open; nozzles and the tee branch are connected.
    assert sorted(c.uid for c, _ in conn.open_ports) == [
        '4"-P-1002-A1A/F3',
        '6"-P-1003-A1A/F4',
        '6"-P-1004-A1A/F2',
    ]
    nozzle_joints = [j for j in conn.joints if NOZZLE in (j.a.kind, j.b.kind)]
    assert len(nozzle_joints) == 4
    tee_branch = [j for j in conn.joints if (j.a.kind == TEE and j.pa.name == "BR") or (j.b.kind == TEE and j.pb.name == "BR")]
    assert len(tee_branch) == 1 and tee_branch[0].is_weld


def test_demo_clash_is_found(project):
    clashes = find_clashes(project)
    assert len(clashes) == 1
    c = clashes[0]
    assert c.hard and {c.a, c.b} == {'4"-P-1001-A1A/P4', '6"-P-1004-A1A/P3'}
    assert abs(c.point.x - 500) < 120 and abs(c.point.y - 1000) < 120 and abs(c.point.z - 3500) < 1


def test_connected_parts_are_not_clearance_clashes(project):
    # Nozzle flange vs pipe flange across a gasket, branch pipe beside its tee: close by design.
    clashes = find_clashes(project, clearance=100)
    assert [(c.a, c.b, c.hard) for c in clashes] == [('4"-P-1001-A1A/P4', '6"-P-1004-A1A/P3', True)]


def test_lowering_the_rack_line_clears_the_clash():
    import tomllib

    data = tomllib.loads(DEMO.read_text())
    rack = next(l for l in data["lines"] if l["number"] == '6"-P-1004-A1A')
    rack["points"] = [[6000, 1000, 1500], [6000, 1000, 3000], [-1000, 1000, 3000]]
    assert find_clashes(build_project(data, base_dir=DEMO.parent)) == []


def test_mto_totals(project):
    mto = material_takeoff(project)
    def total(kind, nps=None):
        return sum(r.quantity for r in mto.rows if r.kind == kind and (nps is None or r.nps == nps))

    assert total("VALVE", "4") == 3  # check + gate on P-1001, gate on P-1002
    assert total("ELBOW") == 10
    gaskets, bolting = total("GASKET"), total("BOLTING")
    assert gaskets == bolting == 12  # 4 valves x 2 + 4 nozzle joints
    pipe_m = sum(r.quantity for r in mto.rows if r.kind == "PIPE")
    assert pipe_m == pytest.approx(sum(l.pipe_length for l in project.lines.values()) / 1000)
    assert mto.weld_count == len(analyse(project).welds)
    assert "Butt welds" in mto.to_csv()


def test_pcf(project):
    text = line_to_pcf(project, project.lines['4"-P-1001-A1A'])
    assert text.startswith("ISOGEN-FILES")
    assert "PIPELINE-REFERENCE 4\"-P-1001-A1A" in text
    assert text.count("\nELBOW\n") == 4
    assert text.count("\nTEE\n") == 1 and "BRANCH1-POINT" in text
    assert "    SKEY CKFL" in text and "\nMATERIALS\n" in text


def test_viewer_data(project):
    data = build_viewer_data(project)
    assert data["stats"]["lines"] == 4
    assert len(data["clashes"]) == 1
    assert {c["uid"] for c in data["components"]} >= {'V-101/BODY', '4"-P-1001-A1A/T1'}
    html = render_viewer(project)
    assert html.startswith("<!doctype html>") and "</script>" in html
    fragment = render_viewer(project, standalone=False)
    assert fragment.startswith("<title>")


def test_unknown_nozzle_reference():
    data = {
        "project": {"name": "x"},
        "lines": [{"number": "L1", "spec": "A1A", "nps": 4, "from": "P-1/N9", "points": [[0, 0, 1000]]}],
    }
    with pytest.raises(ProjectError, match="unknown nozzle"):
        build_project(data)


def test_cli_build(tmp_path):
    rc = main(["build", str(DEMO), "-o", str(tmp_path), "--no-ifc", "--no-iso"])
    assert rc == 0
    assert (tmp_path / "model.html").exists() and (tmp_path / "mto.csv").exists()
    assert len(list((tmp_path / "pcf").glob("*.pcf"))) == 4
    assert "HARD" in (tmp_path / "report.txt").read_text()
    assert main(["check", str(DEMO)]) == 2  # hard clash -> non-zero for CI
