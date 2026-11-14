# Midtown NYC — a World Labs Marble world

A walkable 3D Gaussian-splat world of a Midtown Manhattan intersection, generated
with the [World Labs](https://www.worldlabs.ai) Marble API (`marble-1.1-plus`) and
rendered in the browser with [Spark](https://sparkjs.dev) + three.js.

![Panorama preview](assets/preview.jpg)

## View it

```bash
npm install
npm start
# then open http://localhost:8123
```

`npm start` runs `server.mjs`, which serves the site and powers the chatbox. The chat uses the
Claude Agent SDK with **this machine's own Claude Code login** (no API key is stored anywhere), so
`claude` must be installed and logged in. Without the server (e.g. `python3 -m http.server`), the
world still works but the chat can't answer questions.

Controls:

- **Click** the scene to look around with the mouse (a small dot marks the centre), **Esc** to release
- **WASD** move · **Q/E** down/up · **Shift** faster
- Each floating label has a round **＋ button** beside it. Aim the dot at it and **click** to open
  (only one label's set is open at a time):
  - **6 trustworthy sources** — a mix of encyclopedia articles (Wikipedia, which cites its
    sources) and scholarly papers from [OpenAlex](https://openalex.org) (an open index of ~250M
    works with a **Cited by N** badge, DOI and free-full-text links, abstract, most-cited references
    and related papers). Click a reference to follow the citation trail inside the screen.
  - a **chat panel** — aim at the text field, click, type and press **Enter**. Claude answers from
    the six screens, citing them like [3], and can **change the screens** (each has a number). It can
    also **search the web for other trustworthy sites** (government, universities, museums,
    journals, reputable news) and put them on a screen: *"open the official NYC TLC page on
    screen 6"*, *"open a paper about congestion pricing on screen 2"*, *"highlight where screen 5
    mentions zoning"*, *"show me sources about urban heat islands instead"*, or `/pages <topic>`.
    Other sites are fetched by the local server and shown as a clean, script-free reading view;
    a few sites refuse automated requests and show a short error instead.
  - The screens, chat panel and a **close button** form one curved display that **stays where you
    opened it**. As you walk, the **whole display turns together to face you** (it swivels about its
    own centre), so its layout never changes and no screen ends up behind another.
- **Aim the dot** at a screen: the **mouse wheel** scrolls it, **click** follows the link under the
  dot, **Back** in the screen's toolbar goes back.
- To close: the **✕** at the top-right of any screen, the close button above the chat panel, the
  **×** beside the label, the pinned **Close** button at the top-right of your view, or press **X**.
- **T** add a label (with an optional topic) · **U** undo · **P** hide/show everything

The interface follows the public Material Design 3 / spatial-panel style (dark rounded panels,
floating "orbiter" toolbars, pill text fields); it is original styling, not copied assets. Screens are
script-free reading views rendered on this page, so the crosshair can drive them.

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
