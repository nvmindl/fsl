const { addonBuilder } = require("stremio-addon-sdk");
const cheerio = require("cheerio");
const vm = require("vm");
require("dotenv").config();

// ── Puppeteer Browser (CF bypass) — auto-close after idle to save memory ──
const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";
let browserInstance = null;
let browserLaunchPromise = null;
let browserIdleTimer = null;
const BROWSER_IDLE_MS = 60_000; // close browser after 60s idle

function resetBrowserIdle() {
  if (browserIdleTimer) clearTimeout(browserIdleTimer);
  browserIdleTimer = setTimeout(async () => {
    if (browserInstance && browserInstance.isConnected()) {
      console.log("[Browser] Idle timeout, closing to free memory");
      workerPage = null;
      workerDomain = null;
      try { await browserInstance.close(); } catch {}
      browserInstance = null;
    }
  }, BROWSER_IDLE_MS);
}

async function getBrowser() {
  if (browserInstance && browserInstance.isConnected()) {
    resetBrowserIdle();
    return browserInstance;
  }
  if (browserLaunchPromise) return browserLaunchPromise;

  browserLaunchPromise = (async () => {
    try {
      console.log("[Browser] Launching browser...");
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
          "--disable-software-rasterizer",
          "--disable-background-networking",
          "--disable-default-apps",
          "--disable-sync",
          "--disable-translate",
          "--metrics-recording-only",
          "--mute-audio",
          "--no-default-browser-check",
          "--js-flags=--max-old-space-size=128",
        ],
      });

      browserInstance.on("disconnected", () => {
        console.log("[Browser] Disconnected");
        browserInstance = null;
        workerPage = null;
        workerDomain = null;
        if (browserIdleTimer) clearTimeout(browserIdleTimer);
      });

      resetBrowserIdle();
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

// ── CF Cookie Cache ──
// After Puppeteer bypasses CF, we extract cookies and reuse them with fast HTTP fetch
let cfCookies = ""; // "cf_clearance=...; __cf_bm=..." etc.
let cfCookiesDomain = "";
let cfCookiesTs = 0;
const CF_COOKIE_TTL = 8 * 60 * 1000; // CF cookies last ~15min, refresh at 8min

async function extractCfCookies(page) {
  try {
    const cookies = await page.cookies();
    if (cookies.length > 0) {
      cfCookies = cookies.map(c => `${c.name}=${c.value}`).join("; ");
      cfCookiesDomain = new URL(page.url()).hostname;
      cfCookiesTs = Date.now();
      const cfCount = cookies.filter(c => c.name.startsWith("cf_") || c.name.startsWith("__cf")).length;
      console.log(`[CF] Cached ${cookies.length} cookie(s) (${cfCount} CF) for ${cfCookiesDomain}`);
    }
  } catch {}
}

function getCfCookies(url) {
  if (!cfCookies || Date.now() - cfCookiesTs > CF_COOKIE_TTL) return null;
  try {
    const host = new URL(url).hostname;
    // Cookies work for same domain or subdomains
    if (host === cfCookiesDomain || host.endsWith("." + cfCookiesDomain) || cfCookiesDomain.endsWith("." + host)) {
      return cfCookies;
    }
  } catch {}
  return null;
}

// Fast HTTP fetch using cached CF cookies (no browser needed)
async function fastFetch(url) {
  const cookies = getCfCookies(url);
  if (!cookies) return null;
  try {
    const resp = await fetch(url, {
      headers: { ...HEADERS, Cookie: cookies, Referer: url },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    if (html.includes("Just a moment") || html.includes("Checking your browser")) {
      console.log("[FastFetch] CF challenge — cookies expired");
      cfCookies = ""; // invalidate
      return null;
    }
    if (html.length < 500) return null; // too short, probably error
    return html;
  } catch {
    return null;
  }
}

// ── Worker page: persistent browser tab for FaselHD content ──
// CF challenges each NEW tab with Turnstile (can't auto-solve).
// But navigating the SAME tab to different URLs keeps the CF session alive.
// So: load homepage once (pass CF), then navigate the same tab to content pages.
let workerPage = null;
let workerDomain = null;

async function ensureWorkerPage() {
  const browser = await getBrowser();
  const domain = activeDomain || MAIN_DOMAIN;

  if (workerPage && !workerPage.isClosed() && workerDomain === domain) {
    return workerPage;
  }

  if (workerPage && !workerPage.isClosed()) {
    await workerPage.close().catch(() => {});
  }

  console.log(`[Worker] Opening session on ${domain}...`);
  workerPage = await browser.newPage();
  await workerPage.setUserAgent(UA);
  await workerPage.setViewport({ width: 1280, height: 720 });

  await workerPage.goto(domain + "/", { waitUntil: "domcontentloaded", timeout: 25000 });

  // Handle CF challenge on homepage
  const content = await workerPage.content();
  if (content.includes("Just a moment") || content.includes("Checking your browser")) {
    console.log("[Worker] CF challenge on homepage...");
    try {
      await new Promise(r => setTimeout(r, 2000));
      for (const frame of workerPage.frames()) {
        const box = await frame.$('input[type="checkbox"], .cb-lb');
        if (box) { await box.click(); break; }
      }
    } catch {}
    await workerPage.waitForFunction(
      () => !document.body.innerHTML.includes("Just a moment") && !document.body.innerHTML.includes("Checking your browser"),
      { timeout: 20000 }
    ).catch(() => console.log("[Worker] CF did not resolve"));
  }

  workerDomain = domain;
  await extractCfCookies(workerPage);
  console.log("[Worker] Session ready");
  return workerPage;
}

// Fetch a FaselHD page by navigating the worker tab (same CF session)
async function workerNavigate(url, timeout = 20000) {
  const page = await ensureWorkerPage();
  console.log(`[Worker] Navigating: ${url.substring(0, 80)}...`);

  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout });

  // Quick CF check — worker tab usually passes without Turnstile
  const content = await page.content();
  if (content.includes("Just a moment") || content.includes("Checking your browser")) {
    console.log("[Worker] CF on content page, waiting...");
    await page.waitForFunction(
      () => !document.body.innerHTML.includes("Just a moment") && !document.body.innerHTML.includes("Checking your browser"),
      { timeout: 15000 }
    ).catch(() => {});
  }

  const html = await page.content();
  const finalUrl = page.url();
  const status = response ? response.status() : 0;
  console.log(`[Worker] ${status} (${html.length} chars)`);

  // Detect domain rotation
  if (isFaselUrl(url) && !isFaselUrl(finalUrl)) {
    console.log(`[Worker] Domain rotated! → ${finalUrl}`);
    markDomainBad();
    return null;
  }

  // If still CF-blocked, return null
  if (html.includes("Just a moment") || html.includes("Checking your browser") || html.length < 1000) {
    console.log("[Worker] Still CF-blocked, invalidating session");
    workerPage = null;
    workerDomain = null;
    return null;
  }

  // Refresh cookies after every successful navigation so fastFetch works for subsequent pages
  await extractCfCookies(page);

  return html;
}

// Fetch a page using Puppeteer
async function browserFetch(url, timeout = 30000) {
  return withBrowserLock(async () => {
    // For FaselHD: navigate the worker tab (same CF session, no new Turnstile)
    if (isFaselUrl(url)) {
      try {
        const html = await workerNavigate(url, timeout);
        if (html) return html;
        console.log("[Browser] Worker failed, trying fresh tab...");
      } catch (err) {
        console.log(`[Browser] Worker error: ${err.message}, trying fresh tab...`);
        workerPage = null;
        workerDomain = null;
      }
    }

    // Fallback: fresh tab (non-FaselHD or if worker failed)
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      await page.setUserAgent(UA);
      await page.setViewport({ width: 1280, height: 720 });

      console.log(`[Browser] Direct navigation: ${url}`);
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout });

      const content = await page.content();
      if (content.includes("Just a moment") || content.includes("Checking your browser")) {
        console.log("[Browser] CF challenge, waiting...");
        try {
          await new Promise(r => setTimeout(r, 2000));
          for (const frame of page.frames()) {
            const box = await frame.$('input[type="checkbox"], .cb-lb');
            if (box) { await box.click(); break; }
          }
        } catch {}
        await page.waitForFunction(
          () => !document.body.innerHTML.includes("Just a moment") && !document.body.innerHTML.includes("Checking your browser"),
          { timeout: 20000 }
        ).catch(() => console.log("[Browser] CF did not resolve"));
      }

      const html = await page.content();
      const finalUrl = page.url();
      const status = response ? response.status() : 0;
      console.log(`[Browser] ${url.substring(0, 60)}... → ${status} (${html.length} chars)`);

      await extractCfCookies(page);

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
  page: new Map(),    // url → { html, ts } — short-lived, avoids re-fetching same URL
};
const IMDB_TTL = 24 * 60 * 60 * 1000;   // 24h
const SEARCH_TTL = 15 * 60 * 1000;        // 15min

function cacheGet(store, key, ttl) {
  const entry = store.get(key);
  if (entry && Date.now() - entry.ts < ttl) return entry.data;
  return null;
}
function cacheSet(store, key, data) {
  store.set(key, { data, ts: Date.now() });
  // Evict old entries if cache grows too large
  if (store.size > 100) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
}

// ── FaselHD Domain Rotation ──
const DOMAIN_BASE = "faselhdx";
const MAIN_DOMAIN = "https://www.fasel-hd.cam";
function isFaselUrl(url) { return url.includes(DOMAIN_BASE) || url.includes("fasel-hd.cam") || url.includes("faselhd."); }
let activeDomain = process.env.FASELHDX_DOMAIN ? `https://${process.env.FASELHDX_DOMAIN.replace(/^https?:\/\//, "")}` : MAIN_DOMAIN;
let domainLastCheck = process.env.FASELHDX_DOMAIN ? Date.now() : 0; // Skip discovery if domain provided
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

  // After discovery, pre-warm worker page for content fetches
  try { await ensureWorkerPage(); } catch {}

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
  workerDomain = null; // force worker page recreation on new domain
}

