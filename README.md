# Senja 3D Wind

Interactive 3D visualization of wind over Senja, Northern Norway: global AI forecasts, steady
CFD runs and WindINR downscaling, all shown over the real terrain in the browser.

```
forecast model (FCN3 · GraphCast · Aurora) ─┐
OpenFOAM CFD cases ─────────────────────────┼─▶ common wind schema ─▶ Three.js viewer
WindINR × forecast ─────────────────────────┘          + Kartverket DTM terrain
```

The viewer reads only the common schema, so a new model needs a converter and no frontend change.

## Quick start

The repo ships all the data the viewer loads (`data/web/`, about 17 MB). You only need Node.js 18 or newer.

```bash
git clone git@github.com:chensy618/3D-wind-vis.git
cd 3D-wind-vis/frontend
npm install
npm run dev        # http://127.0.0.1:5173
```

To publish the viewer on a web server, `npm run build` writes a static site, data included, to `frontend/dist`.

> **Windows:** `frontend/public/data` is a symlink to `data/web`, which git on Windows often
> checks out as a text file. If the viewer cannot load data, replace it with a copy of `data/web`,
> or clone with `git clone -c core.symlinks=true` with Developer Mode on.

## The two views

The switcher at the top of the page moves between them.

### 3D wind viewer (`index.html`)

| Panel | What it does |
|---|---|
| **Query point** | Type `lat, lon` (e.g. `69.35, 17.60`; `lon, lat` is swapped automatically) to inspect a point. The camera pans to it. |
| **Data** | The dataset menu, grouped as below; the terrain follows the dataset. |
| **Layers** | One checkbox per level and one for the 10 m wind, plus **All layers**. Everything is on at load. |
| **Display** | Level surfaces (translucent, coloured by speed), smooth time interpolation, reset camera. |
| **Inspector** | Click the terrain: position, ground height, and speed, direction and w per level, with a vertical profile. |
| **Timeline** | Play/pause, step (← / →, space), drag, playback speed. Hidden for steady CFD cases. |

- Particles follow the wind with bilinear interpolation in space and linear interpolation in time. They respawn when they expire, leave the domain or run into the terrain. Colour shows horizontal speed.
- Datasets with a vertical wind (WindINR, CFD, synthetic) move particles with **w** too.
- The **10 m layer** is a flat level at 10 m above sea level. Like the other levels, it is hidden where the terrain is higher.
- **Vertical exaggeration** follows the domain size: ×4 for the 50 km Senja domain, ×1.5 for the CFD box.
- The panels keep the same layout on every screen. Below 1400 × 800 they shrink as one; phones get a stacked layout.
- Flow speed is a visual time scale, not the forecast clock: at real speed, 10 m/s crosses the 50 km domain in about 1.5 h.

Mouse: left-drag rotates, right-drag pans, the wheel zooms, a click inspects.

### Forecast vs WindINR (`compare.html`)

Two linked views over the CFD box, sharing the camera, time and colour scale:

- **left:** the raw forecast at its own resolution, with the model grid and one arrow per grid cell;
- **right:** WindINR driven by that forecast, with the CFD grid.

Choose the forecast model and the levels (or the 10 m layer) in the bar at the top. A click shows speed, direction and w per level in both views.

## Datasets

| Menu group | Datasets | Domain | Levels |
|---|---|---|---|
| Forecast · Senja 50 km | FCN3 0.25°, GraphCast 0.25°, Aurora 0.1° (init 2024-01-31 06 UTC, T+0…24 h) | 69.15–69.60° N, 16.95–18.25° E | 1000, 925, 850, 700, 500 hPa + 10 m |
| Forecast, native resolution · CFD box | the same forecasts, nearest model grid point on the CFD box | CFD box | 50, 150, 300, 500 m ASL + 10 m |
| WindINR × forecast · CFD box | WindINR downscaling of each forecast | CFD box | 50, 150, 300, 500 m ASL + 10 m, with w |
| CFD cases · CFD box | 9 steady OpenFOAM cases: from SW at 8/12/16 m/s, from W, NW, N, NE, E, S at 12 m/s | CFD box | 50 … 1500 m ASL (7 levels) + 10 m, with w |
| Test | synthetic field with a vertical wind forced by the Senja DTM | Senja | 50, 150, 300, 500 m ASL + 10 m, with w |

- **Senja domain:** about 52 × 50 km of ocean, fjords and mountains up to ~1000 m; 64 × 64 wind grid; terrain from the Kartverket NHM DTM 25 m, resampled to 256 × 256.
- **CFD box:** about 6 × 6 km around Segla/Ersfjord (69.56–69.61° N, 17.41–17.55° E), with a 10 m DTM.
- **Coarse models:** FCN3 and GraphCast have only about 12 grid points over Senja (Aurora about 65), so their wind does not resolve the terrain. WindINR and the CFD cases do.
- **Default case:** init 2024-01-31 06 UTC, just before Storm Ingunn. The low is so deep that the 1000 hPa surface lies below sea level over the whole domain.

