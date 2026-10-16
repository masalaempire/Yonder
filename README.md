# Yonder

A mobile-first arrow that helps two friends find each other. No map, accounts, names, or location history. Both people explicitly agree before either can transmit or receive location.

## Status

Frontend and Cloudflare Worker/Durable Object source are provided on this branch. **Undeployed:** no Cloudflare service, binding, domain, or account connection has been created. Physical iOS Safari and Android Chrome acceptance remains **PHYSICAL PENDING**. Passing automated checks does not prove real compass accuracy, hibernation, or production pairing.

## Run and check

Use Node.js 22 or newer. After cloning the repository yourself:

```sh
npm install
npm run dev
npm test
npm run build
npm run typecheck:worker
```

Vite alone previews the frontend. Real pairing needs the same-origin Worker API. To test the included Worker locally after building, use `npm run worker:dev`. Phone sensors require a secure context; a phone opening another computer's plain HTTP LAN address is not sufficient.

- [Cloudflare setup](docs/CLOUDFLARE_SETUP.md): your own GitHub connection, bindings, commands, and deployment choices.
- [API and privacy boundaries](docs/API.md): temporary sessions, credentials, consent, validation, and expiry.
- [Device testing](docs/DEVICE_TESTING.md): physical acceptance checklist and honest evidence categories.

## Privacy and limitations

Invitation links carry an eight-character code in the hash only. Participant secrets stay out of URLs; keep them in memory. Coordinates travel over HTTPS/WSS through Cloudflare only after mutual consent. The service can read them: **this is not end-to-end encrypted**. Coordinates and compass data are not written to Durable Object storage, socket attachments, logs, analytics, or browser history by this application. The server only relays fresh fixes; compass calculation stays local.

Temporary metadata holds token hashes, consent, expiry, connection identity, and ordering/rate counters. On Stop, Found, or expiry, credentials and invitation mapping are cleared. A minimal terminal per-session marker remains to prevent an old opaque ID from reopening. Cloudflare may retain operational/network metadata independently; inspect your account settings before use. Anyone with an unused invitation code can take the second seat, so share privately and restart if the wrong person joins.

This is foreground-only browser guidance. GPS uncertainty, magnetic interference, permissions, screen rotation, phone sleep, background suspension, and network loss can remove guidance. Nearby is an accuracy-aware heuristic, not precise ranging or proof that a person is within a particular distance. Use visual confirmation and normal surroundings awareness.
