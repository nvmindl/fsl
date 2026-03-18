const { addonBuilder } = require("stremio-addon-sdk");
const cheerio = require("cheerio");
require("dotenv").config();

// ── Persistent Puppeteer Browser (CF bypass) ──
const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";
let browserInstance = null;
let browserLaunchPromise = null;

async function getBrowser() {
  if (browserInstance && browserInstance.isConnected()) return browserInstance;
  if (browserLaunchPromise) return browserLaunchPromise;

  browserLaunchPromise = (async () => {
    try {
      console.log("[Browser] Launching persistent browser...");
      const puppeteer = require("puppeteer-extra");
      const StealthPlugin = require("puppeteer-extra-plugin-stealth");
      puppeteer.use(StealthPlugin());

      browserInstance = await puppeteer.launch({
        executablePath: CHROME_PATH,
        headless: "new",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--no-first-run",
          "--no-zygote",
          "--single-process",
          "--disable-extensions",
        ],
      });

      browserInstance.on("disconnected", () => {
        console.log("[Browser] Disconnected");
        browserInstance = null;
      });

      console.log("[Browser] Ready");
      return browserInstance;
    } catch (err) {
      console.error("[Browser] Launch failed:", err.message);
      browserInstance = null;
      throw err;
    } finally {
      browserLaunchPromise = null;
    }
  })();

  return browserLaunchPromise;
}

// Simple mutex: only 1 browser page at a time to prevent OOM on free tier
let browserQueue = Promise.resolve();
function withBrowserLock(fn) {
  const p = browserQueue.then(fn, fn);
  browserQueue = p.catch(() => {});
  return p;
}

// Fetch a page using Puppeteer (bypasses CF)
async function browserFetch(url, timeout = 45000) {
  return withBrowserLock(async () => {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1920, height: 1080 });
    // NOTE: Do NOT use request interception — aborting CSS/images triggers CF detection

    console.log(`[Browser] Navigating: ${url}`);
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout,
    });
    // Extra wait for dynamic content to render
    await new Promise(r => setTimeout(r, 2000));

    // Wait for CF challenge to resolve (Turnstile may need interaction)
    const content = await page.content();
    if (content.includes("Just a moment") || content.includes("Checking your browser")) {
      console.log("[Browser] CF challenge detected, waiting for resolution...");

      // Try to click the Turnstile checkbox if it appears in an iframe
      try {
        await new Promise(r => setTimeout(r, 3000)); // Wait for Turnstile iframe to load
        const frames = page.frames();
        for (const frame of frames) {
          const turnstileBox = await frame.$('input[type="checkbox"], .cb-lb');
          if (turnstileBox) {
            console.log("[Browser] Clicking Turnstile checkbox...");
            await turnstileBox.click();
            break;
          }
        }
      } catch (e) {
        console.log("[Browser] Turnstile click attempt:", e.message);
      }

      // Wait up to 30s for challenge to resolve
      await page.waitForFunction(
        () => !document.body.innerHTML.includes("Just a moment") && !document.body.innerHTML.includes("Checking your browser"),
        { timeout: 30000 }
      ).catch(() => console.log("[Browser] CF challenge did not resolve in time"));
    }

    const html = await page.content();
    const finalUrl = page.url();
    const status = response ? response.status() : 0;
    console.log(`[Browser] ${url.substring(0, 60)}... → ${status} (${html.length} chars)`);

    // Detect domain rotation: if we were redirected to a different domain
    if (isFaselUrl(url) && !isFaselUrl(finalUrl)) {
      console.log(`[Browser] Domain rotated! ${url} → ${finalUrl}`);
      markDomainBad();
      return null;
    }

    return html;
  } catch (err) {
    console.error(`[Browser] Error: ${err.message}`);
    return null;
  } finally {
    await page.close().catch(() => {});
  }
  }); // end withBrowserLock
}

