# Senja 3D Wind Visualization MVP --- Development Plan

## 1. Objective

Build a small interactive web prototype for visualizing atmospheric wind
forecasts over **Senja, Northern Norway**.

The MVP should demonstrate the complete pipeline:

**Pretrained weather model → regional wind-field extraction → web-ready
data → interactive 3D visualization**

The first version is intentionally small. It is designed to validate the
visualization and data pipeline before integrating the future
high-resolution U-NO, GNO, and NOFE models.

------------------------------------------------------------------------

## 2. MVP Scope

### Region

Use a small region of Senja rather than all of Northern Norway.

Initial target:

-   Approximately **30--50 km × 30--50 km**
-   Prefer an area containing:
    -   ocean
    -   fjord
    -   steep mountains
    -   complex coastline

This makes Senja particularly useful for demonstrating the relationship
between complex terrain and atmospheric wind.

### Pretrained model

Start with **Aurora Small Pretrained** as the development model.

The small checkpoint is suitable for debugging and pipeline development.
Once the workflow is stable, it can be replaced with the full Aurora
pretrained model or the project's own neural-operator models.

### Atmospheric variables

Initial data schema:

\[ u(t,p,y,x) \]

\[ v(t,p,y,x) \]

\[ `\Phi`{=tex}(t,p,y,x) \]

where:

-   (t): forecast time
-   (p): pressure level
-   (x,y): horizontal coordinates
-   (u): zonal wind
-   (v): meridional wind
-   (`\Phi`{=tex}): geopotential

Aurora does not directly provide vertical wind velocity (w), so the
first prototype should be described as a **multi-level 3D atmospheric
wind visualization**, rather than a full ((u,v,w)) velocity-field
visualization.

Future models may extend the common schema to:

\[ `\mathbf{V}`{=tex}(x,y,z,t)=(u,v,w) \]

------------------------------------------------------------------------

## 3. Vertical Levels

Use only five pressure levels initially:

  Pressure level   Purpose
  ---------------- -------------------------
  1000 hPa         Near-surface atmosphere
  925 hPa          Lower atmosphere
  850 hPa          Lower atmosphere
  700 hPa          Mid atmosphere
  500 hPa          Mid atmosphere

The levels should **not be displayed at equally spaced geometric
heights**.

Use geopotential to estimate geopotential height:

\[ H `\approx `{=tex}`\frac{\Phi}{g}`{=tex} \]

and use this height for positioning atmospheric layers in the 3D scene.

------------------------------------------------------------------------

## 4. Forecast Times

Keep the temporal dimension small:

-   T+0 h
-   T+6 h
-   T+12 h
-   T+18 h
-   T+24 h

The web interface should contain a timeline:

`00 h — 06 h — 12 h — 18 h — 24 h`

Users should be able to:

-   select a forecast time
-   play/pause the sequence
-   move backward/forward
-   eventually interpolate between forecast steps for smoother animation

------------------------------------------------------------------------

## 5. Common Data Interface

The visualization should not depend directly on Aurora.

Define a common wind-data format so that future models can use exactly
the same frontend.

Conceptual structure:

``` text
time
 └── level
      └── y
           └── x
                ├── u
                ├── v
                ├── height
                └── wind_speed
```

Recommended dimensions for the first prototype:

``` text
time       = 5
level      = 5
y          ≈ 40–100
x          ≈ 40–100
```

The initial dataset should remain deliberately small.

Later converters can map different sources into the same schema:

``` text
Aurora  ──────┐
ERA5   ───────┤
CARRA  ───────┤
U-NO   ───────┤ → Common Wind Schema → 3D Viewer
GNO     ──────┤
NOFE    ──────┘
```

------------------------------------------------------------------------

## 6. Phase 0 --- Synthetic Prototype

Before connecting Aurora, generate a small synthetic wind field.

Example:

\[ u(x,y,z)=5+2`\sin`{=tex}(x) \]

\[ v(x,y,z)=3`\cos`{=tex}(y) \]

The purpose is to test the frontend independently from the weather
model.

### Deliverable

A browser page showing animated particles moving through a synthetic
wind field.

No backend is required.

------------------------------------------------------------------------

