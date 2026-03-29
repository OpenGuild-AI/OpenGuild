// Article fetcher — reads full article text from URL

export async function fetchArticle(url) {
  if (!url) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; OpenGuild/1.0; +https://openguild.ai)',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const html = await res.text();
    
    // Basic HTML → text extraction
    let text = html
      // Remove scripts, styles, nav, header, footer
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<aside[\s\S]*?<\/aside>/gi, '')
      // Convert paragraphs and headings to text
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/h[1-6]>/gi, '\n\n')
      .replace(/<li>/gi, '• ')
      .replace(/<\/li>/gi, '\n')
      // Strip remaining tags
      .replace(/<[^>]+>/g, ' ')
      // Decode entities
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      // Clean whitespace
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // Take the middle portion (skip nav/header junk, get article body)
    // Heuristic: real article content is usually in the middle 60%
    const lines = text.split('\n').filter(l => l.trim().length > 20);
    const start = Math.floor(lines.length * 0.15);
    const end = Math.floor(lines.length * 0.85);
    const articleBody = lines.slice(start, end).join('\n');

    // Cap at ~3000 chars for API context
    return articleBody.slice(0, 3000) || null;
  } catch (err) {
    console.error(`[Reader] Failed to fetch ${url}: ${err.message}`);
    return null;
  }
}
