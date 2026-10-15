# Run baseline-v2

| suite | agent | tasks | success | score | median s | median steps | median tokens | tab leaks (tasks) | tabs left (total) |
|---|---|---|---|---|---|---|---|---|---|
| hard | aside | 25 | 23/25 (92%) | 23.0 | 16 | 4 | 358591 | 0 | 0 |
| hard | ours | 25 | 22/25 (88%) | 22.0 | 19 | 10 | 228267 | 0 | 0 |
| mind2web | aside | 20 | 8/20 (40%) | 12.5 | 19 | 3 | 295144 | 0 | 0 |
| mind2web | ours | 20 | 4/20 (20%) | 10.0 | 27 | 11 | 268506 | 1 | 1 |

| task | category | aside | ours |
|---|---|---|---|
| fx-datepicker | complex-widget | ✅ 21s 7st  | ✅ 15s 7st  |
| fx-delayed | waiting-overlays | ✅ 15s 4st  | ✅ 19s 10st  |
| fx-dialogs | js-dialogs | ❌ 27s 9st dialog_or_popup | ✅ 34s 10st  |
| fx-download | download-read | ✅ 15s 5st  | ✅ 23s 8st  |
| fx-dragdrop | drag-drop | ✅ 21s 5st  | ❌ 59s 30st interaction_failed |
| fx-hover | hover-menus | ✅ 16s 4st  | ✅ 44s 15st  |
| fx-iframe | iframe-oopif | ✅ 9s 2st  | ✅ 22s 13st  |
| fx-infinite | infinite-scroll | ✅ 47s 8st  | ✅ 16s 6st  |
| fx-popup | popup-multi-window | ✅ 32s 7st  | ✅ 38s 20st  |
| fx-shadow | shadow-dom | ✅ 16s 3st  | ✅ 15s 6st  |
| fx-upload | file-upload | ✅ 20s 5st  | ❌ 205s 15st download_or_upload |
| fx-widgets | complex-widget | ✅ 9s 2st  | ✅ 19s 6st  |
| live-arxiv-transformer | download-read | ✅ 32s 4st  | ✅ 38s 10st  |
| live-books-mystery | ecommerce-filter-sort | ✅ 10s 4st  | ✅ 25s 11st  |
| live-herokuapp-gauntlet | waiting-overlays | ✅ 73s 15st  | ✅ 58s 21st  |
| live-hn-dropbox | multi-hop-nav | ✅ 7s 2st  | ✅ 11s 4st  |
| live-jqueryui-datepicker | complex-widget | ❌ 16s 5st wrong_answer | ✅ 49s 16st  |
| live-multitab-stars | multi-tab-compare | ✅ 56s 4st  | ✅ 17s 11st  |
| live-nobel-physics | multi-hop-research | ✅ 10s 1st  | ✅ 17s 7st  |
| live-oscar-zemeckis | multi-hop-research | ✅ 12s 3st  | ✅ 15s 7st  |
| live-pypi-requests | multi-hop-nav | ✅ 24s 5st  | ✅ 10s 4st  |
| live-quotes-scroll | infinite-scroll | ✅ 13s 2st  | ❌ 29s 11st scroll_or_pagination |
| live-rfc9110 | multi-hop-research | ✅ 9s 2st  | ✅ 14s 4st  |
| live-vscode-issue1 | multi-hop-nav | ✅ 19s 2st  | ✅ 14s 4st  |
| live-wiki-table | table-extraction | ✅ 17s 3st  | ✅ 11s 4st  |
| m2w-0059adc6 | mind2web-easy | ✅ 17s 2st  | ✅ 16s 7st  |
| m2w-005be9dd | mind2web-easy | ✅ 10s 1st  | ❌ 21s 8st incomplete |
| m2w-0170ca95 | mind2web-medium | ✅ 14s 2st  | ❌ 24s 11st incomplete |
| m2w-01abae96 | mind2web-easy | ❌ 32s 3st wrong_answer | ❌ 25s 10st incomplete |
| m2w-04613880 | mind2web-hard | ✅ 50s 6st  | ❌ 22s 13st incomplete |
| m2w-05483c50 | mind2web-medium | ❌ 33s 9st incomplete | ❌ 80s 30st incomplete |
| m2w-0632e496 | mind2web-easy | ✅ 19s 5st  | ✅ 21s 11st  |
| m2w-070c907d | mind2web-medium | ❌ 13s 2st incomplete | ❌ 27s 7st incomplete |
| m2w-07bdc595 | mind2web-easy | ❌ 6s 0st incomplete | ❌ 29s 8st gave_up |
| m2w-07ec4a12 | mind2web-easy | ✅ 13s 2st  | ✅ 27s 10st  |
| m2w-0a0fa834 | mind2web-hard | ❌ 23s 6st incomplete | ❌ 40s 25st incomplete |
| m2w-0b2623e9 | mind2web-medium | ❌ 32s 8st gave_up | ❌ 24s 14st blocked_or_captcha |
| m2w-0b838cd5 | mind2web-medium | ❌ 25s 3st incomplete | ❌ 18s 7st incomplete |
| m2w-1223b075 | mind2web-medium | ✅ 168s 20st  | ❌ 50s 23st gave_up 🗂1 tab(s) left |
| m2w-1ab384fb | mind2web-hard | ❌ 46s 8st interaction_failed | ❌ 79s 41st gave_up |
| m2w-239a29bd | mind2web-hard | ❌ 12s 1st incomplete | ❌ 26s 10st incomplete |
| m2w-28e7574e | mind2web-hard | ❌ 19s 3st incomplete | ❌ 22s 8st incomplete |
| m2w-301f267f | mind2web-hard | ❌ 18s 3st hallucination | ✅ 28s 19st  |
| m2w-354b4ddf | mind2web-hard | ✅ 19s 6st  | ❌ 47s 17st interaction_failed |
| m2w-39c388cd | mind2web-hard | ❌ 25s 8st incomplete | ❌ 28s 19st incomplete |
