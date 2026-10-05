"""Run GraphCast 0.25° (Google DeepMind, GraphCast_operational) and keep a Senja crop.

GraphCast_operational is pretrained on ERA5 and fine-tuned on IFS HRES, at 0.25°
on 13 pressure levels. It needs the state at t - 6 h and t: surface 2t/10u/10v/msl,
t/z/u/v/w/q on 13 levels, and static land-sea mask and surface geopotential.
Solar radiation and the time-of-day/year features are computed by graphcast.
The initial state here is ERA5 (as for FCN3), read from Google's public ARCO archive.

Two steps, because Olivia's GPU nodes have no internet:

    python model/graphcast_inference.py --fetch-only        # login node: ~0.7 GB of ERA5 + weights
    sbatch jobs/run_graphcast_senja.slurm                    # GPU node: inference (JAX)

Output: data/forecast/graphcast_<init>.nc, the same layout as model/fcn3_inference.py
    dims: lead_time (h), variable, lat (ascending), lon
    variables kept: u/v/z at 1000, 925, 850, 700, 500 hPa + u10m, v10m
so preprocessing/convert_fcn3.py converts it (--name GraphCast --web-dir graphcast025).
"""

from __future__ import annotations

import argparse
import dataclasses
import functools
import os
import urllib.parse
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
WORK = Path(os.environ.get("GRAPHCAST_WORK", "/cluster/work/projects/nn8106k/siyan"))
CACHE = WORK / "graphcast_cache"  # ERA5 inputs, one file per initial time
WEIGHTS = WORK / "windvis_weights" / "graphcast-operational"

ARCO = "gs://gcp-public-data-arco-era5/ar/full_37-1h-0p25deg-chunk-1.zarr-v3"
GCS = "https://storage.googleapis.com/dm_graphcast/graphcast/"
PARAMS = ("params/GraphCast_operational - ERA5-HRES 1979-2021 - resolution 0.25 - "
          "pressure levels 13 - mesh 2to6 - precipitation output only.npz")
STATS = ["stats/diffs_stddev_by_level.nc", "stats/mean_by_level.nc", "stats/stddev_by_level.nc"]

LEVELS13 = [50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 850, 925, 1000]
ATMOS = ["temperature", "geopotential", "u_component_of_wind", "v_component_of_wind",
         "vertical_velocity", "specific_humidity"]
SURFACE = ["2m_temperature", "mean_sea_level_pressure", "10m_u_component_of_wind", "10m_v_component_of_wind"]
STATIC = ["land_sea_mask", "geopotential_at_surface"]

LEVELS = [1000, 925, 850, 700, 500]
KEEP = [f"{c}{p}" for c in ("u", "v", "z") for p in LEVELS] + ["u10m", "v10m"]
# same crop as model/fcn3_inference.py, with a margin around Senja (69.15-69.60N, 16.95-18.25E)
CROP = {"lat_min": 67.5, "lat_max": 71.5, "lon_min": 13.0, "lon_max": 22.0}


def input_file(init: datetime) -> Path:
    return CACHE / f"era5_graphcast_{init:%Y%m%dT%H}.nc"


