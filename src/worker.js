const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomCode(length = 7) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, b => CODE_CHARS[b % CODE_CHARS.length]).join("");
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
function cleanName(value) {
  const name = String(value || "Guest").trim().replace(/[<>\r\n]/g, "").slice(0, 18);
  return name || "Guest";
}
function defaults(raw = {}) {
  const maxPlayers = [2, 3, 4].includes(Number(raw.maxPlayers)) ? Number(raw.maxPlayers) : 4;
  return {
    maxPlayers,
    board: raw.board === "200" ? "200" : "50",
    difficulty: Math.max(1, Math.min(5, Math.round(Number(raw.difficulty) || 3))),
    startCards: raw.startCards === true,
    allowSpectators: raw.allowSpectators !== false,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return json({ ok: true, service: "snake-and-slop-online", privateRoomsOnly: true });

    if (url.pathname === "/api/rooms" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const clientId = String(body.clientId || "").slice(0, 80);
      if (!clientId) return json({ error: "Missing clientId" }, 400);
      const name = cleanName(body.name);
      const settings = defaults(body.settings || {});
      for (let attempt = 0; attempt < 4; attempt++) {
        const roomCode = randomCode(7);
        const id = env.ROOMS.idFromName(roomCode);
        const stub = env.ROOMS.get(id);
        const response = await stub.fetch("https://room.internal/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ roomCode, clientId, name, settings }),
        });
        const result = await response.json();
        if (response.status === 201) return json({ roomCode, hostKey: result.hostKey });
      }
      return json({ error: "Could not allocate a room; retry." }, 503);
    }

    const wsMatch = url.pathname.match(/^\/ws\/([A-Z0-9]{5,8})$/i);
    if (wsMatch) {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket upgrade required", { status: 426 });
      }
      const code = wsMatch[1].toUpperCase();
      const id = env.ROOMS.idFromName(code);
      return env.ROOMS.get(id).fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/create" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const existing = await this.state.storage.get("room");
      if (existing) return json({ error: "Room code collision" }, 409);
      const hostKey = crypto.randomUUID() + crypto.randomUUID();
      const room = {
        code: String(body.roomCode),
        hostId: String(body.clientId),
        hostKey,
        status: "lobby",
        locked: false,
        settings: defaults(body.settings),
        players: [{ id: String(body.clientId), name: cleanName(body.name), ready: true, connected: false }],
        spectators: [],
        snapshot: null,
        revision: 0,
        createdAt: Date.now(),
      };
      await this.state.storage.put("room", room);
      await this.scheduleExpiry();
      return json({ hostKey }, 201);
    }
    if (url.pathname !== "/ws" && !/^\/ws\/[A-Z0-9]{5,8}$/i.test(url.pathname)) return new Response("Not found", { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket upgrade required", { status: 426 });

    const room = await this.state.storage.get("room");
    if (!room) return new Response("Room not found", { status: 404 });
    const clientId = String(url.searchParams.get("clientId") || "").slice(0, 80);
    const name = cleanName(url.searchParams.get("name"));
    const hostKey = String(url.searchParams.get("hostKey") || "");
    const resumeKey = String(url.searchParams.get("resumeKey") || "");
    if (!clientId) return new Response("Missing clientId", { status: 400 });
    const claimsHost = clientId === room.hostId && hostKey && hostKey === room.hostKey;
    if (clientId === room.hostId && !claimsHost) return new Response("Host reconnect key missing", { status: 403 });

    let player = room.players.find(p => p.id === clientId);
    let spectator = room.spectators.find(p => p.id === clientId);
    // Browser IDs are visible in lobby state, so they are not credentials. Each non-host
    // connection also needs a per-room secret that is never broadcast to other clients.
    if (player && !claimsHost && (!resumeKey || !player.resumeKey || resumeKey !== player.resumeKey)) {
      return new Response("Player reconnect key invalid", { status: 403 });
    }
    if (spectator && (!resumeKey || !spectator.resumeKey || resumeKey !== spectator.resumeKey)) {
      return new Response("Spectator reconnect key invalid", { status: 403 });
    }
    if (!player && !spectator && !claimsHost && resumeKey.length < 32) {
      return new Response("A private reconnect key is required", { status: 403 });
    }
    if (!player && !spectator) {
      if (room.locked) return new Response("Room is locked", { status: 403 });
      if (room.status === "lobby") {
        if (room.players.length >= room.settings.maxPlayers) return new Response("Room full", { status: 409 });
        player = { id: clientId, name, ready: false, connected: false, resumeKey };
        room.players.push(player);
      } else {
        if (!room.settings.allowSpectators) return new Response("Spectators disabled", { status: 403 });
        spectator = { id: clientId, name, connected: false, resumeKey };
        room.spectators.push(spectator);
      }
    }
    if (player) { player.name = name; player.connected = true; }
    if (spectator) { spectator.name = name; spectator.connected = true; }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ clientId, name, isHost: !!claimsHost, isSpectator: !!spectator });
    await this.state.storage.put("room", room);
    await this.scheduleExpiry();
    this.send(server, { type: "room", room: this.publicRoom(room), snapshot: room.snapshot, revision: room.revision, isHost: !!claimsHost, isSpectator: !!spectator });
    this.broadcast({ type: "room", room: this.publicRoom(room), revision: room.revision }, clientId);
    return new Response(null, { status: 101, webSocket: client });
  }

  publicRoom(room) {
    return {
      code: room.code,
      hostId: room.hostId,
      status: room.status,
      locked: room.locked,
      settings: room.settings,
      // Never serialize reconnect secrets in the public room snapshot.
      players: room.players.map(({ id, name, ready, connected }) => ({ id, name, ready, connected })),
      spectators: room.spectators.map(({ id, name, connected }) => ({ id, name, connected })),
      revision: room.revision,
    };
  }
  send(ws, data) { try { ws.send(JSON.stringify(data)); } catch {} }
  broadcast(data, exceptId = null) {
    for (const ws of this.state.getWebSockets()) {
      let attachment = {};
      try { attachment = ws.deserializeAttachment() || {}; } catch {}
      if (exceptId && attachment.clientId === exceptId) {
        // Send revision acknowledgements to the actor too, but the client won't re-apply its own snapshot.
        if (data.type === "snapshot") this.send(ws, data);
        continue;
      }
      this.send(ws, data);
    }
  }
  async loadRoom() { return await this.state.storage.get("room"); }
  async scheduleExpiry() {
    // Idle private rooms expire after 12 hours; any connection/action refreshes the alarm.
    try { if (typeof this.state.storage.setAlarm === "function") await this.state.storage.setAlarm(Date.now() + 12 * 60 * 60 * 1000); } catch {}
  }
  async alarm() {
    await this.state.storage.delete("room");
    for (const ws of this.state.getWebSockets()) {
      this.send(ws, { type: "closed", reason: "expired" });
      try { ws.close(1000, "Room expired"); } catch {}
    }
  }
  async saveAndBroadcast(room, message, exceptId = null) {
    await this.state.storage.put("room", room);
    this.broadcast({ ...message, room: this.publicRoom(room), revision: room.revision, snapshot: room.status === "playing" ? room.snapshot : null }, exceptId);
  }
  attachment(ws) { try { return ws.deserializeAttachment() || {}; } catch { return {}; } }
  fail(ws, message, room = null) { this.send(ws, { type: "error", message, ...(room ? { room: this.publicRoom(room), snapshot: room.snapshot, revision: room.revision } : {}) }); }

  async webSocketMessage(ws, raw) {
    const att = this.attachment(ws);
    let msg;
    try { msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); } catch { return this.fail(ws, "Invalid message"); }
    let room = await this.loadRoom();
    if (!room) return this.fail(ws, "Room expired");
    await this.scheduleExpiry();
    const actorId = att.clientId;
    const playerIndex = room.players.findIndex(p => p.id === actorId);
    const isHost = !!att.isHost && actorId === room.hostId;
    const inRoom = playerIndex >= 0 || room.spectators.some(p => p.id === actorId);

    if (msg.type === "ready") {
      if (room.status !== "lobby" || playerIndex < 0) return;
      const player = room.players[playerIndex];
      if (player.id !== room.hostId) player.ready = !player.ready;
      room.revision++;
      await this.saveAndBroadcast(room, { type: "room" });
      return;
    }
    if (msg.type === "settings") {
      if (!isHost || room.status !== "lobby") return this.fail(ws, "Only the host can edit lobby rules");
      const next = defaults(msg.settings || {});
      if (room.players.length > next.maxPlayers) return this.fail(ws, "Player limit is lower than current room size");
      room.settings = next;
      room.revision++;
      await this.saveAndBroadcast(room, { type: "room" });
      return;
    }
    if (msg.type === "lock") {
      if (!isHost || room.status !== "lobby") return this.fail(ws, "Only the host can lock the lobby");
      room.locked = !room.locked;
      room.revision++;
      await this.saveAndBroadcast(room, { type: "room" });
      return;
    }
    if (msg.type === "kick") {
      if (!isHost || room.status !== "lobby") return this.fail(ws, "Kicking is available in the lobby only");
      const target = String(msg.playerId || "");
      if (!target || target === room.hostId) return;
      room.players = room.players.filter(p => p.id !== target);
      room.spectators = room.spectators.filter(p => p.id !== target);
      room.revision++;
      await this.state.storage.put("room", room);
      for (const open of this.state.getWebSockets()) {
        const a = this.attachment(open);
        if (a.clientId === target) {
          this.send(open, { type: "kicked" });
          try { open.close(4001, "Kicked"); } catch {}
        }
      }
      this.broadcast({ type: "room", room: this.publicRoom(room), revision: room.revision });
      return;
    }
    if (msg.type === "start") {
      if (!isHost || room.status !== "lobby") return this.fail(ws, "Only the host can start the game");
      if (room.players.length < 2 || room.players.some(p => !p.connected || !p.ready)) return this.fail(ws, "All players must be connected and ready");
      if (!validSnapshot(msg.snapshot, room.players.length)) return this.fail(ws, "Invalid initial game state");
      room.status = "playing";
      room.snapshot = sanitizeSnapshot(msg.snapshot);
      room.settings = defaults(msg.settings || room.settings);
      room.revision++;
      await this.state.storage.put("room", room);
      this.broadcast({ type: "started", snapshot: room.snapshot, revision: room.revision, fromId: actorId, room: this.publicRoom(room) });
      return;
    }
    if (msg.type === "sync") {
      if (room.status !== "playing" || playerIndex < 0) return this.fail(ws, "Not a player in this match");
      if (!room.snapshot?.game || Number(msg.baseRevision) !== room.revision) return this.fail(ws, "State changed; synchronized to the latest state", room);
      if (Number(room.snapshot.game.cur) !== playerIndex) return this.fail(ws, "Not your turn", room);
      if (!validSnapshot(msg.snapshot, room.players.length)) return this.fail(ws, "Invalid game state", room);
      const nextIndex = Number(msg.snapshot.game.cur);
      const same = nextIndex === playerIndex;
      const next = (playerIndex + 1) % room.players.length;
      if (!same && nextIndex !== next) return this.fail(ws, "Invalid turn transition", room);
      room.snapshot = sanitizeSnapshot(msg.snapshot);
      room.status = Number(room.snapshot.game.win) >= 0 ? "finished" : "playing";
      this.skipDisconnected(room);
      room.revision++;
      await this.state.storage.put("room", room);
      this.broadcast({ type: "snapshot", snapshot: room.snapshot, event: safeEvent(msg.event), fromId: actorId, revision: room.revision, room: this.publicRoom(room) });
      return;
    }
    if (msg.type === "reaction") {
      if (!inRoom) return;
      const allowed = ["💀", "😂", "🗿", "🎲"];
      if (!allowed.includes(msg.emoji)) return;
      this.broadcast({ type: "reaction", name: att.name, emoji: msg.emoji }, actorId);
      this.send(ws, { type: "reaction", name: "Bạn", emoji: msg.emoji });
      return;
    }
    if (msg.type === "rematch") {
      if (!isHost || room.status !== "finished") return this.fail(ws, "Host can rematch after a finished match");
      room.status = "lobby";
      room.snapshot = null;
      room.players = room.players.map(p => ({ ...p, ready: p.id === room.hostId }));
      room.revision++;
      await this.saveAndBroadcast(room, { type: "rematch" });
      return;
    }
    if (msg.type === "leave") {
      if (isHost && (room.status === "lobby" || room.status === "finished")) {
        for (const open of this.state.getWebSockets()) this.send(open, { type: "closed" });
        await this.state.storage.delete("room");
        for (const open of this.state.getWebSockets()) { try { open.close(1000, "Room closed"); } catch {} }
        return;
      }
      if (room.status === "playing" || room.status === "finished") {
        const p = room.players.find(p => p.id === actorId);
        if (p) p.connected = false;
        room.spectators = room.spectators.filter(p => p.id !== actorId);
        this.skipDisconnected(room);
      } else {
        room.players = room.players.filter(p => p.id !== actorId);
        room.spectators = room.spectators.filter(p => p.id !== actorId);
      }
      room.revision++;
      await this.saveAndBroadcast(room, { type: "room" });
      try { ws.close(1000, "Left room"); } catch {}
      return;
    }
    this.fail(ws, "Unknown action");
  }

  skipDisconnected(room) {
    if (room.status !== "playing" || !room.snapshot?.game || room.players.length < 2) return;
    if (!room.players.some(p => p.connected)) return;
    const game = room.snapshot.game;
    let safety = room.players.length;
    while (safety-- > 0 && room.players[game.cur] && !room.players[game.cur].connected) {
      const missed = room.players[game.cur];
      game.cur = (game.cur + 1) % room.players.length;
      room.snapshot.log = [...(room.snapshot.log || []), `${missed.name} mất kết nối — bỏ lượt.`].slice(-3);
    }
  }

  async webSocketClose(ws) {
    const att = this.attachment(ws);
    let room = await this.loadRoom();
    if (!room || !att.clientId) return;
    // A reconnect can briefly overlap the old socket; do not mark a still-connected player offline.
    const duplicate = this.state.getWebSockets().some(open => {
      if (open === ws) return false;
      const a = this.attachment(open);
      return a.clientId === att.clientId;
    });
    if (duplicate) return;
    const player = room.players.find(p => p.id === att.clientId);
    if (player) player.connected = false;
    room.spectators = room.spectators.filter(p => p.id !== att.clientId);
    this.skipDisconnected(room);
    room.revision++;
    await this.saveAndBroadcast(room, { type: "room" });
  }
}