## 7. Phase 1 --- Basic 3D Scene

Recommended frontend stack:

-   TypeScript
-   Three.js
-   WebGL

Initial scene:

``` text
Scene
 ├── Camera
 ├── Lighting
 ├── Terrain
 ├── Wind particles
 └── UI controls
```

Required interactions:

-   rotate
-   zoom
-   pan
-   reset camera

Start with synthetic terrain before introducing the real Senja DTM.

------------------------------------------------------------------------

## 8. Phase 2 --- Wind Particle System

Represent each particle as:

\[ P_i=(x_i,y_i,z_i) \]

The wind field determines particle movement:

\[ P_i\^{t+`\Delta `{=tex}t} =
P_i^t+`\mathbf{V}`{=tex}(P_i^t)`\Delta `{=tex}t \]

For Aurora:

\[ `\mathbf{V}`{=tex}=(u,v,0) \]

for the initial implementation.

### Particle workflow

``` text
Particle position
       ↓
Locate surrounding wind-grid cells
       ↓
Interpolate wind
       ↓
Obtain u, v
       ↓
Update particle position
       ↓
Render
```

Start with approximately **2,000--5,000 particles** and increase only
after profiling browser performance.

------------------------------------------------------------------------

## 9. Wind Interpolation

Particles will normally lie between model grid points.

For a single atmospheric level, use bilinear interpolation:

\[ u(x,y)=`\mathrm{Bilinear}`{=tex}(u\_{grid}) \]

\[ v(x,y)=`\mathrm{Bilinear}`{=tex}(v\_{grid}) \]

For future full 3D fields containing (w), extend this to trilinear
interpolation:

\[ u(x,y,z),`\quad `{=tex}v(x,y,z),`\quad `{=tex}w(x,y,z) \]

Keep interpolation in a separate module so it can be reused by all
models.

Suggested file:

``` text
interpolation.ts
```

------------------------------------------------------------------------

## 10. Particle Lifecycle

Each particle should have a finite lifetime.

Example:

``` text
age
maxAge
position
velocity
```

Respawn the particle when:

-   `age > maxAge`
-   it leaves the visualization domain
-   it enters an invalid/masked region

New particles should be initialized within valid atmospheric regions.

------------------------------------------------------------------------

## 11. Wind Speed Visualization

For Aurora:

\[ S=`\sqrt{u^2+v^2}`{=tex} \]

For future 3D velocity fields:

\[ S=`\sqrt{u^2+v^2+w^2}`{=tex} \]

Encode information using:

-   particle movement direction → wind direction
-   particle movement speed → approximate flow speed
-   particle color → wind-speed magnitude

Include a wind-speed legend in m s⁻¹.

------------------------------------------------------------------------

## 12. Phase 3 --- Real Senja Terrain

Replace synthetic terrain with a Digital Terrain Model.

Pipeline:

``` text
DTM
 ↓
Crop Senja region
 ↓
Reproject if required
 ↓
Downsample
 ↓
Generate terrain mesh
 ↓
Three.js
```

Do not use the full native DTM resolution in the browser initially.

For a 30--50 km domain, start with approximately:

-   250 × 250 terrain vertices, or
-   500 × 500 if performance remains good.

The original high-resolution terrain should remain available for future
high-resolution experiments.

------------------------------------------------------------------------

## 13. Phase 4 --- Aurora Integration

Once the visualization works with synthetic data, connect the pretrained
weather model.

Pipeline:

``` text
Initial weather data
        ↓
Aurora Small Pretrained
        ↓
Forecast
        ↓
Crop Senja
        ↓
Select five pressure levels
        ↓
Extract u, v, geopotential
        ↓
Convert geopotential → height
        ↓
Convert to common schema
        ↓
Web visualization
```

Keep model inference completely separate from frontend code.

------------------------------------------------------------------------

## 14. Aurora Converter

Create a dedicated preprocessing script:

``` text
convert_aurora.py
```

Input:

``` text
Aurora prediction
```

Output:

``` text
wind.zarr
```

Proposed structure:

``` text
wind.zarr
│
├── coordinates
│   ├── time
│   ├── level
│   ├── latitude
│   └── longitude
│
└── variables
    ├── u
    ├── v
    ├── height
    └── wind_speed
```

