"""Piping specifications (pipe classes).

A spec selects parts by size and service; the catalog supplies their dimensions.
Specs are TOML files so that a piping engineer can write one without code.
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from .catalog import Catalog, CatalogError, FlangeData, PipeData, default_catalog, normalize_nps, nps_value

SPEC_DIR = Path(__file__).parent / "specs"


class SpecError(ValueError):
    pass


@dataclass(frozen=True)
class PartRule:
    description: str
    skey: str = ""


@dataclass(frozen=True)
class PipeRule:
    lo: float
    hi: float
    schedule: str
    description: str

    def covers(self, nps: str) -> bool:
        return self.lo <= nps_value(nps) <= self.hi


@dataclass
class PipingSpec:
    name: str
    description: str
    rating: str
    material: str
    corrosion_allowance: float
    min_pipe_length: float
    gasket_thickness: float
    pipe_rules: list[PipeRule]
    parts: dict[str, PartRule]
    valves: dict[str, PartRule]
    catalog: Catalog = field(default_factory=default_catalog, repr=False)

    # -- loading ---------------------------------------------------------------
    @classmethod
    def from_toml(cls, path: str | Path, catalog: Catalog | None = None) -> "PipingSpec":
        with open(path, "rb") as fh:
            data = tomllib.load(fh)
        return cls.from_dict(data, catalog)

    @classmethod
    def from_dict(cls, data: dict, catalog: Catalog | None = None) -> "PipingSpec":
        try:
            rules = [
                PipeRule(
                    nps_value(normalize_nps(r["from"])),
                    nps_value(normalize_nps(r["to"])),
                    str(r["schedule"]),
                    r["description"],
                )
                for r in data["pipe"]
            ]
            parts = {
                key: PartRule(data[key]["description"], data[key].get("skey", ""))
                for key in ("elbow90", "elbow45", "tee", "flange", "gasket", "bolting")
                if key in data
            }
            valves = {
                vtype: PartRule(v["description"], v.get("skey", ""))
                for vtype, v in data.get("valve", {}).items()
            }
            return cls(
                name=data["name"],
                description=data.get("description", ""),
                rating=data["rating"],
                material=data.get("material", ""),
                corrosion_allowance=float(data.get("corrosion_allowance", 0.0)),
                min_pipe_length=float(data.get("min_pipe_length", 50.0)),
                gasket_thickness=float(data.get("gasket_thickness", 3.0)),
                pipe_rules=rules,
                parts=parts,
                valves=valves,
                catalog=catalog or default_catalog(),
            )
        except KeyError as exc:
            raise SpecError(f"spec is missing required key {exc}") from None

    # -- selection -------------------------------------------------------------
    def _rule(self, nps: str) -> PipeRule:
        for rule in self.pipe_rules:
            if rule.covers(nps):
                return rule
        raise SpecError(f"spec {self.name}: NPS {normalize_nps(nps)} is not allowed")

    def part(self, key: str) -> PartRule:
        try:
            return self.parts[key]
        except KeyError:
            raise SpecError(f"spec {self.name}: no {key} defined") from None

    def schedule(self, nps: str) -> str:
        return self._rule(nps).schedule

    def pipe(self, nps: str) -> tuple[PipeData, str]:
        rule = self._rule(nps)
        return self.catalog.pipe(nps, rule.schedule), f"{rule.description}, SCH {rule.schedule}"

    def bw_description(self, key: str, nps: str) -> str:
        """Butt-weld fittings take the wall thickness (schedule) of the connected pipe."""
        return f"{self.part(key).description}, SCH {self.schedule(nps)}"

    def flange(self, nps: str) -> FlangeData:
        return self.catalog.flange(nps, self.rating)

    def valve(self, valve_type: str, nps: str) -> tuple[float, PartRule]:
        try:
            rule = self.valves[valve_type]
        except KeyError:
            raise SpecError(
                f"spec {self.name}: valve type {valve_type!r} not allowed "
                f"(allowed: {', '.join(sorted(self.valves)) or 'none'})"
            ) from None
        try:
            return self.catalog.valve_length(valve_type, nps, self.rating), rule
        except CatalogError as exc:
            raise SpecError(str(exc)) from None


def load_spec(name_or_path: str, catalog: Catalog | None = None) -> PipingSpec:
    """Load a spec by name from the bundled ``specs`` folder, or from a path."""
    path = Path(name_or_path)
    if not path.suffix:
        path = SPEC_DIR / f"{name_or_path}.toml"
    if not path.exists():
        raise SpecError(f"spec not found: {name_or_path}")
    return PipingSpec.from_toml(path, catalog)
