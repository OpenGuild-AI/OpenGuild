// Kimi API client — uses Anthropic Messages API format
const KIMI_API_URL = process.env.KIMI_API_URL || 'https://api.kimi.com/coding/v1/messages';
const KIMI_API_KEY = process.env.KIMI_API_KEY;
const KIMI_MODEL = process.env.KIMI_MODEL || 'k2p5';

export async function callKimi(systemPrompt, userPrompt, opts = {}) {
  if (!KIMI_API_KEY) {
    console.error('[Kimi] No API key set (KIMI_API_KEY)');
    return null;
  }

  const maxTokens = opts.maxTokens || 400;
  const temperature = opts.temperature || 0.85;

  try {
    const res = await fetch(KIMI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': KIMI_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: KIMI_MODEL,
        system: systemPrompt,
        messages: [
          { role: 'user', content: userPrompt }
        ],
        temperature,
        max_tokens: maxTokens
      })
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`[Kimi] API error ${res.status}: ${err}`);
      return null;
    }

    const data = await res.json();
    const text = data.content?.[0]?.text?.trim();
    const usage = data.usage || {};
    return { text: text || null, usage: { input: usage.input_tokens || 0, output: usage.output_tokens || 0 } };
  } catch (err) {
    console.error('[Kimi] Request failed:', err.message);
    return { text: null, usage: { input: 0, output: 0 } };
  }
}
