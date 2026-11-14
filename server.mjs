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
  if (req.method === "GET" || req.method === "HEAD") return handleStatic(req, res);
  res.writeHead(405);
  res.end();
}).listen(PORT, () => console.log(`NYC world on http://localhost:${PORT}`));
