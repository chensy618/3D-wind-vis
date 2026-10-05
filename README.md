# Senja 3D Wind — MVP

Interactive 3D visualization of multi-level atmospheric wind over Senja, Northern Norway.

```
FCN3 (pretrained)  →  Senja crop  →  u / v / geopotential, 10 m wind  →  common wind schema  →  Three.js viewer
                                                                                              + Kartverket DTM terrain
```

Three pretrained models drive the viewers: **FourCastNet v3 (FCN3, 0.25°)** from earth2studio
and **GraphCast 0.25°** (Google DeepMind, `GraphCast_operational`), both started from ERA5, and
**Aurora 0.1° Fine-Tuned** (Microsoft, `AuroraHighRes`), started from IFS HRES analysis. The
viewers read only the common schema, so ERA5, CARRA or the U-NO/GNO/NOFE models can be added
later by writing another converter.

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

- FCN3 forecast initialized 2024-01-31 06 UTC: T+0 to T+24 h, 5 pressure levels (u, v, height, wind speed) and the 10 m wind
- Aurora 0.1° forecast for the same case and the same fields (65 model grid points over Senja, against 12 for FCN3)
- GraphCast 0.25° forecast for the same case and the same fields (12 grid points; same ERA5 initial state as FCN3)
- Senja terrain: Kartverket DTM resampled to 256 × 256

Not included (excluded by `.gitignore`; kept on Olivia and reproducible with the scripts):

| Data | Size | Location | Regenerate with |
|---|---|---|---|
| Source DTM GeoTIFF, 25 m | 19 MB | `data/terrain/senja_dtm_25m_25833.tif` | `python preprocessing/terrain.py` |
| Raw FCN3 crop (`.nc`) and common-schema `.zarr` | 1.4 MB | `data/forecast/` | `sbatch jobs/run_fcn3_senja.slurm`, then `convert_fcn3.py` |
| Raw Aurora 0.1° crop (`.nc`) and `.zarr` | 2 MB | `data/forecast/` | `aurora01_inference.py --fetch-only`, `sbatch jobs/run_aurora01_senja.slurm`, then `convert_fcn3.py` |
| Raw GraphCast 0.25° crop (`.nc`) and `.zarr` | 0.5 MB | `data/forecast/` | `graphcast_inference.py --fetch-only`, `sbatch jobs/run_graphcast_senja.slurm`, then `convert_fcn3.py` |
| ERA5 input (GraphCast) and GraphCast 0.25° weights | 0.7 + 0.14 GB | `/cluster/work/projects/nn8106k/siyan/{graphcast_cache,windvis_weights/graphcast-operational}` | `graphcast_inference.py --fetch-only` |
| IFS HRES analysis GRIB (Aurora input) and Aurora 0.1° weights | 6.5 + 4.9 GB | `/cluster/work/projects/nn8106k/siyan/{aurora01_cache,windvis_weights/aurora-0.1}` | `aurora01_inference.py --fetch-only` |

The preprocessing scripts run on any machine after `pip install -r requirements.txt`
(`terrain.py` downloads from Kartverket, so it needs internet). FCN3 inference needs an
NVIDIA GPU with CUDA and `earth2studio` with the FCN3 extras, plus a `~/.cdsapirc` key to
fetch ERA5 initial conditions from CDS. Without a suitable GPU, run it on Olivia and copy
the small output back.

## Layout

