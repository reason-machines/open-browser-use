// WS-E: uploads (setFileInputFiles fast path; chunked DataTransfer fallback without
// file-URL access; 2 s iframe fallback) and per-tab downloads (downloadWillBegin <-> chrome.downloads).
export const UPLOAD_CHUNK_BYTES = 512 * 1024;
