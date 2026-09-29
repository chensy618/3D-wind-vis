# Senja 3D Wind — MVP

Interactive 3D visualization of multi-level atmospheric wind over Senja, Northern Norway.

```
FCN3 (pretrained)  →  Senja crop  →  u / v / geopotential  →  common wind schema  →  Three.js viewer
                                                               ↑
                                   synthetic field (Phase 0) ──┘      + Kartverket DTM terrain
```

The pretrained model is **FourCastNet v3 (FCN3)** from earth2studio, not Aurora as in the
original plan (`senja_3d_wind_mvp_plan.md`). The viewer reads only the common schema, so
Aurora, GraphCast, ERA5, CARRA or the U-NO/GNO/NOFE models can be added later by writing
another converter.

## Quick start (local machine)

The repo ships the processed data the viewer needs, so it runs directly after cloning.
The only requirement is Node.js 18 or newer; no Python, GPU or HPC access is needed.

```bash
git clone git@github.com:chensy618/3D-wind-vis.git
cd 3D-wind-vis/frontend
npm install
npm run dev        # open http://127.0.0.1:5173
```

`npm run build` produces a static site in `frontend/dist` (data included) that any web server can host.

**Windows:** `frontend/public/data` is a symlink to `data/web`, which Windows git often checks
out as a plain text file. If the viewer says it cannot load data, delete `frontend/public/data`
and copy the `data/web` folder there as `data`, or clone with `git clone -c core.symlinks=true`
from a shell with Developer Mode enabled. macOS and Linux work as-is.

## Data in this repo

Included in `data/web/` (3.7 MB, everything the viewer loads):

- FCN3 forecast initialized 2024-01-31 06 UTC: T+0 to T+24 h, 5 pressure levels, u, v, height and wind speed
- Senja terrain: Kartverket DTM resampled to 256 × 256
- Synthetic wind field and synthetic terrain, for testing the frontend

Not included (excluded by `.gitignore`; kept on Olivia and reproducible with the scripts):

| Data | Size | Location | Regenerate with |
|---|---|---|---|
| Source DTM GeoTIFF, 25 m | 19 MB | `data/terrain/senja_dtm_25m_25833.tif` | `python preprocessing/terrain.py` |
| Raw FCN3 crop (`.nc`) and common-schema `.zarr` | 1.4 MB | `data/forecast/` | `sbatch jobs/run_fcn3_senja.slurm`, then `convert_fcn3.py` |
| Synthetic `.zarr` | 0.9 MB | `data/synthetic/` | `python preprocessing/make_synthetic.py` |

The preprocessing scripts run on any machine after `pip install -r requirements.txt`
(`terrain.py` downloads from Kartverket, so it needs internet). FCN3 inference needs an
NVIDIA GPU with CUDA and `earth2studio` with the FCN3 extras, plus a `~/.cdsapirc` key to
fetch ERA5 initial conditions from CDS. Without a suitable GPU, run it on Olivia and copy
the small output back.

## Layout

```
model/fcn3_inference.py        FCN3 forecast on a GPU node → data/forecast/fcn3_<init>.nc (Senja crop)
jobs/run_fcn3_senja.slurm      SLURM wrapper (accel partition, earth2studio env)
preprocessing/common_schema.py common schema, zarr writer, web export, data index
preprocessing/convert_fcn3.py  raw FCN3 crop → common schema (.zarr + web export)
preprocessing/make_synthetic.py Phase 0 synthetic wind + synthetic terrain
preprocessing/terrain.py       Kartverket NHM DTM (WCS) → Senja terrain grid
data/terrain/                  source DTM GeoTIFF (25 m, EPSG:25833), kept for later high-res work
data/forecast/                 raw model crops + common-schema .zarr
data/web/                      browser data: index.json, <dataset>/manifest.json + *.bin
frontend/                      TypeScript + Three.js + Vite viewer
```

## Domain and data

