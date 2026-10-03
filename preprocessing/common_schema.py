"""Common Wind Schema shared by every model converter.

Every source (FCN3, GraphCast, ERA5, CARRA, U-NO, GNO, NOFE) is
converted to the same xarray Dataset before it reaches the viewer:

    dims:       time (lead hours), level (hPa), latitude, longitude
    variables:  u, v            [m s-1]   (t, level, lat, lon)
                height          [m]       geopotential height Phi / g
                wind_speed      [m s-1]   sqrt(u^2 + v^2)
    optional:   u10, v10        [m s-1]   (t, lat, lon) 10 m wind
    attrs:      model, init_time, bbox, native_deg (model grid spacing), ...

`export_web` then writes the browser-facing format: one manifest.json plus
one little-endian float32 .bin file per variable, laid out C-order as
(time, level, lat, lon) with latitude ascending (south -> north). Surface
fields are listed under "surface" in the manifest and laid out (time, lat, lon).
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import xarray as xr

G = 9.80665  # m s-2

# Senja MVP domain (approx. 50 km x 50 km, ocean + fjords + steep mountains)
SENJA_BBOX = {
    "lat_min": 69.15,
    "lat_max": 69.60,
    "lon_min": 16.95,
    "lon_max": 18.25,
}

LEVELS_HPA = [1000, 925, 850, 700, 500]
LEAD_HOURS = [0, 6, 12, 18, 24]
VARIABLES = ["u", "v", "height", "wind_speed"]
SURFACE_VARIABLES = {"u10": "10 m zonal wind", "v10": "10 m meridional wind"}


def target_grid(ny: int = 64, nx: int = 64, bbox: dict = SENJA_BBOX):
    """Regular lat/lon grid (ascending) covering the Senja domain."""
    lat = np.linspace(bbox["lat_min"], bbox["lat_max"], ny)
    lon = np.linspace(bbox["lon_min"], bbox["lon_max"], nx)
    return lat, lon


def build_dataset(
    u: np.ndarray,
    v: np.ndarray,
    geopotential: np.ndarray | None = None,
    height: np.ndarray | None = None,
    *,
    lead_hours,
    levels,
    lat,
    lon,
    attrs: dict,
    surface: dict[str, np.ndarray] | None = None,
) -> xr.Dataset:
    """Assemble a common-schema Dataset. Arrays are (time, level, lat, lon);
    optional `surface` fields (SURFACE_VARIABLES) are (time, lat, lon)."""
    if height is None:
        if geopotential is None:
            raise ValueError("need either geopotential or height")
        height = geopotential / G
    speed = np.sqrt(u**2 + v**2)
    dims = ("time", "level", "latitude", "longitude")
    ds = xr.Dataset(
        {
            "u": (dims, u.astype(np.float32), {"units": "m s-1", "long_name": "zonal wind"}),
            "v": (dims, v.astype(np.float32), {"units": "m s-1", "long_name": "meridional wind"}),
            "height": (dims, height.astype(np.float32), {"units": "m", "long_name": "geopotential height"}),
            "wind_speed": (dims, speed.astype(np.float32), {"units": "m s-1", "long_name": "horizontal wind speed"}),
        },
        coords={
            "time": ("time", np.asarray(lead_hours, dtype=np.int32), {"units": "hours since init_time"}),
            "level": ("level", np.asarray(levels, dtype=np.int32), {"units": "hPa"}),
            "latitude": ("latitude", np.asarray(lat, dtype=np.float64), {"units": "degrees_north"}),
            "longitude": ("longitude", np.asarray(lon, dtype=np.float64), {"units": "degrees_east"}),
        },
        attrs={"schema": "senja-common-wind-v1", **attrs},
    )
    for name, arr in (surface or {}).items():
        if name not in SURFACE_VARIABLES:
            raise ValueError(f"unknown surface variable {name}")
        ds[name] = (("time", "latitude", "longitude"), arr.astype(np.float32),
                    {"units": "m s-1", "long_name": SURFACE_VARIABLES[name]})
    validate(ds)
    return ds


def validate(ds: xr.Dataset) -> None:
    for name in VARIABLES:
        if name not in ds:
            raise ValueError(f"missing variable {name}")
        if ds[name].dims != ("time", "level", "latitude", "longitude"):
            raise ValueError(f"{name} has dims {ds[name].dims}")
        if not np.isfinite(ds[name].values).all():
            raise ValueError(f"{name} contains non-finite values")
    for name in SURFACE_VARIABLES:
        if name in ds:
            if ds[name].dims != ("time", "latitude", "longitude"):
                raise ValueError(f"{name} has dims {ds[name].dims}")
            if not np.isfinite(ds[name].values).all():
                raise ValueError(f"{name} contains non-finite values")
    if not (np.diff(ds.latitude.values) > 0).all():
        raise ValueError("latitude must be ascending")
    if not (np.diff(ds.longitude.values) > 0).all():
        raise ValueError("longitude must be ascending")


def write_zarr(ds: xr.Dataset, path: str | Path) -> None:
    ds.to_zarr(str(path), mode="w", zarr_format=2, consolidated=True)


def export_web(ds: xr.Dataset, out_dir: str | Path) -> Path:
    """Write manifest.json + <var>.bin (float32 LE) for the browser."""
    validate(ds)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    variables = {}
    for name in VARIABLES:
        arr = np.ascontiguousarray(ds[name].values, dtype="<f4")
        arr.tofile(out / f"{name}.bin")
        variables[name] = {
            "file": f"{name}.bin",
            "units": ds[name].attrs.get("units", ""),
            "min": float(arr.min()),
            "max": float(arr.max()),
        }
    surface = {}
    for name in SURFACE_VARIABLES:
        if name not in ds:
            continue
        arr = np.ascontiguousarray(ds[name].values, dtype="<f4")
        arr.tofile(out / f"{name}.bin")
        surface[name] = {"file": f"{name}.bin", "units": "m s-1", "min": float(arr.min()), "max": float(arr.max())}
    manifest = {
        "schema": ds.attrs.get("schema", "senja-common-wind-v1"),
        "model": ds.attrs.get("model", "unknown"),
        "init_time": ds.attrs.get("init_time", ""),
        "description": ds.attrs.get("description", ""),
        "shape": [int(ds.sizes[d]) for d in ("time", "level", "latitude", "longitude")],
        "times": [int(t) for t in ds.time.values],
        "levels": [int(p) for p in ds.level.values],
        "lat": [float(x) for x in ds.latitude.values],
        "lon": [float(x) for x in ds.longitude.values],
        "variables": variables,
    }
    if surface:
        manifest["surface"] = surface
    if "native_deg" in ds.attrs:  # spacing of the model's own lat/lon grid
        manifest["native_deg"] = float(ds.attrs["native_deg"])
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1))
    update_index(out.parent)
    return out / "manifest.json"


def export_terrain_web(elev: np.ndarray, lat, lon, out_dir: str | Path, source: str) -> Path:
    """Terrain on a regular lat/lon grid, latitude ascending, (lat, lon)."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    arr = np.ascontiguousarray(elev, dtype="<f4")
    arr.tofile(out / "elevation.bin")
    manifest = {
        "source": source,
        "shape": list(arr.shape),
        "lat": [float(x) for x in lat],
        "lon": [float(x) for x in lon],
        "file": "elevation.bin",
        "min": float(arr.min()),
        "max": float(arr.max()),
        "units": "m",
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1))
    update_index(out.parent)
    return out / "manifest.json"


def update_index(web_root: str | Path) -> Path:
    """Rebuild data/web/index.json listing every wind dataset and terrain."""
    root = Path(web_root)
    datasets, terrains = [], []
    for m in sorted(root.glob("*/manifest.json")):
        meta = json.loads(m.read_text())
        entry_id = m.parent.name
        if "schema" in meta:
            init = meta.get("init_time", "")
            label = meta["model"] + (f" · {init.replace('T', ' ')}Z" if init[:2].isdigit() else "")
            datasets.append({"id": entry_id, "label": label})
        elif meta.get("file") == "elevation.bin":
            terrains.append({"id": entry_id, "label": "Senja DTM (Kartverket)"})
    index = {"datasets": datasets, "terrains": terrains}
    (root / "index.json").write_text(json.dumps(index, indent=1))
    return root / "index.json"
