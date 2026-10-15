// WS-E: uploads (setFileInputFiles fast path; chunked DataTransfer fallback
// without file-URL access; 2 s fallback for inputs that silently ignore it) and
// per-tab downloads (Page.downloadWillBegin/downloadProgress on the tab's own
// session, so a download always belongs to the tab that triggered it).
import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import type { DownloadInfo, TabId } from "../contract.js";
import { ObuError } from "../errors.js";
import type { FrameHandle, PageContext, TabCdp } from "../seams.js";
import { callOn, type ElementTarget } from "../actions/target.js";
import { fnFileCount, fnUploadChunk, fnUploadCommit } from "../actions/page-fns.js";

export const UPLOAD_CHUNK_BYTES = 512 * 1024;
export const UPLOAD_VERIFY_MS = 2000;
export const UPLOAD_MAX_BYTES = 200 * 1024 * 1024;

const MIME: Record<string, string> = {
  ".txt": "text/plain", ".csv": "text/csv", ".json": "application/json", ".pdf": "application/pdf", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".html": "text/html", ".md": "text/markdown", ".zip": "application/zip", ".mp4": "video/mp4", ".mp3": "audio/mpeg",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".xml": "application/xml",
};

export function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export interface UploadResult {
  mode: "setFileInputFiles" | "inject-input" | "inject-drop";
  files: string[];
  warnings: string[];
}

async function checkFiles(files: string[]): Promise<{ path: string; size: number; mtime: number }[]> {
  if (!files.length) throw new ObuError("invalid_params", "upload needs `files`: absolute local paths.");
  const out = [];
  let total = 0;
  for (const f of files) {
    if (!isAbsolute(f)) throw new ObuError("invalid_params", `Upload paths must be absolute: "${f}".`);
    let s;
    try {
      s = await stat(f);
    } catch {
      throw new ObuError("invalid_params", `File not found: ${f}`);
    }
    if (!s.isFile()) throw new ObuError("invalid_params", `Not a file: ${f}`);
    total += s.size;
    out.push({ path: f, size: s.size, mtime: s.mtimeMs });
  }
  if (total > UPLOAD_MAX_BYTES) throw new ObuError("invalid_params", `Upload too large (${total} bytes; limit ${UPLOAD_MAX_BYTES}).`);
  return out;
}

/** Inject files into the element through the isolated world (no file-URL access needed). */
async function injectFiles(page: PageContext, frame: FrameHandle, objectId: string, files: { path: string; mtime: number }[]): Promise<{ count: number; mode: string }> {
  const key = `__obuUpload${Math.random().toString(36).slice(2)}`;
  for (let i = 0; i < files.length; i++) {
    const buf = await readFile(files[i].path);
    if (buf.length === 0) await callOn(page, frame, objectId, fnUploadChunk, [key, i, 0, ""]);
    for (let off = 0, c = 0; off < buf.length; off += UPLOAD_CHUNK_BYTES, c++) {
      await callOn(page, frame, objectId, fnUploadChunk, [key, i, c, buf.subarray(off, off + UPLOAD_CHUNK_BYTES).toString("base64")]);
    }
  }
  const meta = files.map((f) => ({ name: basename(f.path), type: mimeFor(f.path), lastModified: Math.round(f.mtime) }));
  return callOn(page, frame, objectId, fnUploadCommit, [key, meta]);
}

/**
 * Upload to a file input or drop zone. `target` is the element the agent named:
 * - <input type=file>: DOM.setFileInputFiles, verified; else injected DataTransfer.
 * - anything else: if clicking it opens a file chooser (intercepted), fill that
 *   chooser's input; otherwise drop the files on it.
 * `clickToOpen` clicks the element (used for buttons that open a chooser).
 */
