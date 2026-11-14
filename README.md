# Midtown NYC — a World Labs Marble world

A walkable 3D Gaussian-splat world of a Midtown Manhattan intersection, generated
with the [World Labs](https://www.worldlabs.ai) Marble API (`marble-1.1-plus`) and
rendered in the browser with [Spark](https://sparkjs.dev) + three.js.

![Panorama preview](assets/preview.jpg)

## View it

The page loads the 3D file with `fetch`, so it must be served over HTTP (opening
`index.html` directly from disk won't work):

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Or enable **GitHub Pages** (Settings → Pages → Deploy from branch → `main` / root)
and open the published URL.

Controls:

- **Click** the scene to look around with the mouse (a dot marks the centre), **Esc** to release
- **WASD** move · **Q/E** down/up · **Shift** faster
- Web pages stay **closed boxes** until you're close enough to read them, then open automatically
  (and close again when you walk away) to keep the scene uncluttered.
- **Aim the dot** at an open page: the **mouse wheel** scrolls it, the link under the dot is
  highlighted, and **click** follows it inside the panel. Aim at **◀ Back** and click to go back.
- **T** add floating text (optionally with a web page under it) · **U** undo · **C** copy labels ·
  **P** show/hide pages

Pages are shown as clean, script-free reading views (fetched as HTML) so the crosshair can drive
them. Wikipedia works well; other sites only work if they allow cross-origin fetching.

Add `?quality=full` to the URL to stream the full-resolution splat (~69 MB) from the
World Labs CDN instead of the bundled 500k version (~8 MB).

You can also open it in World Labs' own viewer:
https://marble.worldlabs.ai/world/826538f2-f5c8-4ec8-9abd-9deec5b479fe

## Files

| Path | What |
| --- | --- |
| `index.html` | Self-contained viewer (three.js + Spark from CDN, no build step) |
| `assets/nyc_500k.spz` | 500k Gaussian splats (SPZ format) |
| `assets/nyc_pano.jpg` | 4608×2304 equirectangular panorama |
| `assets/preview.jpg` | Smaller panorama for this README |
| `world.json` | Prompt, World Labs caption, world id, and source asset URLs |

The full-resolution splat is linked from the World Labs CDN rather than committed,
because it is too large for a normal Git repo.
