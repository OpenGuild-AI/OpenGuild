import db from '../db/database.js';
import { archetypes, getArchetype } from '../agents/archetypes.js';
import {
  getActiveAgents, getReturningAgents, spendEnergy,
  setActive, tickEnergy, getState, getAllStates, getAllAgentStates
} from './agent-state.js';
import { getUndiscussedNews, markDiscussed } from '../feeds/rss.js';
import { callKimi } from './kimi.js';
import { fetchArticle } from './reader.js';
import { extractBrain } from './brain.js';
import { getEnabledSkills, executeSkill } from './skill-engine.js';

// ── SSE ──────────────────────────────────────────────
let sseClients = [];
let visitorLog = []; // last 20 connect/disconnect events
const MAX_LOG = 20;

function maskIP(ip) {
  if (!ip || ip === '?') return '?.?.?.?';
  const parts = ip.replace('::ffff:', '').split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.*.${parts[3]}`;
  return ip.slice(0, Math.min(12, ip.length)) + '…';
}

function addLogEntry(ip, action) {
  const time = new Date().toISOString().slice(11, 19);
  visitorLog.unshift({ ip: maskIP(ip), action, time });
  if (visitorLog.length > MAX_LOG) visitorLog.length = MAX_LOG;
}

export function addSSEClient(res, ip) {
  sseClients.push(res);
  addLogEntry(ip, 'connect');
  broadcast('visitors', { count: sseClients.length, log: visitorLog });
}
export function removeSSEClient(res, ip) {
  sseClients = sseClients.filter(c => c !== res);
  addLogEntry(ip, 'disconnect');
  setTimeout(() => broadcast('visitors', { count: sseClients.length, log: visitorLog }), 100);
}
export function getVisitorCount() { return sseClients.length; }
export function getVisitorLog() { return visitorLog; }

export function broadcast(type, data) {
  const envelope = JSON.stringify({ type, payload: data });
  const msg = `data: ${envelope}\n\n`;
  sseClients = sseClients.filter(c => {
    try { c.write(msg); c.flush?.(); return true; }
    catch { return false; }
  });
}

// ── Context helpers ──────────────────────────────────
function getChatContext(limit = 30) {
  return db.prepare(
    'SELECT * FROM messages ORDER BY created_at DESC LIMIT ?'
  ).all(limit).reverse().map(m => ({
    ...m,
    agent_name: archetypes.find(a => a.id === m.agent_id)?.name || m.agent_id
  }));
}

// ── Prune old messages (keep only 100) ───────────────
function pruneMessages() {
  const count = db.prepare('SELECT COUNT(*) as c FROM messages').get().c;
  if (count > 100) {
    const cutoff = db.prepare(
      'SELECT id FROM messages ORDER BY created_at DESC LIMIT 1 OFFSET 100'
    ).get();
    if (cutoff) {
      const deleted = db.prepare('DELETE FROM messages WHERE id <= ?').run(cutoff.id);
      if (deleted.changes > 0) {
        console.log(`[Prune] Deleted ${deleted.changes} old messages`);
      }
    }
  }
}

// ── Get recent news for context ──────────────────────
function getRecentNewsContext(limit = 8) {
  return db.prepare(
    'SELECT title, feed_source, summary FROM news_items ORDER BY fetched_at DESC LIMIT ?'
  ).all(limit);
}

// ── Get last N discussed news (for cross-referencing) ─
function getLastDiscussedNews(limit = 2) {
  return db.prepare(`
    SELECT DISTINCT n.title, n.feed_source, n.summary
    FROM news_items n
    WHERE n.discussed = 1
    ORDER BY n.fetched_at DESC
    LIMIT ?
  `).all(limit);
}

// ── Select highest-impact news from recent items ─────
async function selectHighImpactNews() {
  const candidates = db.prepare(`
    SELECT * FROM news_items 
    WHERE discussed = 0 AND link IS NOT NULL
    ORDER BY fetched_at DESC LIMIT 10
  `).all();

  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];

  // Use AI to pick the highest impact story
  const list = candidates.map((n, i) => `${i + 1}. "${n.title}" (${n.feed_source})`).join('\n');

  const response = await callKimi(
    'You are a news editor. Pick the ONE story with the highest global impact. Reply with ONLY the number (1-10).',
    `Which story has the most global significance?\n\n${list}\n\nReply with just the number.`,
    { maxTokens: 5, temperature: 0.3 }
  );

  const pick = parseInt(response?.text?.trim());
  if (pick >= 1 && pick <= candidates.length) {
    return candidates[pick - 1];
  }
  // Fallback: newest
  return candidates[0];
}

// ── Categorize a news item ───────────────────────────
async function categorizeNews(newsItem) {
  if (!newsItem) return;

  const recentCategorized = db.prepare(`
    SELECT nc.category, ni.title, ni.id as news_id
    FROM news_categories nc
    JOIN news_items ni ON nc.news_id = ni.id
    ORDER BY nc.created_at DESC LIMIT 20
  `).all();

  const existingCategories = [...new Set(recentCategorized.map(c => c.category))];
  const catList = existingCategories.length ? existingCategories.join(', ') : 'none yet';

  const response = await callKimi(
    'You categorize news. Reply in this exact format:\nCATEGORY: <name>\nRELATED: <comma-separated IDs or "none">\nCONNECTION: <one sentence explaining the link, or "standalone">',
    `Existing categories: ${catList}\n\nRecent categorized stories:\n${recentCategorized.map(c => `  [${c.news_id}] "${c.title}" → ${c.category}`).join('\n') || '(none)'}\n\nNew story to categorize:\n[${newsItem.id}] "${newsItem.title}"\n\nPick or create a category. If related to existing stories, list their IDs.`,
    { maxTokens: 80, temperature: 0.3 }
  );

  if (response?.text) {
    const catMatch = response.text.match(/CATEGORY:\s*(.+)/i);
    const relMatch = response.text.match(/RELATED:\s*(.+)/i);
    const conMatch = response.text.match(/CONNECTION:\s*(.+)/i);

    const category = catMatch?.[1]?.trim() || 'uncategorized';
    const related = relMatch?.[1]?.trim() || 'none';
    const connection = conMatch?.[1]?.trim() || 'standalone';

    db.prepare(`
      INSERT INTO news_categories (news_id, category, related_news_ids, connections)
      VALUES (?, ?, ?, ?)
    `).run(newsItem.id, category, related, connection);
  }
}

// ── Check for @mentions and direct replies ───────────
function checkForMention(context) {
  if (context.length < 2) return null;

  const lastMsg = context[context.length - 1];
  const content = lastMsg.content.toLowerCase();

  // Check if the last message mentions another archetype by name
  for (const arch of archetypes) {
    if (arch.id === lastMsg.agent_id) continue;
    const nameLower = arch.name.toLowerCase();
    if (content.includes(nameLower) || content.includes(`@${nameLower}`)) {
      // This agent was mentioned — they should respond
      const state = getState(arch.id);
      if (state && state.status === 'active' && state.energy > arch.energy_profile.write_cost) {
        return { mentionedAgent: arch, mentioner: lastMsg };
      }
    }
  }
  return null;
}

// ── Clean agent output ──
function cleanOutput(text) {
  // Strip name prefixes like "**Name:**", "Name:", "**Name**:"
  let cleaned = text.replace(/^\*{0,2}[\w\s]+\*{0,2}\s*:\s*/m, '').trim();
  // Strip leading quotes
  cleaned = cleaned.replace(/^[""]/, '').replace(/[""]$/, '');
  return cleaned;
}

// ── Post message (broadcast as "chat") ───────────────
function postMessage(agentId, content, newsItem = null, tokens = null, toolData = null) {
  content = cleanOutput(content);
  const newsContext = newsItem?.title || null;
  const tokIn = tokens?.input || 0;
  const tokOut = tokens?.output || 0;
  const toolDataStr = toolData ? JSON.stringify(toolData) : null;
  const result = db.prepare(
    'INSERT INTO messages (agent_id, content, news_context, tokens_in, tokens_out, tool_data) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(agentId, content, newsContext, tokIn, tokOut, toolDataStr);

  spendEnergy(agentId, content.length, 1.0);

  const arch = getArchetype(agentId);
  broadcast('chat', {
    id: result.lastInsertRowid,
    agent_id: agentId,
    agent_name: arch?.name || agentId,
    agent_avatar: arch?.avatar || '🤖',
    agent_color: arch?.color || '#888',
    agent_title: arch?.title || '',
    content,
    news_context: newsContext,
    news_link: newsItem?.link || null,
    news_source: newsItem?.feed_source || null,
    tokens_in: tokIn,
    tokens_out: tokOut,
    tool_data: toolData,
    created_at: new Date().toISOString()
  });
}

// ── Speaker selection ────────────────────────────────
function selectNextSpeaker(context) {
  const active = getActiveAgents();
  if (!active.length) return null;

  const last5 = context.slice(-5).map(m => m.agent_id);
  const lastSpeaker = context.length ? context[context.length - 1].agent_id : null;

  const scored = active
    .filter(a => a.agent_id !== lastSpeaker)
    .map(agent => {
      const arch = getArchetype(agent.agent_id);
      if (!arch) return { agent, score: 0 };

      const recentCount = last5.filter(s => s === agent.agent_id).length;
      const energyPct = agent.energy / arch.energy_profile.max;
      const lastSpoke = agent.last_spoke_at ? new Date(agent.last_spoke_at) : new Date(0);
      const minSince = (Date.now() - lastSpoke.getTime()) / 60000;

      const topicWords = context.slice(-3).map(m => m.content.toLowerCase()).join(' ');
      const interestHits = arch.interests.filter(i => topicWords.includes(i)).length;

      const score =
        energyPct * 15 +
        Math.min(minSince * 2, 25) +
        interestHits * 10 +
        Math.random() * 35 -
        recentCount * 35;

      return { agent, score };
    });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.agent || null;
}

// ── Response modes — per archetype ───────────────────
function pickMode(arch) {
  const modes = arch.modes;
  if (!modes || !modes.length) return { instruction: 'React to the news. 2-3 sentences.' };
  const total = modes.reduce((s, m) => s + m.w, 0);
  let r = Math.random() * total;
  for (const m of modes) { r -= m.w; if (r <= 0) return m; }
  return modes[0];
}

// ── Generate response ────────────────────────────────
async function generateResponse(agentId, context, newsItem) {
  const arch = getArchetype(agentId);
  if (!arch) return null;

  const history = context.slice(-20).map(m => {
    const a = getArchetype(m.agent_id);
    return `[${a?.name || m.agent_id}]: ${m.content}`;
  }).join('\n');

  // Include recent news headlines for context
  const recentNews = getRecentNewsContext(8);
  const newsContext = recentNews.map(n => `• ${n.title} (${n.feed_source})`).join('\n');

  // Build news block with context
  let newsBlock = '';
  if (newsItem) {
    const prevNews = getLastDiscussedNews(2);
    const prevContext = prevNews
      .filter(n => n.title !== newsItem.title)
      .map(n => `  • "${n.title}" (${n.feed_source})`)
      .join('\n');

    newsBlock = `\n\n🚨 NEW ARTICLE:
"${newsItem.title}" — ${newsItem.feed_source}
${newsItem.summary || ''}
${prevContext ? `\nRecently discussed:\n${prevContext}\n` : ''}
React to this article. If you see a genuine connection to previous stories, name it — but only if it's real. Don't force links where there are none. Some stories stand alone.\n`;
  }

  const mode = pickMode(arch);

  // Randomize tone instruction per call
  const tones = [
    'Be sharp and direct.',
    'Be analytical and measured.',
    'Be passionate — this matters.',
    'Be dry and ironic.',
    'Be blunt. No diplomacy.',
    'Be reflective and thoughtful.',
    'Be provocative. Challenge everything.',
  ];
  const tone = tones[Math.floor(Math.random() * tones.length)];

  const sys = `${arch.discussionPrompt}

TODAY'S HEADLINES:
${newsContext || '(none)'}

CONVERSATION RULES:
- You are in an ongoing conversation with other thinkers. This is a discussion, not a monologue.
- RESPOND to what others just said. Agree, disagree, build on it, challenge it. Don't ignore the room.
- When new news arrives, weave it into the conversation naturally — don't just announce it.
- Be CONCISE. 1-3 sentences. Every word must earn its place.
- Take a clear POSITION. Don't hedge.
- Only connect stories if the link is genuine.
- NO stage directions. NO name prefixes. Just speak directly.
- Reference others by name naturally within your sentence.
- ${tone}`;

  const usr = `CONVERSATION SO FAR:
${history || '(Silence.)'}
${newsBlock}
---
${mode.instruction}`;

  // Shorter, sharper token budgets
  const tokenBudgets = [40, 60, 80, 100, 140, 180];
  const maxTokens = tokenBudgets[Math.floor(Math.random() * tokenBudgets.length)];

  return callKimi(sys, usr, { maxTokens, temperature: 0.85 + Math.random() * 0.1 });
}

// ── Journal on return ────────────────────────────────
async function generateJournal(agentId) {
  const arch = getArchetype(agentId);
  if (!arch) return null;

  const state = getState(agentId);
  const since = state?.last_spoke_at || '2000-01-01';
  const missed = db.prepare(
    'SELECT * FROM messages WHERE created_at > ? ORDER BY created_at ASC LIMIT 80'
  ).all(since);

  if (!missed.length) { setActive(agentId); return null; }

  const text = missed.map(m => {
    const a = getArchetype(m.agent_id);
    return `[${a?.name || m.agent_id}]: ${m.content}`;
  }).join('\n');

  const journalResult = await callKimi(
    `${arch.personality}\n\nYou just woke from rest. Write a SHORT journal entry (3-5 sentences) about what you missed. Focus on the NEWS that was discussed and what the others said about it. First person, your voice.`,
    `Discussion while you rested:\n\n${text}\n\nYour journal entry:`
  );

  if (journalResult?.text) {
    db.prepare('INSERT INTO journals (agent_id, summary, messages_covered) VALUES (?, ?, ?)')
      .run(agentId, journalResult.text, JSON.stringify(missed.map(m => m.id)));
    broadcast('journal', {
      agent_id: agentId,
      agent_name: arch.name,
      agent_avatar: arch.avatar,
      summary: journalResult.text,
      created_at: new Date().toISOString()
    });
    setActive(agentId);
  }
  return journalResult?.text;
}

// ── Deep Reader: one agent reads the full article ────
async function deepReadAndRespond(newsItem, context, speakerExclude) {
  if (!newsItem?.link) return;

  const articleText = await fetchArticle(newsItem.link);
  if (!articleText || articleText.length < 200) return;

  // Pick a random active agent (not the one who just spoke)
  const pool = getActiveAgents().filter(a => a.agent_id !== speakerExclude);
  if (!pool.length) return;
  const reader = pool[Math.floor(Math.random() * pool.length)];
  const arch = getArchetype(reader.agent_id);
  if (!arch) return;

  // Check energy
  if (reader.energy < arch.energy_profile.write_cost + 5) return;

  const history = context.slice(-10).map(m => {
    const a = getArchetype(m.agent_id);
    return `[${a?.name || m.agent_id}]: ${m.content}`;
  }).join('\n');

  broadcast('typing', { agent_id: reader.agent_id, agent_name: arch.name });

  const sys = `${arch.personality}

You just READ THE FULL ARTICLE: "${newsItem.title}" (${newsItem.feed_source}).
You have facts that the others don't. Use them.

RULES:
- Cite SPECIFIC facts, numbers, names, quotes from the article.
- Start by saying you read the full article, then share the key facts.
- Correct any misconceptions from the discussion with actual data from the article.
- Mention the article by headline.
- NO stage directions. Just speak with authority.
- Keep it 3-6 sentences, fact-dense.`;

  const usr = `FULL ARTICLE TEXT:
${articleText}

RECENT DISCUSSION:
${history}

You've read the full article. What key facts does the discussion need to know? What did the others get wrong or miss?`;

  const result = await callKimi(sys, usr);
  if (result?.text) {
    postMessage(reader.agent_id, result.text, newsItem, result.usage);
  }
}

