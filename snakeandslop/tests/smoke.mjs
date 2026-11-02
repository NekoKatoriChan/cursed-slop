import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// Minimal Cloudflare Durable Object test doubles for local protocol/room-state tests.
const NativeResponse = globalThis.Response;
class TestResponse {
  constructor(body = null, init = {}) { this.status = init.status ?? 200; this.headers = new Map(Object.entries(init.headers || {})); this.webSocket = init.webSocket; this.body = body; }
  async json() { return JSON.parse(String(this.body)); }
  async text() { return String(this.body ?? ''); }
}
globalThis.Response = TestResponse;
class FakeSocket {
  constructor(label) { this.label = label; this.sent = []; this.attachment = null; this.closed = false; }
  serializeAttachment(value) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return this.attachment; }
  send(value) { this.sent.push(JSON.parse(value)); }
  close(code, reason) { this.closed = true; this.closeCode = code; this.closeReason = reason; }
}
class FakePair { constructor() { this[0] = new FakeSocket('client'); this[1] = new FakeSocket('server'); } }
globalThis.WebSocketPair = FakePair;
class FakeStorage {
  constructor() { this.data = new Map(); }
  async get(k) { return structuredClone(this.data.get(k)); }
  async put(k, v) { this.data.set(k, structuredClone(v)); }
  async delete(k) { return this.data.delete(k); }
  async setAlarm(at) { this.alarmAt = at; }
}
class FakeState {
  constructor() { this.storage = new FakeStorage(); this.sockets = []; }
  acceptWebSocket(ws) { this.sockets.push(ws); }
  getWebSockets() { return this.sockets.filter(s => !s.closed); }
}
const { Room, default: Worker } = await import('../src/worker.js');
const state = new FakeState();
const room = new Room(state, {});
const createRes = await room.fetch(new Request('https://room.internal/create', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ roomCode: 'TEST234', clientId: 'host-id', name: 'Host', settings: { maxPlayers: 4, board: '50', difficulty: 3 } }),
}));
assert.equal(createRes.status, 201, 'room create endpoint');
const { hostKey } = await createRes.json();
assert.ok(hostKey.length > 20, 'host key is unguessable-sized');
assert.ok(state.storage.alarmAt > Date.now(), 'private room has an idle-expiry alarm');
async function connect(clientId, name, key = '', resumeKey = '', expectedStatus = 101) {
  const url = new URL('https://room.internal/ws/TEST234');
  url.searchParams.set('clientId', clientId); url.searchParams.set('name', name);
  if (key) url.searchParams.set('hostKey', key);
  if (resumeKey) url.searchParams.set('resumeKey', resumeKey);
  const response = await room.fetch(new Request(url, { headers: { Upgrade: 'websocket' } }));
  assert.equal(response.status, expectedStatus, 'websocket handshake/authorization');
  const server = response.status === 101 ? state.getWebSockets().at(-1) : null;
  return { server, response };
}
const host = await connect('host-id', 'Host', hostKey);
assert.ok(host.server.sent.some(m => m.type === 'room'), 'host receives private lobby state');
const guestToken = 'guest-room-secret-token-for-testing-123456';
const guest = await connect('guest-id', 'Friend', '', guestToken);
const roomPayload = guest.server.sent.find(m => m.type === 'room');
assert.ok(!JSON.stringify(roomPayload.room).includes(guestToken), 'private resume key is never broadcast');
const spoofedGuest = await connect('guest-id', 'Impersonator', '', 'wrong-secret-token-0000000000000000', 403);
assert.equal(spoofedGuest.response.status, 403, 'visible client ID alone cannot impersonate a player');
let saved = await state.storage.get('room');
assert.equal(saved.players.length, 2, 'guest joins room');
assert.equal(saved.players[1].connected, true, 'guest is connected');
assert.equal(saved.settings.startGold, 8, 'custom-rule defaults preserve starting gold');
assert.equal(saved.settings.allowCards, true, 'custom-rule defaults enable cards');
assert.equal(saved.settings.cardChance, 10, 'custom-rule defaults preserve card chance');
await room.webSocketMessage(guest.server, JSON.stringify({ type: 'ready' }));
saved = await state.storage.get('room');
assert.equal(saved.players[1].ready, true, 'ready toggles');
await room.webSocketMessage(host.server, JSON.stringify({ type: 'settings', settings: { ...saved.settings, board: 'custom', cols: 10, rows: 5, startGold: 12, cardChance: 25, diceSides: 12, allowCards: false, allowSnakes: false, allowLadders: true, allowPortals: false, allowEvents: true, allowSlowZones: false } }));
saved = await state.storage.get('room');
assert.equal(saved.settings.board, 'custom', 'custom map setting persists in the lobby');
assert.equal(saved.settings.startGold, 12, 'custom starting gold persists');
assert.equal(saved.settings.cardChance, 25, 'custom card chance persists');
assert.equal(saved.settings.diceSides, 12, 'custom dice sides persist');
assert.equal(saved.settings.allowCards, false, 'custom card toggle persists');
const map = { n: 10, r: 5, sp: Array(50).fill(0), sl: Array(50).fill(0), sn: [], la: [], po: [], cost: 0 };
const game = { p: [{ pos: 0, gold: 12, cards: [] }, { pos: 0, gold: 12, cards: [] }], cur: 0, win: -1, busy: 0, t: 0, tmp: [] };
game.tornado = false; game.snakeForm = null;
const initial = { game, map, log: [] };
await room.webSocketMessage(host.server, JSON.stringify({ type: 'start', snapshot: initial, settings: saved.settings }));
saved = await state.storage.get('room');
assert.equal(saved.status, 'playing', 'host starts after all players ready');
assert.ok(guest.server.sent.some(m => m.type === 'started'), 'guest receives start snapshot');
const unauthorized = structuredClone(initial); unauthorized.game.p[1].pos = 9; unauthorized.game.cur = 0;
const beforeUnauthorized = saved.revision;
await room.webSocketMessage(guest.server, JSON.stringify({ type: 'sync', baseRevision: beforeUnauthorized, snapshot: unauthorized, event: { type: 'roll', dice: [6] } }));
saved = await state.storage.get('room');
assert.equal(saved.revision, beforeUnauthorized, 'non-current player cannot submit a turn');
const afterHostMove = structuredClone(initial); afterHostMove.game.p[0].pos = 3; afterHostMove.game.cur = 1; afterHostMove.game.t = 1;
await room.webSocketMessage(host.server, JSON.stringify({ type: 'sync', baseRevision: saved.revision, snapshot: afterHostMove, event: { type: 'roll', dice: [3] } }));
saved = await state.storage.get('room');
assert.equal(saved.snapshot.game.p[0].pos, 3, 'valid current-player snapshot is accepted');
assert.equal(saved.snapshot.game.cur, 1, 'turn advances consistently');
assert.ok(host.server.sent.some(m => m.type === 'snapshot'), 'actor receives revision ack');
assert.ok(guest.server.sent.some(m => m.type === 'snapshot'), 'other players receive snapshot');
const afterGuestMove = structuredClone(saved.snapshot); afterGuestMove.game.p[1].pos = 2; afterGuestMove.game.cur = 0; afterGuestMove.game.t = 2; afterGuestMove.game.tornado = true; afterGuestMove.game.snakeForm = { owner: 1, turnsLeft: 3 };
const revision = saved.revision;
await room.webSocketMessage(guest.server, JSON.stringify({ type: 'sync', baseRevision: revision, snapshot: afterGuestMove, event: { type: 'roll', dice: [2] } }));
saved = await state.storage.get('room');
assert.equal(saved.snapshot.game.p[1].pos, 2, 'second player can make the next move');
assert.equal(saved.snapshot.game.tornado, true, 'permanent Tornado state is accepted and synchronized');
assert.deepEqual(saved.snapshot.game.snakeForm, { owner: 1, turnsLeft: 3 }, 'temporary snake-form state is synchronized');
const invalidEffectSnapshot = structuredClone(saved.snapshot);
invalidEffectSnapshot.game.snakeForm = { owner: 9, turnsLeft: 3 };
const invalidEffectRevision = saved.revision;
await room.webSocketMessage(host.server, JSON.stringify({ type: 'sync', baseRevision: invalidEffectRevision, snapshot: invalidEffectSnapshot }));
saved = await state.storage.get('room');
assert.equal(saved.revision, invalidEffectRevision, 'invalid snake-form owner is rejected');
const revisionBeforeStale = saved.revision;
await room.webSocketMessage(host.server, JSON.stringify({ type: 'sync', baseRevision: revisionBeforeStale - 1, snapshot: afterHostMove }));
saved = await state.storage.get('room');
assert.equal(saved.revision, revisionBeforeStale, 'stale revision rejected without mutating room');
await room.webSocketMessage(guest.server, JSON.stringify({ type: 'reaction', emoji: '💀' }));
assert.ok(host.server.sent.some(m => m.type === 'reaction' && m.emoji === '💀'), 'quick reactions broadcast');
const spectator = await connect('spectator-id', 'Watcher', '', 'spectator-room-secret-token-for-testing-123456');
saved = await state.storage.get('room');
assert.equal(saved.spectators.length, 1, 'late joiner becomes a spectator instead of changing the live player order');
assert.ok(spectator.server.sent.some(m => m.type === 'room' && m.isSpectator), 'spectator receives spectator role');
const winningMove = structuredClone(saved.snapshot);
winningMove.game.p[0].pos = 49; winningMove.game.win = 0; winningMove.game.cur = 0;
await room.webSocketMessage(host.server, JSON.stringify({ type: 'sync', baseRevision: saved.revision, snapshot: winningMove, event: { type: 'roll', dice: [6] } }));
saved = await state.storage.get('room');
assert.equal(saved.status, 'finished', 'valid winning snapshot finishes the game');
await room.webSocketMessage(host.server, JSON.stringify({ type: 'rematch' }));
saved = await state.storage.get('room');
assert.equal(saved.status, 'lobby', 'host rematch returns room to lobby');
assert.equal(saved.snapshot, null, 'rematch clears the previous match snapshot');
assert.equal(saved.players[1].ready, false, 'guests must ready again for rematch');