// ── Caches ──
const cache = {
  imdb: new Map(),    // imdbId → { title, year, ts }
  search: new Map(),  // "query|year" → { results, ts }
  stream: new Map(),  // imdbId:s:e → { streams, ts }
};
const IMDB_TTL = 24 * 60 * 60 * 1000;   // 24h
const SEARCH_TTL = 60 * 60 * 1000;        // 1h (sitemap-based, stable results)
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
const DOMAIN_BASE = "faselhdx";
const MAIN_DOMAIN = "https://www.fasel-hd.cam";
function isFaselUrl(url) { return url.includes(DOMAIN_BASE) || url.includes("fasel-hd.cam") || url.includes("faselhd."); }
let activeDomain = MAIN_DOMAIN;
let domainLastCheck = 0; // Force discovery on first request
const DOMAIN_TTL = 10 * 60 * 1000; // 10 min
let domainDiscoveryPromise = null;

async function discoverDomain() {
  // If we have a webXx domain, check if it's still alive
  if (activeDomain !== MAIN_DOMAIN && activeDomain.includes(DOMAIN_BASE)) {
    try {
      const resp = await fetch(`${activeDomain}/`, {
        redirect: "manual",
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(5000),
      });
      if (resp.status === 200) {
        console.log(`[Domain] Current domain still alive: ${activeDomain}`);
        domainLastCheck = Date.now();
        return activeDomain;
      }
    } catch {}
  }

  console.log("[Domain] Discovering active domain via Puppeteer...");

  // Use Puppeteer to visit fasel-hd.cam — it goes through CF and lands on active domain
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      await page.setUserAgent(UA);
      await page.goto(MAIN_DOMAIN, { waitUntil: "domcontentloaded", timeout: 30000 });

      // Wait for CF challenge if present
      const content = await page.content();
      if (content.includes("Just a moment") || content.includes("Checking your browser")) {
        console.log("[Domain] CF challenge, waiting...");
        await page.waitForFunction(
          () => !document.body.innerHTML.includes("Just a moment") && !document.body.innerHTML.includes("Checking your browser"),
          { timeout: 20000 }
        ).catch(() => {});
      }

      const finalUrl = page.url();
      console.log(`[Domain] Browser landed on: ${finalUrl}`);

      // Extract the domain from the final URL
      const m = finalUrl.match(/https?:\/\/web\d+x\.faselhdx\.[a-z]+/);
      if (m) {
        activeDomain = m[0].replace(/^http:/, "https:");
        domainLastCheck = Date.now();
        console.log(`[Domain] Discovered: ${activeDomain}`);
        return activeDomain;
      }

      // Maybe it stayed on fasel-hd.cam — check if page links contain webXx
      const html = await page.content();
      const linkMatch = html.match(/https?:\/\/web\d+x\.faselhdx\.[a-z]+/);
      if (linkMatch) {
        activeDomain = linkMatch[0].replace(/^http:/, "https:");
        domainLastCheck = Date.now();
        console.log(`[Domain] Discovered from page links: ${activeDomain}`);
        return activeDomain;
      }

      // Site might now run directly on fasel-hd.cam
      if (finalUrl.includes("fasel-hd.cam") && html.length > 5000 && !html.includes("Just a moment")) {
        activeDomain = MAIN_DOMAIN;
        domainLastCheck = Date.now();
        console.log(`[Domain] Site running directly on ${MAIN_DOMAIN}`);
        return activeDomain;
      }
    } finally {
      await page.close().catch(() => {});
    }
  } catch (e) {
    console.log(`[Domain] Puppeteer discovery failed: ${e.message}`);
  }

  // FALLBACK: Quick parallel scan of nearby numbers
  console.log("[Domain] Puppeteer failed, scanning...");
  const numMatch = activeDomain.match(/web(\d+)x/);
  const lastNum = numMatch ? parseInt(numMatch[1]) : 31718;

  const candidates = [];
  for (let offset = -10; offset <= 200; offset++) {
    for (const tld of ['best', 'xyz']) {
      candidates.push(`https://web${lastNum + offset}x.${DOMAIN_BASE}.${tld}`);
    }
  }
  console.log(`[Domain] Scanning ${candidates.length} candidates...`);

  const scanResults = await Promise.all(
    candidates.map(async (domain) => {
      try {
        const resp = await fetch(`${domain}/`, {
          redirect: "manual",
          headers: { "User-Agent": UA },
          signal: AbortSignal.timeout(3000),
        });
        if (resp.status === 200) return domain;
      } catch {}
      return null;
    })
  );

  const found = scanResults.find(Boolean);
  if (found) {
    activeDomain = found;
    domainLastCheck = Date.now();
    console.log(`[Domain] Discovered via scan: ${activeDomain}`);
    return activeDomain;
  }

  console.log("[Domain] Could not discover, using last known");
  domainLastCheck = Date.now();
  return activeDomain;
}

