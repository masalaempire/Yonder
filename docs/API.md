# Yonder protocol v1

All API requests use the page's own HTTPS origin; sockets use WSS. No CORS is enabled. Unsafe requests and socket upgrades require an exact matching Origin. Cross-site fetch metadata is rejected. API responses use no-store; unknown /api routes return JSON errors and never the SPA. Do not put secrets or coordinates in query strings, invitation links, localStorage, analytics, or logs.

## HTTP

| Request | Body / credential | Success |
| --- | --- | --- |
| GET /api/health | none | 200 {status:"ok",service:"yonder-pairing",protocol:1} |
| POST /api/sessions | JSON {} | 201 SessionGrant |
| POST /api/sessions/join | JSON {code:"ABCDEFGH"} | 201 SessionGrant |
| POST /api/sessions/:sessionId/end | Authorization: Bearer TOKEN; JSON {reason:"stopped"} or {reason:"found"} | 204 |
| GET /api/sessions/:sessionId/socket | Upgrade: websocket; exact Origin; no query | 101, then authenticate first frame |

JSON errors: `{"error":{"code":"session_full","message":"This invitation already has two people."}}`. Typical status: 400 invalid message/code, 401 credentials, 403 origin/consent, 404 route, 409 full/collision, 410 expired/ended, 413 payload, 415 content type, 426 socket upgrade, 429 rate limit, 503 unavailable. Never assume an HTML 200 means the backend exists; check the health service identifier.

SessionGrant: `{sessionId,participantId,token,code,expiresAt}`. IDs/token/code are strings; expiresAt is Unix milliseconds. Session IDs are random opaque Durable Object IDs, distinct from invitation codes. The token is a separate 256-bit random secret for each participant; only its SHA-256 hash is stored.

## WebSocket frames

`src/shared/protocol.ts` is the exact TypeScript source of truth. Send the first frame within five seconds:

```json
{"type":"authenticate","participantId":"participant UUID","token":"64-character hex secret"}
```

Other client frames:

```json
{"type":"consent","granted":true}
{"type":"location","fix":{"latitude":31.2,"longitude":121.5,"accuracy":8,"timestamp":1792108800000}}
{"type":"end","reason":"stopped"}
{"type":"end","reason":"found"}
{"type":"ping"}
```

Server frames: `{type:"state",state:SessionSnapshot}`, `{type:"peer-location",fix:LocationFix}`, `{type:"ended",reason:"stopped"|"found"|"expired"}`, `{type:"error",code,message}`, `{type:"pong"}`.

Snapshot contains sessionId, code, phase (waiting/consent/sharing/ended), expiresAt, participants, selfConsent, peerConsent, peerConnected, and optional endReason. Connected means an authenticated live socket, not durable consent. A false peerConnected immediately invalidates displayed coordinates. Clear guidance on local disconnect too. A reconnect must authenticate with its original ID/secret. A valid new socket replaces an old one only after authentication; an invalid reconnect cannot evict it. Durable consent survives hibernation/reconnection, but the frontend must ask for a new user action to restart sensors after suspension or disconnect.

## Server rules

- Invitation lifetime: 10 minutes from creation. Single consent never extends it. Both explicit consents begin one 60-minute sharing lifetime. Repeated consent does not extend sharing. Configurable TTL values accept 30–86400 seconds.
- Exactly two participant slots; join allocation and consent changes are serialized in the session DO. No coordinates can be sent or received before mutual consent.
- Frames and HTTP JSON bodies: at most 2048 UTF-8 bytes; binary frames and unsupported fields/messages are rejected. Compass never leaves the browser.
- Fix latitude/longitude must be finite and within ±90/±180; accuracy must be finite, 0–100000 metres; timestamp must be no older than 15 seconds and no more than 5 seconds in the future. Require strictly increasing timestamps and at most one accepted fix per participant per second, across reconnects.
- Socket authentication: one first-frame attempt, five-second alarm deadline, at most eight concurrent open sockets per session, 120 socket upgrades over the session lifetime. Invalid authenticated frames are bounded to three strikes; over 60 messages in a 10-second socket window closes the connection.
- Pair/create/join/socket traffic uses native Cloudflare rate limiting: 30 per minute per coarse IP key, plus code/session keys. Invitation lookup also caps at 40 total attempts in its serialized directory object.
- Native limits are permissive/eventually consistent and local to a Cloudflare location. Anonymous IP keys can throttle friends on a shared mobile/network address. The app does not persist/log IP addresses.
- Every HTTP, message, close/error, and alarm path rechecks expiry or terminal state. Accepted sockets use the Hibernation API; attachments carry connection/auth deadline/rate metadata only. Actual socket events reconstruct auth by matching attachment participant/connection identity against stored metadata.
- Coordinates exist only while handling and relaying a fix. No retained peer-position cache, reconnect replay, durable coordinate storage, or persisted compass. Coordinate timestamps alone are kept for ordering/rate checks.
- Invitation-directory metadata maps a code to a fresh random session ID only until invitation expiry or end, then is deleted. Collision retries check active mappings. Reusing an expired random code would create a different random ID, never reset the old object. Terminal session markers contain no code, participants, or token hashes.
- Stop/Found ends both peers and clears hashes/consent; authenticated HTTP is a fallback if the socket is unavailable. Offline Stop must clear local sensors/state immediately, even if end cannot reach the server. Peers lose guidance at disconnect or the freshness threshold; the server then expires the session normally.

Authentication authorizes possession of an invitation or participant secret, not a verified real-world identity. Encryption is transport encryption via HTTPS/WSS; no end-to-end encryption is claimed.
