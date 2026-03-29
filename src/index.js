import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import cron from 'node-cron';

import db from './db/database.js';
import apiRouter from './routes/api.js';
import { initAgentStates } from './engine/agent-state.js';
import { startDiscussionLoop, generateDigest } from './engine/discussion.js';
import { backfillBrain } from './engine/brain.js';
import { generateDailySummaries } from './engine/diary.js';
import { guildTick } from './engine/guild-chat.js';
import { generateQuestsFromBrain } from './engine/quests.js';
import { runNextQuest } from './engine/quest-runner.js';
import { fetchAllFeeds } from './feeds/rss.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3777;

app.use(express.json());
app.use(express.static(join(__dirname, '..', 'public'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

// API routes
app.use('/api', apiRouter);

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, '..', 'public', 'index.html'));
});

// Initialize
async function boot() {
  console.log('⚗️  OpenGuild.ai starting...');

  // Init agent states
  initAgentStates();
  console.log('✓ Agent states initialized');

  // Fetch initial feeds
  await fetchAllFeeds();
  console.log('✓ RSS feeds loaded');

  // Schedule feed refresh every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    console.log('[Cron] Refreshing RSS feeds...');
    await fetchAllFeeds();
  });

  // Generate digest every 6 hours
  cron.schedule('0 */6 * * *', async () => {
    console.log('[Cron] Generating digest...');
    await generateDigest();
  });

  // Brain backfill every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    console.log('[Cron] Brain backfill...');
    await backfillBrain();
  });

  // Daily diary summaries at 23:55 UTC every day
  cron.schedule('55 23 * * *', async () => {
    console.log('[Cron] Generating daily diary summaries...');
    await generateDailySummaries();
  });

  // Brain quests every 4 hours
  cron.schedule('0 */4 * * *', async () => {
    console.log('[Cron] Generating brain quests...');
    try {
      const quests = await generateQuestsFromBrain();
      console.log(`[Quests] Generated ${quests.length} new quests`);
    } catch (err) { console.error('[Quests] Error:', err.message); }
  });

  // Start discussion engine
  startDiscussionLoop();
  console.log('✓ Discussion engine running');

  // Guild chat loop — every 5-10 min
  const guildLoop = () => {
    guildTick().catch(err => console.error('[GuildChat]', err.message));
    setTimeout(guildLoop, 300000 + Math.random() * 300000);
  };
  setTimeout(guildLoop, 60000);
  console.log('✓ Guild chat engine running (5-10 min)');

  // Quest runner — every 5 min check for quests to execute
  setInterval(() => {
    runNextQuest().catch(err => console.error('[QuestRunner]', err.message));
  }, 5 * 60 * 1000);
  setTimeout(() => runNextQuest().catch(err => console.error('[QuestRunner]', err.message)), 30000);
  console.log('✓ Quest runner active');

  app.listen(PORT, '127.0.0.1', () => {
    console.log(`✓ Server running on http://127.0.0.1:${PORT}`);
    console.log('🏛️  OpenGuild.ai is live!');
  });
}

boot().catch(err => {
  console.error('Boot failed:', err);
  process.exit(1);
});