```
model/fcn3_inference.py        FCN3 forecast on a GPU node → data/forecast/fcn3_<init>.nc (Senja crop)
jobs/run_fcn3_senja.slurm      SLURM wrapper (accel partition, earth2studio env)
model/aurora01_inference.py    Aurora 0.1°: fetch IFS HRES analysis (login node), run on a GPU node → data/forecast/aurora01_<init>.nc
jobs/run_aurora01_senja.slurm  SLURM wrapper (GH200, earth2studio env + microsoft-aurora on PYTHONPATH)
model/graphcast_inference.py   GraphCast 0.25°: fetch ERA5 from ARCO (login node), run with JAX on a GPU node → data/forecast/graphcast_<init>.nc
jobs/run_graphcast_senja.slurm SLURM wrapper (GH200, earth2studio-graphcast env: jax[cuda13], dm-haiku, graphcast)
preprocessing/common_schema.py common schema, zarr writer, web export, data index
preprocessing/convert_fcn3.py  raw FCN3 crop → common schema (.zarr + web export)
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
| `u10`, `v10` | m s⁻¹  | optional 10 m wind, `(time, latitude, longitude)`, listed under `surface` in the manifest (FCN3 has it) |

The web export is `manifest.json` (coordinates, shape and value ranges) plus one little-endian
float32 `.bin` per variable. `data/web/index.json` lists every dataset and terrain, and is
rebuilt automatically on each export.

## Running

Python environments (Olivia):

- GPU inference uses `/cluster/projects/nn8106k/siyan/envs/earth2studio`, which is aarch64 and only runs on `accel` nodes.
- CPU preprocessing uses `/cluster/projects/nn8106k/siyan/envs/wind-vis-cpu` (see `requirements.txt`).

```bash
PY=/cluster/projects/nn8106k/siyan/envs/wind-vis-cpu/bin/python

# 1. terrain
$PY preprocessing/terrain.py                      # --n 500 for a finer mesh

# 2. FCN3 forecast (≈12 min, mostly the CDS download)
sbatch jobs/run_fcn3_senja.slurm                  # or: sbatch jobs/run_fcn3_senja.slurm 2024-01-31T06:00:00 cds
$PY preprocessing/convert_fcn3.py data/forecast/fcn3_20240131T06.nc

# 2b. Aurora 0.1° (≈30 min download once, ≈3 min on one GH200)
#     IFS HRES analysis at t-6 h and t from NCAR GDEX (d113001, formerly RDA), anonymous
$PY model/aurora01_inference.py --fetch-only     # login node: GRIB + checkpoint + static fields
pip install --no-deps --target /cluster/work/projects/nn8106k/siyan/pylib/aurora microsoft-aurora==2.0.1   # once
sbatch jobs/run_aurora01_senja.slurm              # or: sbatch jobs/run_aurora01_senja.slurm 2024-01-31T06
$PY preprocessing/convert_fcn3.py data/forecast/aurora01_20240131T06.nc --name Aurora --web-dir aurora01

# 2c. GraphCast 0.25° (ERA5 from ARCO, anonymous; ≈1 min download, ≈2.5 min on one GH200)
$PY model/graphcast_inference.py --fetch-only     # login node: ERA5 at t-6 h and t + weights
sbatch jobs/run_graphcast_senja.slurm             # or: sbatch jobs/run_graphcast_senja.slurm 2024-01-31T06
$PY preprocessing/convert_fcn3.py data/forecast/graphcast_20240131T06.nc --name GraphCast --web-dir graphcast025

