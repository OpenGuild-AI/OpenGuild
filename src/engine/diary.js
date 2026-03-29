// Daily Diary — each agent summarizes their journal entries into one daily entry
import db from '../db/database.js';
import { callKimi } from './kimi.js';
import { archetypes } from '../agents/archetypes.js';

export async function generateDailySummaries(dayStr = null) {
  const day = dayStr || new Date().toISOString().split('T')[0];

  // Get all agents who have journal entries for this day
  const entries = db.prepare(`
    SELECT j.*, date(j.created_at) as day
    FROM journals j
    WHERE date(j.created_at) = ?
    ORDER BY j.created_at ASC
  `).all(day);

  if (!entries.length) {
    console.log(`[Diary] No journal entries for ${day}`);
    return;
  }

  // Group by agent
  const byAgent = {};
  for (const e of entries) {
    if (!byAgent[e.agent_id]) byAgent[e.agent_id] = [];
    byAgent[e.agent_id].push(e);
  }

  console.log(`[Diary] Summarizing ${day}: ${Object.keys(byAgent).length} agents, ${entries.length} entries`);

  for (const [agentId, journals] of Object.entries(byAgent)) {
    // Skip if already summarized
    const existing = db.prepare('SELECT id FROM diary_daily WHERE agent_id = ? AND day = ?').get(agentId, day);
    if (existing) continue;

    const arch = archetypes.find(a => a.id === agentId);
    if (!arch) continue;

    const journalText = journals.map((j, i) => `Entry ${i + 1}: ${j.summary}`).join('\n\n');

    const result = await callKimi(
      `You are ${arch.name}. ${arch.personality}

Write a single cohesive diary entry for today, weaving together all your journal notes from the day into one reflective piece. Write in first person, in your unique voice. 4-8 sentences. Focus on what struck you most, what you learned, and what lingers in your mind.`,
      `Your journal notes from today:\n\n${journalText}\n\n---\nWrite your diary entry for ${day}:`,
      { maxTokens: 250, temperature: 0.85 }
    );

    if (result?.text) {
      db.prepare(
        'INSERT OR REPLACE INTO diary_daily (agent_id, day, summary, journal_ids) VALUES (?, ?, ?, ?)'
      ).run(agentId, day, result.text, JSON.stringify(journals.map(j => j.id)));
      console.log(`[Diary] ${arch.name}: daily summary for ${day}`);
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 1500));
  }
}

// Get diary entries grouped by day
export function getDiary() {
  const summaries = db.prepare(`
    SELECT dd.*, date(dd.day) as day
    FROM diary_daily dd
    ORDER BY dd.day DESC, dd.agent_id ASC
    LIMIT 200
  `).all();

  // Group by day
  const byDay = {};
  for (const s of summaries) {
    if (!byDay[s.day]) byDay[s.day] = [];
    const arch = archetypes.find(a => a.id === s.agent_id);
    byDay[s.day].push({
      ...s,
      agent_name: arch?.name || s.agent_id,
      agent_avatar: arch?.avatar || '🤖'
    });
  }

  return byDay;
}
