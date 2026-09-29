"""Phase 3: real Senja terrain from Kartverket's national DTM (NHM, hoydedata.no).

Pipeline:  DTM (WCS, EPSG:25833)  ->  crop Senja  ->  reproject to the
common lat/lon grid  ->  downsample  ->  data/web/terrain/

The downloaded GeoTIFF (default 25 m) is kept in data/terrain/ so higher
resolution experiments can reuse it later.

Usage:
    python preprocessing/terrain.py                 # 25 m source, 256x256 web grid
    python preprocessing/terrain.py --n 500 --res 10
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import rasterio
import requests
from pyproj import Transformer
from scipy.ndimage import map_coordinates, uniform_filter

from common_schema import SENJA_BBOX, export_terrain_web, target_grid

ROOT = Path(__file__).resolve().parents[1]
WCS_URL = "https://wcs.geonorge.no/skwms1/wcs.hoyde-dtm-nhm-25833"
COVERAGE = "nhm_dtm_topo_25833"


def utm_bbox(bbox: dict, pad: float = 1000.0):
    t = Transformer.from_crs(4326, 25833, always_xy=True)
    xs, ys = [], []
    for lo in np.linspace(bbox["lon_min"], bbox["lon_max"], 11):
        for la in np.linspace(bbox["lat_min"], bbox["lat_max"], 11):
            x, y = t.transform(lo, la)
            xs.append(x)
            ys.append(y)
    snap = lambda v, f: float(f(v / 1000.0) * 1000.0)
    return (snap(min(xs) - pad, np.floor), snap(min(ys) - pad, np.floor),
            snap(max(xs) + pad, np.ceil), snap(max(ys) + pad, np.ceil))


def download_dtm(path: Path, res: float, bbox: dict = SENJA_BBOX) -> Path:
    x0, y0, x1, y1 = utm_bbox(bbox)
    width, height = int(round((x1 - x0) / res)), int(round((y1 - y0) / res))
    params = {
        "service": "WCS", "version": "1.0.0", "request": "GetCoverage",
        "coverage": COVERAGE, "crs": "EPSG:25833",
        "bbox": f"{x0},{y0},{x1},{y1}", "width": width, "height": height,
        "format": "GeoTIFF",
    }
    print(f"requesting {width}x{height} DTM at {res} m from Kartverket WCS ...")
    r = requests.get(WCS_URL, params=params, timeout=600)
    r.raise_for_status()
    if "tiff" not in r.headers.get("content-type", ""):
        raise RuntimeError(f"unexpected WCS response: {r.text[:500]}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(r.content)
    return path


def resample_to_latlon(tif: Path, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    with rasterio.open(tif) as src:
        dem = src.read(1).astype(np.float64)
        inv = ~src.transform
        res = abs(src.transform.a)
        if src.nodata is not None:
            dem[dem == src.nodata] = np.nan
    dem = np.where(np.isfinite(dem) & (dem > -500), dem, 0.0)

    LON, LAT = np.meshgrid(lon, lat)
    x, y = Transformer.from_crs(4326, 25833, always_xy=True).transform(LON, LAT)
    col, row = inv * (x, y)
    # box-filter to the target spacing before sampling to avoid aliasing
    spacing = 111_320.0 * (lat[1] - lat[0])
    size = max(1, int(round(spacing / res)))
    dem = uniform_filter(dem, size=size, mode="nearest")
    # pixel centres are at +0.5
    out = map_coordinates(dem, [row - 0.5, col - 0.5], order=1, mode="nearest")
    return np.maximum(out, 0.0).astype(np.float32)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=256, help="web terrain vertices per side")
    ap.add_argument("--res", type=float, default=25.0, help="source DTM resolution (m)")
    ap.add_argument("--force", action="store_true", help="re-download the DTM")
    args = ap.parse_args()

    tif = ROOT / f"data/terrain/senja_dtm_{int(args.res)}m_25833.tif"
    if args.force or not tif.exists():
        download_dtm(tif, args.res)
    print("source DTM:", tif)

    lat, lon = target_grid(args.n, args.n)
    elev = resample_to_latlon(tif, lat, lon)
    print(f"elevation range {elev.min():.1f} .. {elev.max():.1f} m, water fraction {(elev < 0.5).mean():.2f}")
    out = export_terrain_web(elev, lat, lon, ROOT / "data/web/terrain",
                             f"Kartverket NHM DTM {int(args.res)} m (hoydedata.no), resampled")
    print("wrote", out)


if __name__ == "__main__":
    main()
