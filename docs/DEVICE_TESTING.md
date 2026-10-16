# Device acceptance — PHYSICAL PENDING

No physical phone checks or live deployment tests are claimed by this source. Mark each check with phone model, OS/browser version, date, result and brief observation. Use two real people/phones on HTTPS: current iOS Safari and Android Chrome. Repeat with different networks and a shared Wi-Fi/mobile hotspot.

## Evidence categories

- Automated pure tests: geography, heading calculations, freshness, session rules.
- Automated platform-double tests: actual sensor lifecycle and Worker/DO event handlers with mocked browser/Cloudflare APIs. These cannot prove real GPS/compass quality, real WebSocket upgrades or hibernation.
- Simulation: labeled fake positions; no real friend or device evidence.
- **PHYSICAL PENDING**: every item below until executed on phones.
- Live Cloudflare runtime: separate from local mocks; only claim after a test deployment exists.

## Physical checklist

- [ ] First open starts no sensor or sharing; invitation link contains only a hash code.
- [ ] Create one invitation, join the second phone; a third join fails. Wrong/expired code is clear. Invite expires after 10 minutes even if only one person consents.
- [ ] Before both explicit consents, neither person sends or receives any coordinates. Confirm network frames without recording coordinates in an artifact/log.
- [ ] Accept location and compass on each platform via their own button taps. Deny either permission, retry, and revoke access in browser settings; guidance must disappear with a useful next action.
- [ ] Turn in place through 360 degrees while the other friend stands still. Arrow follows phone heading, does not require walking, and crosses north without jumping backward.
- [ ] Check true-north sanity against a trustworthy true-north reference outdoors. Compare a known physical direction using several headings; record magnetic interference/model limitations instead of accepting a visually plausible arrow.
- [ ] Walk toward, away, and around the other person outdoors. Verify bearing direction and approximate distance. GPS drift/large accuracy circles suppress confident nearby status.
- [ ] Rotate portrait, both landscape orientations, and back. Tilt gently, then hold near vertical: unusable orientation clears confident guidance. Test near metal/magnetic phone accessories.
- [ ] Nearby requires stable fresh accurate fixes; it must not flicker or claim precise ranging. Walk out again and confirm it exits.
- [ ] Lock each phone, background the tab, switch apps, and return. This is foreground-only: guidance clears, sensors stop locally, and returning requires explicit resume/permission actions.
- [ ] Disconnect Wi-Fi/mobile data or close one tab. Peer guidance clears on disconnect or within the 15-second freshness threshold. Reconnect uses original credentials and no stale position is replayed.
- [ ] Stop and Found terminate both views while online; no further fix is sent. Offline Stop immediately stops local GPS/listeners even if server end fails; the other phone must lose stale guidance. Retry end after connectivity only if the client still has the grant.
- [ ] Reload/reconnect cannot automatically restart sensors. Missing in-memory credentials requires a new invitation rather than recovering secret data from a URL/history.
- [ ] Wait for 60-minute sharing expiry, or use short test TTL values configured in the Worker. Both phones end; reconnect/end/old IDs cannot reopen the session.

## Deployed runtime checklist — pending until you deploy

- [ ] Confirm /api/health JSON service identifier and /api/not-a-route JSON 404.
- [ ] Validate Origin and cross-site rejection, oversized body/frame rejection, anonymous native limiter behavior, two-seat simultaneous join, and invalid-token denial.
- [ ] Leave authenticated sockets idle long enough for hibernation, then verify state/consent reconstruction, fresh-only relay, and peer disconnect state after wake.
- [ ] Leave an accepted socket unauthenticated; five-second alarm closes it even after hibernation. Wrong first frame/token closes immediately and cannot evict a valid socket.
- [ ] Reconnect one participant with valid credentials; old socket closes, new socket is valid, and an old socket's late close does not mark the new socket disconnected.
- [ ] End/expire while sockets exist, then inspect storage safely: credentials and invitation mapping are gone, no coordinate values/history exist, only a terminal session marker remains.
- [ ] Keep account/app logging disabled; confirm production headers, HTTPS/WSS and no coordinate-bearing URLs or third-party analytics.

Record automated CI result, local emulator result, deployed runtime result, and physical result separately. A passing build, simulation, or calculation test is never evidence that physical direction was correct.
