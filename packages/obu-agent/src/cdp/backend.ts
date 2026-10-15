// WS-C: the browser backend seam. The daemon core talks to Chrome only through
// this interface; two implementations exist:
//   - ObuHostBackend  (obu-host.ts): extension + native host socket (production)
//   - DirectCdpBackend (direct.ts):  --remote-debugging-port websocket (tests,
//     Chrome for Testing, and the round-2 "fast mode" spike)
import type { TabId, TargetId } from "../contract.js";

export interface BackendTab {
  tabId: TabId;
  targetId?: TargetId;
  url: string;
  title: string;
  /** Selected tab of its window. */
  active?: boolean;
  /** The tab's window is the focused window. */
  windowFocused?: boolean;
  groupTitle?: string;
  lastAccessed?: number;
}

/**
 * Who a backend operation is on behalf of. `key` is the backend-level owner
 * (the extension session id); the daemon uses one key per daemon session.
 */
export interface BackendOwner {
  key: string;
  label?: string;
}

export type BackendEvent =
  | { type: "cdp"; tabId: TabId; method: string; params: any; sessionId?: string }
  | { type: "tab_closed"; tabId: TabId }
  | { type: "popup"; tabId: TabId; openerTabId: TabId; url?: string; targetId?: TargetId }
  | { type: "lease_revoked"; tabId: TabId; reason: "dragged_out_of_group" | "user_closed" | "user_took_over" }
  | { type: "disconnected"; error?: string }
  /** The debugger (re)attached to a tab: per-tab CDP setup must be redone. */
  | { type: "attached"; tabId: TabId }
  /** The debugger detached from a tab (idle detach, infobar Cancel): CDP state is gone. */
  | { type: "detached"; tabId: TabId; reason: string }
  /**
   * A browser-level download change (chrome.downloads), attributed to a tab when
   * the backend can tell. Backends that emit these set `capabilities.downloads`.
   */
  | {
      type: "download";
      id: string;
      tabId?: TabId;
      url: string;
      path: string;
      status: "started" | "in_progress" | "complete" | "interrupted";
      mime?: string;
      bytes?: number;
    }
  /** The backend finalized a session on its own (e.g. extension lease backstop). */
  | { type: "owner_expired"; ownerKey: string; closedTabIds: TabId[] };

/** What a connected backend can do natively (feature-detected, never version-sniffed). */
export interface BackendCapabilities {
  /** Pushes tab_closed / lease_revoked / popup events: no polling needed. */
  tabEvents: boolean;
  /** Emits `download` events with the final file path. */
  downloads: boolean;
  /** Has a guarded closeTab RPC. */
  closeTab: boolean;
}

export interface SendOptions {
  /** Flat child session (OOPIF) id from Target.attachedToTarget. */
  sessionId?: string;
  timeoutMs?: number;
}

export interface BrowserBackend {
  readonly kind: "obu-host" | "direct";
  connect(): Promise<void>;
  isConnected(): boolean;
  version(): string | undefined;
  /** Native capabilities of the connected browser side. */
  capabilities(): BackendCapabilities;
  /** New background tab (never focused, never activates the user's tab), grouped for `owner`. */
  createTab(owner: BackendOwner, url: string): Promise<BackendTab>;
  closeTab(owner: BackendOwner, tabId: TabId): Promise<void>;
  /** Claim a user tab for `owner` (borrowed). */
  claimTab(owner: BackendOwner, tabId: TabId): Promise<BackendTab>;
  /** Hand a tab's backend-level ownership to another owner (tabs.transfer). Best effort. */
  moveTab?(from: BackendOwner, to: BackendOwner, tabId: TabId): Promise<void>;
  /** Extension-level finalize of a root owner (tab group bookkeeping). Optional. */
  finalize?(owner: BackendOwner, keep: { tabId: TabId; status: "handoff" | "deliverable" }[]): Promise<void>;
  /** Release a borrowed tab without closing it. */
  releaseTab(owner: BackendOwner, tabId: TabId): Promise<void>;
  /** Fetch one tab, or undefined when it no longer exists. */
  getTab(tabId: TabId): Promise<BackendTab | undefined>;
  /** The user's whole tab strip (read-only). */
  listBrowserTabs(): Promise<BackendTab[]>;
  /** Attach the debugger (idempotent). */
  attach(owner: BackendOwner, tabId: TabId): Promise<void>;
  send<T = any>(owner: BackendOwner, tabId: TabId, method: string, params?: Record<string, unknown>, opts?: SendOptions): Promise<T>;
  onEvent(handler: (event: BackendEvent) => void): () => void;
  close(): Promise<void>;
}

export class Emitter<E> {
  #handlers = new Set<(event: E) => void>();
  on(handler: (event: E) => void): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }
  emit(event: E): void {
    for (const handler of this.#handlers) {
      try {
        handler(event);
      } catch {
        // A faulty subscriber must not break the backend's event pump.
      }
    }
  }
}

/** True when a backend error means the tab is gone (closed / crashed / detached). */
export function isTabGoneError(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error);
  return /No tab with (given )?id|No target with given id|Target closed|target.*not found|Session with given id not found|Cannot access a chrome:|tab was closed|Detached while handling command/i.test(
    message,
  );
}

/** True when an execution context is gone (navigation) and the world must be recreated. */
export function isContextGoneError(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error);
  return /Cannot find context with specified id|Execution context was destroyed|Cannot find default execution context|Inspected target navigated or closed|uniqueContextId not found/i.test(
    message,
  );
}
