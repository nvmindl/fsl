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
  resolve: new Map(), // "type/imdbId:s:e" → { streams[], ts }
  streams: new Map(), // "type/imdbId:s:e" → { json, ts } — /streams/ response cache
};
const IMDB_TTL = 24 * 60 * 60 * 1000;   // 24h
const SEARCH_TTL = 15 * 60 * 1000;        // 15min
const RESOLVE_TTL = 10 * 60 * 1000;       // 10min
const STREAMS_TTL = 5 * 60 * 1000;        // 5min

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
let domainLastCheck = 0; // Always verify domain on first request — env var may be stale
const DOMAIN_TTL = 5 * 60 * 1000; // 5 min — check more often since domains rotate fast
let domainDiscoveryPromise = null;

async function discoverDomain() {
  const t0 = Date.now();

  // Helper: probe a single domain — tests AJAX search endpoint (not just homepage)
  // Homepage can return 200 while AJAX is blocked, so this catches broken domains
  async function probe(domain, ac) {
    const sig = ac ? ac.signal : AbortSignal.timeout(3000);
    try {
      // For the main domain (fasel-hd.cam), GET the root to find the redirect target
      // then AJAX-test that target. CF blocks direct AJAX POSTs to fasel-hd.cam.
      if (domain.includes("fasel-hd.cam")) {
        const mainResp = await fetch(`${domain}/`, {
          redirect: "manual",
          headers: { "User-Agent": UA },
          signal: sig,
        });
        if (mainResp.status === 301 || mainResp.status === 302) {
          const mainLoc = mainResp.headers.get("location") || "";
          const mainM = mainLoc.match(/https?:\/\/web\d+x\.faselhdx\.[a-z]+/);
          if (mainM) {
            const target = mainM[0].replace(/^http:/, "https:");
            const resp2 = await fetch(`${target}/wp-admin/admin-ajax.php`, {
              method: "POST",
              headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
              body: "action=dtc_live&trsearch=test",
              redirect: "manual",
              signal: sig,
            });
            if (resp2.status === 200) return target;
          }
        }
        return null;
      }

      // For regular subdomains, test AJAX directly
      const resp = await fetch(`${domain}/wp-admin/admin-ajax.php`, {
        method: "POST",
        headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
        body: "action=dtc_live&trsearch=test",
        redirect: "manual",
        signal: sig,
      });
      if (resp.status === 200) return domain;
      if (resp.status === 301 || resp.status === 302) {
        const loc = resp.headers.get("location") || "";
        const m = loc.match(/https?:\/\/web\d+x\.faselhdx\.[a-z]+/);
        if (m) {
          const target = m[0].replace(/^http:/, "https:");
          const resp2 = await fetch(`${target}/wp-admin/admin-ajax.php`, {
            method: "POST",
            headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
            body: "action=dtc_live&trsearch=test",
            redirect: "manual",
            signal: sig,
          });
          if (resp2.status === 200) return target;
        }
        // Redirect to fasel-hd.cam? Follow the chain: fasel-hd.cam → working subdomain
        if (loc.includes("fasel-hd.cam")) {
          const mainOrigin = new URL(loc).origin;
          const mainResp = await fetch(`${mainOrigin}/`, {
            redirect: "manual",
            headers: { "User-Agent": UA },
            signal: sig,
          });
          const mainLoc = mainResp.headers?.get("location") || "";
          const mainM = mainLoc.match(/https?:\/\/web\d+x\.faselhdx\.[a-z]+/);
          if (mainM) {
            const mainTarget = mainM[0].replace(/^http:/, "https:");
            const resp3 = await fetch(`${mainTarget}/wp-admin/admin-ajax.php`, {
              method: "POST",
              headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
              body: "action=dtc_live&trsearch=test",
              redirect: "manual",
              signal: sig,
            });
            if (resp3.status === 200) return mainTarget;
          }
        }
      }
    } catch {}
    return null;
  }

  function applyFound(domain) {
    const changed = domain !== activeDomain;
    activeDomain = domain;
    domainLastCheck = Date.now();
    if (changed) { cache.page.clear(); cache.search.clear(); }
    console.log(`[Domain] Resolved: ${domain} (${Date.now() - t0}ms)`);
    return domain;
  }

  // ── Phase 1: Quick check current domain + TLD swap + main domain redirect (parallel, <5s) ──
  const numMatch = activeDomain.match(/web(\d+)x\.faselhdx\.([a-z]+)/);
  const quickCandidates = new Set();
  // Always try the main domain — it redirects to the current working subdomain
  quickCandidates.add(MAIN_DOMAIN);
  if (activeDomain !== MAIN_DOMAIN && activeDomain.includes(DOMAIN_BASE)) {
    quickCandidates.add(activeDomain);
  }
  // Try all TLDs of the current domain number
  if (numMatch) {
    for (const t of ['best', 'xyz', 'top']) {
      quickCandidates.add(`https://web${numMatch[1]}x.${DOMAIN_BASE}.${t}`);
    }
  }
  // Also try known-good domain number 3216 across TLDs (fallback for stale env)
  for (const t of ['best', 'xyz', 'top']) {
    quickCandidates.add(`https://web3216x.${DOMAIN_BASE}.${t}`);
  }

  if (quickCandidates.size) {
    console.log(`[Domain] Quick probing ${quickCandidates.size} candidates...`);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    try {
      const result = await Promise.any(
        [...quickCandidates].map(d => probe(d, ac).then(r => r || Promise.reject()))
      );
      clearTimeout(timer);
      ac.abort();
      return applyFound(result);
    } catch { clearTimeout(timer); }
  }

  // ── Phase 2: Puppeteer fallback — solves CF challenge on fasel-hd.cam ──
  const remaining = 15000 - (Date.now() - t0);
  if (remaining > 3000) {
    console.log(`[Domain] Quick check failed, Puppeteer fallback (${remaining}ms budget)...`);
    try {
      const browser = await getBrowser();
      const page = await browser.newPage();
      try {
        await page.setUserAgent(UA);
        await page.goto(MAIN_DOMAIN, { waitUntil: "domcontentloaded", timeout: Math.min(remaining - 1000, 12000) });

        const content = await page.content();
        if (content.includes("Just a moment") || content.includes("Checking your browser")) {
          await page.waitForFunction(
            () => !document.body.innerHTML.includes("Just a moment") && !document.body.innerHTML.includes("Checking your browser"),
            { timeout: Math.min(remaining - 2000, 8000) }
          ).catch(() => {});
        }

        let foundDomain = null;
        const finalUrl = page.url();
        const m = finalUrl.match(/https?:\/\/web(\d+)x\.faselhdx\.([a-z]+)/);
        if (m) foundDomain = m[0].replace(/^http:/, "https:");

        if (!foundDomain) {
          const html = await page.content();
          const linkMatch = html.match(/https?:\/\/web(\d+)x\.faselhdx\.([a-z]+)/);
          if (linkMatch) foundDomain = linkMatch[0].replace(/^http:/, "https:");
        }

        if (foundDomain) {
          // Puppeteer found a domain — verify AJAX search works
          const numM = foundDomain.match(/web(\d+)x\.faselhdx\.([a-z]+)/);
          if (numM) {
            const domNum = numM[1];
            const foundTld = numM[2];
            // Quick AJAX test on the found domain
            try {
              const testResp = await fetch(`${foundDomain}/wp-admin/admin-ajax.php`, {
                method: "POST",
                headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
                body: "action=dtc_live&trsearch=test",
                redirect: "follow",
                signal: AbortSignal.timeout(5000),
              });
              if (testResp.ok) return applyFound(foundDomain);
            } catch {}
            // AJAX failed — try same number with other TLDs
            console.log(`[Domain] ${foundDomain} AJAX blocked, trying alternate TLDs...`);
            for (const tld of ['top', 'best', 'xyz']) {
              if (tld === foundTld) continue;
              const alt = `https://web${domNum}x.${DOMAIN_BASE}.${tld}`;
              try {
                const altResp = await fetch(`${alt}/wp-admin/admin-ajax.php`, {
                  method: "POST",
                  headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
                  body: "action=dtc_live&trsearch=test",
                  redirect: "follow",
                  signal: AbortSignal.timeout(3000),
                });
                if (altResp.ok) {
                  console.log(`[Domain] Alternate TLD works: ${alt}`);
                  return applyFound(alt);
                }
              } catch {}
            }
            // No TLD has working AJAX — use what Puppeteer found anyway
            return applyFound(foundDomain);
          }
          return applyFound(foundDomain);
        }
      } finally {
        await page.close().catch(() => {});
      }
    } catch (e) {
      console.log(`[Domain] Puppeteer failed: ${e.message}`);
    }
  }

  console.log(`[Domain] Discovery failed after ${Date.now() - t0}ms, using last known`);
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
    // Don't learn CF-protected main domains
    if (u.hostname.includes("fasel-hd.cam") || u.hostname.includes("faselhd.")) return;
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
          // Use manual redirect for ?p= shortlinks to intercept CF-domain redirects
          const isShortlink = /[?&]p=\d+/.test(url);
          const resp = await fetch(url, {
            headers: { ...HEADERS, Referer: url },
            redirect: isShortlink ? "manual" : "follow",
            signal: AbortSignal.timeout(12000),
          });
          if (isShortlink && [301, 302, 303, 307, 308].includes(resp.status)) {
            // Shortlink redirect — rewrite target to working domain (don't mark domain bad)
            const location = resp.headers.get("location");
            if (location) {
              const redirectPath = new URL(location, url).pathname + new URL(location, url).search;
              const domain = activeDomain || MAIN_DOMAIN;
              const rewrittenUrl = `${domain}${redirectPath}`;
              console.log(`[Fetch] Shortlink redirect → rewriting to ${rewrittenUrl}`);
              // Fetch the rewritten URL with redirect follow
              const retryResp = await fetch(rewrittenUrl, {
                headers: { ...HEADERS, Referer: rewrittenUrl },
                redirect: "follow",
                signal: AbortSignal.timeout(12000),
              });
              if (retryResp.ok) {
                learnDomainFromUrl(retryResp.url);
                const retryText = await retryResp.text();
                if (retryText.length > 1000 && !retryText.includes("Just a moment") && !retryText.includes("Checking your browser")) {
                  console.log(`[Fetch] Shortlink rewrite OK (${retryText.length} chars)`);
                  cacheSet(cache.page, url, retryText);
                  return retryText;
                }
              }
            }
          } else if (resp.ok) {
            // Check if we got redirected to a dead/CF domain
            const finalHost = new URL(resp.url).hostname;
            if (finalHost.includes("fasel-hd.cam")) {
              console.log(`[Fetch] Redirected to CF-protected ${finalHost}, re-discovering domain...`);
              markDomainBad();
              const newDomain = await getDomain();
              // Rewrite URL to new domain and retry
              if (newDomain !== MAIN_DOMAIN) {
                const newUrl = url.replace(/https?:\/\/[^/]+/, newDomain);
                if (newUrl !== url) {
                  console.log(`[Fetch] Retrying with new domain: ${newUrl}`);
                  const retryResp = await fetch(newUrl, {
                    headers: { ...HEADERS, Referer: newUrl },
                    redirect: "follow",
                    signal: AbortSignal.timeout(12000),
                  });
                  if (retryResp.ok) {
                    learnDomainFromUrl(retryResp.url);
                    const retryText = await retryResp.text();
                    if (retryText.length > 1000 && !retryText.includes("Just a moment") && !retryText.includes("Checking your browser")) {
                      console.log(`[Fetch] Retry OK (${retryText.length} chars)`);
                      cacheSet(cache.page, newUrl, retryText);
                      return retryText;
                    }
                  }
                }
              }
            } else {
              learnDomainFromUrl(resp.url);
              const text = await resp.text();
              if (text.length > 1000 && !text.includes("Just a moment") && !text.includes("Checking your browser")) {
                console.log(`[Fetch] HTTP follow-redirect OK (${text.length} chars)`);
                cacheSet(cache.page, url, text);
                return text;
              }
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

// ── Website search (AJAX API — FaselHD's /?s= is dead, uses admin-ajax.php) ──
async function searchWebsite(query, domain) {
  try {
    const ajaxUrl = `${domain}/wp-admin/admin-ajax.php`;
    console.log(`[WebSearch] POST ${ajaxUrl} trsearch="${query}"`);
    const resp = await fetch(ajaxUrl, {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
      body: `action=dtc_live&trsearch=${encodeURIComponent(query)}`,
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      console.log(`[WebSearch] HTTP ${resp.status}`);
      if (resp.status === 403 && isFaselUrl(domain)) {
        // Try main domain redirect FIRST — fastest way to find current working domain
        try {
          console.log(`[WebSearch] Checking main domain redirect...`);
          const mainResp = await fetch(`${MAIN_DOMAIN}/`, {
            redirect: "manual",
            headers: { "User-Agent": UA },
            signal: AbortSignal.timeout(5000),
          });
          const mainLoc = mainResp.headers?.get("location") || "";
          const mainM = mainLoc.match(/https?:\/\/web\d+x\.faselhdx\.[a-z]+/);
          if (mainM) {
            const mainDomain = mainM[0].replace(/^http:/, "https:");
            if (mainDomain !== domain) {
              console.log(`[WebSearch] Main domain redirects to ${mainDomain}, trying AJAX...`);
              const mainAjax = await fetch(`${mainDomain}/wp-admin/admin-ajax.php`, {
                method: "POST",
                headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
                body: `action=dtc_live&trsearch=${encodeURIComponent(query)}`,
                redirect: "follow",
                signal: AbortSignal.timeout(8000),
              });
              if (mainAjax.ok) {
                const mainHtml = await mainAjax.text();
                if (mainHtml.length > 50 && !mainHtml.includes("Just a moment")) {
                  console.log(`[WebSearch] Main redirect domain works: ${mainDomain}`);
                  activeDomain = mainDomain;
                  domainLastCheck = Date.now();
                  cache.page.clear(); cache.search.clear();
                  return parseSearchResults(mainHtml);
                }
              }
            }
          }
        } catch (e) { console.log(`[WebSearch] Main domain check failed: ${e.message}`); }

        // Try alternate TLDs of current domain number
        const numM = domain.match(/web(\d+)x\.faselhdx\.([a-z]+)/);
        if (numM) {
          for (const tld of ['best', 'top', 'xyz']) {
            if (tld === numM[2]) continue;
            const altDomain = `https://web${numM[1]}x.${DOMAIN_BASE}.${tld}`;
            try {
              console.log(`[WebSearch] Trying alt TLD: ${altDomain}`);
              const altResp = await fetch(`${altDomain}/wp-admin/admin-ajax.php`, {
                method: "POST",
                headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
                body: `action=dtc_live&trsearch=${encodeURIComponent(query)}`,
                redirect: "follow",
                signal: AbortSignal.timeout(8000),
              });
              if (altResp.ok) {
                const altHtml = await altResp.text();
                if (altHtml.length > 50 && !altHtml.includes("Just a moment")) {
                  console.log(`[WebSearch] Alt TLD works: ${altDomain}`);
                  activeDomain = altDomain;
                  domainLastCheck = Date.now();
                  cache.page.clear(); cache.search.clear();
                  return parseSearchResults(altHtml);
                }
                console.log(`[WebSearch] Alt TLD ${tld}: response too short or CF blocked (${altHtml.length} chars)`);
              } else {
                console.log(`[WebSearch] Alt TLD ${tld}: HTTP ${altResp.status}`);
              }
            } catch (e) { console.log(`[WebSearch] Alt TLD ${tld}: ${e.message}`); }
          }
        }
        // Alt TLDs all failed — full domain rediscovery
        markDomainBad();
        const newDomain = await getDomain();
        if (newDomain !== domain && newDomain !== MAIN_DOMAIN) {
          console.log(`[WebSearch] Retrying on ${newDomain}`);
          const retryResp = await fetch(`${newDomain}/wp-admin/admin-ajax.php`, {
            method: "POST",
            headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
            body: `action=dtc_live&trsearch=${encodeURIComponent(query)}`,
            redirect: "follow",
            signal: AbortSignal.timeout(10000),
          });
          if (retryResp.ok) {
            learnDomainFromUrl(retryResp.url);
            const html = await retryResp.text();
            if (html.length > 50 && !html.includes("Just a moment")) {
              return parseSearchResults(html);
            }
          }
        }
      }
      return [];
    }
    // Check if we got redirected to CF-protected domain
    const finalHost = new URL(resp.url).hostname;
    if (finalHost.includes("fasel-hd.cam")) {
      console.log(`[WebSearch] Redirected to CF-protected ${finalHost}, re-discovering...`);
      markDomainBad();
      const newDomain = await getDomain();
      if (newDomain !== MAIN_DOMAIN) {
        console.log(`[WebSearch] Retrying on ${newDomain}`);
        const retryResp = await fetch(`${newDomain}/wp-admin/admin-ajax.php`, {
          method: "POST",
          headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
          body: `action=dtc_live&trsearch=${encodeURIComponent(query)}`,
          redirect: "follow",
          signal: AbortSignal.timeout(15000),
        });
        if (retryResp.ok) {
          learnDomainFromUrl(retryResp.url);
          const html = await retryResp.text();
          if (html.length > 50 && !html.includes("Just a moment")) {
            return parseSearchResults(html);
          }
        }
      }
      return [];
    }
    learnDomainFromUrl(resp.url);
    const html = await resp.text();
    if (html.includes("Just a moment") || html.includes("Checking your browser")) {
      console.log("[WebSearch] CF blocked, will try browser fallback");
      return [];
    }
    // "لا يوجد نتائج" = "No results" — don't try to parse
    if (html.length < 50) return [];
    return parseSearchResults(html);
  } catch (err) {
    console.error(`[WebSearch] ${err.message}`);
    return [];
  }
}

// ── Browser-based search (fallback when HTTP is CF-blocked) ──
async function searchViaBrowser(query, domain) {
  try {
    // Use Puppeteer to navigate to the search page and extract AJAX results
    const searchUrl = `${domain}/search/${encodeURIComponent(query)}`;
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
  // FaselHD content URL patterns
  const contentPat = /\/(movies|seasons|series|anime|hindi|asian-series|asian-movies|anime-movies|anime-episodes|asian-episodes|episodes)\//;
  // Find all links pointing to content pages
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    if (href && contentPat.test(href)) {
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

  // If website search failed, refresh domain — it may have been re-discovered
  if (!results.length) {
    const freshDomain = await getDomain();
    if (freshDomain !== domain) {
      console.log(`[Search] Domain changed to ${freshDomain}, retrying website search`);
      domain = freshDomain;
      results = await searchWebsite(query, domain);
    }
  }

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

  // NO browser fallback here — it's too slow per-query.
  // Browser search is only used as final fallback in resolve() with the best query.

  // Filter by type
  if (results.length > 0) {
    if (type === "movie") {
      const f = results.filter((r) => r.url.includes("/movies/") || r.url.includes("/hindi/") || r.url.includes("/asian-movies/") || r.url.includes("/anime-movies/"));
      if (f.length) results = f;
    } else if (type === "series") {
      const f = results.filter((r) => r.url.includes("/seasons/") || r.url.includes("/series/") || r.url.includes("/anime/") || r.url.includes("/asian-series/") || r.url.includes("/episodes/") || r.url.includes("/anime-episodes/") || r.url.includes("/asian-episodes/"));
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

// Extract season number from title/URL text (supports Arabic ordinals and digits)
function extractSeasonNum(text) {
  const arabicOrdinals = {
    'الأول': 1, 'الاول': 1, 'الثاني': 2, 'الثانى': 2, 'الثالث': 3, 'الرابع': 4,
    'الخامس': 5, 'السادس': 6, 'السابع': 7, 'الثامن': 8, 'التاسع': 9, 'العاشر': 10,
  };
  const decoded = decodeURIComponent(text);
  // Check Arabic ordinals
  for (const [word, num] of Object.entries(arabicOrdinals)) {
    if (decoded.includes(word)) return num;
  }
  // Check for digit patterns like "الموسم 3", "Season 3", "S03"
  const mDigit = decoded.match(/(?:الموسم|الجزء|season|الموسم)\s*(\d+)/i) || decoded.match(/\bS0?(\d+)\b/i);
  if (mDigit) return parseInt(mDigit[1]);
  return 0;
}

// Pick the right search result for a given season number (for anime-style separate entries)
function pickSeasonResult(results, seasonNum) {
  // Score each result by how well it matches the requested season
  const scored = results.map(r => {
    const combined = `${r.title} ${r.url}`;
    const num = extractSeasonNum(combined);
    return { ...r, seasonNum: num };
  }).filter(r => r.seasonNum > 0);

  if (scored.length === 0) return null;
  const exact = scored.find(r => r.seasonNum === seasonNum);
  if (exact) return exact;
  return null;
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

// Filter search results by relevance to the actual title
function filterResultsByRelevance(results, title, year) {
  if (results.length <= 1) return results;

  // Build slug variants of the title to match against URLs
  const titleSlug = slugify(title); // e.g. "the-oc"
  const cleanedSlug = slugify(title.replace(/[.]/g, "")); // e.g. "the-oc"
  const noTheSlug = slugify(title.replace(/^the\s+/i, "").replace(/[.]/g, "")); // e.g. "oc"
  const words = titleSlug.split("-").filter(w => w.length > 1); // significant words

  const scored = results.map(r => {
    const decoded = decodeURIComponent(r.url).toLowerCase();
    let score = 0;

    // Exact slug match in URL (strongest signal)
    if (decoded.includes(titleSlug)) score += 100;
    if (cleanedSlug !== titleSlug && decoded.includes(cleanedSlug)) score += 90;
    if (noTheSlug !== cleanedSlug && decoded.includes(noTheSlug)) score += 80;

    // Year match
    if (year && decoded.includes(String(year))) score += 20;

    // Individual word matches (weaker)
    for (const w of words) {
      if (decoded.includes(w)) score += 5;
    }

    return { ...r, score };
  });

  // Only keep results with score > 0 (at least some relevance)
  const relevant = scored.filter(r => r.score > 0);
  if (relevant.length === 0) return results; // fallback to unfiltered if nothing matches

  // Sort by score descending
  relevant.sort((a, b) => b.score - a.score);
  console.log(`[Filter] ${results.length} → ${relevant.length} relevant (top: ${decodeURIComponent(relevant[0].url).substring(relevant[0].url.lastIndexOf("/") + 1, relevant[0].url.lastIndexOf("/") + 60)} score=${relevant[0].score})`);
  return relevant;
}

// ── Main resolver ──

async function resolve(imdbId, type, season, episode) {
  const resolveKey = `${type}/${imdbId}:${season || ""}:${episode || ""}`;
  const cachedResolve = cacheGet(cache.resolve, resolveKey, RESOLVE_TTL);
  if (cachedResolve) {
    console.log(`[Resolve] Cache hit: ${resolveKey} (${cachedResolve.length} streams)`);
    return cachedResolve;
  }
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
  // Order: main title first (most likely to match), then full, then cleaned, then subtitle
  const queries = [];
  const parts = info.title.split(/[:\-–—]\s*/);
  if (parts.length > 1) {
    queries.push(parts[0].trim()); // main title before colon/dash (e.g. "Peaky Blinders")
  }
  queries.push(info.title); // full original title
  // Strip only trailing punctuation (e.g. "The O.C." → "The O.C" — FaselHD needs internal periods)
  const noTrailing = info.title.replace(/[.!?]+$/, "").trim();
  if (noTrailing !== info.title && !queries.includes(noTrailing)) queries.push(noTrailing);
  // Strip special characters (including periods — e.g. "The O.C." → "The OC")
  const cleaned = info.title.replace(/[''`:;,!?.]/g, "").replace(/\s+/g, " ").trim();
  if (cleaned !== info.title && !queries.includes(cleaned)) queries.push(cleaned);
  // Try periods → spaces (e.g. "The O.C." → "The O C" → search matches "o-c" slug)
  const spaceDots = info.title.replace(/\./g, " ").replace(/\s+/g, " ").trim();
  if (spaceDots !== info.title && !queries.includes(spaceDots)) queries.push(spaceDots);
  // Strip leading "The " — FaselHD often omits it (e.g. "The O.C." → "OC")
  const noThe = cleaned.replace(/^the\s+/i, "").trim();
  if (noThe && noThe !== cleaned && !queries.includes(noThe)) queries.push(noThe);
  // Also try noThe with dots→spaces (e.g. "O C")
  const noTheDots = spaceDots.replace(/^the\s+/i, "").trim();
  if (noTheDots && noTheDots !== noThe && !queries.includes(noTheDots)) queries.push(noTheDots);
  if (parts.length > 1) {
    const subtitle = parts[parts.length - 1].trim();
    if (!queries.includes(subtitle)) queries.push(subtitle); // subtitle
  }

  let results = [];
  for (const q of queries) {
    results = await searchFasel(q, info.year, type);
    if (results.length > 0) {
      results = filterResultsByRelevance(results, info.title, info.year);
      if (results.length > 0) break;
    }
    if (info.year) {
      results = await searchFasel(`${q} ${info.year}`, info.year, type);
      if (results.length > 0) {
        results = filterResultsByRelevance(results, info.title, info.year);
        if (results.length > 0) break;
      }
    }
  }

  // Final fallback: browser search with the main title (only if everything else failed)
  if (results.length === 0) {
    const domain = await getDomain();
    const bestQuery = parts.length > 1 ? parts[0].trim() : info.title;
    console.log(`[Resolve] All HTTP searches failed, browser fallback: "${bestQuery}"`);
    results = await searchViaBrowser(bestQuery, domain);
    // Filter by type AND relevance
    if (results.length > 0) {
      results = filterResultsByRelevance(results, info.title, info.year);
      if (results.length > 0) {
        if (type === "movie") {
          const f = results.filter(r => r.url.includes("/movies/") || r.url.includes("/hindi/") || r.url.includes("/asian-movies/") || r.url.includes("/anime-movies/"));
          if (f.length) results = f;
        } else if (type === "series") {
          const f = results.filter(r => r.url.includes("/seasons/") || r.url.includes("/series/") || r.url.includes("/anime/") || r.url.includes("/asian-series/") || r.url.includes("/episodes/"));
          if (f.length) results = f;
        }
      }
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

    // For anime/shows with separate entries per season, pick the right one
    let pickedFromSearch = false;
    if (results.length > 1) {
      const seasonResult = pickSeasonResult(results, sn);
      if (seasonResult) {
        console.log(`[Resolve] Matched season ${sn} from search results: ${seasonResult.url}`);
        targetUrl = seasonResult.url;
        pickedFromSearch = true;
      }
    }

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
    } else if (seasons.length > 1 && !pickedFromSearch) {
      // Episodes shown but check if we're on the right season
      // Skip if we already picked the correct season page from search results
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
    } else if (pickedFromSearch && episodes.length > 0) {
      console.log(`[Resolve] Using ${episodes.length} episodes from search-matched season page`);
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

  // Extract streams from all servers IN PARALLEL
  const extractions = await Promise.allSettled(
    players.map(p => extractStreamFromPlayer(p.url).then(s => s ? { url: s.url, title: [p.quality, p.name].filter(Boolean).join(" | ") || "FaselHD" } : null))
  );
  for (const r of extractions) {
    if (r.status === "fulfilled" && r.value) streams.push(r.value);
  }

  console.log(`[Resolve] ${streams.length} stream(s)`);
  if (streams.length > 0) cacheSet(cache.resolve, resolveKey, streams);
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

// Play session cache for /play/ endpoint
const playCache = {};
const playResolving = {};
// Dedup concurrent /streams/ requests — second request waits for first
const streamsResolving = {};
// Clean up expired sessions every 5 minutes (sessions live 30 min)
setInterval(() => {
  const now = Date.now();
  for (const key of Object.keys(playCache)) {
    if (now - playCache[key].created > 30 * 60 * 1000) {
      delete playCache[key];
      console.log(`[Play] Expired session: ${key}`);
    }
  }
}, 5 * 60 * 1000);

// Helper: fetch a variant m3u8 from CDN and parse segment URLs
async function fetchSegments(variantUrl) {
  const resp = await fetch(variantUrl, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`CDN returned ${resp.status}`);
  const body = await resp.text();
  if (!body.includes("#EXTM3U")) throw new Error("Invalid m3u8");
  const base = variantUrl.substring(0, variantUrl.lastIndexOf("/") + 1);
  const segments = [];
  const rewrittenLines = [];
  let segIdx = 0;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      rewrittenLines.push(trimmed);
      continue;
    }
    const absUrl = trimmed.startsWith("http") ? trimmed : new URL(trimmed, base).href;
    segments.push(absUrl);
    rewrittenLines.push(`s/${segIdx}.ts`);
    segIdx++;
  }
  return { m3u8: rewrittenLines.join("\n"), segments };
}

const server = http.createServer(async (req, res) => {
  // CORS — support Range header for seek
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

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
    const allowed = ['scdns.io', 'faselhdx.best', 'faselhdx.xyz', 'faselhdx.top', 'fasel-hd.cam', 'faselhd.club'];
    let hostname;
    try { hostname = new URL(targetUrl).hostname; } catch { hostname = ''; }
    if (!allowed.some(d => hostname.endsWith(d))) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Domain not allowed");
      return;
    }

    try {
      const proxyBase = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || `http://localhost:${PORT}`;

      // Forward Range header from client for seek support
      const upHeaders = { "User-Agent": UA };
      if (req.headers.range) upHeaders["Range"] = req.headers.range;

      const upstream = await fetch(targetUrl, {
        headers: upHeaders,
        signal: AbortSignal.timeout(30000),
      });

      if (!upstream.ok && upstream.status !== 206) {
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

      // For .ts segments or other binary data, pipe through with seek support
      const headers = {
        "Content-Type": ct || "application/octet-stream",
        "Access-Control-Allow-Origin": "*",
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600",
      };
      const cl = upstream.headers.get("content-length");
      if (cl) headers["Content-Length"] = cl;
      const cr = upstream.headers.get("content-range");
      if (cr) headers["Content-Range"] = cr;
      const statusCode = upstream.status; // 200 or 206
      if (res.headersSent) return;
      res.writeHead(statusCode, headers);

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

  // ── /play/ endpoint — short-URL HLS for external players ──
  // Format: /play/:type/:imdbId[:season:episode]/:qualityIndex/master.m3u8
  //         /play/:type/:imdbId[:season:episode]/:qualityIndex/s/:segNum.ts
  const playMatch = req.url.match(/^\/play\/([^/]+)\/([^/]+)\/(\d+)\/(master\.m3u8|s\/(\d+)\.ts)$/);
  if (playMatch) {
    const [, pType, pId, pQuality, pPath, pSegNum] = playMatch;
    const sessionKey = `${pType}/${pId}/${pQuality}`;

    // Lazily resolve and cache sessions
    if (!playCache[sessionKey]) {
      if (playResolving[sessionKey]) {
        // Another request is already resolving — wait for it
        await playResolving[sessionKey];
      } else {
        console.log(`[Play] Resolving: ${sessionKey}`);
        const parts = pId.split(":");
        const imdbId = parts[0];
        const season = parts[1] || null;
        const episode = parts[2] || null;
        playResolving[sessionKey] = (async () => {
          try {
            const raw = await resolve(imdbId, pType, season, episode);
            const qi = parseInt(pQuality);
            if (!raw.length) throw new Error("No streams found");

            // For each raw stream, fetch the master m3u8 to get quality variants
            let targetUrl = null;
            let allVariants = [];
            for (const s of raw) {
              const variants = await parseMasterPlaylist(s.url);
              if (variants && variants.length > 0) {
                for (const v of variants) {
                  allVariants.push({ url: v.url, label: v.label, title: s.title });
                }
              } else {
                allVariants.push({ url: s.url, label: "auto", title: s.title });
              }
            }

            if (qi >= allVariants.length) throw new Error("Quality index out of range");
            targetUrl = allVariants[qi].url;

            const { m3u8, segments } = await fetchSegments(targetUrl);
            playCache[sessionKey] = {
              variantUrl: targetUrl,
              m3u8,
              segments,
              created: Date.now(),
              segmentsFetched: Date.now(),
            };
          } catch (err) {
            console.error(`[Play] Resolve error: ${err.message}`);
          }
          delete playResolving[sessionKey];
        })();
        await playResolving[sessionKey];
      }
    }

    const session = playCache[sessionKey];
    if (!session) {
      if (!res.headersSent) {
        res.writeHead(503, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
        res.end("Stream not available");
      }
      return;
    }

    // Extend TTL on access
    session.created = Date.now();

    if (pPath === "master.m3u8") {
      // Proactively refresh segment URLs if older than 3 minutes
      if (session.variantUrl && Date.now() - session.segmentsFetched > 3 * 60 * 1000) {
        try {
          console.log(`[Play] Refreshing stale segments: ${sessionKey}`);
          const fresh = await fetchSegments(session.variantUrl);
          session.m3u8 = fresh.m3u8;
          session.segments = fresh.segments;
          session.segmentsFetched = Date.now();
        } catch (err) {
          console.error(`[Play] Segment refresh failed: ${err.message}`);
          // Serve stale if refresh fails — better than nothing
        }
      }
      if (!res.headersSent) {
        res.writeHead(200, {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache",
        });
        res.end(session.m3u8);
      }
      return;
    }

    // Segment request
    const segIdx = parseInt(pSegNum);
    if (segIdx >= session.segments.length) {
      if (!res.headersSent) {
        res.writeHead(404, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
        res.end("Segment not found");
      }
      return;
    }

    try {
      let segUrl = session.segments[segIdx];
      const segHeaders = { "User-Agent": UA };
      if (req.headers.range) segHeaders["Range"] = req.headers.range;
      let upstream = await fetch(segUrl, {
        headers: segHeaders,
        signal: AbortSignal.timeout(30000),
      });

      // CDN 403 = expired tokens — refresh segment URLs and retry once
      if (upstream.status === 403 && session.variantUrl) {
        console.log(`[Play] CDN 403 on segment ${segIdx}, refreshing tokens...`);
        try {
          const fresh = await fetchSegments(session.variantUrl);
          session.m3u8 = fresh.m3u8;
          session.segments = fresh.segments;
          session.segmentsFetched = Date.now();
          if (segIdx < session.segments.length) {
            segUrl = session.segments[segIdx];
            const retryHeaders = { "User-Agent": UA };
            if (req.headers.range) retryHeaders["Range"] = req.headers.range;
            upstream = await fetch(segUrl, {
              headers: retryHeaders,
              signal: AbortSignal.timeout(30000),
            });
          }
        } catch (refreshErr) {
          console.error(`[Play] Token refresh failed: ${refreshErr.message}`);
          // Delete session so next m3u8 request triggers full re-resolution
          delete playCache[sessionKey];
        }
      }

      if (!upstream.ok) {
        // Return 503 instead of 403 so ExoPlayer may retry
        const code = upstream.status === 403 ? 503 : upstream.status;
        if (!res.headersSent) {
          res.writeHead(code, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
          res.end(`Upstream: ${upstream.status}`);
        }
        return;
      }
      const headers = {
        "Content-Type": upstream.headers.get("content-type") || "video/MP2T",
        "Access-Control-Allow-Origin": "*",
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600",
      };
      const cl = upstream.headers.get("content-length");
      if (cl) headers["Content-Length"] = cl;
      const cr = upstream.headers.get("content-range");
      if (cr) headers["Content-Range"] = cr;
      const statusCode = upstream.status; // 200 or 206
      if (res.headersSent) return;
      res.writeHead(statusCode, headers);
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
        res.end(`Proxy error: ${err.message}`);
      }
    }
    return;
  }

  // ── /streams/ endpoint — returns available quality variants for Nuvio ──
  const streamsMatch = req.url.match(/^\/streams\/([^/]+)\/([^/]+)\.json$/);
  if (streamsMatch) {
    const [, sType, sId] = streamsMatch;
    const parts = sId.split(":");
    const imdbId = parts[0];
    const season = parts[1] || null;
    const episode = parts[2] || null;

    const streamsCacheKey = `${sType}/${sId}`;

    // Check /streams/ response cache first
    const cachedStreams = cacheGet(cache.streams, streamsCacheKey, STREAMS_TTL);
    if (cachedStreams) {
      console.log(`[Streams] Cache hit: ${streamsCacheKey}`);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(cachedStreams);
      return;
    }

    // Dedup: if another request is already resolving this, wait for it
    if (streamsResolving[streamsCacheKey]) {
      console.log(`[Streams] Waiting for in-flight: ${streamsCacheKey}`);
      try {
        await streamsResolving[streamsCacheKey];
      } catch {}
      if (res.headersSent) return;
      const cached2 = cacheGet(cache.streams, streamsCacheKey, STREAMS_TTL);
      if (cached2) {
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(cached2);
        return;
      }
    }

    // This request owns the resolution
    streamsResolving[streamsCacheKey] = (async () => {
      console.log(`[Streams] ${sType} ${sId}`);
      const raw = await resolve(imdbId, sType, season, episode);
      const proxyBase = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || `http://localhost:${PORT}`;

      // Collect all variants — parse master playlists IN PARALLEL
      const masterResults = await Promise.allSettled(
        raw.map(s => parseMasterPlaylist(s.url).then(variants => ({ variants, title: s.title, url: s.url })))
      );
      const allVariants = [];
      for (const r of masterResults) {
        if (r.status !== "fulfilled") continue;
        const { variants, title, url } = r.value;
        if (variants && variants.length > 0) {
          for (const v of variants) allVariants.push({ url: v.url, label: v.label, title });
        } else {
          allVariants.push({ url, label: "auto", title });
        }
      }

      // Pre-cache play sessions in background — so /play/ serves instantly
      const streams = [];
      for (let qi = 0; qi < allVariants.length; qi++) {
        const v = allVariants[qi];
        streams.push({
          name: "FaselHD",
          title: [v.label, v.title].filter(Boolean).join(" | "),
          url: `${proxyBase}/play/${sType}/${sId}/${qi}/master.m3u8`,
        });
        const sessionKey = `${sType}/${sId}/${qi}`;
        if (!playCache[sessionKey]) {
          const variantUrl = v.url;
          fetchSegments(variantUrl).then(fresh => {
            playCache[sessionKey] = {
              variantUrl,
              m3u8: fresh.m3u8,
              segments: fresh.segments,
              created: Date.now(),
              segmentsFetched: Date.now(),
            };
            console.log(`[Streams] Pre-cached: ${sessionKey} (${fresh.segments.length} segments)`);
          }).catch(err => {
            console.error(`[Streams] Pre-cache failed for ${sessionKey}: ${err.message}`);
          });
        }
      }

      const jsonBody = JSON.stringify({ streams });
      if (streams.length > 0) cacheSet(cache.streams, streamsCacheKey, jsonBody);
      return jsonBody;
    })().finally(() => {
      delete streamsResolving[streamsCacheKey];
    });

    try {
      const jsonBody = await streamsResolving[streamsCacheKey];
      if (!res.headersSent) {
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(jsonBody);
      }
    } catch (err) {
      console.error(`[Streams] Error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ streams: [] }));
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

  // Self-ping keepalive — prevents Render free tier cold starts
  const selfUrl = process.env.RENDER_EXTERNAL_URL;
  if (selfUrl) {
    setInterval(() => {
      fetch(`${selfUrl}/manifest.json`, { signal: AbortSignal.timeout(10000) })
        .then(() => console.log("[Keepalive] ping OK"))
        .catch(() => {});
    }, 10 * 60 * 1000); // every 10 min
    console.log(`  Keepalive: every 10min → ${selfUrl}`);
  }
});

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  process.exit(0);
});
