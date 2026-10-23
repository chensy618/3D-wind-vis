"""Phase 0: synthetic wind field + synthetic terrain in the common schema.

    u = 5 + 2 sin(kx x + phase(t))      on flat levels 50, 150, 300, 500 m ASL (as WindINR and the
    v = 3 cos(ky y + phase(t))          Forecast vs WindINR page), stronger (+27 %/km) and veering
                                        (6 deg/km) with height
    10 m wind: the same field, weaker (x0.7) and backed 15 deg by surface friction
    w10 = V10 . grad(h)                 air follows the Senja DTM (h smoothed to the wind grid)
    w   = V . grad(h) exp(-(z - h) / H) the terrain forcing decays with height above the ground
                                        (H = 1 km)
    The field is defined over the whole region, inside the terrain too (it is synthetic): the
    viewer hides the parts of a level under the ground, and the wind next to a mountain is not
    pulled towards zero by grid points inside it.

Usage:
    python preprocessing/make_synthetic.py
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from scipy.interpolate import RegularGridInterpolator
from scipy.ndimage import uniform_filter

from common_schema import (
    LEAD_HOURS,
    SENJA_BBOX,
    build_dataset,
    export_terrain_web,
    export_web,
    target_grid,
    update_index,
    write_zarr,
)

ROOT = Path(__file__).resolve().parents[1]

# Flat levels (m ASL), the same as convert_windinr.LEVELS_ASL
LEVELS_ASL = [50, 150, 300, 500]
M_PER_DEG_LAT = 111_320.0
W_DECAY_M = 1000.0  # e-folding height of the terrain-forced vertical wind
TERRAIN_ID = "terrain"  # the Senja DTM the vertical wind is computed on (data/web/terrain)


def terrain_slope(lat: np.ndarray, lon: np.ndarray, terrain_dir: Path):
    """Terrain elevation and slope (dh/dx east, dh/dy north) on the wind grid. The DTM is
    block-averaged to about the wind spacing first, so the slope is the one the wind grid resolves.
    Distances use one cos(latitude) at the domain centre, as the viewer does."""
    tm = json.loads((terrain_dir / "manifest.json").read_text())
    elev = np.fromfile(terrain_dir / tm["file"], "<f4").reshape(tm["shape"]).astype(np.float64)
    tlat, tlon = np.asarray(tm["lat"]), np.asarray(tm["lon"])
    block = max(1, round((lat[1] - lat[0]) / (tlat[1] - tlat[0])))
    smooth = uniform_filter(elev, size=block, mode="nearest")
    yy, xx = np.meshgrid(lat, lon, indexing="ij")
    h = RegularGridInterpolator((tlat, tlon), smooth)(np.stack([yy, xx], axis=-1))
    dy = M_PER_DEG_LAT * (lat[1] - lat[0])
    dx = M_PER_DEG_LAT * np.cos(np.deg2rad(0.5 * (lat[0] + lat[-1]))) * (lon[1] - lon[0])
    dhdy, dhdx = np.gradient(h, dy, dx)
    return h, dhdx, dhdy


def synthetic_terrain(ny: int, nx: int) -> np.ndarray:
    """A coastline with an ocean in the west, a fjord and a few peaks."""
    y, x = np.meshgrid(np.linspace(0, 1, ny), np.linspace(0, 1, nx), indexing="ij")
    rng = np.random.default_rng(0)
    land = np.clip((x - 0.25 + 0.08 * np.sin(8 * y)) * 4, 0, 1)
    peaks = np.zeros_like(x)
    for _ in range(14):
        cx, cy = rng.uniform(0.35, 1.0), rng.uniform(0, 1)
        r, h = rng.uniform(0.04, 0.12), rng.uniform(300, 1000)
        peaks += h * np.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * r**2))
    fjord = np.exp(-((y - 0.55 - 0.1 * (x - 0.5)) ** 2) / (2 * 0.02**2)) * (x < 0.85)
    elev = land * (50 + peaks) * (1 - 0.95 * fjord) - 20 * (1 - land)
    return np.maximum(elev, 0.0)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ny", type=int, default=64)
    ap.add_argument("--nx", type=int, default=64)
    ap.add_argument("--terrain-n", type=int, default=256)
    args = ap.parse_args()

    lat, lon = target_grid(args.ny, args.nx)
    ground, dhdx, dhdy = terrain_slope(lat, lon, ROOT / "data/web" / TERRAIN_ID)
    yy, xx = np.meshgrid(np.linspace(0, 2 * np.pi, args.ny), np.linspace(0, 2 * np.pi, args.nx), indexing="ij")

    nt, nl = len(LEAD_HOURS), len(LEVELS_ASL)
    u = np.empty((nt, nl, args.ny, args.nx), np.float32)
    v = np.empty_like(u)
    w = np.empty_like(u)
    h = np.broadcast_to(np.array(LEVELS_ASL, np.float32)[None, :, None, None], u.shape)
    u10 = np.empty((nt, args.ny, args.nx), np.float32)
    v10 = np.empty_like(u10)
    w10 = np.empty_like(u10)
    for it, lead in enumerate(LEAD_HOURS):
        phase = 2 * np.pi * lead / 24.0
        u0 = 5 + 2 * np.sin(xx + phase)
        v0 = 3 * np.cos(yy + phase)
        for il, z in enumerate(LEVELS_ASL):
            scale = 1.0 + 0.27 * z / 1000.0  # stronger aloft
            turn = np.deg2rad(6.0 * z / 1000.0)  # veering with height
            agl = np.maximum(z - ground, 0.0)  # inside the terrain: the forcing at the ground
            u[it, il] = scale * (u0 * np.cos(turn) - v0 * np.sin(turn))
            v[it, il] = scale * (u0 * np.sin(turn) + v0 * np.cos(turn))
            w[it, il] = (u[it, il] * dhdx + v[it, il] * dhdy) * np.exp(-agl / W_DECAY_M)
        back = np.deg2rad(-15)
        u10[it] = 0.7 * (u0 * np.cos(back) - v0 * np.sin(back))
        v10[it] = 0.7 * (u0 * np.sin(back) + v0 * np.cos(back))
        w10[it] = u10[it] * dhdx + v10[it] * dhdy

    ds = build_dataset(
        u, v, height=h, w=w,
        lead_hours=LEAD_HOURS, levels=LEVELS_ASL, lat=lat, lon=lon,
        attrs={
            "model": "Synthetic",
            "init_time": "synthetic",
            "native_deg": 0.25,  # drawn as a coarse, FCN3-like grid
            "description": "u = 5 + 2 sin(x), v = 3 cos(y) on flat levels at "
                           f"{', '.join(map(str, LEVELS_ASL))} m above sea level, stronger and veering with height; "
                           "10 m wind 0.7x and backed 15 deg. Vertical wind forced by the Senja DTM: "
                           "w10 = V10·∇h, aloft V·∇h decaying with height above the ground (1 km)",
        },
        surface={"u10": u10, "v10": v10, "w10": w10},
    )
    write_zarr(ds, ROOT / "data/synthetic/wind.zarr")
    web = ROOT / "data/web"
    manifest = export_web(ds, web / "synthetic")
    m = json.loads(manifest.read_text())
    m["terrain"] = TERRAIN_ID  # w only matches this terrain, so the viewers load it with this dataset
    m["level_units"] = "m ASL"
    manifest.write_text(json.dumps(m, indent=1))
    update_index(web)
    print("wrote", manifest, f"|w10| max {np.abs(w10).max():.2f} m/s, |w| max {np.abs(w).max():.2f} m/s; inside terrain "
          + ", ".join(f"{z} m {(z <= ground).mean():.0%}" for z in LEVELS_ASL))

    tlat, tlon = target_grid(args.terrain_n, args.terrain_n)
    elev = synthetic_terrain(args.terrain_n, args.terrain_n)
    print("wrote", export_terrain_web(elev, tlat, tlon, ROOT / "data/web/terrain-synthetic", "synthetic"))


if __name__ == "__main__":
    main()
