// Shared Agent Tools — Web Search, Page Fetch, Fact Verification
// No API keys needed — uses DDG HTML POST + Wikipedia + Chromium browser fallback
import { callKimi } from './kimi.js';
import { browse, searchDDGBrowser, searchGoogleBrowser } from './browser.js';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── Web Search — cascading: DDG HTML POST → Wikipedia → Chromium DDG → Chromium Google ──
export async function webSearch(query, opts = {}) {
  const maxResults = opts.maxResults || 5;
  let results = [];

  // Strategy 1: DuckDuckGo HTML POST (fast, no browser needed)
  results = await searchDDG(query, maxResults);
  if (results.length >= 2) {
    console.log(`[Tools] DDG HTML search: ${results.length} results for "${query}"`);
    return results;
  }

  // Strategy 2: Wikipedia search API (always works for entities/facts)
  const wikiResults = await searchWikipedia(query, maxResults);
  results = [...results, ...wikiResults];
  if (results.length >= 2) {
    console.log(`[Tools] DDG+Wiki search: ${results.length} results for "${query}"`);
    return dedup(results).slice(0, maxResults);
  }

  // Strategy 3: DuckDuckGo via Chromium (full JS rendering)
  try {
    const browserResults = await searchDDGBrowser(query, maxResults);
    results = [...results, ...browserResults];
    if (results.length >= 2) {
      console.log(`[Tools] Browser DDG search: ${results.length} results for "${query}"`);
      return dedup(results).slice(0, maxResults);
    }
  } catch (e) { console.error('[Tools] Browser DDG fallback error:', e.message); }

  // Strategy 4: Google via Chromium (last resort)
  try {
    const googleResults = await searchGoogleBrowser(query, maxResults);
    results = [...results, ...googleResults];
  } catch (e) { console.error('[Tools] Browser Google fallback error:', e.message); }

  console.log(`[Tools] Full cascade search: ${results.length} results for "${query}"`);
  return dedup(results).slice(0, maxResults);
}

// DuckDuckGo HTML search — POST form submission
async function searchDDG(query, max = 5) {
  try {
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA
      },
      body: `q=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) return [];
    const html = await res.text();

    const results = [];
    // DDG HTML uses class="result__a" for result links
    const regex = /class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs;
    let match;
    while ((match = regex.exec(html)) && results.length < max) {
      const url = match[1].trim();
      const title = match[2].replace(/<[^>]+>/g, '').trim();
      if (url.startsWith('http') && title.length > 3) {
        results.push({ title, url, description: '', source: 'ddg' });
      }
    }

    // Also grab snippets if available
    if (results.length) {
      const snippetRegex = /class="result__snippet"[^>]*>(.*?)<\/a>/gs;
      let si = 0;
      while ((match = snippetRegex.exec(html)) && si < results.length) {
        results[si].description = match[1].replace(/<[^>]+>/g, '').trim().slice(0, 200);
        si++;
      }
    }

    return results;
  } catch (e) {
    console.error('[Tools] DDG search error:', e.message);
    return [];
  }
}

// Wikipedia search API — no auth, always reliable
async function searchWikipedia(query, max = 3) {
  try {
    const res = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${max}&srprop=snippet`,
      { headers: { 'User-Agent': 'OpenGuild/1.0 (research bot)' }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.query?.search || []).map(r => ({
      title: r.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
      description: (r.snippet || '').replace(/<[^>]+>/g, '').slice(0, 200),
      source: 'wikipedia'
    }));
  } catch (e) {
    console.error('[Tools] Wikipedia search error:', e.message);
    return [];
  }
}

