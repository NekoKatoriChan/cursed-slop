# Rắn và Thang — Online V3 (Private Rooms)

Features: offline and private-room multiplayer; selectable auto-generated 50/200-cell boards, generated custom dimensions, and saved custom maps; custom starting gold, card draw chance, dice sides (4/6/8/10/12), and toggles for cards/snakes/ladders/portals/events/slow zones; green/yellow cinematic effects; three randomly scattered black shards for the passive black-tier TẬN THẾ instant-win objective; Dev Mode manual shard collection and re-scattering on the current map; host lobby settings, ready state, room lock/unlock, kick (lobby only), optional spectators, revision-checked WebSocket snapshots, protected reconnect keys, reactions, and rematches.

## Deploy once to Cloudflare Workers

Requires Node.js and a Cloudflare account. From this folder:

```sh
npm install
npx wrangler login
npm run check
npm run deploy
```

Wrangler deploys the HTML assets and realtime Worker/ Durable Object together. The deploy output gives a `*.workers.dev` URL. Open that URL and use **Chơi online · Phòng riêng**. The default Worker name is aligned to `cursed-slop-2`, matching the successful deployment logged for this project. The URL you send your friends is generated in-game; they only need a browser.

## Notes

- There is no public room browser. Anyone with an invite link/code can request entry; the host may lock the room and kick players while in the lobby.
- Room IDs are random 7-character codes and idle rooms expire after 12 hours. The host key and each player’s per-room reconnect key are stored locally and never included in the invite URL or public room state. A visible browser ID alone cannot impersonate a player.
- The host needs to be online to change lobby settings/start/rematch. During the match, the current player sends the state update to the room. Turn ownership and revision are checked server-side; the server still accepts a client-generated game snapshot, so this is a friend-room prototype, not a hardened anti-cheat platform.
- The host chooses custom lobby rules before starting. A saved custom map for online play is read from the host browser only and then shipped with the initial room snapshot. The room code is added to the address bar, so a page refresh reconnects to the same invite room. Player reconnect uses a per-room secret in local storage. While playing, disconnected turns are skipped only when at least two players remain connected.
- Cloudflare billing/quotas depend on the current account plan and platform limits. Check the dashboard before public use.
