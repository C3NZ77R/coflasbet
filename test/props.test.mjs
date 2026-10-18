// Props: normalización de The Odds API (fixture con el formato v4), enlace con ESPN y demo-props.json. Sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normName, sameTeam, matchGame, normEventProps, getProps } from '../lib/props.mjs';
import { normScoreboard } from '../lib/espn.mjs';
import { leagueById } from '../public/leagues.js';
import { statForMarket } from '../public/stats.js';

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

test('nombres y equipos', () => {
  assert.equal(normName('Luka Dončić'), 'luka doncic');
  assert.equal(normName('Chris Cenac Jr.'), 'chris cenac');
  assert.equal(normName("De'Aaron Fox"), 'de aaron fox');
  assert.ok(sameTeam('Atletico Madrid', 'Atlético de Madrid'));
  assert.ok(sameTeam('LA Clippers', 'Los Angeles Clippers'));
  assert.ok(sameTeam('Detroit Pistons', 'Detroit Pistons'));
  assert.ok(!sameTeam('Los Angeles Lakers', 'Los Angeles Clippers'));
  assert.ok(!sameTeam('Real Madrid', 'Atletico Madrid'));
  assert.ok(sameTeam('Inter Miami CF', 'Inter Miami'));
  assert.ok(!sameTeam('', 'Boston Celtics'));
});

test('enlace evento de The Odds API ↔ partido de ESPN', () => {
  const games = normScoreboard(fx('scoreboard-nba.json'), 'nba');
  const ev = fx('oddsapi-event-props.json');
  assert.equal(matchGame(ev, games)?.id, '401909088');
  assert.equal(matchGame({ ...ev, commence_time: '2026-10-22T19:00:00Z' }, games), null); // otro día
  assert.equal(matchGame({ ...ev, home_team: 'Boston Celtics', away_team: 'Detroit Pistons' }, games), null); // local/visita al revés
});

test('evento de The Odds API → Prop[]', () => {
  const players = new Map([[normName('Jayson Tatum'), { athleteId: '4065648', team: 'BOS', opp: 'DET' }]]);
  const props = normEventProps(fx('oddsapi-event-props.json'), { league: 'nba', sport: 'basketball', gameId: '401909088', players });
  const over = props.find((p) => p.player === 'Jayson Tatum' && p.market === 'player_points' && p.line === 26.5 && p.side === 'Over');
  assert.deepEqual(over.books, [{ key: 'draftkings', title: 'DraftKings', price: 1.87 }, { key: 'fanduel', title: 'FanDuel', price: 1.9 }]);
  assert.deepEqual([over.athleteId, over.team, over.opp, over.stat, over.gameId, over.start], ['4065648', 'BOS', 'DET', 'pts', '401909088', '2026-10-20T19:00:00Z']);
  assert.equal(over.eventId, 'e912304de2b2ce35b473ce2ecd3d1502');
  assert.ok(props.some((p) => p.line === 29.5), 'otra línea = otro prop');
  const dd = props.filter((p) => p.market === 'player_double_double');
  assert.deepEqual(dd.map((p) => [p.side, p.line, p.stat]), [['Over', 0.5, 'dd'], ['Under', 0.5, 'dd']]); // Sí/No → Over/Under 0.5
  const cade = props.find((p) => p.player === 'Cade Cunningham');
  assert.deepEqual([cade.athleteId, cade.team], [null, null]); // sin enlace no se inventa
  assert.equal(props.find((p) => p.market === 'player_threes_alternate').stat, '3pm');
  assert.ok(!props.some((p) => p.player === 'Jaylen Brown' || p.player === ''), 'se descartan cuotas <= 1 y outcomes sin jugador');
  assert.equal(new Set(props.map((p) => p.id)).size, props.length);
});

test('sin clave: demo-props.json filtrado y marcado como demo', async () => {
  const all = await getProps('nba');
  assert.equal(all.source, 'demo');
  assert.ok(all.data.length > 0);
  assert.ok(all.data.every((p) => p.league === 'nba'));
  const gameId = all.data[0].gameId;
  const one = await getProps('nba', gameId);
  assert.ok(one.data.length > 0 && one.data.every((p) => p.gameId === gameId));
  assert.equal((await getProps('nhl')).data.length, 0);
  await assert.rejects(getProps('xx'), { status: 400 });
});

test('demo-props.json cumple el tipo Prop y usa IDs reales de ESPN', () => {
  const { props } = JSON.parse(readFileSync(new URL('../demo-props.json', import.meta.url), 'utf8'));
  const keys = ['athleteId', 'books', 'eventId', 'gameId', 'id', 'league', 'line', 'market', 'opp', 'player', 'side', 'start', 'stat', 'team'];
  assert.ok(new Set(props.map((p) => p.league)).size >= 2);
  assert.equal(new Set(props.map((p) => p.id)).size, props.length);
  for (const p of props) {
    assert.deepEqual(Object.keys(p).sort(), keys);
    assert.match(p.gameId, /^\d+$/);
    assert.match(p.athleteId, /^\d+$/);
    assert.ok(['Over', 'Under'].includes(p.side));
    assert.equal(statForMarket(leagueById(p.league).sport, p.market)?.key, p.stat);
    assert.ok(p.books.length >= 2 && p.books.every((b) => b.key && b.title && b.price > 1));
  }
});

test('con clave: eventos gratis → odds del partido elegido, enlazado con ESPN (fetch simulado)', async (t) => {
  const start = new Date(Date.now() + 864e5).toISOString().replace('.000', '');
  const ev = { ...fx('oddsapi-event-props.json'), commence_time: start };
  const board = fx('scoreboard-nba.json');
  board.events[0].date = board.events[0].competitions[0].date = start;
  const roster = { team: { id: '2', abbreviation: 'BOS' }, athletes: [{ id: '4065648', displayName: 'Jayson Tatum', position: { abbreviation: 'F' } }] };
  const calls = [];
  const reply = (body, headers = {}) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', ...headers } });
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = new URL(url);
    calls.push(u);
    if (u.pathname.endsWith('/sports/basketball_nba/events')) return reply([{ id: ev.id, commence_time: start, home_team: ev.home_team, away_team: ev.away_team }]);
    if (u.pathname.endsWith(`/events/${ev.id}/odds`)) return reply(ev, { 'x-requests-remaining': '488' });
    if (u.pathname.endsWith('/scoreboard')) return reply(board);
    if (u.pathname.endsWith('/roster')) return reply(roster);
    return new Response('{}', { status: 404 });
  });
  const res = await getProps('nba', '401909088', { key: 'test-key', regions: 'us', maxEvents: 2 });
  assert.equal(res.source, 'live');
  assert.equal(res.remaining, '488');
  const odds = calls.find((u) => u.pathname.endsWith('/odds'));
  assert.equal(odds.searchParams.get('regions'), 'us');
  assert.equal(odds.searchParams.get('oddsFormat'), 'decimal');
  assert.ok(odds.searchParams.get('markets').split(',').includes('player_points'));
  const tatum = res.data.find((p) => p.player === 'Jayson Tatum');
  assert.deepEqual([tatum.gameId, tatum.athleteId, tatum.team, tatum.opp], ['401909088', '4065648', 'BOS', 'DET']);
  assert.deepEqual((await getProps('nba', '999', { key: 'test-key', regions: 'us' })).data, []); // partido sin evento en The Odds API
});
