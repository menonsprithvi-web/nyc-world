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
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

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
// Governments that don't use .gov (cities, provinces, transit authorities).
const CIVIC = ["toronto.ca", "canada.ca", "ontario.ca", "vancouver.ca", "montreal.ca", "paris.fr", "service-public.fr",
  "bund.de", "berlin.de", "tokyo.lg.jp", "go.jp", "gov.sg", "gov.au", "govt.nz", "mta.info", "panynj.gov", "tfl.gov.uk",
  "london.gov.uk", "nycedc.com", "nysenate.gov", "europarl.europa.eu"];
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
  if (CIVIC.some((d) => endsWith(host, d))) return { score: 0.9, label: "Government", host };
  if (/\.museum$/.test(host) || /museum/.test(host.split(".")[0])) return { score: 0.86, label: "Museum / library", host };
  for (const [score, label, list] of TRUSTED) if (list.some((d) => endsWith(host, d))) return { score, label, host };
  if (/\.org$/.test(host)) return { score: 0.55, label: "Organisation", host };
  return { score: 0.4, label: "Unverified", host };
}
const TRUST_MIN = 0.7;

// Same page, different spelling: drop protocol, www, trailing slash and #hash.
const normUrl = (u) => {
  try { const x = new URL(u); return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/$/, "") + x.search).toLowerCase(); }
  catch { return u; }
};

// Each label / question becomes a small search plan. Every step is its own
// Telem call (auto-routed across providers) with options suited to its job.
const OFFICIAL = ["gov.uk", "europa.eu", "un.org", "who.int", "worldbank.org", "oecd.org", "nyc.gov", "ny.gov", "usa.gov",
  "census.gov", "transportation.gov", "epa.gov", "nasa.gov", "loc.gov", "nps.gov", "nih.gov", "noaa.gov", "energy.gov", "ca.gov", "mta.info"];
const RESEARCH = ["nature.com", "sciencedirect.com", "springer.com", "wiley.com", "tandfonline.com", "jstor.org", "sagepub.com",
  "cambridge.org", "academic.oup.com", "plos.org", "pnas.org", "ieee.org", "acm.org", "arxiv.org", "mit.edu", "harvard.edu",
  "stanford.edu", "berkeley.edu", "columbia.edu", "nyu.edu"];
const NEWS = ["reuters.com", "apnews.com", "bbc.com", "nytimes.com", "npr.org", "theguardian.com", "washingtonpost.com",
  "bloomberg.com", "theatlantic.com", "wired.com", "technologyreview.com", "scientificamerican.com", "economist.com", "pbs.org"];
const yearAgo = () => new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);

const PLAN_STEPS = {
  overview: (q) => ({ query: q, search: { auto_routing: "accuracy", num_results: 8, tier: "default" },
                      note: "auto-routed across all engines" }),
  official: (q) => ({ query: q, search: { auto_routing: "accuracy", num_results: 5, tier: "default", include_domains: OFFICIAL },
                      note: `limited to ${OFFICIAL.length} government / intergovernmental sites` }),
  research: (q) => ({ query: q, search: { auto_routing: "accuracy", num_results: 5, tier: "default", include_domains: RESEARCH },
                      note: `limited to ${RESEARCH.length} journals and universities` }),
  news:     (q) => ({ query: q, search: { auto_routing: "accuracy", num_results: 5, tier: "default", include_domains: NEWS,
                                          published_after: yearAgo() },
                      note: `${NEWS.length} reputable outlets, published in the last 12 months` }),
};

