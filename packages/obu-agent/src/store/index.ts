// WS-C: durable store (SQLite: node:sqlite / bun:sqlite / better-sqlite3).
// Tables: sessions{id,parent,label,profile,heartbeat_at,expires_at}
//         session_tabs{session_id,tab_id,target_id,ownership,active}
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
  upsertSession(row: SessionRow): void;
  getSession(id: SessionId): SessionRow | undefined;
  deleteSession(id: SessionId): void;
  listSessions(): SessionRow[];
  putTab(row: SessionTabRow): void;
  removeTab(tabId: TabId): void;
  tabsOf(sessionId: SessionId): SessionTabRow[];
  ownerOf(tabId: TabId): SessionTabRow | undefined;
}
