// Predictions engine — generates forecasts from knowledge graph patterns
import db from '../db/database.js';
import { callKimi } from './kimi.js';

export async function generatePredictions() {
  // Get hot topics and strongly connected entities
  const hotTopics = db.prepare('SELECT * FROM brain_topics ORDER BY heat DESC LIMIT 10').all();
  const strongConns = db.prepare(`
    SELECT bc.*, ea.name as from_name, ea.type as from_type, eb.name as to_name, eb.type as to_type
    FROM brain_connections bc
    JOIN brain_entities ea ON bc.entity_a = ea.id
    JOIN brain_entities eb ON bc.entity_b = eb.id
    ORDER BY bc.strength DESC LIMIT 20
  `).all();

  const topEntities = db.prepare('SELECT * FROM brain_entities ORDER BY mention_count DESC LIMIT 15').all();

  if (!hotTopics.length && !strongConns.length) return [];

  const context = `HOT TOPICS:\n${hotTopics.map(t => `- ${t.name} (heat: ${t.heat}): ${t.description || ''}`).join('\n')}

STRONGEST CONNECTIONS:\n${strongConns.map(c => `- ${c.from_name} (${c.from_type}) → ${c.relation} → ${c.to_name} (${c.to_type}) [strength: ${c.strength}]`).join('\n')}

TOP ENTITIES:\n${topEntities.map(e => `- ${e.name} (${e.type}, mentioned ${e.mention_count}x)`).join('\n')}`;

  const result = await callKimi(
    `You are a geopolitical and technology analyst. Based on knowledge graph data, generate 5 predictions about what will happen next. Be specific, bold, and justify each prediction with the data.

Output format (no markdown, no extra text):
PREDICTION: <one-sentence prediction>
CONFIDENCE: <0.0-1.0>
REASONING: <2-3 sentences explaining why>
ENTITIES: <comma-separated entity names involved>
---`,
    context,
    { maxTokens: 800, temperature: 0.7 }
  );

  if (!result?.text) return [];

  // Parse predictions
  const predictions = [];
  const blocks = result.text.split('---').filter(b => b.trim());

  for (const block of blocks) {
    const pred = block.match(/PREDICTION:\s*(.+)/i)?.[1]?.trim();
    const conf = parseFloat(block.match(/CONFIDENCE:\s*([\d.]+)/i)?.[1] || '0.5');
    const reasoning = block.match(/REASONING:\s*(.+)/is)?.[1]?.trim();
    const entities = block.match(/ENTITIES:\s*(.+)/i)?.[1]?.split(',').map(e => e.trim()).filter(Boolean) || [];

    if (pred) {
      predictions.push({
        prediction: pred,
        confidence: Math.min(1, Math.max(0, conf)),
        reasoning: reasoning || '',
        entities,
        source_count: hotTopics.length + strongConns.length,
        created_at: new Date().toISOString()
      });
    }
  }

  return predictions;
}