async function getDomain() {
  if (Date.now() - domainLastCheck > DOMAIN_TTL) {
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
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Cache-Control": "max-age=0",
};

async function fetchPage(url, retries = 2) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`[Fetch] (${i + 1}/${retries}) ${url}`);

      // Use Puppeteer for FaselHD pages, native fetch for others
      let html;
      if (isFaselUrl(url)) {
        // Quick check: is the domain still alive? (native fetch, no browser needed)
        try {
          const checkResp = await fetch(url, {
            redirect: "manual",
            headers: { "User-Agent": UA },
            signal: AbortSignal.timeout(5000),
          });
          if (checkResp.status >= 300 && checkResp.status < 400) {
            const loc = checkResp.headers.get("location") || "";
            // Only rotate if redirect goes to a different base domain
            const urlHost = new URL(url).hostname;
            const locHost = loc ? new URL(loc).hostname : "";
            if (locHost && locHost !== urlHost) {
              console.log(`[Fetch] Domain returned ${checkResp.status} → ${loc}, rotating...`);
              markDomainBad();
              const newDomain = await getDomain();
              url = url.replace(/https?:\/\/[^/]+/, newDomain);
              console.log(`[Fetch] Retrying with new domain: ${url}`);
            }
          }
        } catch {}
        html = await browserFetch(url);
      } else {
        const resp = await fetch(url, {
          headers: { ...HEADERS, Referer: url },
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        html = await resp.text();
      }

      if (!html) throw new Error("Empty response");

      if (html.includes("Just a moment") || html.includes("Checking your browser")) {
        console.log("[Fetch] Cloudflare challenge page returned");
        continue;
      }

      return html;
    } catch (err) {
      console.error(`[Fetch] ${err.message}`);
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
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
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

// ── Sitemap-based search (bypasses CF-blocked /?s= endpoint) ──

// ── Sitemap-based search (on-demand, low memory) ──
// Instead of loading all sitemaps into memory, we search them one at a time

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[''`]/g, "")
    .replace(/[&]/g, "and")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

// Search a single sitemap XML for matching URLs
function searchInXml(xml, slug, year) {
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  const results = [];
  for (const url of urls) {
    const decoded = decodeURIComponent(url).toLowerCase();
    if (decoded.includes(slug)) {
      let score = 0;
      if (year && decoded.includes(String(year))) score += 10;
      results.push({ url, title: "", score });
    }
  }
  // Fallback: try individual words
  if (results.length === 0) {
    const words = slug.split("-").filter(w => w.length >= 4);
    if (words.length > 1) {
      for (const url of urls) {
        const decoded = decodeURIComponent(url).toLowerCase();
        const matchCount = words.filter(w => decoded.includes(w)).length;
        if (matchCount >= Math.ceil(words.length * 0.6)) {
          let score = matchCount;
          if (year && decoded.includes(String(year))) score += 10;
          results.push({ url, title: "", score });
        }
      }
    }
  }
  return results;
}

// Search across sitemaps of a given type in parallel, stopping early when found
async function searchSitemaps(domain, prefix, maxNum, slug, year) {
  const allResults = [];
  let found = false;

  // Fetch all sitemaps in parallel, process results as they arrive
  let domainDead = false;
  const fetches = [];
  for (let i = 1; i <= maxNum; i++) {
    fetches.push(
      fetch(`${domain}/${prefix}-sitemap${i}.xml`, {
        headers: { "User-Agent": UA },
        redirect: "manual",
        signal: AbortSignal.timeout(12000),
      })
        .then(async (resp) => {
          // Detect domain rotation (301/302 redirect)
          if (resp.status >= 300 && resp.status < 400) {
            domainDead = true;
            return;
          }
          if (!resp.ok || found) return;
          const xml = await resp.text();
          if (xml.includes("Just a moment")) return;
          const matches = searchInXml(xml, slug, year);
          if (matches.length > 0) {
            allResults.push(...matches);
            // If we found a match with year, mark as found
            if (matches.some(r => r.score >= 10)) found = true;
          }
        })
        .catch(() => {})
    );
  }
  await Promise.all(fetches);

  // If domain rotated, trigger re-discovery and retry with new domain
  if (domainDead && allResults.length === 0) {
    console.log(`[Sitemap] Domain ${domain} rotated, discovering new one...`);
    markDomainBad();
    const newDomain = await getDomain();
    if (newDomain !== domain) {
      console.log(`[Sitemap] Retrying with ${newDomain}`);
      return searchSitemaps(newDomain, prefix, maxNum, slug, year);
    }
  }

  // If no exact year match but we have results, that's fine
  if (allResults.length === 0 && !found) return [];
  allResults.sort((a, b) => b.score - a.score);
  // Normalize URLs to use the active domain
  const currentDomain = await getDomain();
  return allResults.map(r => ({
    ...r,
    url: r.url.replace(/https?:\/\/[^/]+/, currentDomain)
  }));
}

async function searchViaRSS(query, domain) {
  try {
    const url = `${domain}/feed/?s=${encodeURIComponent(query)}`;
    console.log(`[RSS] ${url}`);
    let xml;
    try {
      const resp = await fetch(url, {
        headers: { ...HEADERS, Accept: "application/rss+xml,application/xml,text/xml" },
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        xml = await resp.text();
        if (xml.includes("Just a moment") || xml.includes("Checking your browser")) {
          xml = null;
        }
      }
    } catch {}
    if (!xml) return [];

    const $ = cheerio.load(xml, { xmlMode: true });
    const results = [];
    $("item").each((_, el) => {
      const title = $(el).find("title").text().trim();
      const link = $(el).find("link").text().trim();
      if (link) results.push({ url: link, title });
    });
    console.log(`[RSS] Found ${results.length} result(s)`);
    return results;
  } catch (err) {
    console.error(`[RSS] ${err.message}`);
    return [];
  }
}

// ── FaselHD Search ──

async function searchFasel(query, year, type) {
  const domain = await getDomain();
  const cacheKey = `${query}|${year}|${type}`;
  const cached = cacheGet(cache.search, cacheKey, SEARCH_TTL);
  if (cached) return cached;

  const slug = slugify(query);
  console.log(`[Search] query="${query}" slug="${slug}" year=${year} type=${type}`);

  let results = [];

  // Strategy 1: On-demand sitemap search (works from datacenter, no CF)
  if (type === "movie") {
    results = await searchSitemaps(domain, "movies", 14, slug, year);
  } else if (type === "series") {
    results = await searchSitemaps(domain, "seasons", 4, slug, year);
    if (!results.length) results = await searchSitemaps(domain, "series", 8, slug, year);
  } else {
    results = await searchSitemaps(domain, "movies", 14, slug, year);
    if (!results.length) results = await searchSitemaps(domain, "seasons", 4, slug, year);
    if (!results.length) results = await searchSitemaps(domain, "series", 8, slug, year);
  }

  // Strategy 2: RSS feed fallback (works from residential IPs)
  if (!results.length) {
    results = await searchViaRSS(query, domain);
    // Filter by type
    if (type === "movie") {
      const f = results.filter((r) => r.url.includes("/movies/"));
      if (f.length) results = f;
    } else if (type === "series") {
      const f = results.filter((r) => r.url.includes("/seasons/") || r.url.includes("/series/"));
      if (f.length) results = f;
    }
  }

  console.log(`[Search] "${query}" → ${results.length} result(s)`);
  results.slice(0, 5).forEach((r, i) => console.log(`  ${i}: ${r.url}`));
  if (results.length > 0) cacheSet(cache.search, cacheKey, results);
  return results;
}

// ── Content page parser ──
// Extracts player_token URLs from movie/episode pages

async function getPlayerTokens(url) {
  const html = await fetchPage(url);
  if (!html) return [];

  const tokens = [];
  const seen = new Set();

  // Extract quality badge from page
  const $ = cheerio.load(html);
  const qualityBadge = $(".quality, .مشاهدة").first().text().trim() ||
    (html.match(/(?:quality|الجودة)[^<]*?([0-9]{3,4}p[^<]{0,20})/i) || [])[1] || "";

  // Extract player_token from iframes (data-src and src)
  let serverNum = 0;
  $("iframe").each((_, el) => {
    const src = $(el).attr("data-src") || $(el).attr("src") || "";
    const m = src.match(/player_token=([^"'&\s]+)/);
    if (m && !seen.has(m[1])) {
      seen.add(m[1]);
      serverNum++;
      tokens.push({
        url: src.startsWith("//") ? `https:${src}` : src,
        name: `Server #${String(serverNum).padStart(2, "0")}`,
        quality: qualityBadge,
      });
    }
  });

  // Extract player_tokens from onclick handlers (server buttons)
  $('[onclick*="player_token"]').each((_, el) => {
    const onclick = $(el).attr("onclick") || "";
    const m = onclick.match(/player_token=([^"'&\s]+)/);
    if (m && !seen.has(m[1])) {
      seen.add(m[1]);
      serverNum++;
      const text = $(el).text().trim();
      const domain = new URL(url).origin;
      tokens.push({
        url: `${domain}/video_player?player_token=${m[1]}`,
        name: text || `Server #${String(serverNum).padStart(2, "0")}`,
        quality: qualityBadge,
      });
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
      serverNum++;
      tokens.push({
        url: rm[0],
        name: `Server #${String(serverNum).padStart(2, "0")}`,
        quality: qualityBadge,
      });
    }
  }

  console.log(`[Parse] ${url.substring(url.lastIndexOf("/") + 1, url.lastIndexOf("/") + 40)}... → ${tokens.length} player(s)`);
  return tokens;
}

// Parse a series page: extract season URLs and episode URLs
async function parseSeriesPage(url) {
  const html = await fetchPage(url);
  if (!html) return { seasons: [], episodes: [] };

  const $ = cheerio.load(html);
  const domain = new URL(url).origin;

  // Extract seasons from .seasonDiv onclick handlers
  const seasons = [];
  $(".seasonDiv").each((_, el) => {
    const title = $(el).find(".title").text().trim();
    const onclick = $(el).attr("onclick") || "";
    // "موسم 1" → extract number
    const numMatch = title.match(/(\d+)/);
    const sn = numMatch ? parseInt(numMatch[1]) : 0;
    // onclick="window.location.href = '/?p=212588'"
    const urlMatch = onclick.match(/['"]([^'"]+)['"]/);
    const seasonUrl = urlMatch
      ? urlMatch[1].startsWith("http")
        ? urlMatch[1]
        : `${domain}${urlMatch[1]}`
      : "";
    if (seasonUrl) seasons.push({ num: sn, url: seasonUrl, title });
  });

  // Extract episode links
  const episodes = [];
  const seen = new Set();
  // Prefer .epAll container, fall back to any episode link
  const epLinks = $(".epAll a[href]").length
    ? $(".epAll a[href]")
    : $('a[href*="episode"]');
  epLinks.each((_, el) => {
    const href = $(el).attr("href") || "";
    const text = $(el).text().trim();
    if (
      (href.includes("episode") || href.includes("%d8%a7%d9%84%d8%ad%d9%84%d9%82%d8%a9")) &&
      !seen.has(href)
    ) {
      seen.add(href);
      const full = href.startsWith("http") ? href : `${domain}${href}`;
      // Extract episode number from Arabic "الحلقة N" or URL
      const numMatch = text.match(/(\d+)/) || href.match(/-(\d+)(?:[-%]|$)/);
      const epNum = numMatch ? parseInt(numMatch[1]) : 0;
      episodes.push({ url: full, title: text, num: epNum });
    }
  });

  console.log(
    `[Series] ${seasons.length} season(s), ${episodes.length} episode(s)`
  );
  return { seasons, episodes };
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

  // Build search queries — FaselHD struggles with special chars like apostrophes/colons
  const queries = [info.title];
  // Strip special characters
  const cleaned = info.title.replace(/[''`:;,!?]/g, "").replace(/\s+/g, " ").trim();
  if (cleaned !== info.title) queries.push(cleaned);
  // If title has a colon/dash subtitle, try both parts
  const parts = info.title.split(/[:\-–—]\s*/);
  if (parts.length > 1) {
    queries.push(parts[parts.length - 1].trim()); // subtitle
    queries.push(parts[0].trim()); // main title
  }

  let results = [];
  for (const q of queries) {
    results = await searchFasel(q, info.year, type);
    if (results.length > 0) break;
    if (info.year) {
      results = await searchFasel(`${q} ${info.year}`, info.year, type);
      if (results.length > 0) break;
    }
  }
  if (results.length === 0) {
    console.log("[Resolve] Nothing found on FaselHD");
    return [];
  }

  const streams = [];
  let targetUrl = results[0].url;

  // Series: navigate to correct season → episode
  if (type === "series" && season && episode) {
    const sn = parseInt(season);
    const ep = parseInt(episode);

    // Parse the first result's page for season/episode info
    let { seasons, episodes } = await parseSeriesPage(targetUrl);

    // If seasons exist and we need a different one, navigate there
    if (seasons.length > 0) {
      const match = seasons.find((s) => s.num === sn);
      if (match) {
        console.log(`[Resolve] Season ${sn}: ${match.url}`);
        // If not already on the right season, fetch that page
        const isActive = seasons.findIndex((s) => s.num === sn);
        // Re-parse the correct season page for its episodes
        const seasonPage = await parseSeriesPage(match.url);
        episodes = seasonPage.episodes;
      } else {
        console.log(
          `[Resolve] Season ${sn} not found in [${seasons.map((s) => s.num).join(",")}]`
        );
      }
    }

    // Find the specific episode
    let epUrl = null;
    // Match by episode number
    const epMatch = episodes.find((e) => e.num === ep);
    if (epMatch) {
      epUrl = epMatch.url;
    } else if (episodes.length >= ep) {
      // Fallback: use index
      epUrl = episodes[ep - 1]?.url;
    }

    if (epUrl) {
      console.log(`[Resolve] Episode ${ep}: ${epUrl}`);
      targetUrl = epUrl;
    } else {
      console.log(
        `[Resolve] Episode ${ep} not found (${episodes.length} episodes available)`
      );
    }
  }

  // Get player_token URLs from the page
  const players = await getPlayerTokens(targetUrl);

  // Extract streams from all servers (sequential — mocks use global)
  for (const p of players) {
    const s = await extractStreamFromPlayer(p.url);
    if (s) {
      const label = [p.quality, p.name].filter(Boolean).join(" | ");
      streams.push({ url: s.url, title: label || "FaselHD" });
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

    // Build proxy base URL from environment or request context
    const proxyBase = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || `http://localhost:${PORT}`;

    const seen = new Set();
    const streams = raw
      .map((s) => {
        const proxiedUrl = `${proxyBase}/proxy/${Buffer.from(s.url).toString('base64url')}/stream.m3u8`;
        return {
          name: "FaselHD",
          title: s.title || "FaselHD",
          url: proxiedUrl,
          behaviorHints: { notWebReady: false },
        };
      })
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
const { getRouter } = require("stremio-addon-sdk");
const addonInterface = builder.getInterface();
const router = getRouter(addonInterface);

const http = require("http");
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Global request timeout: 120s max per request
  const requestTimeout = setTimeout(() => {
    if (!res.writableEnded) {
      console.log(`[TIMEOUT] Request timed out: ${req.url}`);
      res.writeHead(504, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Request timed out" }));
    }
  }, 120000);
  res.on("finish", () => clearTimeout(requestTimeout));
  // ── M3U8/segment proxy (bypasses IP-locked streams) ──
  // Supports both: /proxy/{base64url}/stream.m3u8 and /proxy?url={base64url}
  if (req.url.startsWith("/proxy")) {
    let b64;
    if (req.url.startsWith("/proxy/")) {
      b64 = req.url.split('/')[2];
    } else {
      const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
      b64 = parsedUrl.searchParams.get("url");
    }
    if (!b64) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing url parameter");
      return;
    }
    let targetUrl;
    try {
      targetUrl = Buffer.from(b64, 'base64url').toString();
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Invalid url parameter");
      return;
    }

    // Only allow proxying to known CDN domains
    const allowed = ['scdns.io', 'faselhdx.best', 'faselhdx.xyz', 'fasel-hd.cam', 'faselhd.club'];
    let hostname;
    try { hostname = new URL(targetUrl).hostname; } catch { hostname = ''; }
    if (!allowed.some(d => hostname.endsWith(d))) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Domain not allowed");
      return;
    }

    try {
      const proxyBase = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || `http://localhost:${PORT}`;
      const upstream = await fetch(targetUrl, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(30000),
      });

      if (!upstream.ok) {
        res.writeHead(upstream.status, { "Content-Type": "text/plain" });
        res.end(`Upstream error: ${upstream.status}`);
        return;
      }

      const ct = upstream.headers.get("content-type") || "";

      // If it's an m3u8, rewrite URLs inside to go through proxy
      if (ct.includes("mpegurl") || targetUrl.endsWith(".m3u8")) {
        let body = await upstream.text();
        // Rewrite absolute URLs
        body = body.replace(/^(https?:\/\/[^\s]+)/gm, (url) => {
          const trimmed = url.trim();
          const ext = trimmed.endsWith('.m3u8') ? 'stream.m3u8' : 'segment.ts';
          return `${proxyBase}/proxy/${Buffer.from(trimmed).toString('base64url')}/${ext}`;
        });
        res.writeHead(200, {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(body);
        return;
      }

      // For .ts segments or other binary data, pipe through
      const headers = {
        "Content-Type": ct || "application/octet-stream",
        "Access-Control-Allow-Origin": "*",
      };
      const cl = upstream.headers.get("content-length");
      if (cl) headers["Content-Length"] = cl;
      res.writeHead(200, headers);

      // Stream the body
      const reader = upstream.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      };
      await pump();
    } catch (err) {
      console.error(`[Proxy] Error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end(`Proxy error: ${err.message}`);
      }
    }
    return;
  }

  // Health/debug endpoint
  if (req.url === "/health") {
    const fs = require("fs");
    const chromiumExists = fs.existsSync(CHROME_PATH);
    const info = {
      status: "ok",
      domain: activeDomain,
      domainAge: Date.now() - domainLastCheck,
      browserConnected: browserInstance ? browserInstance.isConnected() : false,
      chromiumPath: CHROME_PATH,
      chromiumExists,
      nodeVersion: process.version,
      memoryMB: Math.round(process.memoryUsage().rss / 1048576),
      searchCache: cache.search.size,
      streamCache: cache.stream.size,
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(info, null, 2));
    return;
  }

  // Stremio SDK router
  router(req, res, () => {
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not Found" }));
  });
});

server.listen(PORT, () => {
  console.log("=".repeat(55));
  console.log("  FaselHD Stremio Addon");
  console.log("=".repeat(55));
  console.log(`  Server:   http://localhost:${PORT}`);
  console.log(`  Manifest: http://localhost:${PORT}/manifest.json`);
  console.log(`  Health:   http://localhost:${PORT}/health`);
  console.log(`  Test:     http://localhost:${PORT}/stream/movie/tt6166392.json`);
  console.log("=".repeat(55));
});

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  process.exit(0);
});
