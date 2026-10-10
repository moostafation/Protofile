import pytest

from plantforge.catalog import CatalogError, default_catalog, normalize_nps, nps_value
from plantforge.spec import SpecError, load_spec


@pytest.mark.parametrize(
    "raw, key",
    [(4, "4"), (4.0, "4"), ("4", "4"), ('4"', "4"), (1.5, "1-1/2"), ("1 1/2", "1-1/2"), ("1/2", "1/2"), (0.75, "3/4")],
)
def test_normalize_nps(raw, key):
    assert normalize_nps(raw) == key


def test_nps_value():
    assert nps_value("1-1/2") == 1.5
    assert nps_value("3/4") == 0.75
    assert nps_value("24") == 24.0


def test_pipe_dimensions_and_weight():
    p = default_catalog().pipe("4", "STD")
    assert (p.od, p.wall, p.dn) == (114.3, 6.02, 100)
    assert p.weight_per_m == pytest.approx(16.07, abs=0.02)  # ASME B36.10M table value


def test_fittings_and_flanges():
    cat = default_catalog()
    assert cat.elbow90_lr("6") == 229
    assert cat.tee("4") == 105
    fl = cat.flange("4", "CL150")
    assert fl.bolts == 8 and fl.bolt_dia == "5/8"
    assert fl.length == pytest.approx(76.6)  # Y + 1.6 mm raised face


def test_missing_data_is_an_error():
    cat = default_catalog()
    with pytest.raises(CatalogError):
        cat.pipe("5", "STD")
    with pytest.raises(CatalogError):
        cat.flange("4", "CL300")


def test_spec_selects_schedule_by_size():
    spec = load_spec("A1A")
    assert spec.schedule("1") == "80"
    assert spec.schedule("8") == "STD"
    _, desc = spec.pipe("8")
    assert desc.endswith("SCH STD")
    assert spec.bw_description("tee", "1").endswith("SCH 80")


def test_spec_rejects_unknown_valve():
    spec = load_spec("A1A")
    with pytest.raises(SpecError, match="not allowed"):
        spec.valve("butterfly", "4")
    with pytest.raises(SpecError):
        spec.valve("check", "1")  # no catalog data for small check valves
