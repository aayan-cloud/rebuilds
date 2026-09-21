# Rebuilds

Ten projects that were either abandoned or briefly famous, rebuilt as single
HTML files. No build step, no npm install, no accounts. Every page runs from a
browser and is meant to hold 60fps on a mid-range phone.

Open `index.html` for the hub, or any folder directly.

| Project | Rebuild of | Stack |
|---|---|---|
| `blackhole/` | HN, 477 pts — physically accurate black hole | WebGL2, no libraries |
| `lightspeed/` | HN, 630 pts — what if light went 5 km/h | WebGL2, no libraries |
| `satellites/` | GitHub, 38k stars — gods-eye-view | Three.js + satellite.js |
| `elevators/` | HN, 1,680 pts — Elevators | Canvas 2D |
| `sysdeck/` | GitHub, 45k stars, archived — eDEX-UI | Canvas 2D |
| `recorder/` | GitHub, 40k stars, archived — openscreen | MediaRecorder |
| `deck/` | HN, 1,033 pts — Bento | No dependencies |
| `dashboard/` | GitHub, 10k stars, stale — linux-dash | Python agent |
| `drop/` | Snapdrop | WebRTC |
| `agent/` | GitHub, 36k stars, archived — AgentGPT | Local llama-server |

## Running

Everything is static, so any file server works:

```bash
uv run --no-project python -m http.server 8765 --bind 127.0.0.1
```

Two pages can use a local helper, and both fall back to a working demo without it:

- **Machine** reads `dashboard/server.py` — `uv run python dashboard/server.py`
- **Localmind** talks to a llama-server on `127.0.0.1:18500`

## Benchmarks

Every page exposes `window.__bench.report()`, so the numbers come from the
pages themselves rather than a stopwatch. Add `?peak=1` to any page to run it
under deliberate overload.

```bash
npm i playwright && node bench/bench.cjs
```

That drives each project through four scenarios — desktop and mid-range phone,
each at normal and peak load — plus a cold load over throttled 3G, and writes
`bench/results.json` and `bench/RESULTS.md`.

Run it headed. Headless Chromium falls back to software WebGL, which makes the
3D numbers meaningless.

## Peak modes

| Project | What `?peak=1` does |
|---|---|
| blackhole | 600 integration steps per ray, full resolution, no auto quality |
| lightspeed | 320 march steps, full resolution, near light speed |
| satellites | 8,000 satellites propagated every frame, 60x time |
| elevators | 28 floors, 8 cars, 9 arrivals/sec, 8x simulation speed |
| sysdeck | 32 cores, 40 processes, 160 traffic arcs, 60ms telemetry |
| deck | 200 slides |
| recorder | 1920x1080 capture and encode from a synthetic source |
| dashboard | 100ms poll interval |
| drop | 512 MB loopback WebRTC transfer |
| agent | 12 tasks, unthrottled token streaming |
