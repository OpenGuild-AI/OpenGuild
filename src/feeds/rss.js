import Parser from 'rss-parser';
import db from '../db/database.js';

const parser = new Parser({
  timeout: 10000,
  headers: { 'User-Agent': 'OpenGuild/1.0' }
});

// Curated global news — hard news only, no ads, no fluff
const FEEDS = [
  // ── Tier 1: Major Wire Services & World Desks ──
  { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { name: 'DW News', url: 'https://rss.dw.com/rdf/rss-en-all' },
  { name: 'France 24', url: 'https://www.france24.com/en/rss' },
  { name: 'The Guardian World', url: 'https://www.theguardian.com/world/rss' },

  // ── Tier 2: Quality Analysis & Depth ──
  { name: 'The Economist', url: 'https://www.economist.com/latest/rss.xml' },
  { name: 'Foreign Affairs', url: 'https://www.foreignaffairs.com/rss.xml' },
  { name: 'The Conversation', url: 'https://theconversation.com/articles.atom' },

  // ── Regional Coverage (underreported areas) ──
  { name: 'South China Morning Post', url: 'https://www.scmp.com/rss/91/feed' },
  { name: 'The Hindu', url: 'https://www.thehindu.com/news/international/feeder/default.rss' },
  { name: 'Japan Times', url: 'https://www.japantimes.co.jp/feed/' },
  { name: 'Africa News', url: 'https://www.africanews.com/feed/' },
  { name: 'NZZ International', url: 'https://www.nzz.ch/international.rss' },

  // ── Science & Technology (substance, not hype) ──
  { name: 'Nature News', url: 'https://www.nature.com/nature.rss' },
  { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index' },
  { name: 'MIT Tech Review', url: 'https://www.technologyreview.com/feed/' },

  // ── Climate & Environment ──
  { name: 'Carbon Brief', url: 'https://www.carbonbrief.org/feed/' },
  { name: 'Guardian Environment', url: 'https://www.theguardian.com/environment/rss' },

  // ── Long-form & Ideas ──
  { name: 'Aeon', url: 'https://aeon.co/feed.rss' },
];

const insertNews = db.prepare(`
  INSERT OR IGNORE INTO news_items (feed_source, title, link, summary, published_at)
  VALUES (?, ?, ?, ?, ?)
`);

export async function fetchAllFeeds() {
  let totalNew = 0;
  
  for (const feed of FEEDS) {
    try {
      const result = await parser.parseURL(feed.url);
      for (const item of result.items?.slice(0, 10) || []) {
        const existing = db.prepare('SELECT id FROM news_items WHERE link = ?').get(item.link);
        if (!existing) {
          insertNews.run(
            feed.name,
            item.title || 'Untitled',
            item.link || '',
            (item.contentSnippet || item.content || '').slice(0, 500),
            item.isoDate || item.pubDate || new Date().toISOString()
          );
          totalNew++;
        }
      }
    } catch (err) {
      console.error(`[RSS] Failed to fetch ${feed.name}: ${err.message}`);
    }
  }
  
  console.log(`[RSS] Fetched ${totalNew} new items`);
  return totalNew;
}

// Get undiscussed news, newest first
export function getUndiscussedNews(limit = 5) {
  return db.prepare(`
    SELECT * FROM news_items 
    WHERE discussed = 0 
    ORDER BY published_at DESC 
    LIMIT ?
  `).all(limit);
}

// Mark news as discussed
export function markDiscussed(newsId) {
  db.prepare('UPDATE news_items SET discussed = 1 WHERE id = ?').run(newsId);
}

// Get recent news for context
export function getRecentNews(limit = 20) {
  return db.prepare(`
    SELECT * FROM news_items 
    ORDER BY fetched_at DESC 
    LIMIT ?
  `).all(limit);
}
