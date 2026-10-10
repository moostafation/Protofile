"""PlantForge - an open-source, spec-driven plant & piping design engine."""

from .catalog import Catalog, CatalogError, default_catalog, normalize_nps
from .clash import Clash, find_clashes
from .connectivity import analyse
from .geom import Vec3
from .model import Component, Equipment, Pipeline, Port, Project
from .mto import material_takeoff
from .project_io import ProjectError, build_project, load_project
from .routing import End, Inline, RoutingError, route_line
from .spec import PipingSpec, SpecError, load_spec

__version__ = "0.1.0"

__all__ = [
    "Catalog",
    "CatalogError",
    "Clash",
    "Component",
    "End",
    "Equipment",
    "Inline",
    "Pipeline",
    "PipingSpec",
    "Port",
    "Project",
    "ProjectError",
    "RoutingError",
    "SpecError",
    "Vec3",
    "analyse",
    "build_project",
    "default_catalog",
    "find_clashes",
    "load_project",
    "load_spec",
    "material_takeoff",
    "normalize_nps",
    "route_line",
]