function validSnapshot(s, playerCount) {
  try {
    if (!s || !s.game || !s.map) return false;
    const m = s.map, g = s.game;
    if (!Number.isInteger(m.n) || m.n < 5 || m.n > 20) return false;
    if (!Number.isInteger(m.r) || m.r < 5 || m.r > 40 || m.n * m.r > 200) return false;
    if (!Array.isArray(m.sp) || m.sp.length !== m.n * m.r || !Array.isArray(m.sl) || m.sl.length !== m.n * m.r) return false;
    if (!Array.isArray(g.p) || g.p.length !== playerCount || !Number.isInteger(g.cur) || g.cur < 0 || g.cur >= playerCount) return false;
    const last = m.n * m.r - 1;
    for (const p of g.p) {
      if (!p || !Number.isInteger(p.pos) || p.pos < 0 || p.pos > last) return false;
      if (!Number.isFinite(p.gold) || p.gold < 0 || p.gold > 1000000) return false;
      if (!Array.isArray(p.cards) || p.cards.some(i => !Number.isInteger(i) || i < 0 || i > 1000)) return false;
    }
    if (!Number.isInteger(g.win) || g.win < -1 || g.win >= playerCount) return false;
    if (g.win >= 0 && g.p[g.win].pos !== last) return false;
    return true;
  } catch { return false; }
}
function sanitizeSnapshot(s) {
  const snapshot = JSON.parse(JSON.stringify(s));
  snapshot.game.busy = 0;
  snapshot.log = Array.isArray(snapshot.log) ? snapshot.log.slice(-3).map(x => String(x).slice(0, 200)) : [];
  return snapshot;
}
function safeEvent(event) {
  if (!event || typeof event !== "object") return null;
  if (event.type === "roll") return { type: "roll", dice: Array.isArray(event.dice) ? event.dice.slice(0, 3).filter(n => Number.isInteger(n) && n >= 1 && n <= 6) : [] };
  if (event.type === "card") return { type: "card", key: String(event.key || "").slice(0, 40) };
  if (event.type === "shop") return { type: "shop" };
  return null;
}
