"""Reference data (the "catalog"): standard dimensions of pipe, fittings, flanges and valves.

The data lives in JSON files under ``plantforge/data`` so that engineers can extend
it without touching code. Every lookup raises :class:`CatalogError` with a clear
message when a size or type is missing, instead of silently inventing a dimension.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from fractions import Fraction
from functools import lru_cache
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"
INCH = 25.4


class CatalogError(LookupError):
    pass


def nps_value(nps: str) -> float:
    """Numeric value in inches of an NPS string: ``"1-1/2"`` -> 1.5."""
    whole, _, frac = nps.partition("-")
    if "/" in whole:  # "1/2"
        return float(Fraction(whole))
    return float(whole) + (float(Fraction(frac)) if frac else 0.0)


def normalize_nps(nps: str | int | float) -> str:
    """Accept ``4``, ``4.0``, ``"4"``, ``'4"'``, ``1.5`` or ``"1 1/2"`` and return the catalog key."""
    if isinstance(nps, (int, float)):
        value = Fraction(nps).limit_denominator(8)
    else:
        s = str(nps).strip().replace('"', "").replace("in", "").strip()
        s = s.replace(" ", "-")
        try:
            value = Fraction(nps_value(s)).limit_denominator(8)
        except (ValueError, ZeroDivisionError) as exc:
            raise CatalogError(f"not a valid NPS: {nps!r}") from exc
    whole, rem = divmod(value, 1)
    if rem == 0:
        return str(int(whole))
    if whole == 0:
        return f"{rem.numerator}/{rem.denominator}"
    return f"{int(whole)}-{rem.numerator}/{rem.denominator}"


def inch_fraction_to_mm(s: str) -> float:
    return nps_value(s) * INCH


@lru_cache(maxsize=None)
def _load(name: str) -> dict:
    with open(DATA_DIR / name, encoding="utf-8") as fh:
        return json.load(fh)


@dataclass(frozen=True)
class PipeData:
    nps: str
    dn: int
    od: float
    wall: float
    schedule: str

    @property
    def weight_per_m(self) -> float:
        """Plain-end steel pipe mass in kg/m (ASME B36.10M formula, steel density 7850 kg/m3)."""
        return 0.0246615 * (self.od - self.wall) * self.wall


@dataclass(frozen=True)
class FlangeData:
    nps: str
    rating: str
    o: float
    tf: float
    y: float
    rf_height: float
    rf_dia: float
    hub_dia: float
    bc: float
    bolts: int
    bolt_dia: str

    @property
    def length(self) -> float:
        """Raised-face contact surface to weld end (what routing needs)."""
        return self.y + self.rf_height

    @property
    def bolt_dia_mm(self) -> float:
        return inch_fraction_to_mm(self.bolt_dia)


class Catalog:
    """Read-only access to the standard dimension tables."""

    def __init__(self) -> None:
        self._pipe = _load("pipe_b36_10.json")["sizes"]
        self._fit = _load("fittings_b16_9.json")["sizes"]
        fl = _load("flanges_b16_5_cl150.json")
        self._flanges = {fl["rating"]: fl}
        vv = _load("valves_b16_10_cl150.json")
        self._valves = {vv["rating"]: vv["types"]}

    # -- sizes ---------------------------------------------------------------
    @property
    def sizes(self) -> list[str]:
        return sorted(self._pipe, key=nps_value)

    def _size(self, table: dict, nps: str, what: str) -> dict:
        key = normalize_nps(nps)
        try:
            return table[key]
        except KeyError:
            raise CatalogError(f"{what}: no catalog data for NPS {key}") from None

    def dn(self, nps: str) -> int:
        return self._size(self._pipe, nps, "pipe")["dn"]

    def od(self, nps: str) -> float:
        return self._size(self._pipe, nps, "pipe")["od"]

    # -- parts ---------------------------------------------------------------
    def pipe(self, nps: str, schedule: str) -> PipeData:
        row = self._size(self._pipe, nps, "pipe")
        try:
            wall = row["wall"][schedule]
        except KeyError:
            raise CatalogError(f"pipe NPS {normalize_nps(nps)}: no schedule {schedule!r}") from None
        return PipeData(normalize_nps(nps), row["dn"], row["od"], wall, schedule)

    def elbow90_lr(self, nps: str) -> float:
        return self._size(self._fit, nps, "90deg LR elbow")["elbow90_lr"]

    def elbow45_lr(self, nps: str) -> float:
        return self._size(self._fit, nps, "45deg LR elbow")["elbow45_lr"]

    def tee(self, nps: str) -> float:
        return self._size(self._fit, nps, "equal tee")["tee"]

    def flange(self, nps: str, rating: str) -> FlangeData:
        try:
            table = self._flanges[rating]
        except KeyError:
            raise CatalogError(f"no flange data for rating {rating}") from None
        row = self._size(table["sizes"], nps, f"{rating} flange")
        return FlangeData(normalize_nps(nps), rating, rf_height=table["rf_height"], **row)

    def valve_length(self, valve_type: str, nps: str, rating: str) -> float:
        try:
            table = self._valves[rating][valve_type]
        except KeyError:
            raise CatalogError(f"no {rating} data for valve type {valve_type!r}") from None
        return float(self._size(table, nps, f"{rating} {valve_type} valve"))


@lru_cache(maxsize=1)
def default_catalog() -> Catalog:
    return Catalog()
