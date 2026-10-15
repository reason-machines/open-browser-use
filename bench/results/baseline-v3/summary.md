# Run baseline-v3

| suite | agent | tasks | success | score | median s | median steps | median tokens | tab leaks (tasks) | tabs left (total) |
|---|---|---|---|---|---|---|---|---|---|
| hard | aside | 25 | 23/25 (92%) | 23.0 | 16 | 4 | 358591 | 0 | 0 |
| hard | ours | 25 | 22/25 (88%) | 22.5 | 21 | 10 | 250914 | 0 | 0 |
| hard | ours-in-aside | 25 | 22/25 (88%) | 22.0 | 22 | 10 | 223556 | 1 | 1 |
| hard | ours-new | 25 | 22/25 (88%) | 22.5 | 20 | 5 | 201231 | 1 | 1 |
| mind2web | aside | 20 | 6/20 (30%) | 13.0 | 37 | 12 | 1069500 | 0 | 0 |
| mind2web | ours | 20 | 4/20 (20%) | 9.5 | 54 | 19 | 615310 | 2 | 2 |
| mind2web | ours-in-aside | 20 | 3/20 (15%) | 10.5 | 55 | 22 | 663808 | 1 | 1 |
| mind2web | ours-new | 20 | 3/20 (15%) | 8.0 | 37 | 8 | 347496 | 6 | 6 |