async function planSearch(q, steps = Object.keys(PLAN_STEPS)) {
  const t0 = Date.now();
  const runs = await Promise.all(steps.map(async (intent) => {
    const step = PLAN_STEPS[intent](q);
    const s0 = Date.now();
    try {
      const out = await telem("/v1/search", { user_input: { query: step.query }, search: step.search });
      const results = [];
      const providers = [];
      for (const run of out.preprocessor_runs ?? []) {
        const rs = run.output_payload?.results ?? [];
        if (rs.length) providers.push(run.preprocessor_name);
        for (const r of rs) if (r?.url) results.push({ url: r.url, title: r.title ?? r.url, summary: r.summary ?? r.excerpt ?? "",
          rank: r.rank ?? 99, provider: run.preprocessor_name, intent, trust: trustOf(r.url) });
      }
      return { intent, note: step.note, providers, ms: Date.now() - s0, results };
    } catch (e) {
      return { intent, note: step.note, providers: [], ms: Date.now() - s0, results: [], error: String(e.message ?? e) };
    }
  }));
  // Merge: one entry per page (normalised URL), keep its best-trust sighting.
  const byUrl = new Map();
  for (const run of runs) for (const r of run.results) {
    const k = normUrl(r.url);
    const prev = byUrl.get(k);
    if (!prev || r.trust.score > prev.trust.score) byUrl.set(k, { ...r, intents: [...new Set([...(prev?.intents ?? []), r.intent])] });
    else prev.intents = [...new Set([...prev.intents, r.intent])];
  }
  const all = [...byUrl.values()];
  const trusted = all.filter((r) => r.trust.score >= TRUST_MIN).sort((a, b) => b.trust.score - a.trust.score || a.rank - b.rank);
  // Pick round-robin across plan steps (variety), at most two pages per site.
  const perHost = new Map();
  const queues = steps.map((i) => trusted.filter((r) => r.intent === i));
  const picked = [];
  const pickedKeys = new Set();
  while (queues.some((qq) => qq.length)) {
    for (const qq of queues) {
      while (qq.length) {
        const r = qq.shift();
        const k = normUrl(r.url);
        if (pickedKeys.has(k) || (perHost.get(r.trust.host) ?? 0) >= 2) continue;
        perHost.set(r.trust.host, (perHost.get(r.trust.host) ?? 0) + 1);
        pickedKeys.add(k);
        picked.push(r);
        break;
      }
    }
  }
  const trace = runs.map((run) => ({
    intent: run.intent, note: run.note, providers: run.providers, ms: run.ms, found: run.results.length,
    kept: picked.filter((p) => p.intent === run.intent).length, error: run.error,
  }));
  return {
    query: q, trace, ms: Date.now() - t0,
    providers: [...new Set(runs.flatMap((r) => r.providers))],
    total: all.length,
    dropped: all.filter((r) => r.trust.score < TRUST_MIN).map((r) => ({ host: r.trust.host, label: r.trust.label })),
    results: picked,
  };
}

async function telemRead(url, maxChars = 20000) {
  const target = new URL(url);
  if (!/^https?:$/.test(target.protocol)) throw new Error("only http(s)");
  const addrs = await lookup(target.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivate(a.address))) throw new Error("address not allowed");
  const out = await telem("/v1/fetch", { urls: [target.href], options: { tier: "default", inline_max_chars: maxChars } }, 30000);
  const doc = (out.preprocessor_runs ?? []).flatMap((r) => r.output_payload?.fetched_results ?? []).find((d) => d?.content);
  if (!doc) throw new Error("Telem could not read this page");
  return { url: doc.url ?? target.href, title: doc.title ?? "", content: doc.content, provider: doc.provider ?? null,
           trust: trustOf(doc.url ?? target.href) };
}
const PORT = Number(process.env.PORT ?? 8123);
const MODEL = "claude-opus-5-5";
// Chat answers about pages already in hand: medium effort keeps replies quick.
const EFFORT = "medium";
const MAX_BODY = 25 * 1024 * 1024; // six full articles fit comfortably

const SYSTEM_PROMPT = `You are a research guide inside a 3D world. The user is looking at six screens floating around them, numbered 1-6. Screens show trustworthy sources: encyclopedia articles (Wikipedia, with its citations), scholarly papers from OpenAlex (title, authors, venue, year, citation count, abstract, references), or other reputable web pages.
Answer from those screens. When you use one, cite it like [3]. Say when a claim comes only from a paper's abstract. If the screens don't cover the question, say so briefly, then research it with your tools: telem_search (pick a focus — official, research, news or general — that suits the question; use more than one when it helps) and telem_fetch to read a source before relying on it. Say which sources you used. Only answer from general knowledge if the tools find nothing, and say so.
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
- open with "url": load that trustworthy web page onto one screen (1-6). The URL must come from a telem_search result; never invent one. Prefer pages that are mostly text.
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

  // Claude's research tools: Telem search (planned + routed + trust-filtered)
  // and Telem fetch. Each call is reported to the viewer as a trace event.
  const telemTools = createSdkMcpServer({
    name: "telem",
    version: "1.0.0",
    tools: [
      tool("telem_search",
        "Search the live web through Telem, which routes the query across many search engines. Results are filtered to trustworthy sources and labelled with a trust type and score. focus: 'general' (all engines), 'official' (government / intergovernmental sites), 'research' (journals, universities), 'news' (reputable outlets, last 12 months).",
        { query: z.string().describe("what to search for"),
          focus: z.enum(["general", "official", "research", "news"]).optional().describe("which kind of source to target") },
        async ({ query: q, focus }) => {
          const step = { general: "overview", official: "official", research: "research", news: "news" }[focus ?? "general"];
          const r = await planSearch(q, [step]);
          send("trace", { tool: "search", query: q, focus: focus ?? "general", ...r.trace[0], kept: r.results.length,
                          dropped: r.dropped.length });
          const lines = r.results.slice(0, 8).map((x, i) =>
            `${i + 1}. ${x.title}\n   ${x.url}\n   trust: ${x.trust.label} (${Math.round(x.trust.score * 100)}) · via ${x.provider}\n   ${x.summary.slice(0, 300)}`);
          return { content: [{ type: "text", text: lines.length ? lines.join("\n\n") : "No trustworthy results." }] };
        }),
      tool("telem_fetch",
        "Read a web page's main content (markdown) through Telem Fetch. Use it to check what a source actually says before relying on it.",
        { url: z.string().describe("the page URL") },
        async ({ url }) => {
          const t0 = Date.now();
          try {
            const d = await telemRead(url, 12000);
            send("trace", { tool: "fetch", url: d.url, provider: d.provider, ms: Date.now() - t0, chars: d.content.length, trust: d.trust.label });
            return { content: [{ type: "text", text: `# ${d.title}\nSource: ${d.url} (trust: ${d.trust.label})\n\n${d.content}` }] };
          } catch (e) {
            send("trace", { tool: "fetch", url, ms: Date.now() - t0, error: String(e.message ?? e) });
            return { content: [{ type: "text", text: `Could not read ${url}: ${e.message ?? e}` }], isError: true };
          }
        }),
    ],
  });

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
        // Research tools are Telem's (search + fetch); no built-in tools, no
        // repo settings. A few turns allow search → read → answer.
        tools: telemKey() ? [] : ["WebSearch"],
        mcpServers: telemKey() ? { telem: telemTools } : undefined,
        allowedTools: telemKey() ? ["mcp__telem__telem_search", "mcp__telem__telem_fetch"] : ["WebSearch"],
        settingSources: [],
        maxTurns: 8,
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
  try { send(200, await planSearch(q)); }
  catch (e) { send(502, { error: String(e.message ?? e) }); }
}

