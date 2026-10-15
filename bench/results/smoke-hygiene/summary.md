# Run smoke-hygiene

| suite | agent | tasks | success | score | median s | median steps | median tokens | tab leaks (tasks) | tabs left (total) |
|---|---|---|---|---|---|---|---|---|---|
| hard | aside | 1 | 1/1 (100%) | 1.0 | 33 | 7 | 561898 | 0 | 0 |
| hard | ours | 1 | 1/1 (100%) | 1.0 | 31 | 19 | 368318 | 0 | 0 |

| task | category | aside | ours |
|---|---|---|---|
| fx-popup | popup-multi-window | ✅ 33s 7st  | ✅ 31s 19st  |
