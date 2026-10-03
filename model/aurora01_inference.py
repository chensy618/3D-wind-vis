"""Run Aurora 0.1° Fine-Tuned (Microsoft, AuroraHighRes) and keep a Senja crop.

Aurora 0.1° is fine-tuned on IFS HRES analysis at 0.1°, so its initial state is
IFS HRES analysis (NCAR GDEX dataset d113001, the former RDA), not ERA5. The
model needs the state at t - 6 h and t: surface 2t/10u/10v/msl and t/u/v/q/z on
13 pressure levels, plus the static fields published with the checkpoint.

Two steps, because Olivia's GPU nodes have no internet:

    python model/aurora01_inference.py --fetch-only          # login node: ~12 GB of GRIB + weights
    sbatch jobs/run_aurora01_senja.slurm                     # GPU node: inference

Output: data/forecast/aurora01_<init>.nc, the same layout as model/fcn3_inference.py
    dims: lead_time (h), variable, lat (ascending), lon
    variables kept: u/v/z at 1000, 925, 850, 700, 500 hPa + u10m, v10m
so preprocessing/convert_fcn3.py converts it (--name Aurora --web-dir aurora01).
"""

from __future__ import annotations

import argparse
import os
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
WORK = Path(os.environ.get("AURORA_WORK", "/cluster/work/projects/nn8106k/siyan"))
CACHE = WORK / "aurora01_cache"  # IFS HRES analysis GRIB files
WEIGHTS = WORK / "windvis_weights" / "aurora-0.1"

GDEX = "https://data.gdex.ucar.edu/d113001"
HF = "https://huggingface.co/microsoft/aurora/resolve/main"
CHECKPOINT = "aurora-0.1-finetuned.ckpt"
STATIC = "aurora-0.1-static.pickle"

# Aurora's 13 pressure levels; the Senja crop keeps the 5 the viewer uses
AURORA_LEVELS = (1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100, 50)
LEVELS = [1000, 925, 850, 700, 500]
KEEP = [f"{c}{p}" for c in ("u", "v", "z") for p in LEVELS] + ["u10m", "v10m"]
# same crop as model/fcn3_inference.py, with a margin around Senja (69.15-69.60N, 16.95-18.25E)
CROP = {"lat_min": 67.5, "lat_max": 71.5, "lon_min": 13.0, "lon_max": 22.0}

# ECMWF parameter numbers used in the GDEX file names
SURF = {"2t": ("167", "t2m"), "10u": ("165", "u10"), "10v": ("166", "v10"), "msl": ("151", "msl")}
ATMOS = {"t": "130", "u": "131", "v": "132", "q": "133", "z": "129"}


def surf_file(v: str, day: datetime) -> tuple[Path, str]:
    """Daily surface analysis file (all four analysis times)."""
    name = f"ec.oper.an.sfc.128_{SURF[v][0]}_{v}.regn1280sc.{day:%Y%m%d}.grb"
    return CACHE / name, f"{GDEX}/ec.oper.an.sfc/{day:%Y%m}/{name}"


def atmos_file(v: str, t: datetime) -> tuple[Path, str]:
    """Pressure-level analysis file for one time (all levels)."""
    grid = "uv" if v in {"u", "v"} else "sc"
    name = f"ec.oper.an.pl.128_{ATMOS[v]}_{v}.regn1280{grid}.{t:%Y%m%d%H}.grb"
    return CACHE / name, f"{GDEX}/ec.oper.an.pl/{t:%Y%m}/{name}"


