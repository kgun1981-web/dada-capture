# CLAUDE.md

## What this is
**다다 기록 (dada-capture)**: an offline field-notes PWA that users add to the iPhone home screen from Safari. Users add photos and memos to a record (date/place/topic), then export it as ZIP bundles (photos + `notes.txt` + `기록.md` + `manifest.json`) through the iOS share sheet.

- Plain static site: `index.html` (markup + all CSS inline), `app.js` (all logic), `sw.js` (service worker, shell cache), `manifest.webmanifest`, icons, `.nojekyll`. It is served as static files, which looks like GitHub Pages.
- **No build step, no package.json, no dependencies, no framework.** Keep it that way. Don't add npm packages, bundlers, CDNs or external requests.
- Data lives only on the device: IndexedDB `dada-capture` v1 (stores `records`, `photos` [indexes `byRecord`, `bySha`], `blobs`), plus `localStorage` keys `dada.open` and `dada.draft.<recordId>`.

## Commands
```bash
# Syntax check (there is no test suite)
node --check app.js && node --check sw.js && python3 -m json.tool manifest.webmanifest >/dev/null

# Run locally
python3 -m http.server 8000   # → http://localhost:8000/index.html
```
Headless smoke test with the preinstalled Playwright: load the page and wait for `window.__dadaReady === true`, which `init()` sets when it finishes. Then check that `#appVersion` shows the new version and that no `pageerror` or console errors appeared. Write the script in the scratchpad, not in the repo.

## Release / versioning rules (every user-visible change)
1. Bump `APP_VERSION` in `app.js` (semver-ish: `0.5.4` → `0.5.5` for fixes, `0.6` for features).
2. Bump `VERSION` in `sw.js` (`dada-capture-shell-vNN`, +1). If you skip this, installed phones keep the old cached shell.
3. If you add a new shell file, add it to `SHELL` in `sw.js`.
4. Only change `HASH_VERSION` if the `content_hash` body in `exportRecord()` changes. Only change `SCHEMA_VERSION` if the record or manifest shape changes. A PC-side tool depends on both, so keep exported field names stable.
5. Changing the IndexedDB schema needs a version bump and a migration in `onupgradeneeded`. Never drop users' data.

Commit message format: `vX.Y.Z: <Korean summary of changes, comma-separated>` (see `git log`).

## Code style
- `'use strict'`, vanilla ES2020+, no modules. Helpers: `$ = id => document.getElementById(id)`, plus `tx`, `getOne`, `getAll`, `putRecord`.
- Change records through `mutate(id, fn)`. It does read-modify-write in one transaction, so a background save or export can't overwrite another record. Re-check `current.id` after any `await` before touching the UI.
- 2-space indent, single quotes, semicolons, dense one-line helpers are fine. Match the surrounding density.
- Wrap every `localStorage` call in `try/catch` with `/* 무시 */`.
- Build DOM with `textContent` / `createElement`. Don't put user text into `innerHTML`.
- **All UI text, comments and commit messages are in Korean**, in a plain, friendly tone for a non-technical user. Error messages should say that the originals are still safe ("앱 안 원본은 지우지 않았습니다").
- CSS stays inline in `index.html` and uses the `:root` variables (`--brand`, `--accent`, `--warn`, …).

## Constraints to respect
- **Privacy is a feature**: no network calls, analytics or uploads. Sharing happens only through the user's share sheet (`navigator.share`). The UI warns that choosing ChatGPT uploads the files.
- Target iOS Safari standalone mode. Watch for HEIC/MOV files, date-input styling, storage quota (`storageCheck`/`hasRoomFor`), and a share sheet that needs a user gesture (files are prepared before the tap).
- The recommended save path (confirmed on a real device) is **공유 → 파일에 저장 → iCloud Drive › DadaRecords**. Downloading is only a fallback.
- Verify photo integrity (size + SHA-256) on export. Never silently change originals.
- The service worker never auto-reloads. It shows `#updateBar` so the user can apply the update after saving.
