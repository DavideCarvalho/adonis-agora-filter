---
'@adonis-agora/filter': patch
---

Report the real version from the exported `VERSION` constant.

`VERSION` is a hand-written literal next to a "keep in sync with package.json"
comment, and it had not been touched since the first release: the package shipped
`0.2.0` through `0.6.0` while `VERSION` still answered `'0.1.0'`. Anything gating
on it — a feature check, a bug report, a diagnostics banner — got a wrong answer.

It now reads `0.6.0`, and a test compares it against `package.json` so the next
release cannot silently drift again.
