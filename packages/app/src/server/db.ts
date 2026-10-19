import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// pocket-bots's own storage: one SQLite file that this process alone owns
// (the data folder is locked at start), WAL with synchronous=NORMAL, and numbered migrations that
// each run in one transaction. Commits are durable across process crashes; the newest one may be
// lost on power failure.

type Migration = (db: DatabaseSync) => void;

const MIGRATIONS: Migration[] = [
  // 1: chats and their timelines
  (db) => {
    db.exec(`
      CREATE TABLE chats (
        id TEXT PRIMARY KEY,
        bot_id TEXT,
        provider TEXT NOT NULL,
        model TEXT,
        thinking TEXT,
        mode TEXT,
        cwd TEXT NOT NULL,
        title TEXT,
        labels TEXT NOT NULL DEFAULT '{}',
        resume TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        last_error TEXT,
        last_usage TEXT,
        attention TEXT,
        attention_at TEXT,
        seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_user_message_at TEXT,
        archived_at TEXT
      );
      CREATE INDEX chats_by_bot ON chats (bot_id, updated_at);
      CREATE INDEX chats_by_update ON chats (updated_at);
      CREATE TABLE timeline (
        chat_id TEXT NOT NULL,
        key TEXT NOT NULL,
        seq_start INTEGER NOT NULL,
        seq_end INTEGER NOT NULL,
        turn_id TEXT,
        ts TEXT NOT NULL,
        item TEXT NOT NULL,
        PRIMARY KEY (chat_id, key)
      );
      CREATE INDEX timeline_by_start ON timeline (chat_id, seq_start);
      CREATE INDEX timeline_by_end ON timeline (chat_id, seq_end);
      CREATE TABLE turns (
        chat_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        outcome TEXT,
        error TEXT,
        usage TEXT,
        PRIMARY KEY (chat_id, turn_id)
      );
    `);
  },
  // 2: group chats
  (db) => {
    db.exec(`
      CREATE TABLE groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        wake_mode TEXT NOT NULL DEFAULT 'everyone',
        budget INTEGER NOT NULL DEFAULT 40,
        last_seq INTEGER NOT NULL DEFAULT 0,
        read_seq INTEGER NOT NULL DEFAULT 0,
        bot_wakes INTEGER NOT NULL DEFAULT 0,
        paused INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE group_members (
        group_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        seat_chat_id TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        joined_seq INTEGER NOT NULL DEFAULT 0,
        muted_from_seq INTEGER,
        seen_upto INTEGER NOT NULL DEFAULT 0,
        seen_extra TEXT NOT NULL DEFAULT '[]',
        noticed_upto INTEGER NOT NULL DEFAULT 0,
        wake TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (group_id, bot_id)
      );
      CREATE INDEX group_members_by_seat ON group_members (seat_chat_id);
      CREATE TABLE group_messages (
        group_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        id TEXT NOT NULL UNIQUE,
        sender_kind TEXT NOT NULL,
        sender_id TEXT,
        sender_name TEXT,
        text TEXT NOT NULL,
        reply_to INTEGER,
        everyone INTEGER NOT NULL DEFAULT 0,
        mentions TEXT NOT NULL DEFAULT '[]',
        attachments TEXT NOT NULL DEFAULT '[]',
        idempotency_key TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (group_id, seq)
      );
      CREATE UNIQUE INDEX group_messages_idempotency ON group_messages (group_id, sender_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE TABLE group_claims (
        group_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        claimant_kind TEXT NOT NULL,
        claimant_id TEXT NOT NULL,
        claimant_name TEXT NOT NULL,
        status TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (group_id, seq)
      );
      CREATE TABLE group_reactions (
        group_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        emoji TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (group_id, seq, actor_id, emoji)
      );
      CREATE TABLE group_drafts (
        group_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        text TEXT NOT NULL,
        reply_to INTEGER,
        hold_count INTEGER NOT NULL DEFAULT 1,
        held_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (group_id, bot_id)
      );
      CREATE VIRTUAL TABLE group_messages_fts USING fts5(text, group_id UNINDEXED, seq UNINDEXED, tokenize = 'trigram');
    `);
  },
  // 3: threads on top-level group messages, and who follows them
  (db) => {
    db.exec(`
      ALTER TABLE group_messages ADD COLUMN thread_seq INTEGER;
      CREATE INDEX group_messages_by_thread ON group_messages (group_id, thread_seq, seq);
      ALTER TABLE group_drafts ADD COLUMN thread_seq INTEGER;
      CREATE TABLE group_thread_follows (
        group_id TEXT NOT NULL,
        thread_seq INTEGER NOT NULL,
        follower_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        followed_at TEXT NOT NULL,
        unfollowed_at TEXT,
        PRIMARY KEY (group_id, thread_seq, follower_id)
      );
      -- The latest reply in each thread a member's model has seen.
      CREATE TABLE group_thread_reads (
        group_id TEXT NOT NULL,
        thread_seq INTEGER NOT NULL,
        bot_id TEXT NOT NULL,
        read_upto INTEGER NOT NULL,
        PRIMARY KEY (group_id, thread_seq, bot_id)
      );
    `);
  },
  // 4: no more cap on bots waking each other
  (db) => {
    db.exec(`
      ALTER TABLE groups DROP COLUMN budget;
      ALTER TABLE groups DROP COLUMN bot_wakes;
      ALTER TABLE groups DROP COLUMN paused;
    `);
  },
  // 5: claims become tasks: a top-level message as a task (task #N is message #N), five statuses, one assignee
  (db) => {
    db.exec(`
      CREATE TABLE group_tasks (
        group_id TEXT NOT NULL,
        number INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        status TEXT NOT NULL,
        assignee_kind TEXT,
        assignee_id TEXT,
        assignee_name TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        claimed_at TEXT,
        PRIMARY KEY (group_id, number)
      );
      CREATE UNIQUE INDEX group_tasks_by_seq ON group_tasks (group_id, seq);
      INSERT INTO group_tasks (group_id, number, seq, status, assignee_kind, assignee_id, assignee_name, created_by, created_at, updated_at, claimed_at)
        SELECT group_id, seq, seq,
          CASE status WHEN 'doing' THEN 'in_progress' WHEN 'review' THEN 'in_review' ELSE 'done' END,
          claimant_kind, claimant_id, claimant_name, claimant_id, claimed_at, updated_at, claimed_at
        FROM group_claims;
      DROP TABLE group_claims;
    `);
  },
  // 6: message management. Each receiver's delivery records, read positions per conversation,
  // each bot's model-seen ledger per
  // conversation, and held drafts per conversation. A conversation (conv) is 0 for the top level,
  // else its thread's top message. What's already in a group counts as read and seen.
  (db) => {
    db.exec(`
      ALTER TABLE group_messages ADD COLUMN system_subtype TEXT;
      ALTER TABLE group_messages ADD COLUMN causal_actor_id TEXT;
      CREATE TABLE group_inbox (
        group_id TEXT NOT NULL,
        receiver_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        conv INTEGER NOT NULL,
        personal_mention INTEGER NOT NULL DEFAULT 0,
        unread_eligible INTEGER NOT NULL,
        wake_reason TEXT,
        reactivated INTEGER NOT NULL DEFAULT 0,
        noticed INTEGER NOT NULL DEFAULT 0,
        drained_at TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (group_id, receiver_id, seq)
      );
      CREATE INDEX group_inbox_by_conv ON group_inbox (group_id, receiver_id, conv, seq);
      CREATE INDEX group_inbox_pending ON group_inbox (group_id, receiver_id, seq) WHERE wake_reason IS NOT NULL AND drained_at IS NULL;
      CREATE TABLE group_read_cursors (
        group_id TEXT NOT NULL,
        receiver_id TEXT NOT NULL,
        conv INTEGER NOT NULL,
        last_read_seq INTEGER NOT NULL,
        PRIMARY KEY (group_id, receiver_id, conv)
      );
      CREATE TABLE group_seen (
        group_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        conv INTEGER NOT NULL,
        boundary_seq INTEGER,
        exact_seqs TEXT NOT NULL DEFAULT '[]',
        read_order INTEGER,
        PRIMARY KEY (group_id, bot_id, conv)
      );
      DROP TABLE group_drafts;
      CREATE TABLE group_drafts (
        group_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        conv INTEGER NOT NULL,
        text TEXT NOT NULL,
        reply_to INTEGER,
        draft_key TEXT NOT NULL,
        hold_count INTEGER NOT NULL DEFAULT 0,
        held_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (group_id, bot_id, conv)
      );
      CREATE TEMP TABLE convs AS
        SELECT id AS group_id, 0 AS conv FROM groups
        UNION SELECT DISTINCT group_id, thread_seq FROM group_messages WHERE thread_seq IS NOT NULL;
      INSERT INTO group_read_cursors (group_id, receiver_id, conv, last_read_seq)
        SELECT g.id, r.receiver_id, c.conv, g.last_seq FROM groups g
        JOIN (SELECT group_id, bot_id AS receiver_id FROM group_members UNION SELECT id, 'user' FROM groups) r ON r.group_id = g.id
        JOIN convs c ON c.group_id = g.id;
      INSERT INTO group_seen (group_id, bot_id, conv, boundary_seq)
        SELECT g.id, m.bot_id, c.conv, g.last_seq FROM groups g
        JOIN group_members m ON m.group_id = g.id
        JOIN convs c ON c.group_id = g.id;
      DROP TABLE convs;
      DROP TABLE group_thread_reads;
      ALTER TABLE group_members DROP COLUMN seen_upto;
      ALTER TABLE group_members DROP COLUMN seen_extra;
      ALTER TABLE group_members DROP COLUMN noticed_upto;
      ALTER TABLE group_members DROP COLUMN wake;
      ALTER TABLE groups DROP COLUMN read_seq;
    `);
  },
  // 7: a task's revision: every change bumps it, so an assignment made on
  // a stale view can be refused instead of overwriting a newer one.
  (db) => {
    db.exec("ALTER TABLE group_tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
  },
  // 8: reminders and their events: a bot's own wake-up, anchored to a group
  // message, versioned so a stale change is refused; wake_pending until the owner's seat has it.
  (db) => {
    db.exec(`
      CREATE TABLE group_reminders (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        anchor_seq INTEGER NOT NULL,
        title TEXT NOT NULL,
        fire_at TEXT NOT NULL,
        recurrence TEXT,
        status TEXT NOT NULL DEFAULT 'scheduled',
        version INTEGER NOT NULL DEFAULT 1,
        fired_at TEXT,
        canceled_at TEXT,
        wake_pending INTEGER NOT NULL DEFAULT 0,
        wake_catchup INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX group_reminders_due ON group_reminders (status, fire_at);
      CREATE INDEX group_reminders_owner ON group_reminders (group_id, owner_id);
      CREATE TABLE group_reminder_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reminder_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        at TEXT NOT NULL,
        event TEXT NOT NULL,
        actor TEXT NOT NULL,
        next_fire_at TEXT
      );
      CREATE INDEX group_reminder_events_reminder ON group_reminder_events (reminder_id, id);
    `);
  },
  // 9: an ordinary message's wake reason is "group"; it was "room", the store's old name.
  (db) => {
    db.exec("UPDATE group_inbox SET wake_reason = 'group' WHERE wake_reason = 'room'");
  },
  // 10: task cards and mention delivery. A task's own title (its message's text until
  // amended) and description, when it was done or closed and by whom (tasks); every change to it,
  // in order (group_task_events); each message's @mentions of members with the token as written
  // (group_mentions; tokens already sent weren't kept); and, per delivery record, the notice that
  // told it, whether its seat took that notice, and why delivering it failed. Notices already sent
  // count as taken.
  (db) => {
    db.exec(`
      ALTER TABLE group_tasks ADD COLUMN title TEXT NOT NULL DEFAULT '';
      ALTER TABLE group_tasks ADD COLUMN description TEXT;
      ALTER TABLE group_tasks ADD COLUMN completed_at TEXT;
      ALTER TABLE group_tasks ADD COLUMN closed_at TEXT;
      ALTER TABLE group_tasks ADD COLUMN closed_by TEXT;
      UPDATE group_tasks SET title = COALESCE((SELECT text FROM group_messages m WHERE m.group_id = group_tasks.group_id AND m.seq = group_tasks.seq), '');
      CREATE TABLE group_task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        number INTEGER NOT NULL,
        event TEXT NOT NULL,
        actor_kind TEXT NOT NULL,
        actor_id TEXT,
        actor_name TEXT,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX group_task_events_task ON group_task_events (group_id, number, id);
      CREATE TABLE group_mentions (
        group_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        target_id TEXT NOT NULL,
        handle TEXT NOT NULL,
        PRIMARY KEY (group_id, seq, target_id)
      );
      INSERT OR IGNORE INTO group_mentions (group_id, seq, target_id, handle)
        SELECT m.group_id, m.seq, j.value, '' FROM group_messages m, json_each(m.mentions) j WHERE m.sender_kind IN ('user', 'bot');
      ALTER TABLE group_inbox ADD COLUMN notice_id TEXT;
      ALTER TABLE group_inbox ADD COLUMN notice_accepted INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE group_inbox ADD COLUMN delivery_failure TEXT;
      UPDATE group_inbox SET notice_accepted = noticed;
      CREATE INDEX group_inbox_by_notice ON group_inbox (notice_id) WHERE notice_id IS NOT NULL;
    `);
  },
  // 11: model contexts and standing prompts. Per conversation, the newest boundary a seat was ever
  // shown since it started (which a compaction keeps while the model-seen ledger starts over);
  // per chat, the session and the hash of the standing prompt it runs on.
  (db) => {
    db.exec(`
      ALTER TABLE group_seen ADD COLUMN visible_boundary INTEGER;
      UPDATE group_seen SET visible_boundary = boundary_seq;
      ALTER TABLE chats ADD COLUMN standing_prompt TEXT;
    `);
  },
  // 12: per chat, the failed compactions in a row of its session, on disk so a restart doesn't
  // reset them: session id, model and count.
  (db) => {
    db.exec("ALTER TABLE chats ADD COLUMN compaction_failures TEXT");
  },
  // 13: a bot's replies in a group. A bot's question to the user (its seat's question
  // approval, its status and answers) on its message, and the files a held post attaches (their
  // paths on the bot's computer), kept with its draft until it's sent.
  (db) => {
    db.exec(`
      ALTER TABLE group_messages ADD COLUMN question TEXT;
      ALTER TABLE group_drafts ADD COLUMN files TEXT NOT NULL DEFAULT '[]';
    `);
  },
  // 14: search across chats. The user's and the bot's messages in chat timelines get a
  // full-text index like group messages have (trigram, so any language and any part of a word),
  // keyed by the timeline row. A reply streams in many small updates, so the index isn't kept on
  // every write: a search first indexes what changed since each chat's indexed_seq. Messages
  // already stored are indexed here.
  (db) => {
    db.exec(`
      CREATE VIRTUAL TABLE timeline_fts USING fts5(text, chat_id UNINDEXED, seq UNINDEXED, tokenize = 'trigram');
      ALTER TABLE chats ADD COLUMN indexed_seq INTEGER NOT NULL DEFAULT 0;
      CREATE TRIGGER timeline_fts_delete AFTER DELETE ON timeline BEGIN
        DELETE FROM timeline_fts WHERE rowid = old.rowid;
      END;
      INSERT INTO timeline_fts (rowid, text, chat_id, seq)
        SELECT rowid, substr(json_extract(item, '$.text'), 1, ${TIMELINE_INDEX_CHARS}), chat_id, seq_start FROM timeline
        WHERE json_extract(item, '$.type') IN ('user_message', 'assistant_message') AND json_extract(item, '$.text') <> '';
      UPDATE chats SET indexed_seq = seq;
    `);
  },
  // 15: the wake mode where every message wakes every unmuted bot is stored as 'everyone' (older
  // databases have it under its former name).
  (db) => {
    db.exec("UPDATE groups SET wake_mode = 'everyone' WHERE wake_mode = 'raft'");
  },
  // 16: a group's leader, the member that plans and hands out the work.
  (db) => {
    db.exec("ALTER TABLE groups ADD COLUMN leader_id TEXT");
  },
  // 17: the piece of work a led member's seat session is for (its top-level message).
  (db) => {
    db.exec("ALTER TABLE group_members ADD COLUMN seat_task INTEGER");
  },
];

/** How much of one message the search index takes: a long pasted attachment doesn't need all of it. */
export const TIMELINE_INDEX_CHARS = 50_000;

export class Db {
  readonly raw: DatabaseSync;
  private depth = 0;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL");
    this.raw.exec("PRAGMA synchronous = NORMAL");
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    this.raw.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
    const row = this.raw.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
    let version = row?.version ?? 0;
    if (!row) this.raw.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
    while (version < MIGRATIONS.length) {
      const migration = MIGRATIONS[version]!;
      this.tx(() => {
        migration(this.raw);
        this.raw.prepare("UPDATE schema_version SET version = ?").run(version + 1);
      });
      version++;
    }
  }

  /** Runs `work` in one transaction (nested calls join the outer one). */
  tx<T>(work: () => T): T {
    if (this.depth > 0) return work();
    this.raw.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const result = work();
      this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    } finally {
      this.depth--;
    }
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SQLInputValue[]): void {
    this.raw.prepare(sql).run(...params);
  }

  close(): void {
    this.raw.close();
  }
}