## Repository layout

```
model/            inference: fcn3, aurora01, graphcast (GPU), windinr
jobs/             SLURM / container wrappers for the inference scripts
preprocessing/    converters to the common schema, terrain, synthetic data
  common_schema.py   schema, zarr writer, web export, data/web/index.json
  convert_fcn3.py    raw forecast crop → schema (FCN3, Aurora, GraphCast)
  convert_openfoam.py  OpenFOAM cases → flat ASL levels + CFD-box terrain
  convert_windinr.py   forecast → WindINR inputs; WindINR output → schema
  terrain.py         Kartverket NHM DTM (WCS) → Senja terrain grid
  make_synthetic.py  synthetic test field on the Senja DTM
data/web/         what the browser loads: index.json, <dataset>/manifest.json + *.bin
frontend/         TypeScript + Three.js + Vite
```

## Common wind schema

Each dataset is `data/web/<id>/manifest.json` plus one little-endian float32 `.bin` per
variable, with dimensions `(time, level, latitude, longitude)` and latitude ascending.
`index.json` is rebuilt on every export.

| Variable | Units | Meaning |
|---|---|---|
| `u`, `v` | m s⁻¹ | zonal / meridional wind |
| `w` | m s⁻¹ | vertical wind, positive up (optional) |
| `height` | m | level height: geopotential Φ/g, or the level itself for flat levels |
| `wind_speed` | m s⁻¹ | √(u² + v²) |
| `u10`, `v10`, `w10` | m s⁻¹ | optional 10 m wind, `(time, latitude, longitude)`, under `surface` |

Optional manifest fields: `label` (menu name), `group` (menu group), `level_units` (`hPa`, the
default, or `m ASL`), `terrain` (the terrain the domain was built on; the viewers load it with the
dataset) and `native_deg` (model grid spacing, drawn as grid lines).

## Regenerating the data

Only needed to change or add data. Not in the repo (see `.gitignore`), but reproducible:

| Data | Size | Regenerate with |
|---|---|---|
| Source DTM GeoTIFF, 25 m (`data/terrain/`) | 19 MB | `preprocessing/terrain.py` |
| Raw forecast crops and `.zarr` (`data/forecast/`) | 0.5–2 MB each | the inference job, then `convert_fcn3.py` |
| GraphCast ERA5 input + weights | 0.7 + 0.14 GB | `graphcast_inference.py --fetch-only` |
| Aurora IFS HRES input + weights | 6.5 + 4.9 GB | `aurora01_inference.py --fetch-only` |
| Synthetic `.zarr` (`data/synthetic/`) | 0.9 MB | `make_synthetic.py` |
| OpenFOAM cases | ~0.1 GB each | `wind_sim` (separate repo), then `convert_openfoam.py` |

### CFD cases

Steady RANS (`simpleFoam`, k-ε, neutral log-law inflow) on a ~197 k-cell terrain-following mesh.
Each case is one inflow direction and speed (`Uref` at 10 m), so the dataset has a single frame.

`convert_openfoam.py` interpolates the cell-centre velocity to 96 × 96 points on the flat levels
and to 10 m above ground. The wind is 0 inside the terrain. Below the first cell centre (17 m over
the sea) it follows the log law, u/v are rotated from UTM grid north to true north (~2°), and
250 m is trimmed off each side, where the terrain meets the inflow and outflow boundaries.

Case names give the direction the flow goes *toward* as a math angle (`D225` = toward the SW,
so from the NE); the 45° cases are named `case_senja_U<speed>`, without a `D`.

### WindINR × forecast

WindINR does not forecast by itself. Trained on 65 of the CFD cases (checkpoint `senja_v1/v3`),
it downscales each lead time of a coarse forecast to a high-resolution 3D field on the CFD box,
so together with the forecast model it gives a high-resolution wind prediction. Its input is the
forecast's mean wind between the ground and 500 m on a 7 × 7 (~1 km) grid. Below 25 m above
ground the training data are too slow, so the wind there is taken at 25 m and extended with the
log law.

The native-resolution datasets put the driving forecast on the same grid and levels at its own
resolution: one 0.25° point covers the whole box for FCN3 and GraphCast, two 0.1° points for Aurora.

## Adding a model

1. Write `model/<name>_inference.py` to produce a raw crop.
2. Convert it with `common_schema.build_dataset(...)`, then `write_zarr` and `export_web(ds, data/web/<id>)`. Models with earth2studio-style variable names (`u850`, `z850`, …) can reuse `convert_fcn3.py --name <Name> --web-dir <id>`.
3. The dataset appears in the viewer's **Dataset** menu.