Future converters can follow the same interface:

``` text
convert_era5.py
convert_carra.py
convert_uno.py
convert_gno.py
convert_nofe.py
```

------------------------------------------------------------------------

## 15. Phase 5 --- Vertical Visualization

Implement two visualization modes.

### Mode A --- Single Level

Example:

``` text
Vertical level

○ 500 hPa
○ 700 hPa
● 850 hPa
○ 925 hPa
○ 1000 hPa
```

Only particles belonging to the selected atmospheric level are
displayed.

This should be implemented first.

### Mode B --- Multi-Level Atmosphere

Display particles across several atmospheric levels simultaneously.

Conceptually:

``` text
500 hPa       → → → →

700 hPa         → → →

850 hPa      ↗ → → →

925 hPa       → → →

1000 hPa    → → → →
────────────────────────
       Senja terrain
```

The actual vertical positions should be based on geopotential height.

------------------------------------------------------------------------

## 16. Phase 6 --- Time Playback

Add a timeline:

``` text
T+0 ━━━ T+6 ━━━ T+12 ━━━ T+18 ━━━ T+24
                    ●
```

Controls:

-   Play
-   Pause
-   Previous
-   Next
-   Drag timeline
-   Playback speed

Initially switch directly between forecast times.

Later implement temporal interpolation:

\[ V(t) = (1-`\alpha`{=tex})V\_{t_0} + `\alpha `{=tex}V\_{t_1} \]

to provide smooth transitions.

------------------------------------------------------------------------

## 17. Point Inspection

Allow users to click/select a position in the atmospheric field.

Example information panel:

``` text
Latitude      69.xx°
Longitude     17.xx°
Height        1,250 m

U             7.3 m/s
V            -2.1 m/s
Wind speed    7.6 m/s
Model         Aurora
Lead time     +12 h
```

This interface can later support direct model comparisons.

------------------------------------------------------------------------

## 18. Proposed Project Structure

``` text
senja-3d-wind/

├── model/
│   ├── aurora_inference.py
│   └── download_weights.py
│
├── preprocessing/
│   ├── crop_senja.py
│   ├── convert_aurora.py
│   ├── terrain.py
│   └── common_schema.py
│
├── data/
│   ├── synthetic/
│   ├── terrain/
│   └── forecast/
│
├── frontend/
│   ├── src/
│   │
│   ├── scene/
│   │   ├── terrain.ts
│   │   ├── particles.ts
│   │   └── camera.ts
│   │
│   ├── wind/
│   │   ├── loader.ts
│   │   ├── interpolation.ts
│   │   └── advection.ts
│   │
│   ├── ui/
│   │   ├── timeline.ts
│   │   ├── levels.ts
│   │   └── inspector.ts
│   │
│   └── main.ts
│
├── README.md
└── requirements.txt
```

------------------------------------------------------------------------

## 19. Development Order

### Step 1 --- WebGL foundation

Implement:

-   Three.js scene
-   camera
-   controls
-   synthetic terrain

**Success criterion:** a user can smoothly explore the 3D domain.

### Step 2 --- Synthetic wind

Implement:

-   synthetic u/v grid
-   particle generation
-   bilinear interpolation
-   particle advection
-   particle lifecycle

**Success criterion:** particles visibly follow a known synthetic wind
pattern.

### Step 3 --- Vertical atmosphere

Implement:

-   five levels
-   vertical positioning
-   level selector
-   single-level and multi-level views

**Success criterion:** atmospheric wind can be explored at different
heights.

### Step 4 --- Temporal dimension

Implement:

-   five forecast times
-   timeline
-   play/pause
-   frame switching

**Success criterion:** users can replay changing wind fields.

### Step 5 --- Senja terrain

Implement:

-   real DTM preprocessing
-   terrain mesh
-   correct geographic positioning

**Success criterion:** the wind field is displayed over recognizable
Senja terrain.

### Step 6 --- Aurora

Implement:

-   pretrained checkpoint
-   inference
-   Senja cropping
-   pressure-level extraction
-   common-schema conversion

**Success criterion:** real Aurora forecast winds replace synthetic
winds without changing the viewer architecture.