// Black-tier Cataclysm objective: three unique scattered shards can win away from the finish tile.
await room.webSocketMessage(guest.server, JSON.stringify({ type: 'ready' }));
saved = await state.storage.get('room');
const shardStart = structuredClone(initial);
shardStart.game.shards = [{ id: 1, pos: 3, collected: false }, { id: 2, pos: 16, collected: false }, { id: 3, pos: 29, collected: false }];
shardStart.game.p[0].blackShards = 0; shardStart.game.p[1].blackShards = 0;
await room.webSocketMessage(host.server, JSON.stringify({ type: 'start', snapshot: shardStart, settings: saved.settings }));
saved = await state.storage.get('room');
assert.equal(saved.status, 'playing', 'match restarts for Cataclysm objective test');
const shardVictory = structuredClone(shardStart);
shardVictory.game.p[0].pos = 8;
shardVictory.game.p[0].blackShards = 3;
shardVictory.game.shards.forEach(shard => shard.collected = true);
shardVictory.game.win = 0; shardVictory.game.cur = 0;
shardVictory.game.cataclysmWin = true; shardVictory.game.winReason = 'black-shards';
await room.webSocketMessage(host.server, JSON.stringify({ type: 'sync', baseRevision: saved.revision, snapshot: shardVictory, event: { type: 'cataclysm-win' } }));
saved = await state.storage.get('room');
assert.equal(saved.status, 'finished', 'three black shards win immediately away from the finish tile');
assert.equal(saved.snapshot.game.p[0].pos, 8, 'black-shard victory does not require the finish tile');

