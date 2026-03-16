const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const cheerio = require("cheerio");
require("dotenv").config();

// ── Caches ──
const cache = {
  imdb: new Map(),    // imdbId → { title, year, ts }
  search: new Map(),  // "query|year" → { results, ts }
  stream: new Map(),  // imdbId:s:e → { streams, ts }
};
const IMDB_TTL = 24 * 60 * 60 * 1000;   // 24h
const SEARCH_TTL = 15 * 60 * 1000;       // 15min
const STREAM_TTL = 60 * 60 * 1000;       // 1h

function cacheGet(store, key, ttl) {
  const entry = store.get(key);
  if (entry && Date.now() - entry.ts < ttl) return entry.data;
  return null;
}
function cacheSet(store, key, data) {
  store.set(key, { data, ts: Date.now() });
  // Evict old entries if cache grows too large
  if (store.size > 500) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
}

// ── FaselHD Domain Rotation ──
const DOMAIN_BASE = "faselhdx.best";
let activeDomain = process.env.FASELHDX_DOMAIN || "https://web31618x.faselhdx.best";
let domainLastCheck = 0;
const DOMAIN_TTL = 30 * 60 * 1000;
let domainDiscoveryPromise = null; // dedup concurrent discoveries

async function discoverDomain() {
  // Try last known domain first
  if (await testDomain(activeDomain)) {
    domainLastCheck = Date.now();
    return activeDomain;
  }

  console.log("[Domain] Active domain down, scanning...");
  const numMatch = activeDomain.match(/web(\d+)x/);
  const lastNum = numMatch ? parseInt(numMatch[1]) : 31618;

  // Scan in parallel batches of 10 for speed
  for (let base = -5; base <= 50; base += 10) {
    const batch = [];
    for (let i = 0; i < 10 && base + i <= 50; i++) {
      batch.push(lastNum + base + i);
    }
    const results = await Promise.all(
      batch.map(async (num) => {
        const domain = `https://web${num}x.${DOMAIN_BASE}`;
        return (await testDomain(domain)) ? domain : null;
      })
    );
    const found = results.find(Boolean);
    if (found) {
      activeDomain = found;
      domainLastCheck = Date.now();
      console.log(`[Domain] Discovered: ${activeDomain}`);
      return activeDomain;
    }
  }

  console.log("[Domain] Could not discover active domain, using last known");
  domainLastCheck = Date.now();
  return activeDomain;
}

async function testDomain(domain) {
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${domain}/`, {
      method: "HEAD",
      headers: { "User-Agent": "Mozilla/5.0" },
      redirect: "manual",
      signal: controller.signal,
    });
    clearTimeout(tid);
    return res.status === 200;
  } catch {
    return false;
  }
}

async function getDomain() {
  if (Date.now() - domainLastCheck > DOMAIN_TTL) {
    // Dedup concurrent discovery calls
    if (!domainDiscoveryPromise) {
      domainDiscoveryPromise = discoverDomain().finally(() => { domainDiscoveryPromise = null; });
    }
    await domainDiscoveryPromise;
  }
  return activeDomain;
}

function markDomainBad() {
  console.log(`[Domain] Marking ${activeDomain} as bad`);
  domainLastCheck = 0;
}

// ── HTTP ──

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const HEADERS = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.8,ar;q=0.6",
};

async function fetchPage(url, retries = 2) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`[Fetch] (${i + 1}/${retries}) ${url}`);
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 12000);

      const res = await fetch(url, {
        headers: HEADERS,
        redirect: "follow",
        signal: controller.signal,
      });
      clearTimeout(tid);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();

      if (html.includes("Just a moment") || html.includes("Checking your browser")) {
        console.log("[Fetch] Cloudflare challenge");
        if (url.includes(DOMAIN_BASE)) markDomainBad();
        continue;
      }

      return html;
    } catch (err) {
      console.error(`[Fetch] ${err.message}`);
      if (url.includes(DOMAIN_BASE)) markDomainBad();
    }
  }
  return null;
}

// ── IMDB title lookup ──

async function getImdbInfo(imdbId) {
  const cached = cacheGet(cache.imdb, imdbId, IMDB_TTL);
  if (cached) return cached;
  try {
    const url = `https://v2.sg.media-imdb.com/suggestion/t/${imdbId}.json`;
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: controller.signal,
    });
    clearTimeout(tid);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.d && data.d.length > 0) {
      const info = { title: data.d[0].l, year: data.d[0].y };
      cacheSet(cache.imdb, imdbId, info);
      return info;
    }
  } catch (err) {
    console.error("[IMDB] " + err.message);
  }
  return null;
}