- **Region:** 69.15–69.60° N, 16.95–18.25° E (~52 × 50 km). It covers ocean, fjords and the Senja mountains, up to about 1000 m.
- **Levels:** 1000, 925, 850, 700 and 500 hPa. Each is placed at its geopotential height H = Φ / g, which varies in space and time.
- **Times:** T+0, 6, 12, 18 and 24 h.
- **Wind grid:** 64 × 64. FCN3 runs at 0.25°, which is only about 10 km × 28 km at 69° N. The Senja grid is therefore a bilinear interpolation of a handful of model points and does not resolve terrain-scale flow. That is the job of the later high-resolution models.
- **Terrain:** Kartverket NHM DTM, resampled to 256 × 256. Use `--n 500` for 500 × 500.
- **Default forecast:** initialized 2024-01-31 06 UTC from ERA5 (via CDS), just before Storm Ingunn. The low is deep enough that the 1000 hPa surface lies below sea level over the whole domain. The viewer says so and shows no particles at that level.

### Common wind schema

`wind.zarr` / `data/web/<id>/` have dimensions `(time, level, latitude, longitude)`. Latitude is ascending.

| variable     | units  | meaning                          |
|--------------|--------|----------------------------------|
| `u`, `v`     | m s⁻¹  | zonal / meridional wind          |
| `height`     | m      | geopotential height Φ/g          |
| `wind_speed` | m s⁻¹  | √(u² + v²)                       |

The web export is `manifest.json` (coordinates, shape and value ranges) plus one little-endian
float32 `.bin` per variable. `data/web/index.json` lists every dataset and terrain, and is
rebuilt automatically on each export.

## Running

Python environments (Olivia):

- GPU inference uses `/cluster/projects/nn8106k/siyan/envs/earth2studio`, which is aarch64 and only runs on `accel` nodes.
- CPU preprocessing uses `/cluster/projects/nn8106k/siyan/envs/wind-vis-cpu` (see `requirements.txt`).

```bash
PY=/cluster/projects/nn8106k/siyan/envs/wind-vis-cpu/bin/python

# 1. synthetic data (Phase 0) and real terrain
$PY preprocessing/make_synthetic.py
$PY preprocessing/terrain.py                      # --n 500 for a finer mesh

# 2. FCN3 forecast (≈12 min, mostly the CDS download)
sbatch jobs/run_fcn3_senja.slurm                  # or: sbatch jobs/run_fcn3_senja.slurm 2024-01-31T06:00:00 cds
$PY preprocessing/convert_fcn3.py data/forecast/fcn3_20240131T06.nc

# 3. viewer
module load NRIS/CPU; module load nodejs/20.13.1-GCCcore-13.3.0
cd frontend && npm install && npm run dev         # http://127.0.0.1:5173 (VS Code forwards the port)
npm run build                                     # static site in frontend/dist (data included)
```

`frontend/public/data` is a symlink to `data/web`. URL parameters select the data, e.g.
`?data=synthetic&terrain=terrain-synthetic`.

## Viewer

- Orbit, zoom and pan the camera; **Reset camera** returns to the default view.
- Particles are advected with bilinear interpolation in space and linear interpolation in time. They have finite lifetimes and respawn when they expire, leave the domain, or flow into terrain (level height below ground). Colour shows wind speed; see the legend.
- **Single level** (Mode A) shows one level plus a translucent surface coloured by speed. **All levels** (Mode B) shows all five levels stacked at their geopotential heights.
- The timeline has play/pause, previous/next (←/→), space to toggle, drag, and a playback-speed control. **Smooth time interpolation** switches between V(t) = (1−α)V₀ + αV₁ and jumping directly between frames.
- Click anywhere to inspect a point: lat/lon, terrain height, and u, v, speed and direction for the selected level, plus a vertical profile of all levels.
- Sliders set the particle count, visual flow speed and vertical exaggeration.

Particle motion runs on a visual time scale (**Flow speed** = simulated seconds per real
second) that is independent of the forecast clock. At real speed, a 10 m/s wind crosses the
50 km domain in under 1.5 h.

## Adding another model

1. Write `model/<name>_inference.py` to produce a raw crop.
2. Write `preprocessing/convert_<name>.py` that calls `common_schema.build_dataset(...)`, then `write_zarr` and `export_web(ds, data/web/<id>)`.
3. The dataset appears in the viewer's **Forecast** menu. No frontend change is needed.

GraphCast works the same way through earth2studio, using the
`envs/earth2studio-graphcast` env and `earth2studio.models.px.GraphCastOperational`. It uses the
same `u850`/`z850` variable naming, so `convert_fcn3.py` can be reused with `--name GraphCast --web-dir graphcast`.
