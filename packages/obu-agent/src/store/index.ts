// WS-C: durable store. SQLite via node:sqlite when available (Node >= 22.5),
// otherwise an in-memory store mirrored to a JSON file. No native deps.
//
// Tables: sessions{id,parent,label,profile,heartbeat_at,expires_at}
//         session_tabs{session_id,tab_id,target_id,ownership,active}
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Ownership, SessionId, TabId, TargetId } from "../contract.js";

export interface SessionRow {
  id: SessionId;
  parent: SessionId | null;
  label: string | null;
  profile: string;
  heartbeatAt: number;
  expiresAt: number;
}

export interface SessionTabRow {
  sessionId: SessionId;
  tabId: TabId;
  targetId: TargetId | null;
  ownership: Ownership;
  active: boolean;
}

export interface Store {
  readonly kind: "sqlite" | "json" | "memory";
  upsertSession(row: SessionRow): void;
  getSession(id: SessionId): SessionRow | undefined;
  deleteSession(id: SessionId): void;
  listSessions(): SessionRow[];
  putTab(row: SessionTabRow): void;
  removeTab(tabId: TabId): void;
  tabsOf(sessionId: SessionId): SessionTabRow[];
  ownerOf(tabId: TabId): SessionTabRow | undefined;
  /** Make `tabId` the only active tab of `sessionId` (I1). `null` clears. */
  setActive(sessionId: SessionId, tabId: TabId | null): void;
  close(): void;
}

/** Open the best available store at `path` (":memory:" for tests). */
export function openStore(path: string): Store {
  if (path === ":memory:") return new MemoryStore();
  const sqlite = loadSqlite();
  if (sqlite) return new SqliteStore(sqlite, path);
  return new JsonFileStore(path.replace(/\.(sqlite|db)$/, "") + ".json");
}

// ---------------------------------------------------------------------------

class MemoryStore implements Store {
  kind: Store["kind"] = "memory";
  protected sessions = new Map<SessionId, SessionRow>();
  protected tabs = new Map<TabId, SessionTabRow>();

  upsertSession(row: SessionRow): void {
    this.sessions.set(row.id, { ...row });
    this.persist();
  }
  getSession(id: SessionId): SessionRow | undefined {
    const row = this.sessions.get(id);
    return row ? { ...row } : undefined;
  }
  deleteSession(id: SessionId): void {
    this.sessions.delete(id);
    for (const [tabId, tab] of this.tabs) if (tab.sessionId === id) this.tabs.delete(tabId);
    this.persist();
  }
  listSessions(): SessionRow[] {
    return [...this.sessions.values()].map((row) => ({ ...row }));
  }
  putTab(row: SessionTabRow): void {
    this.tabs.set(row.tabId, { ...row });
    this.persist();
  }
  removeTab(tabId: TabId): void {
    this.tabs.delete(tabId);
    this.persist();
  }
  tabsOf(sessionId: SessionId): SessionTabRow[] {
    return [...this.tabs.values()].filter((tab) => tab.sessionId === sessionId).map((tab) => ({ ...tab }));
  }
  ownerOf(tabId: TabId): SessionTabRow | undefined {
    const row = this.tabs.get(tabId);
    return row ? { ...row } : undefined;
  }
  setActive(sessionId: SessionId, tabId: TabId | null): void {
    for (const tab of this.tabs.values()) if (tab.sessionId === sessionId) tab.active = tab.tabId === tabId;
    this.persist();
  }
  close(): void {}
  protected persist(): void {}
}

class JsonFileStore extends MemoryStore {
  override kind: Store["kind"] = "json";
  constructor(private readonly path: string) {
    super();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path)) {
      try {
        const data = JSON.parse(readFileSync(path, "utf8")) as { sessions: SessionRow[]; tabs: SessionTabRow[] };
        for (const row of data.sessions ?? []) this.sessions.set(row.id, row);
        for (const row of data.tabs ?? []) this.tabs.set(row.tabId, row);
      } catch {
        // Corrupt state is not fatal: reconcile treats unknown tabs as orphans.
      }
    }
  }
  protected override persist(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sessions: [...this.sessions.values()], tabs: [...this.tabs.values()] }), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

