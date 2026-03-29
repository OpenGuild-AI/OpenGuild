// Headless Browser Tool — Puppeteer/Chromium for agents
// Full JS rendering, screenshots, content extraction
import puppeteer from 'puppeteer';

let browserInstance = null;
let lastUsed = 0;
const IDLE_TIMEOUT = 5 * 60 * 1000; // close browser after 5min idle

// Lazy browser singleton — reuse across calls, auto-close when idle
async function getBrowser() {
  if (browserInstance?.connected) {
    lastUsed = Date.now();
    return browserInstance;
  }

  console.log('[Browser] Launching Chromium...');
  browserInstance = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--no-first-run',
      '--disable-translate',
      '--single-process'
    ]
  });
  lastUsed = Date.now();

  // Auto-close after idle timeout
  const idleCheck = setInterval(() => {
    if (Date.now() - lastUsed > IDLE_TIMEOUT && browserInstance?.connected) {
      console.log('[Browser] Idle timeout — closing Chromium');
      browserInstance.close().catch(() => {});
      browserInstance = null;
      clearInterval(idleCheck);
    }
  }, 30000);

  return browserInstance;
}

// ── Browse a URL — full JS rendering, extract text content ──
export async function browse(url, opts = {}) {
  const timeout = opts.timeout || 15000;
  const maxChars = opts.maxChars || 8000;
  const waitFor = opts.waitFor || 'networkidle2';

  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    // Block heavy resources to speed up
    await page.setRequestInterception(true);
    page.on('request', req => {
      const type = req.resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    await page.goto(url, { waitUntil: waitFor, timeout });

    // Extract main text content
    const content = await page.evaluate(() => {
      // Try semantic elements first
      const article = document.querySelector('article') || document.querySelector('[role="main"]') || document.querySelector('main');
      if (article) return article.innerText;

      // Fallback: body minus nav/footer/aside
      const body = document.body.cloneNode(true);
      body.querySelectorAll('nav, footer, aside, header, script, style, [role="navigation"], [role="banner"], [role="contentinfo"]')
        .forEach(el => el.remove());
      return body.innerText;
    });

    // Get page title and meta description
    const title = await page.title();
    const metaDesc = await page.evaluate(() => {
      const meta = document.querySelector('meta[name="description"]') || document.querySelector('meta[property="og:description"]');
      return meta?.content || '';
    });

    // Get all links on the page (useful for further crawling)
    const links = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href]'))
        .map(a => ({ text: a.innerText.trim().slice(0, 80), href: a.href }))
        .filter(l => l.text.length > 3 && l.href.startsWith('http'))
        .slice(0, 20);
    });

    await page.close();

    const cleanContent = content
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxChars);

    console.log(`[Browser] Browsed ${url}: ${cleanContent.length} chars, ${links.length} links`);

    return {
      url,
      title,
      description: metaDesc,
      content: cleanContent,
      links,
      success: true
    };
  } catch (e) {
    console.error(`[Browser] Error browsing ${url}:`, e.message);
    if (page) await page.close().catch(() => {});
    return { url, title: '', description: '', content: '', links: [], success: false, error: e.message };
  }
}

// ── Search DuckDuckGo with full JS rendering ──
// Better than HTML POST when DDG returns JS-heavy pages
export async function searchDDGBrowser(query, maxResults = 5) {
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    await page.goto(`https://duckduckgo.com/?q=${encodeURIComponent(query)}`, {
      waitUntil: 'networkidle2',
      timeout: 15000
    });

    // Wait for results to load
    await page.waitForSelector('[data-testid="result"]', { timeout: 8000 }).catch(() => {});

    // Extract results
    const results = await page.evaluate((max) => {
      const items = document.querySelectorAll('[data-testid="result"]');
      const results = [];
      for (const item of items) {
        if (results.length >= max) break;
        const link = item.querySelector('a[data-testid="result-title-a"]') || item.querySelector('a[href^="http"]');
        const snippet = item.querySelector('[data-result="snippet"]') || item.querySelector('.result__snippet');
        if (link?.href) {
          results.push({
            title: link.innerText?.trim() || '',
            url: link.href,
            description: snippet?.innerText?.trim()?.slice(0, 200) || ''
          });
        }
      }
      return results;
    }, maxResults);

    await page.close();
    console.log(`[Browser] DDG search "${query}": ${results.length} results`);

    return results.map(r => ({ ...r, source: 'ddg-browser' }));
  } catch (e) {
    console.error(`[Browser] DDG search error:`, e.message);
    if (page) await page.close().catch(() => {});
    return [];
  }
}

// ── Google Search with full JS rendering ──
export async function searchGoogleBrowser(query, maxResults = 5) {
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}&num=${maxResults}&hl=en`, {
      waitUntil: 'networkidle2',
      timeout: 15000
    });

    // Handle consent page (common in EU)
    const consentBtn = await page.$('button[id="L2AGLb"]');
    if (consentBtn) {
      await consentBtn.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => {});
    }

    // Extract search results
    const results = await page.evaluate((max) => {
      const results = [];
      // Google uses various selectors for results
      const containers = document.querySelectorAll('#search .g, #rso .g');
      for (const g of containers) {
        if (results.length >= max) break;
        const link = g.querySelector('a[href^="http"]');
        const title = g.querySelector('h3');
        const snippet = g.querySelector('.VwiC3b, [data-snf], .IsZvec');
        if (link?.href && title) {
          results.push({
            title: title.innerText?.trim() || '',
            url: link.href,
            description: snippet?.innerText?.trim()?.slice(0, 200) || ''
          });
        }
      }
      return results;
    }, maxResults);

    await page.close();
    console.log(`[Browser] Google search "${query}": ${results.length} results`);

    return results.map(r => ({ ...r, source: 'google-browser' }));
  } catch (e) {
    console.error(`[Browser] Google search error:`, e.message);
    if (page) await page.close().catch(() => {});
    return [];
  }
}

// ── Screenshot a page (returns base64 PNG) ──
export async function screenshot(url, opts = {}) {
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36');
    await page.setViewport({ width: opts.width || 1280, height: opts.height || 800 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });

    const buffer = await page.screenshot({ type: 'png', fullPage: opts.fullPage || false });
    await page.close();

    return { success: true, data: buffer.toString('base64'), mimeType: 'image/png' };
  } catch (e) {
    if (page) await page.close().catch(() => {});
    return { success: false, error: e.message };
  }
}

// ── Cleanup — call on process exit ──
export async function closeBrowser() {
  if (browserInstance?.connected) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
    console.log('[Browser] Closed');
  }
}