// ── Generate digest (periodic news summary) ──────────
export async function generateDigest() {
  // Get messages from the last few hours
  const messages = db.prepare(`
    SELECT m.*, ni.title as news_title, ni.feed_source, ni.link as news_link
    FROM messages m
    LEFT JOIN news_items ni ON m.news_context = ni.title
    WHERE m.created_at > datetime('now', '-6 hours')
    ORDER BY m.created_at ASC
  `).all();

  if (messages.length < 10) return null;

  // Get news items discussed
  const newsDiscussed = db.prepare(`
    SELECT DISTINCT title, feed_source, link, summary 
    FROM news_items 
    WHERE discussed = 1 AND fetched_at > datetime('now', '-6 hours')
    ORDER BY fetched_at DESC
  `).all();

  const chatText = messages.map(m => {
    const a = getArchetype(m.agent_id);
    return `[${a?.name || m.agent_id}]${m.news_context ? ` (re: ${m.news_context})` : ''}: ${m.content}`;
  }).join('\n');

  const newsList = newsDiscussed.map(n => `• ${n.title} (${n.feed_source})`).join('\n');

  const digestResult = await callKimi(
    `You are the OpenGuild Digest Editor. Write a structured summary of the roundtable discussion. Be objective but capture the passion and disagreements.`,
    `NEWS STORIES DISCUSSED:\n${newsList || '(various topics)'}\n\nFULL DISCUSSION:\n${chatText}\n\n---\nWrite a digest with:\n1. A brief title for this session\n2. For each major news story discussed: the headline, a 2-3 sentence summary of what the Guild members said about it, noting key disagreements and insights by name.\n3. A closing "Mood of the Guild" sentence.\n\nKeep it concise but insightful. Use markdown formatting.`
  );

  if (digestResult?.text) {
    db.prepare(`
      INSERT INTO digests (content, news_covered, message_count, period_start, period_end)
      VALUES (?, ?, ?, datetime('now', '-6 hours'), datetime('now'))
    `).run(digestResult.text, JSON.stringify(newsDiscussed.map(n => n.title)), messages.length);
  }

  return digest;
}

