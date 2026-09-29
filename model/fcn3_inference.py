"""Run pretrained FourCastNet v3 (FCN3, via earth2studio) and keep a Senja crop.

Runs on a GPU node (see jobs/run_fcn3_senja.slurm). Produces a small NetCDF
with the raw 0.25-degree model output around Senja, which
preprocessing/convert_fcn3.py turns into the common wind schema.

Output: data/forecast/fcn3_<init>.nc
    dims: lead_time (h), variable, lat (ascending), lon
    variables kept: u/v/z at 1000, 925, 850, 700, 500 hPa + u10m, v10m
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import torch
import xarray as xr

from earth2studio.data import ARCO, CDS, GFS, fetch_data
from earth2studio.models.px import FCN3
from earth2studio.utils.time import to_time_array

ROOT = Path(__file__).resolve().parents[1]
LEVELS = [1000, 925, 850, 700, 500]
KEEP = [f"{c}{p}" for c in ("u", "v", "z") for p in LEVELS] + ["u10m", "v10m"]
# crop with a generous margin around the Senja domain (69.15-69.60N, 16.95-18.25E)
CROP = {"lat_min": 67.5, "lat_max": 71.5, "lon_min": 13.0, "lon_max": 22.0}
SOURCES = {"cds": CDS, "arco": ARCO, "gfs": GFS}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--init-time", default="2024-01-31T06:00:00",
                    help="initial condition time (default: just before Storm Ingunn)")
    ap.add_argument("--nsteps", type=int, default=4, help="6 h steps (4 -> +24 h)")
    ap.add_argument("--source", choices=SOURCES, default="cds")
    ap.add_argument("--seed", type=int, default=333, help="FCN3 noise seed")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"device: {device}")

    model = FCN3.load_model(FCN3.load_default_package()).to(device)
    model.set_rng(seed=args.seed)
    data = SOURCES[args.source]()

    in_coords = model.input_coords()
    time = to_time_array([args.init_time])
    x, coords = fetch_data(
        source=data,
        time=time,
        variable=in_coords["variable"],
        lead_time=in_coords["lead_time"],
        device=device,
    )
    print("fetched initial condition:", tuple(x.shape))

    variables = list(coords["variable"])
    vidx = [variables.index(v) for v in KEEP]
    lat = np.asarray(coords["lat"])
    lon = np.asarray(coords["lon"])
    lat_sel = np.where((lat >= CROP["lat_min"]) & (lat <= CROP["lat_max"]))[0]
    lon_sel = np.where((lon >= CROP["lon_min"]) & (lon <= CROP["lon_max"]))[0]

    frames, leads = [], []
    with torch.inference_mode():
        for step, (xs, cs) in enumerate(model.create_iterator(x, coords)):
            lead_h = int(cs["lead_time"][0] / np.timedelta64(1, "h"))
            # xs: (time, lead_time, variable, lat, lon)
            crop = xs[0, 0][vidx][:, lat_sel][:, :, lon_sel].float().cpu().numpy()
            frames.append(crop)
            leads.append(lead_h)
            print(f"step {step}: +{lead_h} h")
            if step >= args.nsteps:
                break

    arr = np.stack(frames)  # lead, variable, lat, lon
    lat_c = lat[lat_sel]
    order = np.argsort(lat_c)  # ascending latitude
    da = xr.DataArray(
        arr[:, :, order, :],
        dims=("lead_time", "variable", "lat", "lon"),
        coords={"lead_time": leads, "variable": KEEP, "lat": lat_c[order], "lon": lon[lon_sel]},
        name="fcn3",
        attrs={
            "model": "FCN3 (FourCastNet v3, NVIDIA, via earth2studio)",
            "init_time": str(np.datetime_as_string(time[0], unit="h")),
            "source": args.source,
            "seed": args.seed,
            "units": "u,v: m s-1; z: m2 s-2 (geopotential)",
        },
    )
    out = Path(args.out) if args.out else ROOT / "data/forecast" / (
        "fcn3_" + np.datetime_as_string(time[0], unit="h").replace(":", "").replace("-", "") + ".nc")
    out.parent.mkdir(parents=True, exist_ok=True)
    da.to_dataset().to_netcdf(out)
    print("saved", out, arr.shape)


if __name__ == "__main__":
    main()
