# Midtown NYC — a World Labs Marble world

**▶ Demo video:** [docs/demo.mp4](docs/demo.mp4) — an 83-second captioned tour of every feature
(World Labs world, crosshair interaction, Telem search plans + trust filtering, Claude chat on Telem,
Telem Monitors).

A walkable 3D Gaussian-splat world of a Midtown Manhattan intersection, generated
with the [World Labs](https://www.worldlabs.ai) Marble API (`marble-1.1-plus`) and
rendered in the browser with [Spark](https://sparkjs.dev) + three.js.

![Panorama preview](assets/preview.jpg)

## Worlds

| World | Open | What it is |
| --- | --- | --- |
| Midtown NYC | `http://localhost:8123/` | A Midtown Manhattan intersection at dusk |
| Neon District | `http://localhost:8123/?world=neon` | An original cyberpunk street at night — neon towers with invented signage, an elevated train, a street-food stall, rain-slicked asphalt |

Both are generated with the World Labs Marble API (`marble-1.1-plus`) and have every feature below.
Each world is configured in `worlds/<id>.json` (3D file, title, floating labels and the topic for
each label's six sources); switch between them from the **Worlds** links in the help panel.

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

## Telem AI: planned, routed, trust-filtered research

With a [Telem](https://telem.ai) key in `.env` (`TELEM_API_KEY=…`, git-ignored):

- **Search plan per label.** Each label's topic becomes four Telem searches run in parallel, each
  auto-routed across many engines (Exa, Tavily, Brave, Parallel, Ceramic, Seltz, You…) with its own
  settings: **overview** (all engines), **official** (`include_domains`: 20 government /
  intergovernmental sites), **research** (20 journals and universities), **news** (14 reputable
  outlets, `published_after` the last 12 months).
- **Trust filter.** Every result is scored (government, university, intergovernmental,
  peer-reviewed publisher, museum/library, encyclopedia, reputable news); social media, forums and
  unknown sites are dropped, duplicates merged, at most two pages per site. Screens are picked
  round-robin across the plan's steps and show a **trust badge**.
- **Search trace panel.** Shows each step's engines, time, and found → kept counts.
- **Chat researches with Telem.** Claude's only research tools are `telem_search` (with a focus:
  general / official / research / news) and `telem_fetch`; every call appears live in the chat and
  the trace panel.
- **Telem Fetch** reads pages our own reader can't (blocked or script-heavy sites).
- **Watch a topic** (👁 in the chat panel) creates a **Telem Monitor** that checks hourly for 7 days;
  new trustworthy sources appear as a red badge on the label's ＋.

Without a key, screens fall back to Wikipedia + OpenAlex and the chat uses web search.

A recorded walkthrough of every feature is in the project's demo video.

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