// ---------------------------------------------------------------------------

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDb;
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): any; all(...args: unknown[]): any[] };
  close(): void;
}

function loadSqlite(): SqliteModule | undefined {
  if (process.env.OBU_AGENT_STORE === "json") return undefined;
  try {
    const require = createRequire(import.meta.url);
    // Silence the one-time ExperimentalWarning on older Node versions.
    const emit = process.emitWarning;
    process.emitWarning = (() => {}) as typeof process.emitWarning;
    try {
      return require("node:sqlite") as SqliteModule;
    } finally {
      process.emitWarning = emit;
    }
  } catch {
    return undefined;
  }
}

class SqliteStore implements Store {
  readonly kind = "sqlite" as const;
  readonly #db: SqliteDb;

  constructor(sqlite: SqliteModule, path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#db = new sqlite.DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, parent TEXT, label TEXT, profile TEXT NOT NULL,
        heartbeat_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_tabs (
        tab_id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, target_id TEXT,
        ownership TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS session_tabs_session ON session_tabs(session_id);
    `);
  }

  upsertSession(row: SessionRow): void {
    this.#db
      .prepare(
        `INSERT INTO sessions (id, parent, label, profile, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET parent=excluded.parent, label=excluded.label, profile=excluded.profile,
           heartbeat_at=excluded.heartbeat_at, expires_at=excluded.expires_at`,
      )
      .run(row.id, row.parent, row.label, row.profile, row.heartbeatAt, row.expiresAt);
  }
  getSession(id: SessionId): SessionRow | undefined {
    const row = this.#db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id);
    return row ? sessionFromRow(row) : undefined;
  }
  deleteSession(id: SessionId): void {
    this.#db.prepare(`DELETE FROM session_tabs WHERE session_id = ?`).run(id);
    this.#db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  }
  listSessions(): SessionRow[] {
    return this.#db.prepare(`SELECT * FROM sessions`).all().map(sessionFromRow);
  }
  putTab(row: SessionTabRow): void {
    this.#db
      .prepare(
        `INSERT INTO session_tabs (tab_id, session_id, target_id, ownership, active) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tab_id) DO UPDATE SET session_id=excluded.session_id, target_id=excluded.target_id,
           ownership=excluded.ownership, active=excluded.active`,
      )
      .run(row.tabId, row.sessionId, row.targetId, row.ownership, row.active ? 1 : 0);
  }
  removeTab(tabId: TabId): void {
    this.#db.prepare(`DELETE FROM session_tabs WHERE tab_id = ?`).run(tabId);
  }
  tabsOf(sessionId: SessionId): SessionTabRow[] {
    return this.#db.prepare(`SELECT * FROM session_tabs WHERE session_id = ? ORDER BY rowid`).all(sessionId).map(tabFromRow);
  }
  ownerOf(tabId: TabId): SessionTabRow | undefined {
    const row = this.#db.prepare(`SELECT * FROM session_tabs WHERE tab_id = ?`).get(tabId);
    return row ? tabFromRow(row) : undefined;
  }
  setActive(sessionId: SessionId, tabId: TabId | null): void {
    this.#db.prepare(`UPDATE session_tabs SET active = CASE WHEN tab_id = ? THEN 1 ELSE 0 END WHERE session_id = ?`).run(tabId ?? -1, sessionId);
  }
  close(): void {
    this.#db.close();
  }
}

function sessionFromRow(row: any): SessionRow {
  return {
    id: row.id,
    parent: row.parent ?? null,
    label: row.label ?? null,
    profile: row.profile,
    heartbeatAt: Number(row.heartbeat_at),
    expiresAt: Number(row.expires_at),
  };
}

function tabFromRow(row: any): SessionTabRow {
  return {
    sessionId: row.session_id,
    tabId: Number(row.tab_id),
    targetId: row.target_id ?? null,
    ownership: row.ownership as Ownership,
    active: Number(row.active) === 1,
  };
}