def download(url: str, target: Path) -> None:
    import requests

    if target.exists() and target.stat().st_size > 0:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    print("downloading", url, flush=True)
    with requests.get(url, stream=True, timeout=600) as r:
        r.raise_for_status()
        with open(target.with_suffix(".part"), "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 22):
                f.write(chunk)
    target.with_suffix(".part").rename(target)


def fetch(init: datetime) -> None:
    """ERA5 at t - 6 h and t, global 0.25°, from ARCO (anonymous); plus the weights."""
    import xarray as xr

    for p in [PARAMS] + STATS:
        download(GCS + urllib.parse.quote(p), WEIGHTS / p)
    out = input_file(init)
    if out.exists():
        print("inputs already in", out)
        return
    times = [np.datetime64(init - timedelta(hours=6)), np.datetime64(init)]
    arco = xr.open_zarr(ARCO, chunks=None, storage_options={"token": "anon"})
    print("reading ERA5 from ARCO for", [str(t) for t in times], flush=True)
    parts = {}
    for v in ATMOS:
        parts[v] = arco[v].sel(time=times, level=LEVELS13).astype(np.float32).load()
        print("  ", v, flush=True)
    for v in SURFACE:
        parts[v] = arco[v].sel(time=times).astype(np.float32).load()
    for v in STATIC:
        parts[v] = arco[v].sel(time=times[-1]).drop_vars("time").astype(np.float32).load()
    out.parent.mkdir(parents=True, exist_ok=True)
    xr.Dataset(parts).to_netcdf(out)
    print("saved", out, f"({out.stat().st_size / 1e6:.0f} MB)")


def build_dataset(init: datetime, steps: int):
    """GraphCast's input layout: two input times, NaN placeholders for the targets."""
    import pandas as pd
    import xarray as xr

    ds = xr.load_dataset(input_file(init))
    ds = ds.rename({"latitude": "lat", "longitude": "lon"}).sortby("lat")
    deltas = pd.to_timedelta([-6, 0] + [6 * (i + 1) for i in range(steps)], unit="h")
    ds = ds.assign_coords(time=deltas[:2]).reindex(time=deltas)
    # precipitation is an output only; the target template still needs the variable
    ds["total_precipitation_6hr"] = xr.full_like(ds["2m_temperature"], np.nan)
    ds = ds.assign_coords(datetime=(("batch", "time"), [pd.Timestamp(init) + deltas]))
    for v in ds.data_vars:
        if "time" in ds[v].dims:
            ds[v] = ds[v].expand_dims(batch=1)
    return ds.transpose("batch", "time", "level", "lat", "lon", ...).astype(np.float32)


def crop_frame(d, lat_sel, lon_sel) -> np.ndarray:
    """(variable, lat, lon) crop in KEEP order from one time of a graphcast dataset."""
    names = {"u": "u_component_of_wind", "v": "v_component_of_wind", "z": "geopotential"}
    out = []
    for k in KEEP:
        if k in ("u10m", "v10m"):
            field = d["10m_u_component_of_wind" if k == "u10m" else "10m_v_component_of_wind"]
        else:
            field = d[names[k[0]]].sel(level=int(k[1:]))
        out.append(np.asarray(field.squeeze().transpose("lat", "lon").values)[np.ix_(lat_sel, lon_sel)])
    return np.stack(out)


def run(init: datetime, steps: int, out: Path | None) -> None:
    import haiku as hk
    import jax
    import xarray as xr
    from graphcast import autoregressive, casting, checkpoint, data_utils, graphcast, normalization, rollout

    with open(WEIGHTS / PARAMS, "rb") as f:
        ckpt = checkpoint.load(f, graphcast.CheckPoint)
    model_config, task_config = ckpt.model_config, ckpt.task_config
    stats = {Path(s).stem: xr.load_dataset(WEIGHTS / s) for s in STATS}
    print("devices:", jax.devices(), flush=True)

    @hk.transform_with_state
    def run_forward(inputs, targets_template, forcings):
        predictor = graphcast.GraphCast(model_config, task_config)
        predictor = casting.Bfloat16Cast(predictor)
        predictor = normalization.InputsAndResiduals(predictor, **stats)
        predictor = autoregressive.Predictor(predictor, gradient_checkpointing=True)
        return predictor(inputs, targets_template=targets_template, forcings=forcings)

    fn = jax.jit(functools.partial(run_forward.apply, ckpt.params, {}))
    predict = lambda **kw: fn(**kw)[0]

    ds = build_dataset(init, steps)
    inputs, targets, forcings = data_utils.extract_inputs_targets_forcings(
        ds, target_lead_times=slice("6h", f"{6 * steps}h"), **dataclasses.asdict(task_config))

    lat = inputs.lat.values
    lon = inputs.lon.values
    lat_sel = np.where((lat >= CROP["lat_min"]) & (lat <= CROP["lat_max"]))[0]
    lon_sel = np.where((lon >= CROP["lon_min"]) & (lon <= CROP["lon_max"]))[0]

    frames, leads = [crop_frame(inputs.isel(time=-1), lat_sel, lon_sel)], [0]  # T+0: ERA5 itself
    # The pinned graphcast commit copies its arguments with xarray.Dataset(ds), which
    # xarray >= 2025 rejects; a mapping of the variables (with their coords) works everywhere.
    as_vars = lambda d: dict(d.data_vars)
    preds = rollout.chunked_prediction(
        predict, rng=jax.random.PRNGKey(0), inputs=as_vars(inputs),
        targets_template=as_vars(targets * np.nan), forcings=as_vars(forcings))
    for i in range(steps):
        frames.append(crop_frame(preds.isel(time=i), lat_sel, lon_sel))
        leads.append(6 * (i + 1))
        print(f"step {i + 1}: +{6 * (i + 1)} h", flush=True)

    arr = np.stack(frames).astype(np.float32)  # lead, variable, lat, lon (lat ascending)
    da = xr.DataArray(
        arr,
        dims=("lead_time", "variable", "lat", "lon"),
        coords={"lead_time": leads, "variable": KEEP, "lat": lat[lat_sel], "lon": lon[lon_sel]},
        name="graphcast",
        attrs={
            "model": "GraphCast 0.25° (Google DeepMind, GraphCast_operational)",
            "init_time": init.strftime("%Y-%m-%dT%H"),
            "source": "ERA5 (ARCO)",
            "units": "u,v: m s-1; z: m2 s-2 (geopotential)",
        },
    )
    out = out or ROOT / "data/forecast" / f"graphcast_{init:%Y%m%dT%H}.nc"
    out.parent.mkdir(parents=True, exist_ok=True)
    da.to_dataset().to_netcdf(out)
    print("saved", out, arr.shape)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--init-time", default="2024-01-31T06", help="initial time (default: as the FCN3 run)")
    ap.add_argument("--nsteps", type=int, default=4, help="6 h steps (4 -> +24 h)")
    ap.add_argument("--fetch-only", action="store_true", help="download inputs and weights, then stop")
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()

    init = datetime.strptime(args.init_time[:13], "%Y-%m-%dT%H")
    if args.fetch_only:
        fetch(init)
    else:
        run(init, args.nsteps, args.out)


if __name__ == "__main__":
    main()