// GET /api/read?url=… — Telem Fetch: clean page content (markdown) for sites
// our own fetch can't read (blocked, script-heavy). Same address guard as /api/fetch.
async function handleRead(req, res) {
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  const url = new URL(req.url, "http://x").searchParams.get("url") ?? "";
  if (!telemKey()) return send(503, { error: "TELEM_API_KEY is not set" });
  try { send(200, await telemRead(url)); }
  catch (e) { send(/not allowed/.test(e.message) ? 403 : 502, { error: String(e.message ?? e) }); }
}

// Telem Monitors: "watch this topic". POST /api/watch {query} creates an hourly
// monitor; GET /api/watch?id=… polls it for new results (trust-filtered).
async function handleWatch(req, res) {
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (!telemKey()) return send(503, { error: "TELEM_API_KEY is not set" });
  try {
    if (req.method === "POST") {
      const { query: q } = await readBody(req);
      if (!q || typeof q !== "string") return send(400, { error: "query is required" });
      const m = await telem("/v1/monitors", { query: q.slice(0, 300), options: { frequency: "1h" }, ttl: "7d", agent: false });
      return send(200, { id: m.id, status: m.status, frequency: m.frequency, expires_at: m.expires_at });
    }
    const id = new URL(req.url, "http://x").searchParams.get("id");
    if (!id || !/^[\w-]+$/.test(id)) return send(400, { error: "id is required" });
    const out = await telem(`/v1/monitors/${id}/poll`, {});
    const warnings = [];
    const results = [];
    for (const run of out.preprocessor_runs ?? []) {
      warnings.push(...(run.output_payload?.warnings ?? []).map((w) => (typeof w === "string" ? w : w.code ?? JSON.stringify(w))));
      for (const r of run.output_payload?.results ?? []) {
        if (r?.url) results.push({ url: r.url, title: r.title ?? r.url, provider: run.preprocessor_name, trust: trustOf(r.url) });
      }
    }
    if (out.warnings) warnings.push(...[].concat(out.warnings).map((w) => (typeof w === "string" ? w : w.code ?? "")));
    const seen = new Set();
    const fresh = results.filter((r) => r.trust.score >= TRUST_MIN && !seen.has(normUrl(r.url)) && seen.add(normUrl(r.url)));
    send(200, { id, new_results: fresh, total: results.length, warnings: [...new Set(warnings)].filter(Boolean) });
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
  if (req.url === "/api/watch" && req.method === "POST") return handleWatch(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/watch?")) return handleWatch(req, res);
  if (req.method === "GET" && req.url === "/api/status") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ telem: !!telemKey() }));
  }
  if (req.method === "GET" || req.method === "HEAD") return handleStatic(req, res);
  res.writeHead(405);
  res.end();
}).listen(PORT, () => console.log(`NYC world on http://localhost:${PORT} · Telem ${telemKey() ? "on" : "off (no TELEM_API_KEY)"}`));