export async function uploadFiles(
  page: PageContext,
  target: ElementTarget,
  files: string[],
  opts: { isFileInput: boolean; clickToOpen: () => Promise<void> },
): Promise<UploadResult> {
  const checked = await checkFiles(files);
  const warnings: string[] = [];
  let frame = target.frame;
  let objectId = target.objectId;

  if (!opts.isFileInput) {
    // Button / label that opens a chooser: intercept it and get the real input.
    const chooser = await interceptChooser(page, opts.clickToOpen);
    if (chooser) {
      const resolved = await page.cdp.send<{ object: { objectId: string } }>(
        "DOM.resolveNode",
        { backendNodeId: chooser.backendNodeId, executionContextId: frame.utilityContextId },
        { sessionId: frame.sessionId },
      ).catch(() => null);
      if (resolved?.object.objectId) {
        objectId = resolved.object.objectId;
        if (chooser.mode === "selectSingle" && checked.length > 1) throw new ObuError("invalid_params", "This file input accepts a single file; pass one path.");
      } else {
        warnings.push("file chooser opened in a frame we could not resolve; dropped files on the element instead");
      }
    } else {
      const r = await injectFiles(page, frame, objectId, checked);
      return { mode: r.mode === "drop" ? "inject-drop" : "inject-input", files: checked.map((f) => f.path), warnings };
    }
  }

  // Fast path. chrome.debugger without file-URL access rejects this ("Not allowed").
  try {
    await page.cdp.send("DOM.setFileInputFiles", { files: checked.map((f) => f.path), objectId }, { sessionId: frame.sessionId });
    const deadline = Date.now() + UPLOAD_VERIFY_MS;
    while (Date.now() < deadline) {
      const n = await callOn<number>(page, frame, objectId, fnFileCount);
      if (n === checked.length) return { mode: "setFileInputFiles", files: checked.map((f) => f.path), warnings };
      await new Promise((r) => setTimeout(r, 100));
    }
    warnings.push("setFileInputFiles did not take effect within 2 s; injected the files instead");
  } catch (err) {
    if (err instanceof ObuError && err.code === "stale_ref") throw err;
    // Expected without file-URL access; fall through to injection.
  }
  const r = await injectFiles(page, frame, objectId, checked);
  if (r.count !== checked.length) throw new ObuError("internal", `Upload injection set ${r.count} of ${checked.length} files.`);
  return { mode: "inject-input", files: checked.map((f) => f.path), warnings };
}

