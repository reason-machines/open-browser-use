# Run baseline-20261015

| suite | agent | tasks | success | score | median s | median steps | median tokens |
|---|---|---|---|---|---|---|---|
| hard | aside | 25 | 25/25 (100%) | 25.0 | 40 | 6 | 513439 |
| hard | ours | 25 | 19/25 (76%) | 19.5 | 19 | 10 | 233998 |
| mind2web | aside | 20 | 1/20 (5%) | 5.0 | 15 | 1 | 112223 |
| mind2web | ours | 20 | 2/20 (10%) | 9.0 | 30 | 12 | 310938 |

| task | category | aside | ours |
|---|---|---|---|
| fx-datepicker | complex-widget | ✅ 40s 8st  | ❌ 13s 3st tool_error_or_infra |
| fx-delayed | waiting-overlays | ✅ 24s 5st  | ✅ 20s 9st  |
| fx-dialogs | js-dialogs | ✅ 108s 16st  | ✅ 47s 11st  |
| fx-download | download-read | ✅ 29s 5st  | ✅ 27s 14st  |
| fx-dragdrop | drag-drop | ✅ 53s 9st  | ✅ 60s 24st  |
| fx-hover | hover-menus | ✅ 35s 6st  | ❌ 36s 16st interaction_failed |
| fx-iframe | iframe-oopif | ✅ 23s 4st  | ❌ 19s 4st tool_error_or_infra |
| fx-infinite | infinite-scroll | ✅ 141s 16st  | ✅ 26s 10st  |
| fx-popup | popup-multi-window | ✅ 65s 9st  | ❌ 44s 24st dialog_or_popup |
| fx-shadow | shadow-dom | ✅ 19s 2st  | ✅ 17s 7st  |
| fx-upload | file-upload | ✅ 46s 10st  | ❌ 80s 11st download_or_upload |
| fx-widgets | complex-widget | ✅ 54s 11st  | ❌ 17s 6st tool_error_or_infra |
| live-arxiv-transformer | download-read | ✅ 42s 6st  | ✅ 16s 10st  |
| live-books-mystery | ecommerce-filter-sort | ✅ 56s 9st  | ✅ 23s 11st  |
| live-herokuapp-gauntlet | waiting-overlays | ✅ 152s 22st  | ✅ 64s 29st  |
| live-hn-dropbox | multi-hop-nav | ✅ 14s 2st  | ✅ 11s 4st  |
| live-jqueryui-datepicker | complex-widget | ✅ 18s 4st  | ✅ 25s 12st  |
| live-multitab-stars | multi-tab-compare | ✅ 50s 6st  | ✅ 19s 10st  |
| live-nobel-physics | multi-hop-research | ✅ 32s 4st  | ✅ 16s 7st  |
| live-oscar-zemeckis | multi-hop-research | ✅ 30s 6st  | ✅ 15s 7st  |
| live-pypi-requests | multi-hop-nav | ✅ 70s 11st  | ✅ 13s 7st  |
| live-quotes-scroll | infinite-scroll | ✅ 102s 16st  | ✅ 59s 16st  |
| live-rfc9110 | multi-hop-research | ✅ 10s 1st  | ✅ 10s 4st  |
| live-vscode-issue1 | multi-hop-nav | ✅ 19s 3st  | ✅ 12s 4st  |
| live-wiki-table | table-extraction | ✅ 17s 2st  | ✅ 10s 4st  |
| m2w-0059adc6 | mind2web-easy | ❌ 2s 0st tool_error_or_infra | ❌ 18s 7st hallucination |
| m2w-005be9dd | mind2web-easy | ❌ 2s 0st tool_error_or_infra | ❌ 30s 9st hallucination |
| m2w-0170ca95 | mind2web-medium | ❌ 29s 2st incomplete | ❌ 24s 10st incomplete |
| m2w-01abae96 | mind2web-easy | ❌ 2s 0st tool_error_or_infra | ❌ 23s 9st wrong_answer |
| m2w-04613880 | mind2web-hard | ❌ 65s 11st wrong_answer | ❌ 42s 19st wrong_answer |
| m2w-05483c50 | mind2web-medium | ❌ 64s 12st tool_error_or_infra | ❌ 41s 29st incomplete |
| m2w-0632e496 | mind2web-easy | ❌ 2s 0st tool_error_or_infra | ✅ 38s 13st  |
| m2w-070c907d | mind2web-medium | ❌ 2s 0st tool_error_or_infra | ❌ 87s 10st hallucination |
| m2w-07bdc595 | mind2web-easy | ❌ 2s 0st tool_error_or_infra | ❌ 50s 16st gave_up |
| m2w-07ec4a12 | mind2web-easy | ❌ 2s 0st tool_error_or_infra | ❌ 20s 7st tool_error_or_infra |
| m2w-0a0fa834 | mind2web-hard | ❌ 45s 6st incomplete | ❌ 30s 10st incomplete |
| m2w-0b2623e9 | mind2web-medium | ❌ 2s 0st tool_error_or_infra | ❌ 26s 17st blocked_or_captcha |
| m2w-0b838cd5 | mind2web-medium | ❌ 2s 0st tool_error_or_infra | ❌ 27s 11st incomplete |
| m2w-1223b075 | mind2web-medium | ❌ 2s 0st tool_error_or_infra | ✅ 132s 40st  |
| m2w-1ab384fb | mind2web-hard | ❌ 298s 34st tool_error_or_infra | ❌ 31s 17st hallucination |
| m2w-239a29bd | mind2web-hard | ❌ 28s 2st wrong_answer | ❌ 20s 10st incomplete |
| m2w-28e7574e | mind2web-hard | ❌ 107s 12st wrong_answer | ❌ 46s 17st incomplete |
| m2w-301f267f | mind2web-hard | ❌ 67s 6st hallucination | ❌ 28s 13st hallucination |
| m2w-354b4ddf | mind2web-hard | ✅ 49s 7st  | ❌ 30s 16st interaction_failed |
| m2w-39c388cd | mind2web-hard | ❌ 140s 23st incomplete | ❌ 25s 10st incomplete |
