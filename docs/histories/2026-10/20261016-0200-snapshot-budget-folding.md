# Snapshot budget folding + closed shadow roots (r2-snapshot)

- `snapshot` gains `budget` (default 8K interactive / maxChars−1000 full; 0 = off). Over budget: lossless tidy (footnote links, fragment urls, long queries, duplicate image links), then fold off-screen (above first) → bottom-of-screen subtrees into `[collapsed]` one-liners with expandable refs; long sibling runs are chunked (8) so far parts of one list fold; folded runs merge into one line whose ref expands from the run's first item.
- Unwrapped containers are kept as transparent groups (rendering unchanged) so cards/posts fold as units.
- Closed shadow roots via `DOM.getDocument{pierce}` + `DOM.resolveNode` + `__obu.registerClosedRoot`, gated by a cheap candidate probe, once per document.
- Results (interactive p50 chars / ms, budget off → on): Wikipedia 67.6K→7.2K (27→25 ms), Amazon search 51.7K→7.3K (30→27), GitHub repo 14.6K→7.3K (14→13), HN 15.8K→7.5K (5→5), X-like feed 34.6K→7.3K, LinkedIn-like feed 27.0K→7.3K, 1000-link list 44.8K→7.4K. Full mode no longer fails with snapshot_too_large on these pages (folds to ≤ 39K).
- New fixtures: feed-x, feed-linkedin, closed-shadow. Test harness CDP port range overridable via `OBU_TEST_CDP_PORTS`.
