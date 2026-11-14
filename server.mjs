// Local server for the NYC world: serves the static site and answers chat
// questions about the six open pages with Claude.
//
//   npm install && npm start   →   http://localhost:8123
//
// Like agent_research's /api/chat, this uses the Claude Agent SDK, which runs
// the local Claude Code binary with this machine's own Claude login. No API key
// is read or stored, so it only works where `claude` is logged in.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { query } from "@anthropic-ai/claude-agent-sdk";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));

// Secrets live in .env next to this file (git-ignored), e.g. TELEM_API_KEY=…
try {
  const env = await readFile(join(ROOT, ".env"), "utf8");
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}
const TELEM = "https://router.telem.ai";
const telemKey = () => process.env.TELEM_API_KEY;

async function telem(path, body, timeoutMs = 20000) {
  const res = await fetch(TELEM + path, {
    method: "POST",
    headers: { authorization: `Bearer ${telemKey()}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Telem ${path} ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

// ---- Trust scoring: why a source deserves a screen. ----
const TRUSTED = [
  // [score, label, host suffixes]
  [0.92, "Peer-reviewed publisher", ["nature.com", "science.org", "sciencedirect.com", "springer.com", "link.springer.com",
    "wiley.com", "tandfonline.com", "jstor.org", "plos.org", "cell.com", "thelancet.com", "nejm.org", "bmj.com", "pnas.org",
    "acm.org", "ieee.org", "cambridge.org", "academic.oup.com", "sagepub.com", "annualreviews.org", "aps.org", "iop.org"]],
  [0.9, "Intergovernmental", ["un.org", "who.int", "worldbank.org", "oecd.org", "imf.org", "unesco.org", "europa.eu", "ipcc.ch"]],
  [0.86, "Museum / library", ["metmuseum.org", "moma.org", "britishmuseum.org", "nypl.org", "archive.org", "si.edu",
    "smithsonianmag.com", "nationalgeographic.com", "mcny.org"]],
  [0.85, "Encyclopedia", ["britannica.com", "plato.stanford.edu", "iep.utm.edu"]],
  [0.82, "Reputable news", ["reuters.com", "apnews.com", "bbc.com", "bbc.co.uk", "nytimes.com", "npr.org", "pbs.org",
    "theguardian.com", "washingtonpost.com", "wsj.com", "economist.com", "ft.com", "bloomberg.com", "theatlantic.com",
    "newyorker.com", "scientificamerican.com", "wired.com", "arstechnica.com", "technologyreview.com", "citylab.com"]],
  [0.8, "Encyclopedia (cited)", ["wikipedia.org"]],
  [0.74, "Preprint / scholarly index", ["arxiv.org", "biorxiv.org", "ssrn.com", "researchgate.net", "semanticscholar.org",
    "openalex.org", "doi.org", "mdpi.com", "frontiersin.org", "hindawi.com"]],
];
const BLOCKED = ["reddit.com", "quora.com", "medium.com", "substack.com", "pinterest.com", "tiktok.com", "facebook.com",
  "instagram.com", "x.com", "twitter.com", "youtube.com", "linkedin.com", "fandom.com", "blogspot.com", "wordpress.com",
  "tumblr.com", "answers.com", "wikihow.com", "steamcommunity.com"];
const endsWith = (host, d) => host === d || host.endsWith("." + d);

export function trustOf(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return { score: 0, label: "Invalid", host: "" }; }
  if (BLOCKED.some((d) => endsWith(host, d))) return { score: 0.1, label: "User-generated / social", host };
  if (/\.(gov|mil)(\.[a-z]{2})?$/.test(host) || /(^|\.)gov\.[a-z]{2}$/.test(host)) return { score: 0.95, label: "Government", host };
  if (/\.(edu)(\.[a-z]{2})?$/.test(host) || /\.ac\.[a-z]{2}$/.test(host)) return { score: 0.9, label: "University", host };
  if (/\.int$/.test(host)) return { score: 0.9, label: "Intergovernmental", host };
  for (const [score, label, list] of TRUSTED) if (list.some((d) => endsWith(host, d))) return { score, label, host };
  if (/\.org$/.test(host)) return { score: 0.55, label: "Organisation", host };
  return { score: 0.4, label: "Unverified", host };
}
const TRUST_MIN = 0.7;
const PORT = Number(process.env.PORT ?? 8123);
const MODEL = "claude-opus-5-5";
// Chat answers about pages already in hand: medium effort keeps replies quick.
const EFFORT = "medium";
const MAX_BODY = 25 * 1024 * 1024; // six full articles fit comfortably

const SYSTEM_PROMPT = `You are a research guide inside a 3D world. The user is looking at six screens floating around them, numbered 1-6. Screens show trustworthy sources: encyclopedia articles (Wikipedia, with its citations), scholarly papers from OpenAlex (title, authors, venue, year, citation count, abstract, references), or other reputable web pages.
Answer from those screens. When you use one, cite it like [3]. Say when a claim comes only from a paper's abstract. If the screens don't cover the question, say so briefly; you may use web search to find a trustworthy source, or answer from general knowledge, saying which you did.
Keep answers short: two to five sentences, plain text, no markdown headings or tables.

Trustworthy means: government and intergovernmental sites (.gov, un.org, who.int), universities and research institutes (.edu, .ac.uk), museums and libraries, peer-reviewed journals and publishers, established encyclopedias (Wikipedia, Britannica), and major news organisations with editorial standards (Reuters, AP, BBC, NYT, NPR). Avoid content farms, SEO blogs, forums, social media and AI-generated sites.

You can change the screens. When the user asks you to show, open, put, find, highlight, point to, or change something on the screens, or when showing them would clearly help, end your reply with exactly one fenced block like this:
\`\`\`actions
[{"type": "open", "screen": 3, "url": "https://www.nyc.gov/site/tlc/about/about-tlc.page"},
 {"type": "open", "screen": 4, "query": "Gaussian splatting SLAM"},
 {"type": "find", "screen": 5, "text": "real-time rendering"},
 {"type": "topic", "query": "urban heat islands"}]
\`\`\`
Action types:
- open with "url": load that trustworthy web page onto one screen (1-6). Use web search to find a real, current URL; never invent one. Prefer pages that are mostly text.
- open with "query": search scholarly papers with this query (title words work best) and load the top match.
  For either, pick the screen the user names; otherwise the one least relevant to the conversation.
- find: scroll one screen to a short phrase and highlight it. The phrase must be copied exactly from that screen's page text (3-8 words is best).
- topic: replace all six screens with encyclopedia articles and scholarly papers about a search query.
Only include the block when an action is wanted, and put nothing after it. In your sentences, say briefly what you changed and where it is from (for example "I've put the NYC TLC's page on screen 3").`;

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".css": "text/css", ".jpg": "image/jpeg", ".png": "image/png",
  ".spz": "application/octet-stream", ".md": "text/markdown; charset=utf-8",
};

function buildPrompt({ question, pages, history }) {
  const docs = pages
    .map((p, i) => `<page number="${i + 1}" title="${p.title}" url="${p.url}">\n${p.text}\n</page>`)
    .join("\n\n");
  const earlier = history
    .slice(-20)
    .map((t) => `${t.role === "user" ? "User" : "Guide"}: ${t.content}`)
    .join("\n\n");
  return `Here are the six pages:\n\n${docs}\n\n` +
    (earlier ? `Conversation so far:\n\n${earlier}\n\n` : "") +
    `User's question: ${question}`;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new Error("request too large");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleAsk(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: String(e.message ?? e) }));
  }
  const question = typeof body.question === "string" ? body.question.trim() : "";
  const pages = Array.isArray(body.pages) ? body.pages.filter((p) => p && typeof p.text === "string") : [];
  const history = Array.isArray(body.history)
    ? body.history.filter((t) => (t?.role === "user" || t?.role === "assistant") && typeof t.content === "string")
    : [];
  if (!question || pages.length === 0) {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "question and pages are required" }));
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Stop the model run if the browser goes away mid-answer.
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  try {
    const run = query({
      prompt: buildPrompt({ question, pages, history }),
      options: {
        model: MODEL,
        effort: EFFORT,
        thinking: { type: "adaptive" },
        systemPrompt: SYSTEM_PROMPT,
        // Web search is the only tool (to find trustworthy sources); no repo
        // settings. A few turns allow search → answer.
        tools: ["WebSearch"],
        allowedTools: ["WebSearch"],
        settingSources: [],
        maxTurns: 6,
        includePartialMessages: true,
        abortController: abort,
      },
    });
    for await (const message of run) {
      if (abort.signal.aborted) break;
      if (message.type === "stream_event") {
        const ev = message.event;
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta" && ev.delta.text) {
          send("delta", { text: ev.delta.text });
        }
      } else if (message.type === "result" && message.subtype !== "success") {
        send("error", { message: `stopped: ${message.subtype}` });
        return res.end();
      }
    }
    send("done", {});
  } catch (e) {
    // A missing Claude login shows up here.
    send("error", { message: e instanceof Error ? e.message : String(e) });
  }
  res.end();
}

