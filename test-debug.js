const cheerio = require('cheerio');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function test() {
  const domain = 'https://web3180x.faselhdx.xyz';
  
  // Step 1: Find Interstellar in sitemaps
  for (let i = 1; i <= 8; i++) {
    try {
      const url = `${domain}/movies-sitemap${i}.xml`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': UA },
        redirect: 'manual',
        signal: AbortSignal.timeout(8000)
      });
      if (resp.status !== 200) { console.log(`sitemap ${i}: ${resp.status}`); continue; }
      const xml = await resp.text();
      if (xml.includes('Just a moment')) { console.log(`sitemap ${i}: CF blocked`); continue; }
      const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
      const matches = urls.filter(u => decodeURIComponent(u).toLowerCase().includes('interstellar'));
      if (matches.length > 0) {
        console.log(`Found in sitemap ${i}:`, matches[0]);
        
        // Step 2: Fetch the movie page (plain HTTP, no cookies)
        const pageUrl = matches[0].replace(/https?:\/\/[^\/]+/, domain);
        console.log(`\nFetching page: ${pageUrl}`);
        const pageResp = await fetch(pageUrl, {
          headers: { 'User-Agent': UA },
          signal: AbortSignal.timeout(10000)
        });
        const html = await pageResp.text();
        console.log(`Page: status=${pageResp.status} length=${html.length}`);
        console.log(`CF blocked: ${html.includes('Just a moment')}`);
        
        if (html.includes('Just a moment')) {
          console.log('\n>>> Page is CF-blocked from datacenter. Need Puppeteer or cookies.');
          return;
        }
        
        // Step 3: Find player tokens
        const $ = cheerio.load(html);
        const iframes = [];
        $('iframe').each((_, el) => {
          const src = $(el).attr('data-src') || $(el).attr('src') || '';
          if (src) iframes.push(src.substring(0, 120));
        });
        console.log(`\nIframes (${iframes.length}):`, iframes);
        
        const onclicks = [];
        $('[onclick*="player_token"]').each((_, el) => {
          onclicks.push($(el).attr('onclick').substring(0, 120));
        });
        console.log(`Onclick handlers (${onclicks.length}):`, onclicks);
        
        // Raw regex search for player_token
        const rawHtml = $.html();
        const ptMatches = rawHtml.match(/player_token=[^"'\s&]+/g);
        console.log(`\nRaw player_token matches:`, ptMatches);
        
        return;
      }
    } catch(e) { console.log(`sitemap ${i}: error: ${e.message}`); }
  }
  console.log('Not found in any sitemap');
}

test().catch(console.error);
