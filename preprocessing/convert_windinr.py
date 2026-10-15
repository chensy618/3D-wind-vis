"""Forecast-driven WindINR wind over the Senja CFD box (a unified, time-varying field).

WindINR (../windinr) is trained on the steady CFD case library: from the terrain and a
coarse 7 x 7 (~1 km) background wind it predicts the high-resolution wind (u, v, w) at any
point. Here the background comes from a real forecast instead of a CFD case, so every
forecast time gets one unified field instead of one field per idealised inflow direction:

    prep    forecast in data/web/<driver>/  ->  background per lead time (the forecast's
            mean horizontal wind between the ground and the model ceiling in each 1 km cell,
            the same quantity as the training lowres_uv) + query points on the CFD box grid
            -> data/windinr/<driver>_inputs.npz
    (model/windinr_inference.py, in the LUMI PyTorch container)  ->  <driver>_pred.npz
    export  ->  data/web/windinr-<driver>/  (flat levels in m ASL, 10 m wind, CFD-box terrain)

The checkpoint (senja_v1/v3) was trained on 65 cases (8 directions x 8 speeds) with heights
normalised by a 500 m ceiling, so only levels up to the ceiling are predicted. Its x/y and
u/v live in the CFD mesh frame (UTM 33 grid north), so the forecast wind is rotated into it
and the prediction back to true north.

Usage (LUMI):
    PY=../wind_sim/.venv/bin/python
    $PY preprocessing/convert_windinr.py prep --driver aurora01
    jobs/run_windinr_inference.sh aurora01
    $PY preprocessing/convert_windinr.py export --driver aurora01
    $PY preprocessing/convert_windinr.py native --driver aurora01   # the forecast itself on the CFD box

`native` puts the driving forecast on the same CFD box grid and levels at its own resolution:
every point takes the value of its nearest native model grid point (0.25° FCN3/GraphCast,
0.1° Aurora), interpolated linearly in height from the 10 m wind and the pressure levels. The
native values are read from the viewer's 64 × 64 regridding at the grid points, which is close
to, but not exactly, the raw model output (kept on Olivia).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from pyproj import Transformer
from scipy.interpolate import RegularGridInterpolator

from common_schema import build_dataset, export_web
from convert_openfoam import Dem, grid_axes, latlon_box

ROOT = Path(__file__).resolve().parents[1]
GITHUB = ROOT.parent
DEFAULTS = {
    "domain_info": GITHUB / "wind_sim/case_senja/domain_info.json",
    "dem": GITHUB / "terrain_norge/7705_2_10m_z33.tif",
    "terrain_dir": GITHUB / "windinr/dataset/senja_v1_65case_ceiling500_backup",
}
LEVELS_ASL = [50, 150, 300, 500]
SURFACE_AGL = 10.0
# The training labels fall linearly to 0 at the ground below ~20 m (the extraction
# interpolated the wall's zero velocity into the lowest cells), so WindINR is too slow there.
# Points lower than this are queried at it and taken down with the CFD's log law instead.
Z_LOG_AGL = 25.0
Z0 = 0.1  # roughness length of the senja_v1 CFD cases
N_LR = 7  # background grid of the training data (proportional 1 km bins over the terrain extent)
# Resolution behind the senja_v1/v3 checkpoint, for the viewers (manifest "training"): its 10 m
# terrain input and the case_senja CFD mesh it learned from (100 m blocks, refined to 25 m at
# the terrain by snappyHexMesh level 2).
TRAINING = {"terrain_m": 10, "cfd_m": 100, "cfd_near_terrain_m": 25}


def load_driver(web: Path, driver: str):
    m = json.loads((web / driver / "manifest.json").read_text())
    nt, nl, ny, nx = m["shape"]
    read = lambda f, shape: np.fromfile(web / driver / f, "<f4").reshape(shape)
    if "surface" not in m:
        raise SystemExit(f"{driver} has no 10 m wind")
    return m, {
        "u": read(m["variables"]["u"]["file"], (nt, nl, ny, nx)),
        "v": read(m["variables"]["v"]["file"], (nt, nl, ny, nx)),
        "height": read(m["variables"]["height"]["file"], (nt, nl, ny, nx)),
        "u10": read(m["surface"]["u10"]["file"], (nt, ny, nx)),
        "v10": read(m["surface"]["v10"]["file"], (nt, ny, nx)),
    }


def layer_mean(z10, u10, hl, ul, ground, top, dz=5.0):
    """Mean of a wind component between ground and top, from the 10 m wind and the levels
    above it (piecewise linear in height, constant beyond the end points)."""
    keep = hl > z10
    zs = np.concatenate([[z10], hl[keep]])
    us = np.concatenate([[u10], ul[keep]])
    order = np.argsort(zs)
    z = np.arange(ground, top + dz / 2, dz)
    return float(np.interp(z, zs[order], us[order]).mean())


def prep(args) -> None:
    info = json.loads(args.domain_info.read_text())
    origin = tuple(info["local_origin_utm33"])
    z_min = float(info["z_min"])
    top = z_min + args.ceiling
    to_ll = Transformer.from_crs(25833, 4326, always_xy=True)

    m, f = load_driver(ROOT / "data/web", args.driver)
    interp = lambda arr: RegularGridInterpolator((m["lat"], m["lon"]), arr, bounds_error=False, fill_value=None)

    # background: 7 x 7 cells over the terrain extent, each from 5 x 5 sub-points weighted by air depth
    xc = np.load(args.terrain_dir / "terrain_x_centers.npy")
    yc = np.load(args.terrain_dir / "terrain_y_centers.npy")
    dem = Dem(args.dem, origin)
    sub = (np.arange(5) + 0.5) / 5
    cells = []
    for j in range(N_LR):
        for i in range(N_LR):
            sx = xc[0] + (i + sub) * (xc[-1] - xc[0]) / N_LR
            sy = yc[0] + (j + sub) * (yc[-1] - yc[0]) / N_LR
            SX, SY = np.meshgrid(sx, sy)
            cells.append((SX.ravel(), SY.ravel()))
    # the forecast's wind rotated into the mesh frame (unit vectors of grid x and y, in east/north)
    cx, cy = xc.mean(), yc.mean()
    lon_c, lat_c = to_ll.transform(origin[0] + cx, origin[1] + cy)
    _, _, (gx, gy) = grid_axes(np.array([[lat_c]]), np.array([[lon_c]]))
    gx, gy = np.array([gx[0].item(), gx[1].item()]), np.array([gy[0].item(), gy[1].item()])

    nt = len(m["times"])
    lowres = np.full((nt, N_LR, N_LR, 2), np.nan, np.float32)
    for t in range(nt):
        fu10, fv10 = interp(f["u10"][t]), interp(f["v10"][t])
        fl = [(interp(f["u"][t, k]), interp(f["v"][t, k]), interp(f["height"][t, k])) for k in range(len(m["levels"]))]
        for c, (SX, SY) in enumerate(cells):
            lon, lat = to_ll.transform(origin[0] + SX, origin[1] + SY)
            pts = np.column_stack([lat, lon])
            g = dem.at(SX, SY)
            keep = g < top  # sub-points on summits above the ceiling have no air below it
            if not keep.any():
                continue
            pts, g = pts[keep], g[keep]
            air = top - g
            u10, v10 = fu10(pts), fv10(pts)
            lev = [(a(pts), b(pts), h(pts)) for a, b, h in fl]
            ue = np.array([layer_mean(g[p] + 10, u10[p], np.array([h[p] for _, _, h in lev]),
                                      np.array([a[p] for a, _, _ in lev]), g[p], top) for p in range(len(g))])
            vn = np.array([layer_mean(g[p] + 10, v10[p], np.array([h[p] for _, _, h in lev]),
                                      np.array([b[p] for _, b, _ in lev]), g[p], top) for p in range(len(g))])
            ue, vn = (ue * air).sum() / air.sum(), (vn * air).sum() / air.sum()
            lowres[t, c // N_LR, c % N_LR] = (ue * gx[0] + vn * gx[1], ue * gy[0] + vn * gy[1])

    # query points: the CFD box grid of convert_openfoam.py, flat ASL levels + 10 m above ground
    extent = tuple(info["local_extent_xy"])
    bbox = latlon_box(origin, extent, args.margin)
    lat = np.linspace(bbox["lat_min"], bbox["lat_max"], args.n)
    lon = np.linspace(bbox["lon_min"], bbox["lon_max"], args.n)
    LAT, LON = np.meshgrid(lat, lon, indexing="ij")
    X, Y, (ex, ey) = grid_axes(LAT, LON)
    X, Y = X - origin[0], Y - origin[1]
    ground = dem.at(X, Y)
    z = np.concatenate([np.broadcast_to(np.array(args.levels, float)[:, None, None], (len(args.levels), *X.shape)),
                        (ground + SURFACE_AGL)[None]])
    inside = z <= ground[None]
    agl = z - ground[None]
    zq = np.where(inside, z, np.maximum(z, ground[None] + Z_LOG_AGL))
    with np.errstate(invalid="ignore"):  # NaN only inside the terrain, where the 1.0 branch wins
        log_factor = np.where(inside | (agl >= Z_LOG_AGL), 1.0,
                              np.log((np.maximum(agl, 0) + Z0) / Z0) / np.log((zq - ground[None] + Z0) / Z0))
    above = zq > top  # near the highest summits: beyond the trained height range, clamped
    zq = np.minimum(zq, top)
    pts = np.stack([np.broadcast_to(2 * (X - xc[0]) / (xc[-1] - xc[0]) - 1, z.shape),
                    np.broadcast_to(2 * (Y - yc[0]) / (yc[-1] - yc[0]) - 1, z.shape),
                    (zq - z_min) / args.ceiling], axis=-1).reshape(-1, 3).astype(np.float32)

    out = ROOT / "data/windinr"
    out.mkdir(parents=True, exist_ok=True)
    np.savez(out / f"{args.driver}_inputs.npz", points=pts, lowres_uv=lowres,
             lowres_meta=json.dumps({"coarse_res": 1000.0, "x0": float(xc[0]), "x1": float(xc[-1]),
                                     "y0": float(yc[0]), "y1": float(yc[-1])}),
             lat=lat, lon=lon, ex=np.stack(ex), ey=np.stack(ey), inside=inside, above=above, log_factor=log_factor,
             levels=np.array(args.levels), times=np.array(m["times"]))
    spd = np.hypot(lowres[..., 0], lowres[..., 1])
    for t, lt in enumerate(m["times"]):
        mu = np.nanmean(lowres[t].reshape(-1, 2), axis=0)
        frm = (270 - np.degrees(np.arctan2(mu[1], mu[0]))) % 360  # mesh frame, ~2° off true
        print(f"T+{lt:02d} h: background {np.nanmin(spd[t]):.1f}..{np.nanmax(spd[t]):.1f} m/s, mean from {frm:.0f}°")
    print(f"{len(pts)} query points; {above[-1].mean():.1%} of the 10 m points above the {args.ceiling:g} m ceiling")


def export(args) -> None:
    src = ROOT / "data/windinr"
    inp = np.load(src / f"{args.driver}_inputs.npz")
    pred = np.load(src / f"{args.driver}_pred.npz")["pred"]  # (T, N, 3), mesh frame
    m = json.loads((ROOT / "data/web" / args.driver / "manifest.json").read_text())
    levels = [int(x) for x in inp["levels"]]
    nl, (ny, nx) = len(levels), (len(inp["lat"]), len(inp["lon"]))
    nt = pred.shape[0]
    ux = pred[..., 0].reshape(nt, nl + 1, ny, nx) * inp["log_factor"]
    uy = pred[..., 1].reshape(nt, nl + 1, ny, nx) * inp["log_factor"]
    # vertical: no rotation; below Z_LOG_AGL scaled like the horizontal wind (w ~ V·∇h near the ground)
    w = pred[..., 2].reshape(nt, nl + 1, ny, nx) * inp["log_factor"]
    ex, ey = inp["ex"], inp["ey"]
    u = ux * ex[0] + uy * ey[0]
    v = ux * ex[1] + uy * ey[1]
    u[:, inp["inside"]] = 0.0
    v[:, inp["inside"]] = 0.0
    w[:, inp["inside"]] = 0.0
    height = np.broadcast_to(np.array(levels, np.float32)[None, :, None, None], (nt, nl, ny, nx))
    init = m["init_time"]
    ds = build_dataset(
        u[:, :nl], v[:, :nl], height=height, lead_hours=[int(t) for t in inp["times"]], levels=levels,
        lat=inp["lat"], lon=inp["lon"], surface={"u10": u[:, nl], "v10": v[:, nl], "w10": w[:, nl]}, w=w[:, :nl],
        attrs={
            "model": f"WindINR × {m['model']}",
            "init_time": init,
            "description": (f"WindINR (senja_v1/v3, trained on 65 steady CFD cases) driven by {m['model']}: "
                            f"each lead time's background is {m['model']}'s mean wind between the ground and "
                            f"{args.ceiling:g} m on a 7 × 7 (~1 km) grid over the CFD box. Flat levels at "
                            f"{', '.join(map(str, levels))} m above sea level (the model's height range ends at "
                            f"{args.ceiling:g} m) and 10 m above ground. Below {Z_LOG_AGL:g} m above ground the "
                            f"wind is taken at {Z_LOG_AGL:g} m and extrapolated with the log law (z0 = {Z0:g} m), "
                            f"since the training data are too slow there. Includes WindINR's vertical wind w "
                            f"(positive up)."),
            # a continuous field, exported on the CFD box grid: that grid's spacing
            "native_deg": float(inp["lat"][1] - inp["lat"][0]),
        },
    )
    out = ROOT / "data/web" / f"windinr-{args.driver}"
    export_web(ds, out)
    mm = json.loads((out / "manifest.json").read_text())
    mm.update(label=f"WindINR × {m['model']} · {init.replace('T', ' ')}Z", level_units="m ASL", group="WindINR × forecast · CFD box",
              terrain=args.terrain_id, driver=args.driver, training=TRAINING)
    (out / "manifest.json").write_text(json.dumps(mm, indent=1))
    from common_schema import update_index
    update_index(out.parent)
    s = np.hypot(u, v)
    for t, lt in enumerate(inp["times"]):
        print(f"T+{int(lt):02d} h: speed " + ", ".join(f"{lv} m {s[t, k][~inp['inside'][k]].mean():.1f}"
                                                   for k, lv in enumerate(levels)) + f", 10 m AGL {s[t, nl].mean():.1f} m/s"
              + f"; |w| 10 m AGL {np.abs(w[t, nl]).mean():.2f}, max {np.abs(w[t]).max():.1f} m/s")
    print("wrote", out)


def native(args) -> None:
    info = json.loads(args.domain_info.read_text())
    origin = tuple(info["local_origin_utm33"])
    m, f = load_driver(ROOT / "data/web", args.driver)
    deg = float(m["native_deg"])
    bbox = latlon_box(origin, tuple(info["local_extent_xy"]), args.margin)
    lat = np.linspace(bbox["lat_min"], bbox["lat_max"], args.n)
    lon = np.linspace(bbox["lon_min"], bbox["lon_max"], args.n)
    LAT, LON = np.meshgrid(lat, lon, indexing="ij")
    nlat, nlon = np.round(LAT / deg) * deg, np.round(LON / deg) * deg  # nearest native grid point
    nodes, cell = np.unique(np.column_stack([nlat.ravel(), nlon.ravel()]), axis=0, return_inverse=True)
    tol = 1e-6
    if not ((m["lat"][0] - tol <= nodes[:, 0]).all() and (nodes[:, 0] <= m["lat"][-1] + tol).all()
            and (m["lon"][0] - tol <= nodes[:, 1]).all() and (nodes[:, 1] <= m["lon"][-1] + tol).all()):
        raise SystemExit(f"native grid points {nodes} fall outside {args.driver}'s web grid")
    nodes = np.column_stack([np.clip(nodes[:, 0], m["lat"][0], m["lat"][-1]), np.clip(nodes[:, 1], m["lon"][0], m["lon"][-1])])
    # each native cell's ground: the box DEM averaged over the part of the cell inside the box
    X, Y = Transformer.from_crs(4326, 25833, always_xy=True).transform(LON, LAT)
    ground = Dem(args.dem, origin).at(X - origin[0], Y - origin[1]).ravel()
    cell_ground = np.array([ground[cell.ravel() == c].mean() for c in range(len(nodes))])

    interp = lambda arr: RegularGridInterpolator((m["lat"], m["lon"]), arr)(nodes)
    nt, nl = len(m["times"]), len(args.levels)
    u = np.empty((nt, nl, len(nodes)), np.float32)
    v = np.empty_like(u)
    u10 = np.empty((nt, len(nodes)), np.float32)
    v10 = np.empty_like(u10)
    for t in range(nt):
        u10[t], v10[t] = interp(f["u10"][t]), interp(f["v10"][t])
        hl = np.stack([interp(f["height"][t, k]) for k in range(len(m["levels"]))])
        ul = np.stack([interp(f["u"][t, k]) for k in range(len(m["levels"]))])
        vl = np.stack([interp(f["v"][t, k]) for k in range(len(m["levels"]))])
        for c in range(len(nodes)):
            z10 = cell_ground[c] + 10.0
            keep = hl[:, c] > z10  # levels below the model's 10 m (e.g. 1000 hPa in a deep low)
            zs = np.concatenate([[z10], hl[keep, c]])
            o = np.argsort(zs)
            u[t, :, c] = np.interp(args.levels, zs[o], np.concatenate([[u10[t, c]], ul[keep, c]])[o])
            v[t, :, c] = np.interp(args.levels, zs[o], np.concatenate([[v10[t, c]], vl[keep, c]])[o])
    grid = lambda a: a[..., cell].reshape(*a.shape[:-1], *LAT.shape)
    height = np.broadcast_to(np.array(args.levels, np.float32)[None, :, None, None], (nt, nl, *LAT.shape))
    init = m["init_time"]
    ds = build_dataset(
        grid(u), grid(v), height=height, lead_hours=m["times"], levels=args.levels, lat=lat, lon=lon,
        surface={"u10": grid(u10), "v10": grid(v10)},
        attrs={
            "model": f"{m['model']} {deg:g}° (native)",
            "init_time": init,
            "description": (f"{m['model']} on the CFD box at its own {deg:g}° resolution: each point takes its nearest "
                            f"model grid point ({len(nodes)} over the box), interpolated in height to "
                            f"{', '.join(map(str, args.levels))} m above sea level from the 10 m wind and the pressure "
                            f"levels. The coarse background behind WindINR × {m['model']}."),
            "native_deg": deg,
        },
    )
    out = ROOT / "data/web" / f"{args.driver}-cfdbox"
    export_web(ds, out)
    mm = json.loads((out / "manifest.json").read_text())
    mm.update(label=f"{m['model']} {deg:g}° native · {init.replace('T', ' ')}Z", level_units="m ASL",
              group="Forecast, native resolution · CFD box",
              terrain=args.terrain_id, driver=args.driver)
    (out / "manifest.json").write_text(json.dumps(mm, indent=1))
    from common_schema import update_index
    update_index(out.parent)
    print(f"{args.driver}: {len(nodes)} native grid point(s) over the box: {nodes.round(3).tolist()}")
    for t, lt in enumerate(m["times"]):
        print(f"  T+{lt:02d} h: " + ", ".join(f"{lv} m {np.hypot(u[t, k], v[t, k]).mean():.1f}" for k, lv in enumerate(args.levels))
              + f", 10 m {np.hypot(u10[t], v10[t]).mean():.1f} m/s")
    print("wrote", out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("stage", choices=("prep", "export", "native"))
    ap.add_argument("--driver", default="aurora01", help="forecast dataset id in data/web with u/v/height and u10/v10")
    ap.add_argument("--domain-info", type=Path, default=DEFAULTS["domain_info"])
    ap.add_argument("--dem", type=Path, default=DEFAULTS["dem"])
    ap.add_argument("--terrain-dir", type=Path, default=DEFAULTS["terrain_dir"], help="the training dataset's terrain grid")
    ap.add_argument("--ceiling", type=float, default=500.0, help="height normalisation of the checkpoint's training data")
    ap.add_argument("--levels", type=int, nargs="+", default=LEVELS_ASL, help="altitudes (m ASL), at most the ceiling")
    ap.add_argument("--n", type=int, default=96)
    ap.add_argument("--margin", type=float, default=250.0, help="as in convert_openfoam.py, so the grids match")
    ap.add_argument("--terrain-id", default="terrain-cfd-senja")
    args = ap.parse_args()
    {"prep": prep, "export": export, "native": native}[args.stage](args)


if __name__ == "__main__":
    main()