// Learn the working domain from a redirect target URL
function learnDomainFromUrl(url) {
  try {
    const u = new URL(url);
    const origin = u.origin;
    if (isFaselUrl(origin) && origin !== activeDomain) {
      console.log(`[Domain] Learned working domain from redirect: ${origin}`);
      activeDomain = origin;
      domainLastCheck = Date.now();
    }
  } catch {}
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
  // Short-lived page cache — avoids re-fetching same URL within 2 min
  const pageCached = cacheGet(cache.page, url, 120000);
  if (pageCached) {
    console.log(`[Fetch] Page cache hit (${pageCached.length} chars)`);
    return pageCached;
  }

  for (let i = 0; i < retries; i++) {
    try {
      console.log(`[Fetch] (${i + 1}/${retries}) ${url}`);

      let html;
      if (isFaselUrl(url)) {
        // Try fast HTTP fetch with cached CF cookies first
        html = await fastFetch(url);
        if (html) {
          console.log(`[Fetch] Fast fetch OK (${html.length} chars)`);
          cacheSet(cache.page, url, html);
          return html;
        }

        // Try plain HTTP with redirect following (works on non-CF subdomains)
        try {
          const resp = await fetch(url, {
            headers: { ...HEADERS, Referer: url },
            redirect: "follow",
            signal: AbortSignal.timeout(12000),
          });
          if (resp.ok) {
            learnDomainFromUrl(resp.url);
            const text = await resp.text();
            if (text.length > 1000 && !text.includes("Just a moment") && !text.includes("Checking your browser")) {
              console.log(`[Fetch] HTTP follow-redirect OK (${text.length} chars)`);
              cacheSet(cache.page, url, text);
              return text;
            }
          }
        } catch {}

        // Fall back to Puppeteer
        html = await browserFetch(url);
      } else {
        const resp = await fetch(url, {
          headers: { ...HEADERS, Referer: url },
          signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        html = await resp.text();
      }

      if (!html) throw new Error("Empty response");

      if (html.includes("Just a moment") || html.includes("Checking your browser")) {
        console.log("[Fetch] CF challenge — need browser");
        cfCookies = ""; // invalidate cookies
        continue;
      }

      cacheSet(cache.page, url, html);
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
      const match = data.d.find(e => e.id === imdbId) || data.d[0];
      const info = { title: match.l, year: match.y };
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

  // Fetch all sitemaps in parallel, following redirects to find working domain
  const fetches = [];
  for (let i = 1; i <= maxNum; i++) {
    fetches.push(
      fetch(`${domain}/${prefix}-sitemap${i}.xml`, {
        headers: { "User-Agent": UA },
        redirect: "follow",
        signal: AbortSignal.timeout(12000),
      })
        .then(async (resp) => {
          if (!resp.ok || found) return;
          // Learn working domain from redirect target
          learnDomainFromUrl(resp.url);
          const xml = await resp.text();
          if (xml.includes("Just a moment")) return;
          const matches = searchInXml(xml, slug, year);
          if (matches.length > 0) {
            allResults.push(...matches);
            if (matches.some(r => r.score >= 10)) found = true;
          }
        })
        .catch(() => {})
    );
  }
  await Promise.all(fetches);

  if (allResults.length === 0) return [];
  allResults.sort((a, b) => b.score - a.score);
  const currentDomain = await getDomain();
  return allResults.map(r => ({
    ...r,
    url: r.url.replace(/https?:\/\/[^/]+/, currentDomain)
  }));
}

// ── Website search (fast HTTP, follows redirects, finds everything) ──
async function searchWebsite(query, domain) {
  try {
    const searchUrl = `${domain}/?s=${encodeURIComponent(query)}`;
    console.log(`[WebSearch] ${searchUrl}`);
    const resp = await fetch(searchUrl, {
      headers: { ...HEADERS },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      console.log(`[WebSearch] HTTP ${resp.status}`);
      return [];
    }
    // Learn working domain from redirect target
    learnDomainFromUrl(resp.url);
    const html = await resp.text();
    if (html.includes("Just a moment") || html.includes("Checking your browser")) {
      console.log("[WebSearch] CF blocked, will try browser fallback");
      return [];
    }
    return parseSearchResults(html);
  } catch (err) {
    console.error(`[WebSearch] ${err.message}`);
    return [];
  }
}

// ── Browser-based search (fallback when HTTP is CF-blocked) ──
async function searchViaBrowser(query, domain) {
  try {
    const searchUrl = `${domain}/?s=${encodeURIComponent(query)}`;
    console.log(`[BrowserSearch] ${searchUrl}`);
    const html = await fetchPage(searchUrl);
    if (!html) return [];
    return parseSearchResults(html);
  } catch (err) {
    console.error(`[BrowserSearch] ${err.message}`);
    return [];
  }
}

function parseSearchResults(html) {
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();
  // Find all links pointing to content pages
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    if (href && (href.includes("/movies/") || href.includes("/seasons/") || href.includes("/series/"))) {
      // Normalize: strip query/hash, deduplicate
      const clean = href.split("?")[0].split("#")[0];
      if (seen.has(clean)) return;
      seen.add(clean);
      const title = $(el).text().trim() || $(el).attr("title") || "";
      results.push({ url: clean, title });
    }
  });
  console.log(`[ParseSearch] ${results.length} result(s)`);
  return results;
}

// ── FaselHD Search ──

async function searchFasel(query, year, type) {
  let domain = await getDomain();
  const cacheKey = `${query}|${year}|${type}`;
  const cached = cacheGet(cache.search, cacheKey, SEARCH_TTL);
  if (cached) return cached;

  const slug = slugify(query);
  console.log(`[Search] query="${query}" slug="${slug}" year=${year} type=${type}`);

  // If domain is the CF-protected main domain, probe a sitemap to discover the working domain
  if (domain === MAIN_DOMAIN || domain.includes("fasel-hd.cam")) {
    console.log("[Search] Main domain is CF-protected, probing sitemap for redirect...");
    try {
      const probe = await fetch(`${domain}/movies-sitemap1.xml`, {
        headers: { "User-Agent": UA },
        redirect: "follow",
        signal: AbortSignal.timeout(10000),
      });
      if (probe.ok) {
        learnDomainFromUrl(probe.url);
        domain = await getDomain();
        console.log(`[Search] Discovered working domain: ${domain}`);
      }
    } catch {}
  }

  let results = [];

  // Strategy 1: Website search (fast HTTP, follows redirects, finds ALL content)
  results = await searchWebsite(query, domain);

  // Strategy 2: Sitemap search (fallback if website search fails)
  if (!results.length) {
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
  }

  // Strategy 3: Browser-based search (Puppeteer, last resort)
  if (!results.length) {
    results = await searchViaBrowser(query, domain);
  }

  // Filter by type
  if (results.length > 0) {
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
  let qualityBadge = $(".quality, .مشاهدة").first().text().trim() ||
    (html.match(/(?:quality|الجودة)[^<]*?([0-9]{3,4}p(?:\s*[A-Za-z-]+)?)/i) || [])[1] || "";
  // Strip any residual HTML tags/attributes
  qualityBadge = qualityBadge.replace(/<[^>]*>/g, "").replace(/"[^"]*"/g, "").trim();

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
// We execute it in a VM sandbox with mocked browser globals to capture the JWPlayer config.
// The obfuscated script checks localStorage for a consent key before calling jwplayer().setup().

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

  // Minimal DOM element mock
  const me = () => {
    const el = {
      style: new Proxy({}, { get() { return ""; }, set() { return true; } }),
      innerHTML: "", textContent: "", src: "", id: "", href: "", className: "", type: "",
      setAttribute() {}, getAttribute() { return ""; },
      appendChild() { return el; }, removeChild() { return el; }, insertBefore() { return el; },
      querySelector() { return me(); }, querySelectorAll() { return []; },
      getElementsByTagName() { return []; }, getElementsByClassName() { return []; },
      classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
      addEventListener() {}, removeEventListener() {},
      dataset: new Proxy({}, { get() { return ""; }, set() { return true; } }),
      tagName: "DIV", nodeName: "DIV",
      offsetWidth: 1920, offsetHeight: 1080, clientWidth: 1920, clientHeight: 1080,
      parentNode: null, parentElement: null,
      childNodes: [], children: [], firstChild: null, lastChild: null,
      nextSibling: null, previousSibling: null,
      cloneNode() { return me(); }, dispatchEvent() { return true; },
      getBoundingClientRect() { return { top: 0, left: 0, bottom: 1080, right: 1920, width: 1920, height: 1080 }; },
      scrollIntoView() {}, focus() {}, blur() {}, click() {}, remove() {},
    };
    el.parentNode = el;
    el.parentElement = el;
    return el;
  };

  // jQuery proxy — returns a chainable stub for any method call
  const jqProxy = new Proxy(function() {}, {
    apply(target, thisArg, args) {
      if (typeof args[0] === "function") { try { args[0](); } catch(e) {} }
      return new Proxy({ length: 0, 0: me() }, {
        get(t, p) {
          if (p === "length") return 0;
          if (p === Symbol.toPrimitive || p === "then") return undefined;
          return function() { return t; };
        },
      });
    },
    get(target, prop) {
      if (prop === "ajax" || prop === "get" || prop === "post" || prop === "getJSON") {
        return function() { return { done() { return this; }, fail() { return this; }, always() { return this; } }; };
      }
      return target[prop];
    },
  });

  // JWPlayer mock — capture any config object passed to any method
  let capturedConfig = null;
  const playerProxy = () => new Proxy({}, {
    get(t, p) {
      if (p === "then" || p === Symbol.toPrimitive) return undefined;
      return function(...args) {
        if (args[0] && typeof args[0] === "object") capturedConfig = args[0];
        return playerProxy();
      };
    },
  });
  const mockJw = Object.assign(function() { return playerProxy(); }, { key: null, version: "8.33.2" });

  const parsedUrl = new URL(playerUrl);
  const sandbox = {
    // JS built-ins
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {}, trace() {}, dir() {}, table() {} },
    parseInt, parseFloat, isNaN, isFinite, undefined,
    encodeURIComponent, decodeURIComponent, encodeURI, decodeURI, escape, unescape,
    JSON, Math, Date, RegExp, Array, Object, String, Number, Boolean,
    Error, TypeError, RangeError, SyntaxError, ReferenceError, URIError, EvalError,
    Map, Set, WeakMap, WeakSet, Promise, Symbol, Proxy, Reflect,
    ArrayBuffer, Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array,
    Float32Array, Float64Array, DataView,
    TextEncoder, TextDecoder, URL, URLSearchParams,
    Infinity, NaN,

    setTimeout: (fn, ms) => setTimeout(() => { try { fn(); } catch(e) {} }, Math.min(ms || 0, 500)),
    clearTimeout, setInterval: () => 0, clearInterval,
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),

    document: {
      getElementById() { return me(); }, querySelector() { return me(); }, querySelectorAll() { return []; },
      createElement(tag) { const e = me(); e.tagName = (tag || "DIV").toUpperCase(); return e; },
      createTextNode() { return me(); }, createDocumentFragment() { return me(); },
      createComment() { return me(); },
      body: me(), head: me(), cookie: "", addEventListener() {}, removeEventListener() {},
      documentElement: { style: {} }, readyState: "complete", currentScript: { dataset: {} },
      getElementsByTagName() { return []; }, getElementsByClassName() { return []; },
      getElementsByName() { return []; }, title: "", domain: parsedUrl.hostname,
      hasFocus() { return true; }, hidden: false, visibilityState: "visible",
    },
    // Return '1' for all localStorage keys — the obfuscated script gates jwplayer on this
    localStorage: { getItem() { return "1"; }, setItem() {}, removeItem() {}, clear() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {}, clear() {} },
    navigator: { userAgent: UA, platform: "Win32", language: "en-US", languages: ["en-US"], cookieEnabled: true, onLine: true },
    location: { href: playerUrl, hostname: parsedUrl.hostname, host: parsedUrl.host, origin: parsedUrl.origin, protocol: "https:", pathname: parsedUrl.pathname, search: parsedUrl.search, hash: "" },
    history: { pushState() {}, replaceState() {}, back() {}, forward() {}, go() {}, length: 1 },
    performance: { now() { return Date.now(); } },
    XMLHttpRequest: function() { this.open = function() {}; this.send = function() {}; this.setRequestHeader = function() {}; this.addEventListener = function() {}; },
    fetch: function() { return Promise.resolve({ ok: true, json() { return Promise.resolve({}); }, text() { return Promise.resolve(""); }, headers: { get() { return null; } } }); },
    Cookies: { get() { return null; }, set() {} },
    jQuery: jqProxy, $: jqProxy,
    jwplayer: mockJw,
    Image: function() { this.src = ""; },
    crypto: { getRandomValues(a) { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); return a; } },
    MutationObserver: function() { this.observe = function() {}; this.disconnect = function() {}; },
    Event: function(t) { this.type = t; this.preventDefault = function() {}; this.stopPropagation = function() {}; },
    requestAnimationFrame: function(fn) { return setTimeout(fn, 16); }, cancelAnimationFrame: clearTimeout,
    alert() {}, confirm() { return false; }, prompt() { return null; },
    open() { return null; }, close() {}, postMessage() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    getComputedStyle() { return new Proxy({}, { get() { return ""; } }); },
    matchMedia() { return { matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }; },
    innerWidth: 1920, innerHeight: 1080, screen: { width: 1920, height: 1080 }, devicePixelRatio: 1,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  sandbox.parent = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);

  try {
    vm.runInContext(`try{${mainScript}}catch(_e_){}`, sandbox, { timeout: 10000, filename: "player.js" });
  } catch (e) {
    console.log(`[Extract] VM error: ${e.message}`);
  }

  // Allow any scheduled timers to fire
  await new Promise(r => setTimeout(r, 200));

  if (capturedConfig) {
    let streamUrl = null;
    if (capturedConfig.sources && capturedConfig.sources.length > 0) {
      streamUrl = capturedConfig.sources[0].file;
    } else if (capturedConfig.file) {
      streamUrl = capturedConfig.file;
    }
    if (streamUrl) {
      console.log(`[Extract] Got stream: ${streamUrl.substring(0, 80)}...`);
      // Extract quality labels if available
      let qualityInfo = "";
      if (capturedConfig.qualityLabels) {
        const labels = Object.values(capturedConfig.qualityLabels)
          .map(l => l.replace(/<[^>]*>/g, "").trim())
          .filter(Boolean);
        if (labels.length) qualityInfo = labels.join(", ");
      }
      return { url: streamUrl, title: "FaselHD", quality: qualityInfo };
    }
  }

  console.log("[Extract] Could not capture stream URL");
  return null;
}

// ── Parse master m3u8 into individual quality variants ──
async function parseMasterPlaylist(masterUrl) {
  try {
    const resp = await fetch(masterUrl, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return null;
    const body = await resp.text();
    if (!body.includes("#EXTM3U") || !body.includes("#EXT-X-STREAM-INF")) return null;

    const lines = body.split("\n");
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
      const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/);
      const bwMatch = line.match(/BANDWIDTH=(\d+)/);
      // Next non-empty, non-comment line is the URL
      let url = "";
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (next && !next.startsWith("#")) { url = next; break; }
      }
      if (!url) continue;
      if (!url.startsWith("http")) {
        const base = masterUrl.substring(0, masterUrl.lastIndexOf("/") + 1);
        url = new URL(url, base).href;
      }
      const width = resMatch ? parseInt(resMatch[1]) : 0;
      const height = resMatch ? parseInt(resMatch[2]) : 0;
      const bandwidth = bwMatch ? parseInt(bwMatch[1]) : 0;
      // Try to extract quality from URL (e.g. hd1080b, hd720b, sd360b)
      const urlQMatch = url.match(/(?:hd|sd)(\d{3,4})/i);
      let label = "";
      if (urlQMatch) label = `${urlQMatch[1]}p`;
      else if (width >= 1920) label = "1080p";
      else if (width >= 1280) label = "720p";
      else if (width >= 854) label = "480p";
      else if (width >= 640) label = "360p";
      else if (height) label = `${height}p`;
      variants.push({ url, width, height, bandwidth, label });
    }
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return variants.length > 0 ? variants : null;
  } catch (e) {
    console.log(`[ParseMaster] Error: ${e.message}`);
    return null;
  }
}

