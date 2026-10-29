# Rắn và Thang — Online V3 (Private Rooms)

Features: private invite-link rooms, 2–4 players, host lobby settings, ready state, lock/unlock, kick (lobby only), spectators during a live match (optional), WebSocket state sync, protected reconnect keys, reactions, spectator mode, and host rematch. Existing offline game remains available.

## Deploy once to Cloudflare Workers

Requires Node.js and a Cloudflare account. From this folder:

```sh
npm install
npx wrangler login
npm run check
npm run deploy
```

Wrangler deploys the HTML assets and realtime Worker/ Durable Object together. The deploy output gives a `*.workers.dev` URL. Open that URL and use **ONLINE PLAY · PRIVATE ROOM**. The URL you send your friends is generated in-game; they only need a browser.

## Notes

- There is no public room browser. Anyone with an invite link/code can request entry; the host may lock the room and kick players while in the lobby.
- Room IDs are random 7-character codes and idle rooms expire after 12 hours. The host key and each player’s per-room reconnect key are stored locally and never included in the invite URL or public room state. A visible browser ID alone cannot impersonate a player.
- The host needs to be online to change lobby settings/start/rematch. During the match, the current player sends the state update to the room. Turn ownership and revision are checked server-side; the server still accepts a client-generated game snapshot, so this is a friend-room prototype, not a hardened anti-cheat platform.
- The room code is added to the address bar, so a page refresh reconnects to the same invite room. Player reconnect uses a per-room secret in local storage. While playing, disconnected turns are skipped only when at least two players remain connected.
- Cloudflare billing/quotas depend on the current account plan and platform limits. Check the dashboard before public use.
