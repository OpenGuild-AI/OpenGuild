import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'openguild.db');

import { mkdirSync } from 'fs';
mkdirSync(join(__dirname, '..', 'data'), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    content TEXT NOT NULL,
    reply_to INTEGER,
    news_context TEXT,
    created_at DATETIME DEFAULT (datetime('now')),
    FOREIGN KEY (reply_to) REFERENCES messages(id)
  );

  CREATE TABLE IF NOT EXISTS agent_states (
    agent_id TEXT PRIMARY KEY,
    energy REAL NOT NULL DEFAULT 100,
    status TEXT NOT NULL DEFAULT 'active',
    status_detail TEXT,
    last_spoke_at DATETIME,
    last_energy_update DATETIME DEFAULT (datetime('now')),
    messages_sent INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS news_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_source TEXT NOT NULL,
    title TEXT NOT NULL,
    link TEXT,
    summary TEXT,
    published_at DATETIME,
    fetched_at DATETIME DEFAULT (datetime('now')),
    discussed INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS journals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    messages_covered TEXT,
    created_at DATETIME DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_news_discussed ON news_items(discussed, fetched_at);
  CREATE INDEX IF NOT EXISTS idx_journals_agent ON journals(agent_id, created_at);

  CREATE TABLE IF NOT EXISTS digests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    news_covered TEXT,
    message_count INTEGER DEFAULT 0,
    period_start DATETIME,
    period_end DATETIME,
    created_at DATETIME DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_digests_created ON digests(created_at);

  CREATE TABLE IF NOT EXISTS news_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    news_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    related_news_ids TEXT,
    connections TEXT,
    created_at DATETIME DEFAULT (datetime('now')),
    FOREIGN KEY (news_id) REFERENCES news_items(id)
  );

  CREATE INDEX IF NOT EXISTS idx_news_cat ON news_categories(category);

  -- Guild Brain: Knowledge Graph
  CREATE TABLE IF NOT EXISTS brain_entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    description TEXT,
    first_seen DATETIME DEFAULT (datetime('now')),
    last_seen DATETIME DEFAULT (datetime('now')),
    mention_count INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS brain_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_a INTEGER NOT NULL,
    entity_b INTEGER NOT NULL,
    relation TEXT NOT NULL,
    strength REAL DEFAULT 1.0,
    news_id INTEGER,
    created_at DATETIME DEFAULT (datetime('now')),
    FOREIGN KEY (entity_a) REFERENCES brain_entities(id),
    FOREIGN KEY (entity_b) REFERENCES brain_entities(id)
  );

  CREATE TABLE IF NOT EXISTS brain_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    entity_ids TEXT,
    news_ids TEXT,
    created_at DATETIME DEFAULT (datetime('now')),
    updated_at DATETIME DEFAULT (datetime('now')),
    heat REAL DEFAULT 1.0
  );

  CREATE TABLE IF NOT EXISTS brain_news_entities (
    news_id INTEGER NOT NULL,
    entity_id INTEGER NOT NULL,
    role TEXT,
    PRIMARY KEY (news_id, entity_id),
    FOREIGN KEY (news_id) REFERENCES news_items(id),
    FOREIGN KEY (entity_id) REFERENCES brain_entities(id)
  );

  CREATE INDEX IF NOT EXISTS idx_brain_ent_type ON brain_entities(type);
  CREATE INDEX IF NOT EXISTS idx_brain_conn ON brain_connections(entity_a, entity_b);
  CREATE INDEX IF NOT EXISTS idx_brain_topic ON brain_topics(heat DESC);
  CREATE INDEX IF NOT EXISTS idx_brain_ne ON brain_news_entities(news_id);

  -- Brain Artifacts: Quest outputs tracked in knowledge graph
  CREATE TABLE IF NOT EXISTS brain_artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quest_id INTEGER,
    filename TEXT NOT NULL,
    title TEXT,
    agent_ids TEXT,
    validation_status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_brain_artifacts_quest ON brain_artifacts(quest_id);
`);

export default db;
