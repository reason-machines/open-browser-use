# Run hard2-v1

| suite | agent | tasks | success | score | median s | median steps | median tokens | tab leaks (tasks) | tabs left (total) |
|---|---|---|---|---|---|---|---|---|---|
| hard2 | aside | 20 | 14/20 (70%) | 15.5 | 43 | 12 | 882566 | 0 | 0 |
| hard2 | ours | 20 | 9/20 (45%) | 11.5 | 36 | 18 | 391309 | 1 | 1 |
| hard2 | ours-in-aside | 20 | 11/20 (55%) | 13.0 | 32 | 18 | 400742 | 2 | 2 |
| hard2 | ours-new | 15 | 12/15 (80%) | 13.0 | 32 | 11 | 304886 | 0 | 0 |

| task | category | aside | ours | ours-in-aside | ours-new |
|---|---|---|---|---|---|
| h2-canvas | canvas-hover | ✅ 45s 5st  | ✅ 86s 31st  | ✅ 16s 7st  | ✅ 20s 27st  |
| h2-herokuapp-login | login-test-site | ✅ 14s 5st  | ✅ 26s 13st  | ✅ 22s 13st  | ❌ 28s 11st interaction_failed |
| h2-kanban | drag-drop-html5 | ✅ 60s 15st  | ✅ 30s 7st  | ✅ 19s 6st  | ✅ 16s 5st  |
| h2-lexical-playground | rich-text-editor | ✅ 42s 10st  | ❌ 67s 30st interaction_failed | ❌ 34s 33st interaction_failed | ✅ 31s 9st  |
| h2-linkedin-clone-post | social-composer-fixture | ✅ 47s 15st  | ❌ 216s 19st download_or_upload | ❌ 197s 42st download_or_upload | ✅ 34s 14st  |
| h2-linkedin-compose-discard | real-social-compose-discard | ❌ 75s 18st download_or_upload | ❌ 118s 32st interaction_failed | ❌ 170s 33st gave_up | — |
| h2-login-otp | login-2fa-session | ✅ 65s 15st  | ❌ 39s 13st interaction_failed | ❌ 46s 21st interaction_failed 🗂1 tab(s) left | ✅ 33s 11st  |
| h2-multisite-report | long-multi-site | ✅ 40s 10st  | ✅ 26s 17st  | ✅ 46s 18st  | ✅ 32s 11st  |
| h2-nested | nested-iframes-shadow | ✅ 45s 15st  | ✅ 186s 46st  | ✅ 28s 18st  | ❌ 45s 7st iframe_or_shadow |
| h2-notif-counts | real-social-read | ✅ 22s 5st  | ✅ 28s 9st  | ✅ 29s 9st  | — |
| h2-practicetest-login | login-test-site | ✅ 15s 6st  | ✅ 25s 14st  | ✅ 21s 11st  | ✅ 19s 8st  |
| h2-reddit-bsky-discard | real-social-compose-discard | ❌ 48s 9st incomplete | ❌ 119s 28st incomplete | ❌ 25s 13st gave_up | — |
| h2-richtext | rich-text-editor | ❌ 17s 3st wrong_answer | ✅ 12s 6st  | ✅ 15s 6st  | ✅ 28s 6st  |
| h2-saucedemo-checkout | long-demo-checkout | ✅ 38s 11st  | ❌ 26s 15st wrong_answer | ❌ 39s 18st wrong_answer | ✅ 39s 19st  |
| h2-spa-cookiewall | spa-cookie-wall | ✅ 31s 12st  | ✅ 33s 19st  | ✅ 36s 24st  | ✅ 35s 17st  |
| h2-virtual | virtualized-list | ❌ 61s 12st gave_up | ❌ 28s 8st wrong_answer | ✅ 22s 8st  | ❌ 111s 16st wrong_answer |
| h2-wizard | multi-step-wizard | ✅ 85s 20st  | ❌ 48s 25st interaction_failed | ✅ 35s 13st  | ✅ 42s 17st  |
| h2-x-clone-post | social-composer-fixture | ❌ 34s 17st wrong_answer | ❌ 262s 41st download_or_upload | ❌ 233s 29st download_or_upload | ✅ 28s 11st  |
| h2-x-compose-discard | real-social-compose-discard | ✅ 112s 24st  | ❌ 314s 39st tool_error_or_infra 🗂1 tab(s) left | ❌ 235s 27st download_or_upload 🗂1 tab(s) left | — |
| h2-x-old-post-thread | real-social-read | ❌ 32s 8st gave_up | ❌ 16s 8st incomplete | ❌ 27s 17st incomplete | — |
