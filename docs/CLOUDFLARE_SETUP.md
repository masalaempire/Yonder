# Cloudflare setup — user action, undeployed source

No Cloudflare account changes or deployment were performed. You choose when to connect and deploy. Source uses one Worker for the frontend assets and API, one Session Durable Object per pair, and small auxiliary invitation-directory objects under the same binding. No separate database, KV, D1, Supabase, account system, or frontend API credentials are needed.

## Frontend preview versus live pairing

`npm run dev` runs Vite's frontend preview only. Static hosting of `dist/` can show the interface and its labeled simulation, but cannot create real pairs without the Worker routes. The UI's unavailable-backend state is intentional. The live app must serve assets, /api requests, and WebSocket upgrades on one HTTPS origin. Do not deploy only `dist/` and assume pairing works.

## GitHub to Workers

1. In your Cloudflare dashboard open Workers & Pages, choose creation/import of an existing Git repository, connect your GitHub account, and choose `masalaempire/Yonder`.
2. Select the reviewed branch you intend to deploy. Work here is on `codex/yonder-frontend`; avoid silently pointing production at an unrelated default branch. Keep previews/automatic production publishing disabled until you want them.
3. Use the repository root (no subdirectory). Use Node 22+ and the repository's package manager. Cloudflare installs dependencies before the build.
4. Build command: `npm run build`. Deploy command: `npx wrangler deploy`. This reads `wrangler.jsonc`, bundles `worker/index.ts`, and uploads `dist`. Do not use a frontend-only output-directory deployment for live pairing.
5. Review the configured Worker name `yonder`, your selected account, availability/cost of SQLite Durable Objects and native rate-limit bindings, and the unused numeric rate-limit namespace before deploying. Change the Worker name if it collides in your account.
6. On first deployment Wrangler applies migration `v1` with `new_sqlite_classes: ["Session"]`, creating the `SESSIONS` binding. Keep migration history; do not delete or retag applied migrations. Choose one unused account-wide numeric namespace for `PAIRING_LIMITER`.
7. Confirm `/api/health` reports `yonder-pairing`, test real pairing using two physical phones, then configure a custom domain if desired. The standard Workers HTTPS hostname is sufficient to begin. Do not enter any Cloudflare account/API token in frontend variables or browser code.

Cloudflare's dashboard labels may vary. [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/) documents separate build/deploy commands and selecting the Git branch. Builds use the Wrangler dependency in package.json.

## Optional CLI route on your computer

These are commands for you to choose to run; they were not executed locally as part of this work.

```sh
npm install
npm test
npm run typecheck:worker
npm run build
npx wrangler deploy --dry-run
npx wrangler dev
```

The dry run validates source/configuration and builds a deployment bundle without publishing. `wrangler dev` exercises local Worker emulation; it does not prove production hibernation. For your first real deployment, authenticate your own account and then deploy:

```sh
npx wrangler login
npx wrangler deploy
```

Wrangler must be modern 4.x, at least 4.36.0 for native rate-limit bindings. The config compatibility date is `2026-10-01`. Serving local phone tests needs a secure context: plain HTTP on a LAN hostname is insufficient for sensors. Choose an HTTPS development setup yourself; do not expose credentials.

## Configuration

| Key | Purpose |
| --- | --- |
| assets.directory ./dist; binding ASSETS | Vite production files |
| not_found_handling single-page-application | frontend navigation fallback |
| run_worker_first /api and /api/* | API errors never fall through to the SPA |
| SESSIONS / Session | SQLite Durable Objects, no separate DB setup |
| PAIRING_LIMITER namespace 10014001 | replace if already used in your account; native 30 calls/60 seconds |
| INVITE_TTL_SECONDS 600 | invitation waiting/consent timeout |
| SHARING_TTL_SECONDS 3600 | sharing lifetime from mutual consent |
| observability.enabled false | no application Workers log collection requested |
| upload_source_maps false | source maps not uploaded |

The HTTP API uses no-store. No application console logging, telemetry, analytics, coordinate storage, or token-bearing URLs are included. Security headers cover API responses and Worker-served assets; consider equivalent headers on any separate frontend preview host. The exact-origin checks also apply to curl/manual clients: set Origin to the actual site origin, Content-Type to application/json, and do not bypass the API via SPA routes.

Rate limits use the incoming IP only as a transient coarse key; friends sharing mobile NAT or privacy proxies may share a limit. Cloudflare's limiter is per location and permissive/eventually consistent, not a global hard quota. Invitation and session attempt caps supply additional serialized bounds. Platform networking, billing, security, and access metadata may still exist independently of the application's disabled logs. Review account-level request logging, Logpush, analytics, retention, and access before inviting people; never enable payload/coordinate logging or add third-party trackers.

Invitation mappings/attempt counters expire and are deleted. The DO retains only a minimal terminal per-session marker to ensure an old opaque session ID cannot reopen; coordinate history and invitation-code history are not retained. A stop while offline cannot notify the peer immediately: local sensors stop immediately, and the peer must suppress stale positions within 15 seconds.

## Evidence and remaining checks

The focused tests distinguish pure session validation from actual Worker/DO methods with platform doubles. Those doubles test routing, durable reconstruction, authentication, consent, end and alarm behavior; they do not emulate Cloudflare's network, hibernation engine, WebSocket upgrade response, or billing. GitHub CI should run the automated tests, worker typecheck, frontend build, and Wrangler dry run. Report its result separately from physical acceptance. Before calling this production-ready, use a deployed test Worker for real two-device WebSocket upgrades/reconnect, hibernation wake, auth-timeout alarm, expiry, cleanup, and consent isolation.

Official references checked for this source:
- [Workers static assets](https://developers.cloudflare.com/workers/static-assets/) and [assets binding / API worker-first routing](https://developers.cloudflare.com/workers/static-assets/binding/)
- [Durable Object WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Native rate-limit binding, version, locality and limitations](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Workers Builds settings](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