// ── FaselHD Search ──

async function searchFasel(query, year) {
  const domain = await getDomain();
  const url = `${domain}/?s=${encodeURIComponent(query)}`;
  const html = await fetchPage(url);
  if (!html) return [];

  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  // FaselHD uses .postDiv cards for search results
  $(".postDiv").each((_, el) => {
    const a = $(el).find("a").first();
    const href = a.attr("href") || "";
    const title = $(el).find(".h1").text().trim() || a.text().trim();
    if (href && !seen.has(href)) {
      seen.add(href);
      const full = href.startsWith("http") ? href : `${domain}${href}`;
      results.push({ url: full, title: title || "unknown" });
    }
  });

  // If year provided, sort results so matching year comes first
  if (year) {
    results.sort((a, b) => {
      const aHas = a.title.includes(String(year)) || a.url.includes(String(year)) ? 0 : 1;
      const bHas = b.title.includes(String(year)) || b.url.includes(String(year)) ? 0 : 1;
      return aHas - bHas;
    });
  }

  console.log(`[Search] "${query}" → ${results.length} results`);
  results.forEach((r, i) => console.log(`  ${i}: ${r.title}`));
  return results;
}

// ── Content page parser ──
// Extracts player_token URLs from movie/episode pages

async function getPlayerTokens(url) {
  const html = await fetchPage(url);
  if (!html) return [];

  const tokens = [];
  const seen = new Set();

  // Extract player_token from iframes (data-src and src)
  const $ = cheerio.load(html);
  $("iframe").each((_, el) => {
    const src = $(el).attr("data-src") || $(el).attr("src") || "";
    const m = src.match(/player_token=([^"'&\s]+)/);
    if (m && !seen.has(m[1])) {
      seen.add(m[1]);
      tokens.push(src.startsWith("//") ? `https:${src}` : src);
    }
  });

  // Extract player_tokens from onclick handlers (server buttons)
  $('[onclick*="player_token"]').each((_, el) => {
    const onclick = $(el).attr("onclick") || "";
    const m = onclick.match(/player_token=([^"'&\s]+)/);
    if (m && !seen.has(m[1])) {
      seen.add(m[1]);
      const text = $(el).text().trim();
      const domain = new URL(url).origin;
      tokens.push(`${domain}/video_player?player_token=${m[1]}`);
      console.log(`[Parse] Server: ${text}`);
    }
  });

  // Also match raw HTML for any player_token references
  const raw = $.html();
  const regex = /https?:\/\/[^"'\s]+player_token=[^"'\s&]+/g;
  let rm;
  while ((rm = regex.exec(raw)) !== null) {
    const tkm = rm[0].match(/player_token=([^"'&\s]+)/);
    if (tkm && !seen.has(tkm[1])) {
      seen.add(tkm[1]);
      tokens.push(rm[0]);
    }
  }

  console.log(`[Parse] ${url.substring(url.lastIndexOf("/") + 1, url.lastIndexOf("/") + 40)}... → ${tokens.length} player(s)`);
  return tokens;
}

// Get episode URLs from a series page
async function getEpisodes(url) {
  const html = await fetchPage(url);
  if (!html) return [];

  const $ = cheerio.load(html);
  const domain = new URL(url).origin;
  const episodes = [];

  // FaselHD episode links
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    const text = $(el).text().trim();
    if (href.includes("/episode/")) {
      const full = href.startsWith("http") ? href : `${domain}${href}`;
      episodes.push({ url: full, title: text });
    }
  });

  return episodes;
}

// ── Stream extraction from video_player page ──
// The player page has obfuscated JS that constructs m3u8 URLs.
// We execute it with mocked browser globals to capture the JWPlayer config.

async function extractStreamFromPlayer(playerUrl) {
  const html = await fetchPage(playerUrl);
  if (!html) return null;

  const $ = cheerio.load(html);

  // Find the main obfuscated script (large, contains jwplayer)
  let mainScript = null;
  $("script").each((_, el) => {
    const text = $(el).html() || "";
    if (!$(el).attr("src") && text.length > 20000 && text.includes("jwplayer")) {
      mainScript = text;
    }
  });

  if (!mainScript) {
    console.log("[Extract] No main player script found");
    return null;
  }
  console.log(`[Extract] Found player script (${mainScript.length} chars)`);

  // Execute with mocked globals to capture JWPlayer setup config
  let capturedConfig = null;
  const me = () => ({
    style: { display: "", backgroundImage: "" },
    innerHTML: "", textContent: "", src: "",
    setAttribute() {}, getAttribute() { return null; },
    appendChild() {}, removeChild() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, contains() { return false; } },
    offsetWidth: 1920, offsetHeight: 1080, clientWidth: 1920,
    addEventListener(ev, fn) {
      if (ev === "click") {
        process.nextTick(() => { try { fn({ isTrusted: true }); } catch(e) {} });
      }
    },
  });

  // Save & set globals
  const saved = {};
  const mockGlobals = {
    document: {
      getElementById() { return me(); },
      querySelector() { return me(); },
      querySelectorAll() { return []; },
      createElement() { return me(); },
      body: { appendChild() {}, style: {} },
      head: { appendChild() {} },
      cookie: "", addEventListener() {},
      documentElement: { style: {} },
      readyState: "complete",
      currentScript: { dataset: {} },
    },
    localStorage: {
      getItem(key) {
        if (key && typeof key === "string" && key.includes("qiey9zrCKg")) return "1";
        return null;
      },
      setItem() {}, removeItem() {}, clear() {},
    },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {}, clear() {} },
    navigator: { userAgent: UA },
    location: { href: playerUrl, hostname: new URL(playerUrl).hostname, origin: new URL(playerUrl).origin, protocol: "https:", pathname: "/video_player" },
    performance: { now() { return Date.now(); } },
    window: global,
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    XMLHttpRequest: function() {
      this.open = function() {};
      this.send = function() {};
      this.setRequestHeader = function() {};
    },
    Cookies: { get() { return null; }, set() {} },
  };

  // jQuery mock
  const jqResult = {
    html(v) { return v !== undefined ? jqResult : ""; },
    text(v) { return v !== undefined ? jqResult : ""; },
    css() { return jqResult; }, attr() { return null; },
    on() { return jqResult; }, click() { return jqResult; },
    ready(fn) { try { fn(); } catch(e) {} return jqResult; },
    find() { return jqResult; }, each() { return jqResult; },
    addClass() { return jqResult; }, removeClass() { return jqResult; },
    append() { return jqResult; }, prepend() { return jqResult; },
    val() { return ""; }, hide() { return jqResult; }, show() { return jqResult; },
    remove() { return jqResult; }, length: 0,
  };
  const jqFn = function(sel) { if (typeof sel === "function") { try { sel(); } catch(e) {} } return jqResult; };
  jqFn.ajax = function() {};
  jqFn.get = function() {};
  jqFn.post = function() {};
  mockGlobals.jQuery = jqFn;
  mockGlobals.$ = jqFn;

  // jwplayer mock
  mockGlobals.jwplayer = function(id) {
    const p = {
      setup(config) { capturedConfig = config; return p; },
      on() { return p; }, onReady() { return p; }, onComplete() { return p; },
      onError() { return p; }, getPlaylistItem() { return {}; },
      addButton() { return p; }, seek() { return p; },
      getPosition() { return 0; }, getDuration() { return 0; },
      getState() { return "idle"; }, play() { return p; },
      pause() { return p; }, remove() { return p; },
      resize() { return p; },
      load(config) { capturedConfig = config; return p; },
    };
    return p;
  };
  mockGlobals.jwplayer.key = null;
  mockGlobals.jwplayer.version = "8.33.2";

  // Install mocks on global
  for (const [k, v] of Object.entries(mockGlobals)) {
    saved[k] = global[k];
    global[k] = v;
  }

  try {
    const fn = new Function(mainScript);
    fn();
  } catch (e) {
    console.log(`[Extract] Script error: ${e.message}`);
  }

  // Wait for click handler (overlay bypass via nextTick)
  await new Promise(r => setTimeout(r, 100));

  // Restore globals
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete global[k];
    else global[k] = v;
  }

  if (capturedConfig) {
    // Extract URL from config
    let streamUrl = null;
    if (capturedConfig.sources && capturedConfig.sources.length > 0) {
      streamUrl = capturedConfig.sources[0].file;
    } else if (capturedConfig.file) {
      streamUrl = capturedConfig.file;
    }
    if (streamUrl) {
      console.log(`[Extract] Got stream: ${streamUrl.substring(0, 80)}...`);
      return { url: streamUrl, title: "FaselHD" };
    }
  }

  console.log("[Extract] Could not capture stream URL");
  return null;
}

// ── Main resolver ──

async function resolve(imdbId, type, season, episode) {
  const cacheKey = `${imdbId}:${season || ""}:${episode || ""}`;
  const cached = cacheGet(cache.stream, cacheKey, STREAM_TTL);
  if (cached) {
    console.log(`[Resolve] Cache hit for ${cacheKey}`);
    return cached;
  }

  console.log(`[Resolve] ${type} ${imdbId} S${season || "-"}E${episode || "-"}`);

  // Parallelize IMDB lookup and domain warm-up
  const [info] = await Promise.all([getImdbInfo(imdbId), getDomain()]);
  if (!info) {
    console.log("[Resolve] IMDB lookup failed");
    return [];
  }
  console.log(`[Resolve] "${info.title}" (${info.year})`);

  let results = await searchFasel(info.title, info.year);
  if (results.length === 0 && info.year) {
    results = await searchFasel(`${info.title} ${info.year}`, info.year);
  }
  if (results.length === 0) {
    console.log("[Resolve] Nothing found on FaselHD");
    return [];
  }

  const streams = [];
  let targetUrl = results[0].url;

  // Series: navigate to the specific episode page first
  if (type === "series" && season && episode) {
    const sn = parseInt(season);
    const ep = parseInt(episode);
    const episodes = await getEpisodes(targetUrl);

    const pat = new RegExp(
      `(s0?${sn}e0?${ep}|season[\\s-]*${sn}.*episode[\\s-]*${ep}|الحلقة[\\s-]*${ep}|ep\\.?[\\s-]*${ep})`,
      "i"
    );

    let epUrl = null;
    for (const e of episodes) {
      if (pat.test(e.title) || pat.test(e.url)) {
        epUrl = e.url;
        break;
      }
    }
    if (!epUrl && episodes.length >= ep) {
      epUrl = episodes[ep - 1]?.url;
    }

    if (epUrl) {
      console.log(`[Resolve] Episode: ${epUrl}`);
      targetUrl = epUrl;
    }
  }

  // Get player_token URLs from the page
  const playerUrls = await getPlayerTokens(targetUrl);

  // Try each player to extract stream
  for (const pUrl of playerUrls) {
    const stream = await extractStreamFromPlayer(pUrl);
    if (stream) {
      streams.push(stream);
      break; // one good stream is enough
    }
  }

  console.log(`[Resolve] ${streams.length} stream(s)`);
  if (streams.length > 0) cacheSet(cache.stream, cacheKey, streams);
  return streams;
}

// ── Stremio Addon ──

const manifest = {
  id: "community.faselhdx",
  version: "1.0.0",
  name: "FaselHD",
  description:
    "Stream movies and TV shows from FaselHD — Arabic content with subtitles",
  types: ["movie", "series"],
  resources: ["stream"],
  catalogs: [],
  idPrefixes: ["tt"],
};

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
  try {
    const parts = id.split(":");
    const imdbId = parts[0];
    const season = parts[1] || null;
    const episode = parts[2] || null;

    console.log(`\n[Stream] ${type} ${id}`);
    const raw = await resolve(imdbId, type, season, episode);

    const seen = new Set();
    const streams = raw
      .map((s) => ({
        name: "FaselHD",
        title: s.title || "FaselHD",
        url: s.url,
        behaviorHints: { notWebReady: false },
      }))
      .filter((s) => {
        if (seen.has(s.url)) return false;
        seen.add(s.url);
        return true;
      });

    return { streams };
  } catch (err) {
    console.error("[Stream] Error:", err.message);
    return { streams: [] };
  }
});

// ── Server ──

const PORT = parseInt(process.env.PORT) || 27828;

serveHTTP(builder.getInterface(), { port: PORT }).then(({ url }) => {
  console.log("=".repeat(55));
  console.log("  FaselHD Stremio Addon");
  console.log("=".repeat(55));
  console.log(`  Server:   ${url}`);
  console.log(`  Manifest: ${url}/manifest.json`);
  console.log(`  Test:     ${url}/stream/movie/tt6166392.json`);
  console.log("=".repeat(55));
});

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  process.exit(0);
});
