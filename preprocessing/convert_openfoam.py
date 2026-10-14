"""Convert steady OpenFOAM (simpleFoam) wind cases over Senja to the common schema.

The CFD runs in wind_sim/ cover a ~6 x 6 km box around Segla/Ersfjord on a terrain-
following mesh in local UTM 33 coordinates. Each case becomes one web dataset:

    cell centres + U (last time)  ->  horizontal levels at fixed altitudes (m above sea
    level) on a regular lat/lon grid inside the box  ->  u/v rotated from UTM grid north
    to true north, w (positive up) as is  ->  data/web/<prefix>-<case>/

and the same box gets its own terrain (data/web/<terrain-id>/) from the 10 m Kartverket
DEM, which the viewers load automatically with these datasets (manifest "terrain").

Levels are altitudes, not pressure levels (manifest "level_units": "m ASL"); "height" is
the level itself, so each level is a flat plane that the mountains cut through. Inside the
terrain the wind is 0 (the viewers hide those parts). The surface page's 10 m wind
(u10/v10/w10) is sampled separately at 10 m above ground. There is a single, steady frame
(time 0): the cases are idealised neutral-ABL runs for a given inflow direction and speed,
not forecasts.

Cell centres come from OpenFOAM once per mesh (all cases share it):

    postProcess -func writeCellCentres -time 0 -case <copy of a case>   # writes 0/C

Usage:
    python preprocessing/convert_openfoam.py --centres /path/to/0/C \\
        --domain-info ../wind_sim/case_senja/domain_info.json \\
        --dem ../terrain_norge/7705_2_10m_z33.tif \\
        ../wind_sim/case_senja_U12 ../wind_sim/case_senja_D225_U12 ...
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer
from scipy.interpolate import LinearNDInterpolator
from scipy.ndimage import map_coordinates
from scipy.spatial import Delaunay, cKDTree

from common_schema import build_dataset, export_terrain_web, export_web, update_index
from terrain import resample_to_latlon

ROOT = Path(__file__).resolve().parents[1]
LEVELS_ASL = [50, 150, 300, 500, 700, 1000, 1500]  # summits reach ~800 m, the box top 2363 m
SURFACE_AGL = 10.0
COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
M_PER_DEG_LAT = 111_320.0


def read_vector_field(path: Path) -> np.ndarray:
    """internalField of an ASCII volVectorField (U, C) -> (n, 3)."""
    text = path.read_text()
    m = re.search(r"internalField\s+nonuniform\s+List<vector>\s*(\d+)\s*\(", text)
    if not m:
        raise ValueError(f"{path}: no nonuniform internalField")
    n = int(m.group(1))
    body = text[m.end():].split("\n)", 1)[0]
    arr = np.array(body.replace("(", " ").replace(")", " ").split(), dtype=np.float64).reshape(-1, 3)
    if len(arr) != n:
        raise ValueError(f"{path}: expected {n} vectors, got {len(arr)}")
    return arr


def latest_time(case: Path) -> Path:
    times = [d for d in case.iterdir() if d.is_dir() and re.fullmatch(r"[0-9.]+", d.name) and float(d.name) > 0]
    if not times:
        raise ValueError(f"{case}: no solved time directory")
    return max(times, key=lambda d: float(d.name))


def inflow(case: Path) -> tuple[float, float, float, float]:
    """(flow-toward math angle [deg from +x], Uref [m/s], Zref [m], z0 [m]) from the inlet BC in 0/U."""
    text = (case / "0" / "U").read_text()
    fx, fy = map(float, re.search(r"flowDir\s+\(\s*(\S+)\s+(\S+)\s+\S+\s*\)", text).groups())
    uref = float(re.search(r"Uref\s+([0-9.eE+-]+);", text).group(1))
    zref = float(re.search(r"Zref\s+([0-9.eE+-]+);", text).group(1))
    z0 = float(re.search(r"z0\s+(?:uniform\s+)?([0-9.eE+-]+);", text).group(1))
    return float(np.degrees(np.arctan2(fy, fx)) % 360.0), uref, zref, z0


def from_direction(angle_toward: float) -> float:
    """Math angle the flow goes toward -> meteorological direction it comes from."""
    return (270.0 - angle_toward) % 360.0


class Dem:
    """DEM in local CFD coordinates (metres east/north of the mesh origin)."""

    def __init__(self, tif: Path, origin: tuple[float, float]):
        with rasterio.open(tif) as src:
            self.z = src.read(1).astype(np.float64)
            self.inv = ~src.transform
            if src.nodata is not None:
                self.z[self.z == src.nodata] = np.nan
        self.z = np.where(np.isfinite(self.z) & (self.z > -500), self.z, 0.0)
        self.origin = origin

    def at(self, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        col, row = self.inv * (x + self.origin[0], y + self.origin[1])
        return np.maximum(map_coordinates(self.z, [row - 0.5, col - 0.5], order=1, mode="nearest"), 0.0)


def latlon_box(origin, extent, margin: float):
    """Largest lat/lon rectangle inside the local box [margin, extent - margin]^2."""
    to_ll = Transformer.from_crs(25833, 4326, always_xy=True)
    (x0, y0), (x1, y1) = (origin[0] + margin, origin[1] + margin), (origin[0] + extent[0] - margin, origin[1] + extent[1] - margin)
    lon_sw, lat_sw = to_ll.transform(x0, y0)
    lon_se, lat_se = to_ll.transform(x1, y0)
    lon_nw, lat_nw = to_ll.transform(x0, y1)
    lon_ne, lat_ne = to_ll.transform(x1, y1)
    return {"lat_min": max(lat_sw, lat_se), "lat_max": min(lat_nw, lat_ne),
            "lon_min": max(lon_sw, lon_nw), "lon_max": min(lon_se, lon_ne)}


def grid_axes(LAT, LON):
    """True (east, north) components of the UTM grid's unit x and y vectors at each point."""
    to_utm = Transformer.from_crs(4326, 25833, always_xy=True)
    to_ll = Transformer.from_crs(25833, 4326, always_xy=True)
    x, y = to_utm.transform(LON, LAT)
    axes = []
    for dx, dy in ((1.0, 0.0), (0.0, 1.0)):
        lon2, lat2 = to_ll.transform(x + dx, y + dy)
        e = (lon2 - LON) * M_PER_DEG_LAT * np.cos(np.radians(LAT))
        n = (lat2 - LAT) * M_PER_DEG_LAT
        s = np.hypot(e, n)
        axes.append((e / s, n / s))
    return x, y, axes


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cases", nargs="+", type=Path, help="solved OpenFOAM case directories (same mesh)")
    ap.add_argument("--centres", type=Path, required=True, help="0/C written by writeCellCentres")
    ap.add_argument("--domain-info", type=Path, required=True, help="domain_info.json of the CFD box")
    ap.add_argument("--dem", type=Path, required=True, help="10 m Kartverket DEM tile (EPSG:25833) covering the box")
    ap.add_argument("--levels", type=int, nargs="+", default=LEVELS_ASL, help="altitudes above sea level (m)")
    ap.add_argument("--n", type=int, default=96, help="wind grid points per side")
    ap.add_argument("--terrain-n", type=int, default=256, help="terrain vertices per side")
    ap.add_argument("--margin", type=float, default=250.0,
                    help="metres trimmed off each side of the CFD box (boundary-condition artefacts at the edges)")
    ap.add_argument("--first-cell-radius", type=float, default=75.0,
                    help="horizontal search radius (m) for the lowest cell centre around a column")
    ap.add_argument("--prefix", default="cfd-senja", help="web dataset id prefix")
    ap.add_argument("--terrain-id", default="terrain-cfd-senja")
    args = ap.parse_args()

    info = json.loads(args.domain_info.read_text())
    origin = tuple(info["local_origin_utm33"])
    extent = tuple(info["local_extent_xy"])
    web = ROOT / "data/web"

    # terrain for the CFD box, at the same lat/lon bounds as the wind grid
    bbox = latlon_box(origin, extent, args.margin)
    tlat = np.linspace(bbox["lat_min"], bbox["lat_max"], args.terrain_n)
    tlon = np.linspace(bbox["lon_min"], bbox["lon_max"], args.terrain_n)
    elev = resample_to_latlon(args.dem, tlat, tlon)
    export_terrain_web(elev, tlat, tlon, web / args.terrain_id,
                       f"Kartverket DTM 10 m ({args.dem.name}), CFD box {extent[0] / 1000:.1f} × {extent[1] / 1000:.1f} km")
    tm = json.loads((web / args.terrain_id / "manifest.json").read_text())
    tm["label"] = "Senja CFD box (Kartverket 10 m)"
    (web / args.terrain_id / "manifest.json").write_text(json.dumps(tm, indent=1))
    print(f"terrain {args.terrain_id}: {args.terrain_n}² over {bbox}")

    # wind grid and its targets in local CFD coordinates (x, y, height above ground)
    lat = np.linspace(bbox["lat_min"], bbox["lat_max"], args.n)
    lon = np.linspace(bbox["lon_min"], bbox["lon_max"], args.n)
    LAT, LON = np.meshgrid(lat, lon, indexing="ij")
    X, Y, (ex, ey) = grid_axes(LAT, LON)
    X, Y = X - origin[0], Y - origin[1]
    dem = Dem(args.dem, origin)
    ground = dem.at(X, Y)
    nl = len(args.levels)
    # targets as heights above the DEM: the ASL levels, plus 10 m above ground for u10/v10
    agl = np.concatenate([np.array(args.levels, float)[:, None, None] - ground[None], np.full((1, *X.shape), SURFACE_AGL)])
    inside = agl <= 0.0  # level below the ground here: no wind

    # cell centres as (x, y, z above the DEM); one triangulation serves every case
    C = read_vector_field(args.centres)
    src = np.column_stack([C[:, 0], C[:, 1], C[:, 2] - dem.at(C[:, 0], C[:, 1])])
    # Height of the lowest cell centre around each column (17 m over the sea, where the cells
    # are ~35 m tall). Below it there is no data to interpolate between, so the wind is taken
    # there and extrapolated down with the log law of the rough wall function.
    near = cKDTree(src[:, :2]).query_ball_point(np.column_stack([X.ravel(), Y.ravel()]), r=args.first_cell_radius)
    z1 = np.array([src[i, 2].min() for i in near]).reshape(X.shape)
    z_eval = np.maximum(agl, z1[None])
    below = (agl < z_eval) & ~inside
    tgt = np.stack([np.broadcast_to(X, agl.shape), np.broadcast_to(Y, agl.shape), z_eval], axis=-1).reshape(-1, 3)
    print(f"{len(C)} cells, triangulating ...")
    tri = Delaunay(src)
    nearest = cKDTree(src).query(tgt)[1]
    height = np.broadcast_to(np.array(args.levels, np.float32)[:, None, None], (nl, *X.shape))

    for case in args.cases:
        tdir = latest_time(case)
        U = read_vector_field(tdir / "U")
        if len(U) != len(C):
            raise ValueError(f"{case}: {len(U)} cells, mesh has {len(C)}")
        Ug = LinearNDInterpolator(tri, U)(tgt)
        miss = ~np.isfinite(Ug).all(axis=1)
        Ug[miss] = U[nearest[miss]]
        toward, uref, zref, z0 = inflow(case)
        with np.errstate(invalid="ignore"):  # NaN only inside the terrain, zeroed next
            log_factor = np.where(below, np.log((np.maximum(agl, 0) + z0) / z0) / np.log((z_eval + z0) / z0), 1.0)
        log_factor[inside] = 0.0
        # w below the first cell centre is scaled like the horizontal wind (w ~ V·∇h near the ground)
        ux, uy, w = (a.reshape(nl + 1, *X.shape) * log_factor for a in Ug.T)
        u = ux * ex[0] + uy * ey[0]  # UTM grid components -> true east / north
        v = ux * ex[1] + uy * ey[1]

        frm = from_direction(toward)
        point = COMPASS[int(round(frm / 22.5)) % 16]
        cid = f"{args.prefix}-{point.lower()}-u{int(round(uref)):02d}"
        ds = build_dataset(
            u[None, :nl], v[None, :nl], height=height[None], lead_hours=[0], levels=args.levels, lat=lat, lon=lon,
            surface={"u10": u[None, nl], "v10": v[None, nl], "w10": w[None, nl]}, w=w[None, :nl],
            attrs={
                "model": "OpenFOAM CFD",
                "init_time": "steady",
                "description": (f"Steady RANS (simpleFoam, k-ε) over the Senja CFD box, case {case.name}: "
                                f"neutral log-law inflow from {frm:.0f}° ({point}) at {uref:g} m/s at {zref:g} m, "
                                f"solution at iteration {tdir.name}. Interpolated from {len(C):,} cells to flat levels at "
                                f"{', '.join(map(str, args.levels))} m above sea level (cut by the terrain), and to "
                                f"{SURFACE_AGL:g} m above ground for the surface wind; below the first cell centre "
                                f"log-law extrapolated with z0 = {z0:g} m. Includes the vertical wind w (positive up)."),
                "native_deg": 100.0 / M_PER_DEG_LAT,  # ~100 m background mesh
            },
        )
        export_web(ds, web / cid)
        m = json.loads((web / cid / "manifest.json").read_text())
        m.update(label=f"CFD · from {point} {uref:g} m/s", level_units="m ASL", terrain=args.terrain_id, group="CFD cases · CFD box",
                 case=case.name, inflow={"from_deg": frm, "uref": uref, "zref": zref, "z0": z0})
        (web / cid / "manifest.json").write_text(json.dumps(m, indent=1))
        s10 = np.hypot(u[nl], v[nl])
        print(f"{case.name} -> {cid}: 10 m AGL {s10.min():.1f}..{s10.max():.1f} m/s, |w| max {np.abs(w).max():.1f} m/s; inside terrain "
              + ", ".join(f"{lv} m {inside[k].mean():.0%}" for k, lv in enumerate(args.levels) if inside[k].any()))

    update_index(web)


if __name__ == "__main__":
    main()