# 3. viewer
module load NRIS/CPU; module load nodejs/20.13.1-GCCcore-13.3.0
cd frontend && npm install && npm run dev         # http://127.0.0.1:5173 (VS Code forwards the port)
npm run build                                     # static site in frontend/dist (data included)
```

`frontend/public/data` is a symlink to `data/web`. URL parameters select the data, e.g.
`?data=fcn3&terrain=terrain`.

## Viewer

- Orbit, zoom and pan the camera; **Reset camera** returns to the default view.
- Particles are advected with bilinear interpolation in space and linear interpolation in time. They have finite lifetimes and respawn when they expire, leave the domain, or flow into terrain (level height below ground). Colour shows wind speed; see the legend.
- **Selected levels** (Mode A) shows one or more chosen levels (tick several in the list), each with its own particles and a translucent surface coloured by speed. **All levels** (Mode B) shows all five levels stacked at their geopotential heights, without surfaces.
- The timeline has play/pause, previous/next (←/→), space to toggle, drag, and a playback-speed control. **Smooth time interpolation** switches between V(t) = (1−α)V₀ + αV₁ and jumping directly between frames.
- Click anywhere to inspect a point: lat/lon, terrain height, and u, v, speed and direction for the selected level, plus a vertical profile of all levels.
- **Query point:** type `lat, lon` (e.g. `69.35, 17.60`; `lon lat` is swapped automatically) to inspect that point the same way. The point is marked with a pulsing ring and the camera pans to it.
- Sliders set the particle count, visual flow speed and vertical exaggeration.

Particle motion runs on a visual time scale (**Flow speed** = simulated seconds per real
second) that is independent of the forecast clock. At real speed, a 10 m/s wind crosses the
50 km domain in under 1.5 h.

## Surface wind page (`surface.html`)

Linked from the viewer header. It shows how the Senja terrain changes the 10 m wind: where
the flow is steered, sped up, sheltered, lifted and sunk. Global models resolve Senja with only a
few grid points, so the page adds the terrain response in the browser, from a background wind and
the DTM.

The page is driven by a model's 10 m wind. Tuning parameters are folded under **More settings**.

- **10 m wind:**
  - **Model:** every dataset with a 10 m wind field. Today that is FCN3 at 0.25°; a finer model added later appears here with its own grid. The grid spacing comes from `native_deg` in the manifest.
  - **Time:** a slider from T+0 to T+24 h, with playback.
  - **Terrain adjustment:** off shows the model as it is, one wind per model grid cell, with vertical wind from each cell's mean slope. On, the model wind is interpolated to the 200 m terrain grid and goes through the terrain response below. Both share the colour scales of the adjusted field, so the raw model's weak vertical wind is not stretched to look strong.
- **Show:**
  - **Colour:** the terrain by elevation only (default), by 10 m speed, or by vertical wind (red rising, blue sinking).
  - **Grid:** chooses the model grid (~12 cells over the domain for FCN3) or the 200 m terrain grid (65 536 cells), and the line below it gives the count. The particles follow this choice: one particle per cell, which always respawns inside its cell and moves with the wind of the nearest grid point, with no smoothing between points. Arrows (More settings) use the same grid. **Grid lines** draws the grid.
- **Point:** click the terrain, or type `lat, lon` under **Query point**, for the 10 m wind, how far the terrain turned it, and the vertical wind. The point gets a pulsing ring and a 10 m marker; a query also pans the camera to it.

Particles, arrows and grids are drawn 10 m above the ground. Particles follow the 200 m terrain at both resolutions so that they stay visible.

How the terrain response is computed:

- **Layer flow (steering and speed-up):** air in a layer between the ground and a stable lid conserves mass, ∇·((top − h) V) = 0, and stays irrotational. The flow speeds up across crests and is partly pushed around the mountains. The lid is 800 m above the highest summit (`layerDepth` in `frontend/src/surface/main.ts`); a shallower lid means more stable air and more blocking. The equation is linear in the background wind, so it is solved once for east and once for north, and each cell mixes the two with its local FCN3 wind. It runs on the terrain grid itself (256 × 256, ~200 m), so the wind and the terrain have the same resolution. Red-black SOR stops at a relative residual of 1e-4: about 1000 sweeps, 0.4 s on load, and ~25 ms per time step.
- **Lee sheltering:** speed is reduced by the steepest upwind terrain angle within 3 km (Winstral Sx), by up to 60 % (`shelter`).
- **Vertical wind:** air at the ground follows the terrain, so w = V·∇h. It is positive on windward slopes and negative on lee slopes. At terrain resolution the particles stay 10 m above the ground, so their climbing and sinking is exactly this w.

This is a teaching and exploration tool, not a forecast. It has no lee waves, downslope
windstorms, flow separation or thermal (katabatic) winds.

## Adding another model

1. Write `model/<name>_inference.py` to produce a raw crop.
2. Write `preprocessing/convert_<name>.py` that calls `common_schema.build_dataset(...)`, then `write_zarr` and `export_web(ds, data/web/<id>)`.
3. The dataset appears in the viewer's **Forecast** menu. No frontend change is needed.

GraphCast works the same way through earth2studio, using the
`envs/earth2studio-graphcast` env and `earth2studio.models.px.GraphCastOperational`. It uses the
same `u850`/`z850` variable naming, so `convert_fcn3.py` can be reused with `--name GraphCast --web-dir graphcast`.