// A second lobby proves room-locking and host-only controls before a match.
const lockState = new FakeState();
const lockRoom = new Room(lockState, {});
const lockCreate = await lockRoom.fetch(new Request('https://room.internal/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roomCode: 'LOCK234', clientId: 'lock-host', name: 'Lock Host', settings: { maxPlayers: 2 } }) }));
const lockKey = (await lockCreate.json()).hostKey;
const lockHostPair = new FakePair();
const lockUrl = new URL('https://room.internal/ws/LOCK234'); lockUrl.searchParams.set('clientId','lock-host'); lockUrl.searchParams.set('name','Lock Host'); lockUrl.searchParams.set('hostKey',lockKey);
await lockRoom.fetch(new Request(lockUrl, { headers: { Upgrade: 'websocket' } }));
const lockHost = lockState.getWebSockets()[0];
await lockRoom.webSocketMessage(lockHost, JSON.stringify({ type:'lock' }));
const lockedJoinUrl = new URL('https://room.internal/ws/LOCK234'); lockedJoinUrl.searchParams.set('clientId','late-friend'); lockedJoinUrl.searchParams.set('name','Late Friend'); lockedJoinUrl.searchParams.set('resumeKey','late-friend-secret-token-1234567890123456');
const lockedJoin = await lockRoom.fetch(new Request(lockedJoinUrl, { headers: { Upgrade:'websocket' } }));
assert.equal(lockedJoin.status, 403, 'locked private room rejects new joiners');

const htmlPath = path.join(path.dirname(new URL(import.meta.url).pathname), '../public/index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
assert.match(html, /id="onlineOpen"/, 'ONLINE button is present');
assert.match(html, /PRIVATE ROOM/, 'UI is private-room only');
assert.match(html, /new WebSocket\(/, 'client uses WebSocket');
assert.match(html, /id="mapMode"/, 'game supports default/custom map selection');
assert.match(html, /id="devCollectShard"/, 'dev tools can manually collect black shards');
assert.match(html, /devEditorBtn\.id='devEditorBtn'/, 'dev mode can run the current custom editor map');
assert.match(html, /function scatterBlackShards\(/, 'black shards are generated dynamically for current map dimensions');
assert.match(html, /id="startGold"/, 'custom rules are exposed in the main setup');
assert.equal((html.match(/<option value="kuku">Kukukaka<\/option>/g) || []).length, 2, 'Kukukaka is available in both language selectors');
assert.match(html, /\['Số người chơi','nô lệ'\]/, 'Kukukaka player label mapping exists');
assert.match(html, /\['Mã phòng','sửa đi'\]/, 'Kukukaka room-code mapping exists');
assert.match(html, /\['Ô','Ổ nô lệ'\]/, 'Kukukaka tile mapping exists');
const kukuDictionaryStart = html.indexOf('const APP_TEXT_KUKU=[');
const kukuDictionaryEnd = html.indexOf('];', kukuDictionaryStart) + 2;
const kukuFunctionStart = html.indexOf('function translateAppText(value){');
const kukuFunctionEnd = html.indexOf('\nfunction localizeNode', kukuFunctionStart);
assert.ok(kukuDictionaryStart >= 0 && kukuDictionaryEnd > kukuDictionaryStart && kukuFunctionEnd > kukuFunctionStart, 'Kukukaka translator source is present');
const kukuSandbox = { appLanguage: 'kuku', CD: [{ n: 'Sahur', d: 'wooden summon description' }, { n: 'HỐ ĐEN', d: 'black hole description' }] };
vm.createContext(kukuSandbox);
vm.runInContext(html.slice(kukuDictionaryStart, kukuDictionaryEnd) + '\n' + html.slice(kukuFunctionStart, kukuFunctionEnd) + '\nthis.kukuTranslate = translateAppText;', kukuSandbox);
assert.equal(kukuSandbox.kukuTranslate('Số người chơi'), 'nô lệ', 'Kukukaka player label translates');
assert.equal(kukuSandbox.kukuTranslate('Bản đồ'), 'nơi sinh tồn', 'Kukukaka board label translates');
assert.equal(kukuSandbox.kukuTranslate('Độ khó vùng cuối'), 'ác mộng của nô lệ', 'Kukukaka end-zone label translates');
assert.equal(kukuSandbox.kukuTranslate('Hỗn loạn'), 'tỉ lệ sợ hãi', 'Kukukaka chaos label translates');
assert.equal(kukuSandbox.kukuTranslate('Bộ thẻ khởi đầu'), 'kỹ năng sinh tồn', 'Kukukaka starter label translates');
assert.equal(kukuSandbox.kukuTranslate('Bắt đầu ván'), 'Sinh tồn', 'Kukukaka start label translates');
assert.equal(kukuSandbox.kukuTranslate('Chơi trực tuyến'), 'sinh tồn online', 'Kukukaka online label translates');
assert.equal(kukuSandbox.kukuTranslate('Biệt danh'), 'Thông tin nô lệ', 'Kukukaka nickname label translates');
assert.equal(kukuSandbox.kukuTranslate('Loại phòng'), 'Sân chơi', 'Kukukaka room type translates');
assert.equal(kukuSandbox.kukuTranslate('Riêng tư'), 'cô lập', 'Kukukaka private visibility translates');
assert.equal(kukuSandbox.kukuTranslate('Công khai'), 'tự do', 'Kukukaka public visibility translates');
assert.equal(kukuSandbox.kukuTranslate('MÃ PHÒNG'), 'sửa đi', 'Kukukaka room code translates');
assert.equal(kukuSandbox.kukuTranslate('Tung xúc xắc'), 'vòng quay số mệnh', 'Kukukaka dice action translates');
assert.equal(kukuSandbox.kukuTranslate('Vàng'), 'kinh phí', 'Kukukaka currency label translates');
assert.equal(kukuSandbox.kukuTranslate('50 ô'), '50 Ổ nô lệ', 'Kukukaka standalone tile word translates');
assert.equal(kukuSandbox.kukuTranslate('Sahur'), 'gugugaga', 'Kukukaka card title translates');
assert.equal(kukuSandbox.kukuTranslate('Hố Đen'), 'gugugaga', 'Kukukaka card title matching ignores case');
assert.equal(kukuSandbox.kukuTranslate('wooden summon description'), 'gugugaga', 'Kukukaka card description translates');
assert.equal(kukuSandbox.kukuTranslate('Settings'), 'gugugaga', 'unmapped English UI text falls back to gugugaga');
assert.equal(kukuSandbox.kukuTranslate('Quality'), 'gugugaga', 'unmapped settings labels fall back to gugugaga');
assert.equal(kukuSandbox.kukuTranslate('Nhập keycode để mở công cụ kiểm thử.'), 'gugugaga', 'unmapped Vietnamese dialog text falls back to gugugaga');
assert.equal(kukuSandbox.kukuTranslate('Chưa có hoạt động.'), 'gugugaga', 'unmapped dynamic empty states fall back to gugugaga');
assert.equal(kukuSandbox.kukuTranslate('RẮN RÁC · MULTIPLAYER'), 'gugugaga', 'unmapped brand and overlay labels fall back to gugugaga');
assert.equal(kukuSandbox.kukuTranslate('Kukukaka'), 'gugugaga', 'the language name itself follows the fallback rule');
assert.equal(kukuSandbox.kukuTranslate('Số người chơi: 4'), 'nô lệ: 4', 'existing glossary translations remain intact around dynamic values');
assert.match(html, /function slowEffectAnimations\(el\)/, 'card cinematics share a slowdown helper');
assert.match(html, /animation\.playbackRate=\.72/, 'card cinematic CSS animations play at 72 percent speed');
assert.match(html, /key==='black-hole'\?7200:key==='cataclysm'\?4050:5150\)\*1\.4/, 'black cinematic canvas timeline is lengthened by 40 percent');
assert.match(html, /reduced\?1450:4760/, 'red card cinematic stays visible longer');
assert.match(html, /reduced\?1350:5040/, 'Sahur cinematic stays visible longer');

assert.match(html, /document\.title=appLanguage==='en'\?'Snake Slop':appLanguage==='kuku'\?'gugugaga':'Rắn Rác'/, 'browser title uses gugugaga in Kukukaka mode');
assert.match(html, /key:'masked-knight'/, 'masked knight red card is present');
assert.ok(html.indexOf('CD.push(...EXTRA_CARDS);') < html.indexOf("key:'masked-knight'"), 'new cards are appended after all 100 legacy card IDs');
assert.match(html, /key:'sahur'/, 'Sahur yellow card is present');
assert.match(html, /key:'tornado'/, 'permanent Tornado black card is present');
assert.match(html, /key:'snake-form'/, 'three-turn snake form black card is present');
const appendedCardsStart = html.indexOf('CD.push(...[');
const appendedCardsArrayStart = html.indexOf('[', appendedCardsStart);
const appendedCardsEnd = html.indexOf('\n]);', appendedCardsArrayStart);
assert.ok(appendedCardsStart >= 0 && appendedCardsArrayStart > appendedCardsStart && appendedCardsEnd > appendedCardsArrayStart, 'new card definitions are appended after the legacy deck');
const cardPlayers = [{pos:10,gold:40,cards:[]},{pos:35,gold:0,cards:[]},{pos:20,gold:0,cards:[]}];
const cardGame = {p:cardPlayers};
const getLeaderOpponent = player => cardGame.p.filter(other => other !== player).sort((a,b) => b.pos-a.pos)[0];
const appendedCards = new Function('G','LD','SZ','LAST','NM', 'return [' + html.slice(appendedCardsArrayStart+1,appendedCardsEnd) + '];')(cardGame,getLeaderOpponent,()=>100,()=>99,['You','Leader','Third']);
const maskedKnight = appendedCards.find(card => card.key === 'masked-knight');
const sahur = appendedCards.find(card => card.key === 'sahur');
const tornado = appendedCards.find(card => card.key === 'tornado');
const snakeForm = appendedCards.find(card => card.key === 'snake-form');
assert.equal(maskedKnight.ok(cardPlayers[0]), '', 'Masked Knight requires more than 30 gold');
assert.notEqual(maskedKnight.ok({...cardPlayers[0],gold:30}), '', 'Masked Knight is unavailable at exactly 30 gold');
maskedKnight.use(cardPlayers[0],[]);
assert.equal(cardPlayers[1].pos, 5, 'Masked Knight pushes the leading opponent back by 30% of a 100-tile board');
cardPlayers[1].pos=35;cardPlayers[2].pos=20;
sahur.use(cardPlayers[0],[]);
assert.equal(cardPlayers[1].pos, 0, 'Sahur sends the leading opponent to the starting tile');
tornado.use(cardPlayers[0],[]);
assert.equal(cardGame.tornado, true, 'Tornado sets its permanent match state');
snakeForm.use(cardPlayers[0],[]);
assert.deepEqual(cardGame.snakeForm, {owner:0,turnsLeft:3}, 'Become a Snake starts with three owner turns');
assert.match(html, /@media\(orientation:landscape\)/, 'landscape mobile layout is present');
assert.match(html, /is-tornado-shuffling/, 'Tornado map animation is present');
const effectFunctionsStart = html.indexOf('function playTornadoBoardAnimation(){');
const effectFunctionsEnd = html.indexOf('\nconst SY=', effectFunctionsStart);
assert.ok(effectFunctionsStart >= 0 && effectFunctionsEnd > effectFunctionsStart, 'Tornado and duration functions are present');
const effectBoard = { n: 5, r: 5, sp: Array(25).fill(0), sl: Array(25).fill(0), sn: [[20, 6], [14, 4]], la: [[2, 12], [8, 19]], po: [[5, 17]], cost: 1 };
effectBoard.sp[0] = 2; effectBoard.sp[24] = 3; effectBoard.sl[0] = 1; effectBoard.sl[24] = 1;
for (let i = 1; i < 24; i++) { if (i % 5 === 0) effectBoard.sp[i] = 4; if (i % 7 === 0) effectBoard.sl[i] = 1; }
const effectGame = { t: 0, tornado: true, snakeForm: { owner: 1, turnsLeft: 3 }, tmp: [{ s: effectBoard.sn[0], u: 99 }], p: [{ pos: 3 }, { pos: 8 }] };
let tornadoAnimations = 0;
const effectSandbox = { M: effectBoard, G: effectGame, SZ: () => 25, LAST: () => 24, dirty: 0, gj: '', migrate() {}, storm() {}, $: () => ({ classList: { remove() {}, add() { tornadoAnimations++; } }, get offsetWidth() { return 1; } }), window: { setTimeout() {} } };
vm.createContext(effectSandbox);
vm.runInContext(html.slice(effectFunctionsStart, effectFunctionsEnd) + '\nthis.shuffleTornadoMap = shuffleTornadoMap; this.advanceGlobalTurn = advanceGlobalTurn;', effectSandbox);
const originalCells = { sp: effectBoard.sp.slice().sort((a,b)=>a-b).join(','), sl: effectBoard.sl.slice().sort((a,b)=>a-b).join(','), p: JSON.stringify(effectGame.p.map(player => player.pos)), endpoints: [effectBoard.sp[0],effectBoard.sp[24],effectBoard.sl[0],effectBoard.sl[24]] };
effectSandbox.shuffleTornadoMap([]);
assert.equal(effectBoard.sp.slice().sort((a,b)=>a-b).join(','), originalCells.sp, 'Tornado permutes special tiles without losing them');
assert.equal(effectBoard.sl.slice().sort((a,b)=>a-b).join(','), originalCells.sl, 'Tornado permutes slow zones without losing them');
assert.equal(JSON.stringify(effectGame.p.map(player => player.pos)), originalCells.p, 'Tornado keeps players on their numbered cells');
assert.deepEqual([effectBoard.sp[0],effectBoard.sp[24],effectBoard.sl[0],effectBoard.sl[24]], originalCells.endpoints, 'Tornado leaves start/finish endpoint features fixed');
assert.ok(effectBoard.sn.every(([a,b]) => a > b && a < 25 && b >= 0), 'Tornado preserves descending snake links');
assert.ok(effectBoard.la.every(([a,b]) => a < b), 'Tornado preserves ascending ladder links');
assert.equal(effectGame.tmp[0].s, effectBoard.sn[0], 'Tornado keeps temporary snake expiry attached');
assert.equal(effectSandbox.gj, JSON.stringify(effectBoard), 'Tornado refreshes the portable map snapshot');
assert.ok(tornadoAnimations > 0, 'Tornado triggers its mobile board animation');
effectSandbox.advanceGlobalTurn([], 0);
assert.equal(effectGame.snakeForm.turnsLeft, 3, 'another player turn does not consume snake-form duration');
effectSandbox.advanceGlobalTurn([], 1);
assert.equal(effectGame.snakeForm.turnsLeft, 2, 'the snake owner consumes one duration on their turn');
effectSandbox.advanceGlobalTurn([], 1); effectSandbox.advanceGlobalTurn([], 1);
assert.equal(effectGame.snakeForm, null, 'snake form expires after three owner turns');
assert.equal(effectGame.tornado, true, 'Tornado stays active permanently for the match');
const trapStart = html.indexOf('if(G.snakeForm&&G.snakeForm.turnsLeft>0&&idx!==G.snakeForm.owner&&d.some(value=>value>3))');
const trapEnd = html.indexOf('collectBlackShardAtPosition(p,idx,ms)', trapStart);
assert.ok(trapStart >= 0 && trapEnd > trapStart, 'snake-form trigger is present');
const applySnakeTrap = new Function('G','idx','d','p','route','NM','ms', html.slice(trapStart,trapEnd) + 'return p.pos;');
const trapState = { snakeForm: { owner: 0, turnsLeft: 3 }, p: [{ pos: 20 }, { pos: 3 }] };
const trapPlayer = { pos: 3 }, trapRoute = [3], trapLog = [];
assert.equal(applySnakeTrap(trapState, 1, [2,5,1], trapPlayer, trapRoute, ['Host','Guest'], trapLog), 15, 'a die above 3 pulls the opponent to five spaces behind the snake owner');
assert.deepEqual(trapRoute, [3,15], 'snake-form relocation is appended to the animation route');

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
assert.equal(scripts.length, 2, 'both game and online scripts are present');
for (const [index, match] of scripts.entries()) new vm.Script(match[1], { filename: `index-script-${index}.js` });

// Exercise the Worker HTTP create API, not just the Durable Object internals.
const apiNamespace = new Map();
const env = {
  ROOMS: {
    idFromName(name) { return name; },
    get(id) {
      if (!apiNamespace.has(id)) apiNamespace.set(id, new Room(new FakeState(), {}));
      const instance = apiNamespace.get(id);
      return { fetch: (input, init) => instance.fetch(input instanceof Request ? input : new Request(input, init)) };
    },
  },
  ASSETS: { fetch: async () => new TestResponse('asset', { status: 200 }) },
};
const health = await Worker.fetch(new Request('https://example.workers.dev/api/health'), env);
assert.equal(health.status, 200, 'health endpoint is online');
const createApi = await Worker.fetch(new Request('https://example.workers.dev/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId: 'api-host', name: 'API Host', settings: { maxPlayers: 2 } }) }), env);
assert.equal(createApi.status, 200, 'HTTP room creation succeeds');
const createdApiRoom = await createApi.json();
assert.match(createdApiRoom.roomCode, /^[A-Z2-9]{7}$/, 'room code is private/random');
assert.ok(createdApiRoom.hostKey, 'host key returned privately');
const staticPage = await Worker.fetch(new Request('https://example.workers.dev/'), env);
assert.equal(await staticPage.text(), 'asset', 'static HTML falls through to the asset binding');
const apiWsUrl = new URL(`https://example.workers.dev/ws/${createdApiRoom.roomCode}`);
apiWsUrl.searchParams.set('clientId', 'api-host'); apiWsUrl.searchParams.set('name', 'API Host'); apiWsUrl.searchParams.set('hostKey', createdApiRoom.hostKey);
const apiWs = await Worker.fetch(new Request(apiWsUrl, { headers: { Upgrade: 'websocket' } }), env);
assert.equal(apiWs.status, 101, 'Worker routes /ws/ROOM to the right Durable Object');
console.log('PASS: API/static/WebSocket routing, private reconnect-key protection, custom lobby rules, lobby/ready/start, turn authorization, snapshot sync/revision, reactions, spectator join, finish-tile and black-shard victories, rematch, room locking/expiry, and frontend syntax/markup');