| task | category | aside | ours | ours-in-aside | ours-new |
|---|---|---|---|---|---|
| fx-datepicker | complex-widget | ✅ 21s 7st  | ✅ 17s 8st  | ✅ 15s 7st  | ✅ 22s 13st  |
| fx-delayed | waiting-overlays | ✅ 15s 4st  | ✅ 21s 10st  | ✅ 15s 10st  | ✅ 23s 7st  |
| fx-dialogs | js-dialogs | ❌ 27s 9st dialog_or_popup | ✅ 31s 9st  | ❌ 37s 8st dialog_or_popup | ❌ 30s 6st dialog_or_popup |
| fx-download | download-read | ✅ 15s 5st  | ✅ 21s 8st  | ✅ 17s 10st  | ✅ 15s 4st  |
| fx-dragdrop | drag-drop | ✅ 21s 5st  | ✅ 61s 20st  | ✅ 66s 25st  | ✅ 28s 10st  |
| fx-hover | hover-menus | ✅ 16s 4st  | ✅ 34s 19st  | ✅ 46s 16st  | ✅ 26s 13st  |
| fx-iframe | iframe-oopif | ✅ 9s 2st  | ✅ 30s 16st  | ✅ 30s 12st  | ✅ 24s 5st  |
| fx-infinite | infinite-scroll | ✅ 47s 8st  | ✅ 13s 6st  | ✅ 41s 10st  | ❌ 83s 14st scroll_or_pagination |
| fx-popup | popup-multi-window | ✅ 32s 7st  | ❌ 29s 13st dialog_or_popup | ❌ 41s 18st dialog_or_popup | ✅ 19s 5st  |
| fx-shadow | shadow-dom | ✅ 16s 3st  | ✅ 15s 7st  | ✅ 24s 6st  | ✅ 15s 4st  |
| fx-upload | file-upload | ✅ 20s 5st  | ❌ 223s 15st download_or_upload | ❌ 146s 11st download_or_upload 🗂1 tab(s) left | ✅ 80s 4st  |
| fx-widgets | complex-widget | ✅ 9s 2st  | ✅ 18s 6st  | ✅ 15s 7st  | ✅ 11s 4st  |
| live-arxiv-transformer | download-read | ✅ 32s 4st  | ✅ 60s 14st  | ✅ 21s 7st  | ✅ 96s 16st  🗂1 tab(s) left |
| live-books-mystery | ecommerce-filter-sort | ✅ 10s 4st  | ❌ 18s 12st incomplete | ✅ 33s 13st  | ✅ 16s 4st  |
| live-herokuapp-gauntlet | waiting-overlays | ✅ 73s 15st  | ✅ 60s 32st  | ✅ 60s 25st  | ❌ 90s 15st dialog_or_popup |
| live-hn-dropbox | multi-hop-nav | ✅ 7s 2st  | ✅ 13s 5st  | ✅ 12s 4st  | ✅ 13s 2st  |
| live-jqueryui-datepicker | complex-widget | ❌ 16s 5st wrong_answer | ✅ 62s 29st  | ✅ 49s 22st  | ✅ 21s 9st  |
| live-multitab-stars | multi-tab-compare | ✅ 56s 4st  | ✅ 17s 11st  | ✅ 20s 10st  | ✅ 20s 5st  |
| live-nobel-physics | multi-hop-research | ✅ 10s 1st  | ✅ 14s 10st  | ✅ 16s 10st  | ✅ 20s 7st  |
| live-oscar-zemeckis | multi-hop-research | ✅ 12s 3st  | ✅ 13s 7st  | ✅ 22s 7st  | ✅ 16s 5st  |
| live-pypi-requests | multi-hop-nav | ✅ 24s 5st  | ✅ 27s 7st  | ✅ 14s 4st  | ✅ 12s 2st  |
| live-quotes-scroll | infinite-scroll | ✅ 13s 2st  | ✅ 60s 10st  | ✅ 48s 13st  | ✅ 25s 7st  |
| live-rfc9110 | multi-hop-research | ✅ 9s 2st  | ✅ 12s 4st  | ✅ 13s 4st  | ✅ 20s 5st  |
| live-vscode-issue1 | multi-hop-nav | ✅ 19s 2st  | ✅ 18s 4st  | ✅ 20s 4st  | ✅ 13s 2st  |
| live-wiki-table | table-extraction | ✅ 17s 3st  | ✅ 16s 4st  | ✅ 11s 4st  | ✅ 15s 2st  |
| m2w-0059adc6 | mind2web-easy | ❌ 34s 10st incomplete | ❌ 56s 19st incomplete | ❌ 39s 14st incomplete | ✅ 45s 12st  🗂1 tab(s) left |
| m2w-005be9dd | mind2web-easy | ✅ 18s 4st  | ✅ 30s 12st  | ❌ 47s 14st hallucination | ❌ 37s 8st hallucination |
| m2w-0170ca95 | mind2web-medium | ❌ 21s 5st incomplete | ❌ 44s 15st incomplete | ❌ 24s 13st incomplete | ❌ 16s 5st incomplete |
| m2w-01abae96 | mind2web-easy | ❌ 66s 14st incomplete | ❌ 61s 25st incomplete | ❌ 112s 26st gave_up | ❌ 37s 8st incomplete |
| m2w-04613880 | mind2web-hard | ❌ 31s 12st wrong_answer | ❌ 52s 20st wrong_answer | ❌ 27s 13st incomplete | ✅ 45s 8st  🗂1 tab(s) left |
| m2w-05483c50 | mind2web-medium | ❌ 40s 17st incomplete | ❌ 142s 19st incomplete | ❌ 49s 19st incomplete | ❌ 61s 16st incomplete 🗂1 tab(s) left |
| m2w-0632e496 | mind2web-easy | ✅ 17s 8st  | ✅ 30s 15st  | ✅ 37s 14st  | ✅ 30s 9st  |
| m2w-070c907d | mind2web-medium | ❌ 32s 8st incomplete | ❌ 57s 43st interaction_failed | ❌ 78s 25st hallucination | ❌ 31s 6st incomplete 🗂1 tab(s) left |
| m2w-07bdc595 | mind2web-easy | ❌ 124s 13st blocked_or_captcha | ❌ 59s 21st gave_up | ❌ 57s 23st navigation | ❌ 50s 20st interaction_failed |
| m2w-07ec4a12 | mind2web-easy | ✅ 102s 15st  | ❌ 68s 13st tool_error_or_infra 🗂1 tab(s) left | ❌ 172s 22st tool_error_or_infra | ❌ 30s 6st blocked_or_captcha |
| m2w-0a0fa834 | mind2web-hard | ❌ 20s 12st incomplete | ❌ 71s 22st incomplete | ❌ 41s 28st incomplete | ❌ 48s 11st blocked_or_captcha |
| m2w-0b2623e9 | mind2web-medium | ❌ 64s 23st incomplete | ❌ 23s 9st blocked_or_captcha | ❌ 14s 7st blocked_or_captcha | ❌ 23s 5st blocked_or_captcha |
| m2w-0b838cd5 | mind2web-medium | ✅ 51s 12st  | ❌ 35s 19st gave_up | ❌ 52s 30st wrong_answer | ❌ 60s 9st blocked_or_captcha |
| m2w-1223b075 | mind2web-medium | ✅ 85s 56st  | ✅ 72s 25st  | ✅ 146s 44st  | ❌ 117s 44st wrong_answer |
| m2w-1ab384fb | mind2web-hard | ❌ 68s 23st interaction_failed | ❌ 43s 22st gave_up 🗂1 tab(s) left | ❌ 76s 51st incomplete 🗂1 tab(s) left | ❌ 37s 12st interaction_failed 🗂1 tab(s) left |
| m2w-239a29bd | mind2web-hard | ❌ 20s 5st wrong_answer | ❌ 40s 16st incomplete | ❌ 34s 14st incomplete | ❌ 42s 7st incomplete |
| m2w-28e7574e | mind2web-hard | ❌ 75s 17st incomplete | ❌ 84s 33st interaction_failed | ❌ 58s 28st incomplete | ❌ 24s 5st navigation |
| m2w-301f267f | mind2web-hard | ❌ 27s 9st incomplete | ❌ 32s 18st incomplete | ❌ 65s 38st incomplete | ❌ 115s 12st incomplete 🗂1 tab(s) left |
| m2w-354b4ddf | mind2web-hard | ✅ 24s 13st  | ✅ 66s 26st  | ✅ 66s 25st  | ❌ 24s 6st navigation |
| m2w-39c388cd | mind2web-hard | ❌ 73s 24st incomplete | ❌ 24s 7st blocked_or_captcha | ❌ 66s 16st incomplete | ❌ 17s 3st blocked_or_captcha |
