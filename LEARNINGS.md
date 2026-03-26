# PWA Development Learnings

Captured from building Voice Secretary (March 2026).

## GitHub Pages PWA Deployment

- Private repos need a paid GitHub plan for Pages. Public repos work free.
- Pages URL: `https://<username>.github.io/<repo-name>/`
- `manifest.json` paths (`start_url`, `scope`) must match the repo name path.
- Deploy lag is ~1 min after push. Service worker caching makes it feel longer.

## Service Worker Cache Busting

- Bump `CACHE_NAME` version string on every push, otherwise phones serve stale code.
- Even with cache bump, Android Chrome may hold onto old SW. Closing the tab and reopening usually works.
- Nuclear option: Chrome Settings > Privacy > Clear cached images and files.
- Add a visible version stamp in the UI so you can confirm what's running on-device.

## Config & Secrets for Static PWAs

- Google OAuth Client IDs are public by design — safe to commit.
- Client secrets are NOT needed for browser-based (implicit/token) OAuth flows.
- For truly sensitive config, `.gitignore` won't work — the file won't deploy to Pages.
- If all config values are non-secret, just commit `config.js` directly.
- Keep a `config.example.js` as documentation for setup.

## Google OAuth (GIS) for PWAs

- Use Google Identity Services (`accounts.google.com/gsi/client`), not the deprecated gapi auth.
- OAuth client type: Web application.
- Authorized JavaScript origins: the Pages domain (no trailing slash, no path).
- Add yourself as a test user on the OAuth consent screen while in "Testing" status.
- `drive.file` scope is ideal — app can only see files it created. Can't browse user's Drive.
- Token expires in ~1 hour. Cache in `localStorage` with expiry timestamp for persistence across tab closes.
- Re-auth only on user action (save flow), never proactively.

## Web Speech API (Android)

- Works on Chrome Android over HTTPS. Uses device/Google speech recognition — no AI tokens.
- `continuous: false` is simpler and avoids duplication bugs. One result per session.
- For push-to-talk: use `touchstart`/`touchend` with `e.preventDefault()`.
- Add `mousedown`/`mouseup` fallback for desktop testing.
- Android kills long recognition sessions — handle `onend` to auto-restart if still holding.
- Track `savedTranscript` across restarts to avoid losing accumulated text.

## Security Checklist for Static PWAs

- Add Content-Security-Policy meta tag: lock `script-src`, `connect-src`, `frame-src`.
- Limit API retry loops (add `_retried` flag to prevent infinite 401 loops).
- `localStorage` tokens: acceptable for short-lived, narrow-scope tokens on personal tools.
- No audio/media files should touch disk — transcribe in-memory, save text only.
- `drive.file` scope means even a leaked token can only access app-created files.

## UX Patterns That Worked

- Push-to-talk feels natural for voice note capture (vs toggle on/off).
- Discard buttons on both sides of record button — accommodates lefty/righty.
- Toast messages for status feedback (auth state, save confirmation, errors).
- Green dot indicator for Drive connection status.
- Week label (W13 2026) gives context without clutter.

## Security Hardening (from external audit)

- Extract inline JS to separate `.js` file so CSP can drop `unsafe-inline` — this is the single biggest XSS mitigation for a static PWA.
- Never use `.innerHTML` with any string, even hardcoded ones. Use `.textContent` — prevents future regressions if someone adds dynamic content later.
- Always check `resp.ok` on API responses. Don't assume non-401 means success — handle 403 (quota), 404, 500 etc. with clear error messages.
- `drive.file` scope is defense-in-depth: even if token is stolen from localStorage, attacker can only access app-created files.
- Authorized JavaScript origins on the OAuth client act as the primary gate — attacker can't use your Client ID from a different domain.

## Development Workflow

- Version stamp in UI (`v11`) is essential for mobile debugging — no DevTools, so you need visual confirmation of what's deployed.
- Bump SW cache version on every push. Forget this once and you'll waste 20 minutes wondering why nothing changed.
- `curl` the deployed files from terminal to verify Pages has the latest — faster than waiting and refreshing on phone.
- Build first, git init later. Privacy audit before first commit. Separate config into its own file early.
- Use a second AI agent to audit security — catches blind spots from the building agent.

## Google Drive API Gotchas

- `drive.file` scope means the app can't see manually-created folders — only files it created itself. If user pre-creates folders, the app will create duplicates.
- Weekly file append pattern: find file by name in folder → download content → append → upload. No native "append" API in Drive.
- Use `uploadType=multipart` for create (metadata + content), `uploadType=media` for update (content only).
