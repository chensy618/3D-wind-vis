"""Convert a cropped FCN3 forecast (model/fcn3_inference.py) to the common schema.

    raw 0.25 deg u/v/z (+ u10m/v10m)  ->  Senja grid (bilinear)  ->  height = z / g
    ->  data/forecast/fcn3_<init>.zarr  +  data/web/fcn3/

Note: FCN3 has ~10 km (E-W) x 28 km (N-S) grid spacing at 69N, so the 64x64
Senja grid is a smooth interpolation of only a handful of model points. The
viewer is built so that higher-resolution models can replace it unchanged.

Usage:
    python preprocessing/convert_fcn3.py data/forecast/fcn3_2024013106.nc
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import xarray as xr
from scipy.interpolate import RegularGridInterpolator

from common_schema import LEVELS_HPA, build_dataset, export_web, target_grid, write_zarr

ROOT = Path(__file__).resolve().parents[1]


def regrid(field: np.ndarray, src_lat, src_lon, lat, lon) -> np.ndarray:
    f = RegularGridInterpolator((src_lat, src_lon), field, method="linear")
    LAT, LON = np.meshgrid(lat, lon, indexing="ij")
    return f(np.stack([LAT, LON], axis=-1))


def convert(raw_path: Path, ny: int, nx: int, name: str) -> xr.Dataset:
    raw = xr.open_dataset(raw_path)["fcn3"]
    src_lat, src_lon = raw.lat.values, raw.lon.values
    lat, lon = target_grid(ny, nx)
    leads = [int(x) for x in raw.lead_time.values]

    out = {c: np.empty((len(leads), len(LEVELS_HPA), ny, nx), np.float32) for c in "uvz"}
    for it in range(len(leads)):
        for il, p in enumerate(LEVELS_HPA):
            for c in "uvz":
                field = raw.isel(lead_time=it).sel(variable=f"{c}{p}").values
                out[c][it, il] = regrid(field, src_lat, src_lon, lat, lon)

    # 10 m wind, present in runs of model/fcn3_inference.py that kept it
    surface = {}
    if {"u10m", "v10m"} <= set(raw.coords["variable"].values.tolist()):
        for key, var in (("u10", "u10m"), ("v10", "v10m")):
            surface[key] = np.stack([
                regrid(raw.isel(lead_time=it).sel(variable=var).values, src_lat, src_lon, lat, lon)
                for it in range(len(leads))
            ])

    return build_dataset(
        out["u"], out["v"], geopotential=out["z"],
        lead_hours=leads, levels=LEVELS_HPA, lat=lat, lon=lon,
        attrs={
            "model": name,
            "init_time": raw.attrs.get("init_time", ""),
            "native_deg": float(abs(src_lat[1] - src_lat[0])),
            "description": f"{raw.attrs.get('model', name)}; IC source {raw.attrs.get('source', '?')}; "
                           "0.25 deg output bilinearly interpolated to the Senja grid",
        },
        surface=surface,
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("raw", type=Path)
    ap.add_argument("--ny", type=int, default=64)
    ap.add_argument("--nx", type=int, default=64)
    ap.add_argument("--name", default="FCN3")
    ap.add_argument("--web-dir", default="fcn3")
    args = ap.parse_args()

    ds = convert(args.raw, args.ny, args.nx, args.name)
    zarr_path = args.raw.with_suffix(".zarr")
    write_zarr(ds, zarr_path)
    print("wrote", zarr_path)
    print("wrote", export_web(ds, ROOT / "data/web" / args.web_dir))
    for p in LEVELS_HPA:
        s = ds.sel(level=p)
        print(f"{p:5d} hPa  height {float(s.height.mean()):7.0f} m  "
              f"speed {float(s.wind_speed.min()):5.1f}-{float(s.wind_speed.max()):5.1f} m/s")
    if "u10" in ds:
        s10 = np.hypot(ds.u10, ds.v10)
        print(f" 10 m        speed {float(s10.min()):5.1f}-{float(s10.max()):5.1f} m/s")


if __name__ == "__main__":
    main()
