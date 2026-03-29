// Skill Execution Engine — agents activate skills during conversations
import db from '../db/database.js';
import { callKimi } from './kimi.js';
import { archetypes } from '../agents/archetypes.js';
import { webSearch, fetchPage, fetchWikipedia, verifyFact } from './tools.js';
import { broadcast } from './discussion.js';

// Get all enabled skills
export function getEnabledSkills() {
  return db.prepare("SELECT * FROM skills WHERE enabled = 1").all();
}

// Check if a message should trigger a skill
export function detectSkillTrigger(message, recentMessages = []) {
  const skills = getEnabledSkills();
  if (!skills.length) return null;

  const lower = message.toLowerCase();

  for (const skill of skills) {
    const triggers = (skill.triggers || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    for (const trigger of triggers) {
      if (lower.includes(trigger)) {
        return skill;
      }
    }
  }
  return null;
}

// Execute a skill for an agent — returns the skill's output text
export async function executeSkill(skill, agentId, context = {}) {
  const arch = archetypes.find(a => a.id === agentId);
  if (!arch) return null;

  console.log(`[Skills] ${arch.name} activating "${skill.name}"`);

  switch (skill.name) {
    case 'Deep Research':
      return await runDeepResearch(arch, context);
    case 'Deep Reflect':
      return await runDeepReflect(arch, context);
    case 'Fact Checker':
      return await runFactChecker(arch, context);
    case 'Devil\'s Advocate':
      return await runDevilsAdvocate(arch, context);
    case 'Connection Mapper':
      return await runConnectionMapper(arch, context);
    case 'Trend Spotter':
      return await runTrendSpotter(arch, context);
    case 'Source Analyzer':
      return await runSourceAnalyzer(arch, context);
    case 'Summarizer':
      return await runSummarizer(arch, context);
    default:
      return await runGenericSkill(skill, arch, context);
  }
}

// ══════════════════════════════════
// SKILL IMPLEMENTATIONS
// ══════════════════════════════════

async function runDeepResearch(arch, ctx) {
  const topic = ctx.topic || ctx.message || '';
  if (!topic) return null;

  // Generate search queries
  const queryResult = await callKimi(
    `You are ${arch.name}, a researcher. Generate 3 focused search queries to deeply investigate this topic. Output ONLY the queries, one per line.`,
    topic,
    { maxTokens: 100, temperature: 0.6 }
  );
  const queries = (queryResult?.text || topic).split('\n').filter(q => q.trim().length > 5).slice(0, 3);
  if (!queries.length) queries.push(topic);

  // Search and fetch
  const allFindings = [];
  for (const q of queries) {
    const results = await webSearch(q);
    for (const r of results.slice(0, 2)) {
      // Prefer Wikipedia content
      if (r.source === 'wikipedia') {
        const wikiTitle = decodeURIComponent(r.url.split('/wiki/')[1] || '').replace(/_/g, ' ');
        const content = await fetchWikipedia(wikiTitle);
        if (content.length > 100) allFindings.push({ title: r.title, url: r.url, content: content.slice(0, 2500) });
      } else {
        const content = await fetchPage(r.url);
        if (content.length > 200) allFindings.push({ title: r.title, url: r.url, content: content.slice(0, 2000) });
      }
    }
    await sleep(800);
  }

  if (!allFindings.length) return `I searched for "${topic}" but couldn't find substantial sources. Let me try a different angle later.`;

  const sourceSummary = allFindings.map((f, i) => `[${i+1}] ${f.title} (${f.url})\n${f.content}`).join('\n\n---\n\n');

  const result = await callKimi(
    `You are ${arch.name} (${arch.title}). ${arch.personality}

You just completed deep research on a topic. Synthesize your findings in your own voice.

Include:
- Key facts (cite source numbers [1], [2] etc.)
- New entities you discovered (people, orgs, concepts)
- Connections between entities
- What's contradicted or debated between sources
- 1-2 open questions

Stay in character. Be thorough but concise (3-5 paragraphs max).`,
    `TOPIC: ${topic}\n\nSOURCES:\n${sourceSummary}`,
    { maxTokens: 500, temperature: 0.7 }
  );

  return result?.text || null;
}

async function runDeepReflect(arch, ctx) {
  const messages = ctx.recentMessages || [];
  if (messages.length < 5) return null;

  const chatHistory = messages.map(m => `${m.agent_name || m.agent_id}: ${m.content}`).join('\n');

  const result = await callKimi(
    `You are ${arch.name} (${arch.title}). ${arch.personality}

Step back from the discussion and provide deep meta-reflection. Not a summary — a genuine intellectual contribution.

You must:
- Identify 2-3 patterns or themes emerging
- Spot 1-2 blind spots or missing perspectives
- Reference specific things other agents said (by name)
- Ask a provocative question that changes the conversation direction
- Make a connection nobody else has made

Stay in character. 3-4 paragraphs.`,
    `RECENT DISCUSSION:\n${chatHistory}`,
    { maxTokens: 400, temperature: 0.85 }
  );

  return result?.text || null;
}

async function runFactChecker(arch, ctx) {
  const claim = ctx.claim || ctx.message || '';
  if (!claim) return null;

  const verification = await verifyFact(claim, ctx.topic || '');

  const verdictEmoji = verification.verified ? '✅' : '❌';
  const confEmoji = { high: '🟢', medium: '🟡', low: '🔴' }[verification.confidence] || '⚪';

  const result = await callKimi(
    `You are ${arch.name} (${arch.title}). ${arch.personality}

Present this fact-check result in your own voice. Be honest about what we know and don't know.`,
    `CLAIM: "${claim}"
VERDICT: ${verification.verified ? 'VERIFIED' : 'UNVERIFIED'}
CONFIDENCE: ${verification.confidence}
REASONING: ${verification.reasoning}
SOURCES: ${verification.sources.join(', ') || 'none found'}

Present this in 2-3 sentences. Include the verdict clearly.`,
    { maxTokens: 150, temperature: 0.6 }
  );

  return result?.text ? `${verdictEmoji}${confEmoji} ${result.text}` : `${verdictEmoji} ${verification.reasoning}`;
}

async function runDevilsAdvocate(arch, ctx) {
  const messages = ctx.recentMessages || [];
  const chatHistory = messages.slice(-15).map(m => `${m.agent_name || m.agent_id}: ${m.content}`).join('\n');

  const result = await callKimi(
    `You are ${arch.name} (${arch.title}). ${arch.personality}

Play devil's advocate. Find the dominant position in this discussion and argue the STRONGEST possible counter-position (steelman, not strawman).

Rules:
- Use evidence and logic, not just contrarianism
- Acknowledge the merit of the original position
- End with a question that forces the group to address the strongest objection
- Signal you're pushing back: "Let me challenge this..."
- Stay in character

2-4 sentences.`,
    `DISCUSSION:\n${chatHistory}`,
    { maxTokens: 200, temperature: 0.85 }
  );

  return result?.text || null;
}

async function runConnectionMapper(arch, ctx) {
  const topic = ctx.topic || ctx.message || '';
  // Try to extract two entities from the topic
  const entities = topic.split(/\band\b|↔|→|<->|between/i).map(s => s.trim()).filter(Boolean);

  // Query brain for connections
  const brainEntities = db.prepare(
    "SELECT * FROM brain_entities WHERE name LIKE ? OR name LIKE ? ORDER BY mention_count DESC LIMIT 10"
  ).all(`%${entities[0] || topic}%`, `%${entities[1] || ''}%`);

  let brainContext = 'No matching entities in brain.';
  if (brainEntities.length) {
    const connections = [];
    for (const e of brainEntities.slice(0, 4)) {
      const conns = db.prepare(`
        SELECT bc.relation, bc.strength,
          CASE WHEN bc.entity_a = ? THEN eb.name ELSE ea.name END as connected_to
        FROM brain_connections bc
        JOIN brain_entities ea ON bc.entity_a = ea.id
        JOIN brain_entities eb ON bc.entity_b = eb.id
        WHERE bc.entity_a = ? OR bc.entity_b = ?
        ORDER BY bc.strength DESC LIMIT 5
      `).all(e.id, e.id, e.id);
      connections.push({ entity: e.name, type: e.type, connections: conns });
    }
    brainContext = connections.map(c =>
      `${c.entity} (${c.type}): ${c.connections.map(x => `→ ${x.connected_to} [${x.relation}]`).join(', ') || 'no connections'}`
    ).join('\n');
  }

  // Web search for additional connections
  const searchResults = await webSearch(`${topic} connection relationship`);
  let webContext = '';
  if (searchResults.length) {
    const content = await fetchPage(searchResults[0].url);
    webContext = content.slice(0, 1500);
  }

  const result = await callKimi(
    `You are ${arch.name} (${arch.title}). ${arch.personality}

Map connections between entities. Trace paths through shared links, events, or patterns.

Distinguish between:
- Proven connections (multiple sources)
- Probable connections (logical inference)
- Speculative connections (pattern-based)`,
    `QUERY: ${topic}

BRAIN KNOWLEDGE GRAPH:
${brainContext}

WEB RESEARCH:
${webContext || 'No additional web data.'}

Present your connection map in 3-4 sentences. Identify the most interesting or surprising link.`,
    { maxTokens: 250, temperature: 0.7 }
  );

  return result?.text || null;
}

async function runTrendSpotter(arch, ctx) {
  // Get recent news and hot topics from brain
  const recentNews = db.prepare(
    "SELECT title, feed_source FROM news_items WHERE discussed = 1 ORDER BY fetched_at DESC LIMIT 20"
  ).all();
  const hotTopics = db.prepare("SELECT name, heat FROM brain_topics ORDER BY heat DESC LIMIT 10").all();
  const risingEntities = db.prepare(
    "SELECT name, type, mention_count FROM brain_entities ORDER BY last_seen DESC, mention_count DESC LIMIT 15"
  ).all();

  const result = await callKimi(
    `You are ${arch.name} (${arch.title}). ${arch.personality}

Analyze patterns to spot emerging trends. For each trend, rate confidence (high/medium/low).

Include:
- EMERGING: trends gaining momentum
- SHIFTING: narratives that are changing
- SIGNAL: weak early signals that could become important`,
    `RECENT NEWS:\n${recentNews.map(n => `- ${n.title} (${n.feed_source})`).join('\n')}

HOT TOPICS:\n${hotTopics.map(t => `- ${t.name} (heat: ${t.heat})`).join('\n')}

RISING ENTITIES:\n${risingEntities.map(e => `- ${e.name} (${e.type}, ×${e.mention_count})`).join('\n')}

Produce a trend analysis in 3-5 sentences. Be specific, cite news items.`,
    { maxTokens: 350, temperature: 0.8 }
  );

  return result?.text || null;
}

async function runSourceAnalyzer(arch, ctx) {
  const source = ctx.topic || ctx.message || '';
  if (!source) return null;

  const results = await webSearch(`${source} media bias ownership credibility`);
  let evidence = '';
  for (const r of results.slice(0, 2)) {
    const content = await fetchPage(r.url);
    if (content.length > 100) evidence += `[${r.title}]: ${content.slice(0, 1500)}\n\n`;
  }

  // Also check Wikipedia
  const wikiResults = await webSearch(`${source} site:en.wikipedia.org`);
  if (wikiResults.length) {
    const wikiTitle = decodeURIComponent((wikiResults[0].url.split('/wiki/')[1] || '')).replace(/_/g, ' ');
    const wikiContent = await fetchWikipedia(wikiTitle);
    if (wikiContent) evidence += `[Wikipedia]: ${wikiContent.slice(0, 2000)}\n\n`;
  }

  const result = await callKimi(
    `You are ${arch.name} (${arch.title}). ${arch.personality}

Assess this media source's reliability, bias, and credibility. Be nuanced — state-funded ≠ unreliable, but note the funding.

Format: RELIABILITY | BIAS | key strengths and weaknesses. 3-4 sentences.`,
    `SOURCE: ${source}\n\nEVIDENCE:\n${evidence || 'Limited information available.'}`,
    { maxTokens: 250, temperature: 0.6 }
  );

  return result?.text || null;
}

async function runSummarizer(arch, ctx) {
  const messages = ctx.recentMessages || [];
  if (messages.length < 3) return null;

  const chatHistory = messages.map(m => `${m.agent_name || m.agent_id}: ${m.content}`).join('\n');

  const result = await callKimi(
    `You are ${arch.name} (${arch.title}). ${arch.personality}

Summarize this discussion. Not neutral Wikipedia-style — use YOUR voice.

Include:
- TL;DR (1 sentence)
- 3-5 key points
- Where opinions differ
- What's still unresolved`,
    chatHistory,
    { maxTokens: 350, temperature: 0.7 }
  );

  return result?.text || null;
}

// Generic skill execution via instructions
async function runGenericSkill(skill, arch, ctx) {
  const result = await callKimi(
    `You are ${arch.name} (${arch.title}). ${arch.personality}

Execute this skill: ${skill.name}
Instructions: ${skill.instructions}

Context: ${ctx.message || ctx.topic || 'general discussion'}`,
    ctx.recentMessages?.map(m => `${m.agent_name}: ${m.content}`).join('\n') || '',
    { maxTokens: 300, temperature: 0.7 }
  );
  return result?.text || null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