def download(url: str, target: Path) -> None:
    """Download with resume; skips complete files."""
    import requests

    target.parent.mkdir(parents=True, exist_ok=True)
    size = int(requests.head(url, allow_redirects=True, timeout=60).headers.get("content-length", 0))
    have = target.stat().st_size if target.exists() else 0
    if size and have == size:
        return
    headers = {"Range": f"bytes={have}-"} if have else {}
    print(f"downloading {url} ({size / 1e6:.0f} MB)", flush=True)
    with requests.get(url, headers=headers, stream=True, allow_redirects=True, timeout=600) as r:
        r.raise_for_status()
        with open(target, "ab" if have and r.status_code == 206 else "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 22):
                f.write(chunk)


def fetch(init: datetime) -> None:
    prev = init - timedelta(hours=6)
    days = sorted({datetime.combine(d, datetime.min.time()) for d in (prev.date(), init.date())})
    files = [surf_file(v, d) for v in SURF for d in days]
    files += [atmos_file(v, t) for v in ATMOS for t in (prev, init)]
    for path, url in files:
        download(url, path)
    for name in (CHECKPOINT, STATIC):
        download(f"{HF}/{name}", WEIGHTS / name)
    print("all inputs in", CACHE, "and", WEIGHTS)


def open_grib(path: Path):
    import xarray as xr

    # no .idx files next to the shared GRIB cache
    return xr.open_dataset(path, engine="cfgrib", backend_kwargs={"indexpath": ""})


def build_batch(init: datetime):
    """Aurora batch with the analysis at t - 6 h and t, regridded to 0.1°."""
    import pickle

    import torch
    from aurora import Batch, Metadata

    times = [init - timedelta(hours=6), init]

    def surf(v: str) -> torch.Tensor:
        frames = []
        for t in times:
            ds = open_grib(surf_file(v, datetime.combine(t.date(), datetime.min.time()))[0])
            da = ds[SURF[v][1]]
            frames.append(da.sel(time=np.datetime64(t)).values if "time" in da.dims else da.values)
        return torch.from_numpy(np.stack(frames)[None].astype(np.float32))

    def atmos(v: str) -> torch.Tensor:
        frames = [open_grib(atmos_file(v, t)[0])[v].sel(isobaricInhPa=list(AURORA_LEVELS)).values for t in times]
        return torch.from_numpy(np.stack(frames)[None].astype(np.float32))

    ref = open_grib(surf_file("10u", datetime.combine(init.date(), datetime.min.time()))[0])
    batch = Batch(
        surf_vars={v: surf(v) for v in SURF},
        static_vars={},
        atmos_vars={v: atmos(v) for v in ATMOS},
        metadata=Metadata(
            lat=torch.from_numpy(ref.latitude.values),
            lon=torch.from_numpy(ref.longitude.values),
            time=(init,),
            atmos_levels=AURORA_LEVELS,
        ),
    )
    print("input grid", tuple(batch.spatial_shape), "-> regridding to 0.1°", flush=True)
    batch = batch.regrid(res=0.1)
    # the static fields used in training, already on the 0.1° grid
    with open(WEIGHTS / STATIC, "rb") as f:
        batch.static_vars = {k: torch.from_numpy(v) for k, v in pickle.load(f).items()}
    return batch


def crop_frame(batch, lat_sel, lon_sel) -> np.ndarray:
    """(variable, lat, lon) crop of the last time in a batch, in KEEP order."""
    levels = list(batch.metadata.atmos_levels)
    out = []
    for name in KEEP:
        if name in ("u10m", "v10m"):
            field = batch.surf_vars["10u" if name == "u10m" else "10v"][0, -1]
        else:
            field = batch.atmos_vars[name[0]][0, -1, levels.index(int(name[1:]))]
        out.append(field.float().cpu().numpy()[np.ix_(lat_sel, lon_sel)])
    return np.stack(out)


def run(init: datetime, nsteps: int, device: str, out: Path | None, use_lora: bool) -> None:
    import torch
    import xarray as xr
    from aurora import AuroraHighRes, rollout

    batch = build_batch(init)
    lat = batch.metadata.lat.numpy()
    lon = batch.metadata.lon.numpy()
    lat_sel = np.where((lat >= CROP["lat_min"]) & (lat <= CROP["lat_max"]))[0]
    lon_sel = np.where((lon >= CROP["lon_min"]) & (lon <= CROP["lon_max"]))[0]

    # LoRA off gives more realistic fields at a slightly higher long-range MSE (Aurora docs)
    model = AuroraHighRes(use_lora=use_lora)
    model.load_checkpoint_local(str(WEIGHTS / CHECKPOINT), strict=use_lora)
    model.eval().to(device)
    print(f"model on {device}", flush=True)

    frames, leads = [crop_frame(batch, lat_sel, lon_sel)], [0]  # T+0: the analysis itself
    with torch.inference_mode():
        for step, pred in enumerate(rollout(model, batch, steps=nsteps), start=1):
            frames.append(crop_frame(pred, lat_sel, lon_sel))
            leads.append(6 * step)
            print(f"step {step}: +{6 * step} h", flush=True)

    arr = np.stack(frames)  # lead, variable, lat, lon
    lat_c = lat[lat_sel]
    order = np.argsort(lat_c)  # ascending latitude
    da = xr.DataArray(
        arr[:, :, order, :],
        dims=("lead_time", "variable", "lat", "lon"),
        coords={"lead_time": leads, "variable": KEEP, "lat": lat_c[order], "lon": lon[lon_sel]},
        name="aurora",
        attrs={
            "model": "Aurora 0.1° Fine-Tuned (Microsoft, AuroraHighRes" + ("" if use_lora else ", LoRA off") + ")",
            "init_time": init.strftime("%Y-%m-%dT%H"),
            "source": "IFS HRES analysis (NCAR GDEX d113001)",
            "units": "u,v: m s-1; z: m2 s-2 (geopotential)",
        },
    )
    out = out or ROOT / "data/forecast" / f"aurora01_{init:%Y%m%dT%H}.nc"
    out.parent.mkdir(parents=True, exist_ok=True)
    da.to_dataset().to_netcdf(out)
    print("saved", out, arr.shape)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--init-time", default="2024-01-31T06", help="initial time (default: as the FCN3 run)")
    ap.add_argument("--nsteps", type=int, default=4, help="6 h steps (4 -> +24 h)")
    ap.add_argument("--fetch-only", action="store_true", help="download inputs and weights, then stop")
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--lora", action="store_true", help="keep LoRA on (lower long-range MSE, smoother fields)")
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()

    init = datetime.strptime(args.init_time[:13], "%Y-%m-%dT%H")
    if args.fetch_only:
        fetch(init)
    else:
        run(init, args.nsteps, args.device, args.out, args.lora)


if __name__ == "__main__":
    main()