### Step 7 --- Polish and optimize

Implement:

-   wind-speed legend
-   point inspection
-   loading indicators
-   particle-performance optimization
-   basic error handling

**Success criterion:** stable demonstration-ready MVP.

------------------------------------------------------------------------

## 20. Four-Week Schedule

### Week 1 --- 3D Visualization Foundation

Tasks:

-   initialize TypeScript/Three.js project
-   implement scene and camera
-   create synthetic terrain
-   create synthetic wind grid
-   implement particles
-   implement interpolation and advection

**Milestone:** synthetic 3D wind is running interactively in the
browser.

### Week 2 --- Atmospheric and Geographic Data

Tasks:

-   add five vertical levels
-   implement level selection
-   add time dimension
-   implement timeline
-   obtain/process Senja DTM
-   replace synthetic terrain

**Milestone:** multi-level atmospheric wind can be played over real
Senja terrain.

### Week 3 --- Pretrained Model Integration

Tasks:

-   set up Aurora
-   download Aurora Small pretrained checkpoint
-   prepare model inputs
-   run test inference
-   extract Senja region
-   select pressure levels
-   convert geopotential to height
-   export common wind format
-   connect output to frontend

**Milestone:** Aurora forecast output is visualized over Senja.

### Week 4 --- Interaction and Optimization

Tasks:

-   improve particle rendering
-   add wind-speed legend
-   add point inspection
-   improve timeline
-   add smooth temporal interpolation if time permits
-   clean project structure
-   document setup and data format

**Milestone:** demonstration-ready Senja 3D Wind MVP.

------------------------------------------------------------------------

## 21. Explicitly Out of Scope for MVP

Do **not** implement yet:

-   FastAPI
-   PostgreSQL
-   authentication
-   entire Northern Norway
-   operational real-time forecasting
-   large 72-hour forecast archive
-   multiple model comparison
-   station validation
-   CFD
-   production cloud infrastructure
-   mobile optimization

The MVP should remain focused on:

-   one Senja region
-   one pretrained model
-   five vertical levels
-   five forecast times
-   real terrain
-   wind particles
-   interactive 3D visualization
-   time playback

------------------------------------------------------------------------

## 22. Post-MVP Architecture

After the MVP works, extend the system toward:

``` text
ERA5 / CARRA / MET Nordic / Stations / Terrain
                       ↓
              High-resolution model
             U-NO / GNO / NOFE
                       ↓
             Common Wind Schema
                       ↓
              Forecast Archive
                       ↓
                    API
                       ↓
               3D Wind Viewer
```

The visualization should eventually allow model switching:

``` text
Aurora
ERA5
CARRA
U-NO
GNO
NOFE
```

without changing the rendering pipeline.

------------------------------------------------------------------------

## 23. Longer-Term Scientific Features

After the basic viewer is stable, possible extensions include:

### Model comparison

Display coarse and high-resolution predictions side by side.

### Station observations

Overlay meteorological stations and compare predicted and observed wind.

### Error fields

Visualize:

\[ \|`\mathbf{V}`{=tex}*{pred}-`\mathbf{V}`{=tex}*{obs}\| \]

or differences between models.

### Vertical profiles

Select a location and display wind variation with altitude.

### Vertical cross-sections

Draw a transect across a fjord or mountain range and visualize
atmospheric flow along the section.

### High-wind event browser

Select historical strong-wind events and replay model predictions.

### Full 3D velocity

When a future model provides vertical velocity:

\[ `\mathbf{V}`{=tex}=(u,v,w) \]

upgrade particle advection from multi-level horizontal flow to a true
three-dimensional velocity field.

------------------------------------------------------------------------

## 24. Final MVP Definition

The MVP is considered complete when the following pipeline works
end-to-end:

``` text
Pretrained Aurora
        ↓
Forecast wind
        ↓
Senja subset
        ↓
u / v / geopotential
        ↓
Common wind format
        ↓
Three.js
        ↓
Senja terrain
+
animated atmospheric wind particles
+
vertical-level selection
+
forecast time playback
```

This MVP should serve as the reusable visualization foundation for the
later high-resolution wind-prediction work using multi-resolution
inputs, terrain information, and neural operators.