// GET /api/fetch?url=… — fetch a public web page for a screen. Refuses
// anything that resolves to this machine or a private network (no SSRF).
function isPrivate(ip) {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80")) return true;
    const m = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return m ? isPrivate(m[1]) : false;
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

async function handleFetch(req, res) {
  const fail = (code, msg) => { res.writeHead(code, { "content-type": "text/plain" }); res.end(msg); };
  let target;
  try {
    target = new URL(new URL(req.url, "http://x").searchParams.get("url") ?? "");
  } catch { return fail(400, "bad url"); }
  if (target.protocol !== "https:" && target.protocol !== "http:") return fail(400, "only http(s)");
  try {
    let current = target;
    for (let hop = 0; hop < 5; hop++) {
      const addrs = await lookup(current.hostname, { all: true });
      if (!addrs.length || addrs.some((a) => isPrivate(a.address))) return fail(403, "address not allowed");
      const upstream = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(12000),
        headers: { "user-agent": "Mozilla/5.0 (Macintosh) nyc-world-reader/1.0", accept: "text/html,application/xhtml+xml" },
      });
      if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.get("location")) {
        current = new URL(upstream.headers.get("location"), current); // re-check every redirect hop
        continue;
      }
      if (!upstream.ok) return fail(502, `upstream ${upstream.status}`);
      if (!/html/.test(upstream.headers.get("content-type") ?? "")) return fail(415, "not a web page");
      const text = await upstream.text();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-final-url": current.href });
      return res.end(text.slice(0, 5_000_000));
    }
    return fail(508, "too many redirects");
  } catch (e) {
    return fail(502, String(e.message ?? e));
  }
}