async function interceptChooser(page: PageContext, click: () => Promise<void>): Promise<{ backendNodeId: number; mode: string } | null> {
  let resolveChooser!: (v: { backendNodeId: number; mode: string } | null) => void;
  const opened = new Promise<{ backendNodeId: number; mode: string } | null>((r) => (resolveChooser = r));
  const off = page.cdp.on("Page.fileChooserOpened", (p: { backendNodeId?: number; mode: string }) => {
    if (p.backendNodeId) resolveChooser({ backendNodeId: p.backendNodeId, mode: p.mode });
  });
  try {
    await page.cdp.send("Page.setInterceptFileChooserDialog", { enabled: true }).catch(() => undefined);
    await click();
    const timer = new Promise<null>((r) => setTimeout(() => r(null), UPLOAD_VERIFY_MS));
    return await Promise.race([opened, timer]);
  } finally {
    off();
    await page.cdp.send("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

export interface PendingDownload {
  guid: string;
  url: string;
  suggestedFilename: string;
  startedAt: number;
  tabId: TabId;
}

/**
 * Maps a CDP download to its absolute path. WS-C/WS-A supply the real one
 * (chrome.downloads correlation by url + time); the default assumes
 * `Browser.setDownloadBehavior{allowAndName}` into `downloadDir` (file = guid).
 */
export type DownloadPathResolver = (d: PendingDownload) => Promise<string | undefined>;

export interface DownloadTrackerOptions {
  resolvePath?: DownloadPathResolver;
  /** Directory used by the default resolver. */
  downloadDir?: string;
  /** 'guid' (allowAndName) or 'suggested' (allow). */
  naming?: "guid" | "suggested";
}

let nextDownloadId = 1;

/** PageContext.emit input (distributive SystemEventInput). */
type EmitArg = Parameters<PageContext["emit"]>[0];

/** Per-tab download tracker built on the tab's own CDP session. */
export class DownloadTracker {
  private readonly byGuid = new Map<string, DownloadInfo & { guid: string; startedAt: number; suggestedFilename: string }>();
  private readonly finished: DownloadInfo[] = [];
  private waiters: ((d: DownloadInfo) => void)[] = [];
  private readonly unsubs: (() => void)[] = [];

  constructor(private page: PageContext, private readonly opts: DownloadTrackerOptions = {}) {
    const cdp = page.cdp;
    this.unsubs.push(
      cdp.on("Page.downloadWillBegin", (p: { guid: string; url: string; suggestedFilename: string }) => this.begin(p)),
      cdp.on("Browser.downloadWillBegin", (p: { guid: string; url: string; suggestedFilename: string }) => this.begin(p)),
      cdp.on("Page.downloadProgress", (p: { guid: string; totalBytes: number; receivedBytes: number; state: string }) => void this.progress(p)),
      cdp.on("Browser.downloadProgress", (p: { guid: string; totalBytes: number; receivedBytes: number; state: string; filePath?: string }) => void this.progress(p)),
    );
  }

  private begin(p: { guid: string; url: string; suggestedFilename: string }): void {
    if (this.byGuid.has(p.guid)) return;
    const d = {
      downloadId: nextDownloadId++,
      guid: p.guid,
      url: p.url,
      path: "",
      state: "in_progress" as const,
      tabId: this.page.cdp.tabId,
      startedAt: Date.now(),
      suggestedFilename: p.suggestedFilename,
    };
    this.byGuid.set(p.guid, d);
    this.page.emit({ type: "download_started", tabId: d.tabId, download: this.publicInfo(d) } as EmitArg);
  }

  private async progress(p: { guid: string; totalBytes: number; receivedBytes: number; state: string; filePath?: string }): Promise<void> {
    const d = this.byGuid.get(p.guid);
    if (!d || d.state !== "in_progress") return;
    if (p.state === "inProgress") {
      d.bytes = p.receivedBytes;
      return;
    }
    d.state = p.state === "completed" ? "complete" : "interrupted";
    d.bytes = p.receivedBytes;
    d.path = p.filePath ?? (await this.resolve({ guid: d.guid, url: d.url, suggestedFilename: d.suggestedFilename, startedAt: d.startedAt, tabId: d.tabId ?? this.page.cdp.tabId })) ?? "";
    if (d.path) {
      try {
        d.bytes = (await stat(d.path)).size;
      } catch { /* resolver may point at a path still being renamed */ }
    }
    d.mime = mimeFor(d.suggestedFilename || d.path);
    const info = this.publicInfo(d);
    this.page.emit({ type: "download_finished", tabId: d.tabId, download: info } as EmitArg);
    const waiters = this.waiters;
    this.waiters = [];
    if (waiters.length) waiters.forEach((w) => w(info));
    else this.finished.push(info);
  }

  private async resolve(d: PendingDownload): Promise<string | undefined> {
    if (this.opts.resolvePath) return this.opts.resolvePath(d);
    if (!this.opts.downloadDir) return undefined;
    return join(this.opts.downloadDir, this.opts.naming === "suggested" ? d.suggestedFilename : d.guid);
  }

  private publicInfo(d: DownloadInfo & { guid: string }): DownloadInfo {
    const { downloadId, url, path, mime, bytes, state, tabId } = d;
    return { downloadId, url, path, mime, bytes, state, tabId };
  }

  /** PageContext is per call; events go to the latest one for this tab. */
  bindPage(page: PageContext): void {
    this.page = page;
  }

  /** In-progress downloads of this tab. */
  active(): DownloadInfo[] {
    return [...this.byGuid.values()].filter((d) => d.state === "in_progress").map((d) => this.publicInfo(d));
  }

  /** Next finished download of this tab (one already finished and unclaimed counts). */
  waitNext(timeoutMs: number): Promise<DownloadInfo | null> {
    const ready = this.finished.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const w = (d: DownloadInfo) => { clearTimeout(timer); resolve(d); };
      const timer = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); resolve(null); }, timeoutMs);
      this.waiters.push(w);
    });
  }

  dispose(): void {
    for (const u of this.unsubs) u();
  }
}

const trackers = new WeakMap<TabCdp, DownloadTracker>();
let defaultTrackerOptions: DownloadTrackerOptions = {};

/** WS-C sets the real path resolver (chrome.downloads correlation) once at startup. */
export function configureDownloads(opts: DownloadTrackerOptions): void {
  defaultTrackerOptions = opts;
}

/** The tab's tracker (created on first use; lives as long as the TabCdp). */
export function downloadTracker(page: PageContext, opts?: DownloadTrackerOptions): DownloadTracker {
  let t = trackers.get(page.cdp);
  if (!t) {
    t = new DownloadTracker(page, opts ?? defaultTrackerOptions);
    trackers.set(page.cdp, t);
  }
  t.bindPage(page);
  return t;
}