// Dedup by URL
function dedup(results) {
  const seen = new Set();
  return results.filter(r => {
    const key = r.url.replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Fetch and extract text from URL ──
// Tries fast HTTP fetch first, falls back to Chromium for JS-heavy sites
export async function fetchPage(url, opts = {}) {
  const useBrowser = opts.useBrowser || false;

  // Fast path: direct HTTP fetch
  if (!useBrowser) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(12000),
        redirect: 'follow'
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();

      const clean = extractText(html);
      // If we got very little content, it might be a JS-rendered page
      if (clean.length > 200) return clean;
    } catch (e) {
      // Fall through to browser
    }
  }

  // Slow path: Chromium rendering (handles JS-heavy sites, paywalls, SPAs)
  try {
    const result = await browse(url, { maxChars: 8000 });
    if (result.success && result.content.length > 100) {
      return result.content;
    }
  } catch (e) {
    console.error('[Tools] Browser fetchPage error:', e.message);
  }

  return '';
}

// Extract text from HTML string
function extractText(html) {
  let text = html;
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '');
  text = text.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  const articleMatch = text.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const mainMatch = text.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const content = articleMatch?.[1] || mainMatch?.[1] || text;

  return content
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000);
}

// ── Get Wikipedia article content (clean, structured) ──
export async function fetchWikipedia(title) {
  try {
    const res = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=extracts&exintro=false&explaintext=true&format=json&exsectionformat=plain`,
      { headers: { 'User-Agent': 'OpenGuild/1.0' }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return '';
    const data = await res.json();
    const pages = data.query?.pages || {};
    const page = Object.values(pages)[0];
    return (page?.extract || '').slice(0, 6000);
  } catch (e) { return ''; }
}

// ── Verify a claim against web sources ──
export async function verifyFact(claim, context = '') {
  // Step 1: Generate a search query from the claim
  const queryResult = await callKimi(
    'Generate a single web search query to verify this claim. Output ONLY the query, nothing else.',
    `Claim: "${claim}"\nContext: ${context || 'none'}`,
    { maxTokens: 50, temperature: 0.3 }
  );

  const searchQuery = queryResult?.text?.trim() || claim;

  // Step 2: Search the web
  const results = await webSearch(searchQuery);
  if (!results.length) {
    return { verified: false, confidence: 'low', sources: [], reasoning: 'No web sources found to verify this claim.' };
  }

  // Step 3: Fetch top 2-3 results (prefer Wikipedia for factual claims)
  const sources = [];
  const wikiResult = results.find(r => r.source === 'wikipedia');

  if (wikiResult) {
    // Extract Wikipedia title from URL
    const wikiTitle = decodeURIComponent(wikiResult.url.split('/wiki/')[1] || '').replace(/_/g, ' ');
    const wikiContent = await fetchWikipedia(wikiTitle);
    if (wikiContent.length > 100) {
      sources.push({ title: wikiResult.title, url: wikiResult.url, content: wikiContent.slice(0, 2500) });
    }
  }

  for (const r of results.filter(r => r.source !== 'wikipedia').slice(0, 2)) {
    const content = await fetchPage(r.url);
    if (content.length > 100) {
      sources.push({ title: r.title, url: r.url, content: content.slice(0, 2000) });
    }
    if (sources.length >= 3) break;
  }

  if (!sources.length) {
    return { verified: false, confidence: 'low', sources: results.slice(0, 3).map(r => r.url), reasoning: 'Could not fetch source content for verification.' };
  }

  // Step 4: Compare claim vs sources
  const sourceSummary = sources.map((s, i) => `SOURCE ${i + 1} (${s.url}):\n${s.content}`).join('\n\n---\n\n');

  const verifyResult = await callKimi(
    `You are a fact-checker. Compare the claim against the provided sources and determine if it's verified.
Reply in this EXACT format (no other text):
VERDICT: true|false
CONFIDENCE: high|medium|low
REASONING: one sentence explanation`,
    `CLAIM: "${claim}"
CONTEXT: ${context || 'none'}

${sourceSummary}`,
    { maxTokens: 100, temperature: 0.2 }
  );

  const text = verifyResult?.text || '';
  const verdictMatch = text.match(/VERDICT:\s*(true|false)/i);
  const confMatch = text.match(/CONFIDENCE:\s*(high|medium|low)/i);
  const reasonMatch = text.match(/REASONING:\s*(.+)/i);

  return {
    verified: verdictMatch ? verdictMatch[1].toLowerCase() === 'true' : false,
    confidence: confMatch ? confMatch[1].toLowerCase() : 'low',
    sources: sources.map(s => s.url),
    reasoning: reasonMatch ? reasonMatch[1].trim() : 'Could not parse verification result.'
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