// GET /api/sources?q=… — Telem search (auto-routed across providers), then
// keep only trustworthy results, ranked by trust then provider rank, at most
// two per site. Response explains the routing and filtering.
async function handleSources(req, res) {
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  const q = new URL(req.url, "http://x").searchParams.get("q")?.trim();
  if (!q) return send(400, { error: "q is required" });
  if (!telemKey()) return send(503, { error: "TELEM_API_KEY is not set" });
  const t0 = Date.now();
  try {
    const out = await telem("/v1/search", {
      user_input: { query: q },
      search: { auto_routing: "accuracy", num_results: 10, tier: "default" },
    });
    const runs = out.preprocessor_runs ?? [];
    const seen = new Set();
    const all = [];
    for (const run of runs) {
      for (const r of run.output_payload?.results ?? []) {
        if (!r?.url || seen.has(r.url)) continue;
        seen.add(r.url);
        all.push({ url: r.url, title: r.title ?? r.url, summary: r.summary ?? r.excerpt ?? "", rank: r.rank ?? 99,
                   provider: run.preprocessor_name, trust: trustOf(r.url) });
      }
    }
    const perHost = new Map();
    const kept = all
      .filter((r) => r.trust.score >= TRUST_MIN)
      .sort((a, b) => b.trust.score - a.trust.score || a.rank - b.rank)
      .filter((r) => {
        const n = perHost.get(r.trust.host) ?? 0;
        perHost.set(r.trust.host, n + 1);
        return n < 2;
      });
    send(200, {
      query: q,
      providers: runs.map((r) => r.preprocessor_name),
      total: all.length,
      dropped: all.filter((r) => r.trust.score < TRUST_MIN).map((r) => ({ host: r.trust.host, label: r.trust.label })),
      results: kept,
      ms: Date.now() - t0,
    });
  } catch (e) {
    send(502, { error: String(e.message ?? e) });
  }
}

// GET /api/read?url=… — Telem Fetch: clean page content (markdown) for sites
// our own fetch can't read (blocked, script-heavy). Same address guard as /api/fetch.
async function handleRead(req, res) {
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  let target;
  try { target = new URL(new URL(req.url, "http://x").searchParams.get("url") ?? ""); } catch { return send(400, { error: "bad url" }); }
  if (!/^https?:$/.test(target.protocol)) return send(400, { error: "only http(s)" });
  if (!telemKey()) return send(503, { error: "TELEM_API_KEY is not set" });
  try {
    const addrs = await lookup(target.hostname, { all: true });
    if (!addrs.length || addrs.some((a) => isPrivate(a.address))) return send(403, { error: "address not allowed" });
    const out = await telem("/v1/fetch", { urls: [target.href], options: { tier: "default" } }, 30000);
    const doc = (out.preprocessor_runs ?? []).flatMap((r) => r.output_payload?.fetched_results ?? [])
      .find((d) => d?.content);
    if (!doc) return send(502, { error: "Telem could not read this page" });
    send(200, { url: doc.url ?? target.href, title: doc.title ?? "", content: doc.content, provider: doc.provider ?? null,
                trust: trustOf(doc.url ?? target.href) });
  } catch (e) {
    send(502, { error: String(e.message ?? e) });
  }
}

async function handleStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = normalize(join(ROOT, urlPath === "/" ? "index.html" : urlPath));
  if (!file.startsWith(ROOT) || file.includes("node_modules")) {
    res.writeHead(403);
    return res.end();
  }
  try {
    if (!(await stat(file)).isFile()) throw new Error();
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/ask") return handleAsk(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/fetch?")) return handleFetch(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/sources?")) return handleSources(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/read?")) return handleRead(req, res);
  if (req.method === "GET" && req.url === "/api/status") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ telem: !!telemKey() }));
  }
  if (req.method === "GET" || req.method === "HEAD") return handleStatic(req, res);
  res.writeHead(405);
  res.end();
}).listen(PORT, () => console.log(`NYC world on http://localhost:${PORT} · Telem ${telemKey() ? "on" : "off (no TELEM_API_KEY)"}`));