// ── Main resolver ──

async function resolve(imdbId, type, season, episode) {
  console.log(`[Resolve] ${type} ${imdbId} S${season || "-"}E${episode || "-"}`);

  // Parallelize IMDB lookup and domain discovery
  const [info] = await Promise.all([
    getImdbInfo(imdbId),
    getDomain(),
  ]);
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

    // Only navigate to season page if we need a DIFFERENT season (season 1 is usually default)
    if (seasons.length > 0 && episodes.length === 0) {
      // No episodes on current page — need to navigate to season
      const match = seasons.find((s) => s.num === sn);
      if (match) {
        console.log(`[Resolve] Season ${sn}: ${match.url}`);
        const seasonPage = await parseSeriesPage(match.url);
        episodes = seasonPage.episodes;
      } else {
        console.log(`[Resolve] Season ${sn} not found in [${seasons.map((s) => s.num).join(",")}]`);
      }
    } else if (seasons.length > 1) {
      // Episodes shown but check if we're on the right season
      const match = seasons.find((s) => s.num === sn);
      if (match) {
        // Check if the current page is already for this season
        const activeMatch = seasons.find((s) => s.num === sn);
        // Only re-fetch if a different season URL
        if (activeMatch && activeMatch.url !== targetUrl) {
          console.log(`[Resolve] Season ${sn}: ${activeMatch.url}`);
          const seasonPage = await parseSeriesPage(activeMatch.url);
          if (seasonPage.episodes.length > 0) episodes = seasonPage.episodes;
        }
      }
    }

    // Find the specific episode
    let epUrl = null;
    const epMatch = episodes.find((e) => e.num === ep);
    if (epMatch) {
      epUrl = epMatch.url;
    } else if (episodes.length >= ep) {
      epUrl = episodes[ep - 1]?.url;
    }

    if (epUrl) {
      console.log(`[Resolve] Episode ${ep}: ${epUrl}`);
      targetUrl = epUrl;
    } else {
      console.log(`[Resolve] Episode ${ep} not found (${episodes.length} episodes available)`);
    }
  }

  // Get player_token URLs from the page
  const players = await getPlayerTokens(targetUrl);

  // Extract streams from all servers
  for (const p of players) {
    const s = await extractStreamFromPlayer(p.url);
    if (s) {
      const serverInfo = [p.quality, p.name].filter(Boolean).join(" | ") || "FaselHD";
      streams.push({ url: s.url, title: serverInfo });
    }
  }

  console.log(`[Resolve] ${streams.length} stream(s)`);
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
    const streams = [];

    for (const s of raw) {
      // Parse master m3u8 to split into individual quality streams
      const variants = await parseMasterPlaylist(s.url);
      if (variants && variants.length > 1) {
        for (const v of variants) {
          const proxiedUrl = `${proxyBase}/proxy/${Buffer.from(v.url).toString('base64url')}/stream.m3u8`;
          if (seen.has(proxiedUrl)) continue;
          seen.add(proxiedUrl);
          const title = [v.label, s.title].filter(Boolean).join(" | ");
          streams.push({
            name: "FaselHD",
            title: title || "FaselHD",
            url: proxiedUrl,
            behaviorHints: { notWebReady: false },
          });
        }
      } else {
        const proxiedUrl = `${proxyBase}/proxy/${Buffer.from(s.url).toString('base64url')}/stream.m3u8`;
        if (!seen.has(proxiedUrl)) {
          seen.add(proxiedUrl);
          streams.push({
            name: "FaselHD",
            title: s.title || "FaselHD",
            url: proxiedUrl,
            behaviorHints: { notWebReady: false },
          });
        }
      }
    }

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
    if (!res.headersSent && !res.writableEnded) {
      console.log(`[TIMEOUT] Request timed out: ${req.url}`);
      try {
        res.writeHead(504, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request timed out" }));
      } catch {}
    }
  }, 120000);
  res.on("finish", () => clearTimeout(requestTimeout));
  res.on("close", () => clearTimeout(requestTimeout));
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

        // Verify we got actual m3u8 content, not an HTML error page
        if (body.includes("<!DOCTYPE") || body.includes("<html") || (!body.includes("#EXTM3U") && !body.includes("#EXT-X"))) {
          console.log(`[Proxy] Upstream returned HTML instead of m3u8 (${body.length} chars)`);
          res.writeHead(502, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
          res.end("Stream expired or unavailable");
          return;
        }

        // Compute base URL for resolving relative paths
        const upstreamBase = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

        // Rewrite absolute URLs
        body = body.replace(/^(https?:\/\/[^\s]+)/gm, (url) => {
          const trimmed = url.trim();
          const ext = trimmed.endsWith('.m3u8') ? 'stream.m3u8' : 'segment.ts';
          return `${proxyBase}/proxy/${Buffer.from(trimmed).toString('base64url')}/${ext}`;
        });

        // Rewrite relative URLs (non-comment, non-empty lines not already absolute)
        body = body.replace(/^(?!#)(?!https?:\/\/)(\S+)/gm, (relPath) => {
          const trimmed = relPath.trim();
          if (!trimmed) return relPath;
          const absUrl = new URL(trimmed, upstreamBase).href;
          const ext = trimmed.endsWith('.m3u8') ? 'stream.m3u8' : 'segment.ts';
          return `${proxyBase}/proxy/${Buffer.from(absUrl).toString('base64url')}/${ext}`;
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
      searchCache: cache.search.size,
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(info, null, 2));
    return;
  }

  // Stremio SDK router — guard against double-response from timeout
  if (res.headersSent || res.writableEnded) return;
  router(req, res, () => {
    if (!res.headersSent) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not Found" }));
    }
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