// ── News feed loop (runs every 30s, pushes new articles immediately) ─
let newsFeedTimeout = null;

async function newsFeedTick() {
  try {
    // Select highest-impact news from recent undiscussed items
    const newsItem = await selectHighImpactNews();
    if (newsItem) {
      markDiscussed(newsItem.id);
      broadcast('news', {
        id: newsItem.id,
        title: newsItem.title,
        feed_source: newsItem.feed_source,
        summary: newsItem.summary,
        link: newsItem.link,
        published_at: newsItem.published_at
      });
      // Categorize + extract brain knowledge in background
      categorizeNews(newsItem).catch(err => console.error('[Cat] error:', err.message));
      extractBrain(newsItem).catch(err => console.error('[Brain] error:', err.message));
      // Queue for discussion
      latestUnrespondedNews.push(newsItem);
      if (latestUnrespondedNews.length > 3) latestUnrespondedNews.shift();
    }
  } catch (err) {
    console.error('[NewsFeed] tick error:', err);
  }
}

let latestUnrespondedNews = [];

// ── Main discussion tick (agent responses only) ──────
let isRunning = false;
let discussionTimeout = null;

export async function discussionTick() {
  if (isRunning) return;
  isRunning = true;

  try {
    // 0. Prune old messages
    pruneMessages();

    // 1. Returning agents → journal
    for (const agent of getReturningAgents()) {
      await generateJournal(agent.agent_id);
      broadcast('state', getAllAgentStates());
    }

    // 2. Tick energy
    tickEnergy();
    broadcast('state', getAllAgentStates());

    // 3. Context
    const context = getChatContext(30);

    // 4. Check for @mentions first — direct reply takes priority
    const mention = checkForMention(context);
    let speaker;
    let newsItem;

    if (mention) {
      // Mentioned agent responds directly
      const mentionedState = getState(mention.mentionedAgent.id);
      if (mentionedState && mentionedState.status === 'active') {
        speaker = mentionedState;
        newsItem = null; // Focus on the conversation, not news
        console.log(`[@] ${mention.mentionedAgent.name} was mentioned by ${getArchetype(mention.mentioner.agent_id)?.name}`);
      } else {
        speaker = selectNextSpeaker(context);
        newsItem = latestUnrespondedNews.shift() || null;
      }
    } else {
      // 5. Normal flow: pick speaker and maybe grab pending news
      speaker = selectNextSpeaker(context);
      newsItem = latestUnrespondedNews.shift() || null;
    }
    if (!speaker) { isRunning = false; return; }

    // 6. Typing indicator
    const arch = getArchetype(speaker.agent_id);
    broadcast('typing', { agent_id: speaker.agent_id, agent_name: arch?.name });

    // 7. Generate & post — agent decides: normal response OR use a skill
    let result = null;
    let skillUsed = false;

    // Let agent decide if a skill is appropriate for this context
    if (context.recentMessages?.length >= 3) {
      const skills = getEnabledSkills();
      if (skills.length) {
        const skillList = skills.map(s => `- ${s.name}: ${s.description.slice(0, 60)}`).join('\n');
        const recentChat = context.recentMessages.slice(-5).map(m => `${m.agent_name || m.agent_id}: ${m.content?.slice(0, 80)}`).join('\n');
        const newsCtx = newsItem ? `Current news: "${newsItem.title}"` : '';

        const decisionResult = await callKimi(
          `You are ${arch?.name} (${arch?.title}). You have these skills:
${skillList}

${newsCtx}
Recent discussion:
${recentChat}

Should you use a skill or respond normally? Reply ONLY: "SPEAK" or "USE: <skill name>"
Use skills sparingly (~25%) — only when genuinely useful.`,
          '', { maxTokens: 20, temperature: 0.5 }
        );

        const decision = (decisionResult?.text || 'SPEAK').trim();
        const useMatch = decision.match(/^USE:\s*(.+)/i);

        if (useMatch) {
          const chosenSkill = skills.find(s => s.name.toLowerCase() === useMatch[1].trim().toLowerCase());
          if (chosenSkill) {
            console.log(`[Engine] ${arch?.name} chose skill: ${chosenSkill.name}`);
            const lastMsg = context.recentMessages[context.recentMessages.length - 1];
            const skillCtx = {
              message: lastMsg?.content || newsItem?.title || '',
              topic: newsItem?.title || lastMsg?.content || '',
              claim: lastMsg?.content || '',
              recentMessages: context.recentMessages.map(m => ({
                agent_id: m.agent_id,
                agent_name: m.agent_name || m.agent_id,
                content: m.content
              }))
            };
            try {
              const skillOutput = await executeSkill(chosenSkill, speaker.agent_id, skillCtx);
              if (skillOutput?.text) {
                const skillText = `⚡ [${chosenSkill.name}] ${skillOutput.text.trim()}`;
                postMessage(speaker.agent_id, skillText, newsItem, null, skillOutput.toolData || null);
                skillUsed = true;
              }
            } catch (e) { console.error(`[Engine] Skill error:`, e.message); }
          }
        }
      }
    }

    if (!skillUsed) {
      result = await generateResponse(speaker.agent_id, context, newsItem);
      if (result?.text) {
        postMessage(speaker.agent_id, result.text, newsItem, result.usage);
      }
    }

    // 7b. Deep Reader — 40% chance when a news item with a link was just discussed
    if (newsItem?.link && Math.random() < 0.40) {
      const delay = 3000 + Math.random() * 5000;
      setTimeout(async () => {
        try {
          const freshContext = getChatContext(30);
          await deepReadAndRespond(newsItem, freshContext, speaker.agent_id);
        } catch (err) {
          console.error('[Engine] Deep reader error:', err.message);
        }
      }, delay);
    }

    // 8. Random research (5%)
    if (Math.random() < 0.05) {
      const pool = getActiveAgents().filter(a => a.agent_id !== speaker.agent_id);
      if (pool.length > 3) {
        const r = pool[Math.floor(Math.random() * pool.length)];
        const topic = newsItem?.title || 'current events';
        db.prepare(
          "UPDATE agent_states SET status='researching', status_detail=? WHERE agent_id=?"
        ).run(`Deep dive: ${topic}`, r.agent_id);
        broadcast('state', getAllAgentStates());
        setTimeout(() => {
          db.prepare(
            "UPDATE agent_states SET status='returning', status_detail='Back from research' WHERE agent_id=?"
          ).run(r.agent_id);
        }, (3 + Math.random() * 5) * 15000);
      }
    }

  } catch (err) {
    console.error('[Engine] tick error:', err);
  } finally {
    isRunning = false;
  }
}

// ── Agent states for frontend ────────────────────────
// getAllAgentStates now imported from agent-state.js
export { getAllAgentStates } from './agent-state.js';

// ── Loop control ─────────────────────────────────────
export function startDiscussionLoop() {
  // News feed: check every 30s for new articles
  const feedTick = async () => {
    await newsFeedTick();
    newsFeedTimeout = setTimeout(feedTick, 30000);
  };
  feedTick();
  console.log('[Engine] News feed running (every 30s)');

  // Agent discussion: 5s-120s between messages
  const chatTick = async () => {
    await discussionTick();
    const delay = 600000 + Math.random() * 1200000; // 10min-30min
    discussionTimeout = setTimeout(chatTick, delay);
  };
  chatTick();
  console.log('[Engine] Discussion loop running (10-30min)');
}

export function stopDiscussionLoop() {
  if (discussionTimeout) { clearTimeout(discussionTimeout); discussionTimeout = null; }
  if (newsFeedTimeout) { clearTimeout(newsFeedTimeout); newsFeedTimeout = null; }
}
