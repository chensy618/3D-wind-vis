"""Phase 0: synthetic wind field + synthetic terrain in the common schema.

    u = 5 + 2 sin(kx x + phase(t))      scaled with height
    v = 3 cos(ky y + phase(t))

Usage:
    python preprocessing/make_synthetic.py
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

from common_schema import (
    LEAD_HOURS,
    LEVELS_HPA,
    SENJA_BBOX,
    build_dataset,
    export_terrain_web,
    export_web,
    target_grid,
    write_zarr,
)

ROOT = Path(__file__).resolve().parents[1]

# Rough standard-atmosphere geopotential heights (m) for the five levels
STD_HEIGHT = {1000: 110.0, 925: 760.0, 850: 1460.0, 700: 3010.0, 500: 5570.0}


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
    yy, xx = np.meshgrid(np.linspace(0, 2 * np.pi, args.ny), np.linspace(0, 2 * np.pi, args.nx), indexing="ij")

    nt, nl = len(LEAD_HOURS), len(LEVELS_HPA)
    u = np.empty((nt, nl, args.ny, args.nx), np.float32)
    v = np.empty_like(u)
    h = np.empty_like(u)
    for it, lead in enumerate(LEAD_HOURS):
        phase = 2 * np.pi * lead / 24.0
        for il, p in enumerate(LEVELS_HPA):
            scale = 1.0 + 1.5 * (1000 - p) / 500.0  # stronger aloft
            turn = np.deg2rad(8 * il)  # veering with height
            u0 = 5 + 2 * np.sin(xx + phase)
            v0 = 3 * np.cos(yy + phase)
            u[it, il] = scale * (u0 * np.cos(turn) - v0 * np.sin(turn))
            v[it, il] = scale * (u0 * np.sin(turn) + v0 * np.cos(turn))
            h[it, il] = STD_HEIGHT[p] + 40 * np.sin(yy / 2 + phase) + 20 * il * np.cos(xx / 2)

    ds = build_dataset(
        u, v, height=h,
        lead_hours=LEAD_HOURS, levels=LEVELS_HPA, lat=lat, lon=lon,
        attrs={
            "model": "Synthetic",
            "init_time": "synthetic",
            "description": "u = 5 + 2 sin(x), v = 3 cos(y); stronger and veering with height",
        },
    )
    write_zarr(ds, ROOT / "data/synthetic/wind.zarr")
    print("wrote", export_web(ds, ROOT / "data/web/synthetic"))

    tlat, tlon = target_grid(args.terrain_n, args.terrain_n)
    elev = synthetic_terrain(args.terrain_n, args.terrain_n)
    print("wrote", export_terrain_web(elev, tlat, tlon, ROOT / "data/web/terrain-synthetic", "synthetic"))


if __name__ == "__main__":
    main()
