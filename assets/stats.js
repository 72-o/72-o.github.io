// Shared by the site (browser) and the image build (Node). Pure functions only:
// everything shown anywhere is derived from data/db.json through this file.

export const MIN_GAMES = 3;      // games needed to enter the ranking
export const MIN_QUALIFIED = 3;  // below this many qualified players, everyone is ranked
export const MIN_PLAYERS = 3;    // smallest table we accept as a game

// ---------- names ----------

export function cleanName(name) {
  return String(name ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

export function nameKey(name) {
  return cleanName(name).toLocaleLowerCase('tr');
}

// Leaderboards show the nickname when one is set, otherwise the real name.
export function displayName(name, nicks) {
  const nick = nicks && nicks[nameKey(name)];
  return nick ? cleanName(nick) : cleanName(name);
}

// ---------- points ----------

// 1st 5, 2nd 4, 3rd 3, last 0, everyone else 1. Podium wins over "last" at tiny tables.
export function pointsFor(place, tableSize) {
  if (place === 1) return 5;
  if (place === 2) return 4;
  if (place === 3) return 3;
  if (place === tableSize) return 0;
  return 1;
}

// ---------- dates and leagues ----------

export function todayISO(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

export function isValidISODate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// A league runs from 1 October to 30 September.
export function ligKey(iso) {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const start = m >= 10 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export function ligLabel(key) {
  return `${key.replace('-', '–')} Ligi`;
}

// ---------- games and scopes ----------

export function activeGames(db) {
  return (db?.games || [])
    .filter(g => !g.deleted)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
}

// Ana Tablo first, then every league that has games plus the current one, newest first.
export function scopeList(db, today = todayISO()) {
  const current = ligKey(today);
  const keys = new Set(activeGames(db).map(g => ligKey(g.date)));
  keys.add(current);
  const ligs = [...keys].sort().reverse().map(key => ({
    type: 'lig', key, id: `lig-${key}`, label: ligLabel(key), current: key === current,
  }));
  return [{ type: 'ana', key: 'ana', id: 'ana', label: 'Ana Tablo', current: false }, ...ligs];
}

export function findScope(db, id, today = todayISO()) {
  return scopeList(db, today).find(s => s.id === id) || null;
}

export function gamesFor(db, scope) {
  const all = activeGames(db);
  return scope.type === 'ana' ? all : all.filter(g => ligKey(g.date) === scope.key);
}

// The roster: registered players plus any name that appears in a game, with active game counts.
export function playerList(db) {
  const map = new Map();
  for (const p of db?.players || []) {
    const key = nameKey(p.name);
    if (key && !map.has(key)) map.set(key, { key, name: cleanName(p.name), nick: cleanName(p.nick || ''), count: 0, registered: true });
  }
  for (const g of db?.games || []) {
    for (const n of g.players) {
      const key = nameKey(n);
      if (!map.has(key)) map.set(key, { key, name: cleanName(n), nick: '', count: 0, registered: false });
      if (!g.deleted) map.get(key).count++;
    }
  }
  return [...map.values()];
}

export function nickMap(db) {
  const out = {};
  for (const p of db?.players || []) if (p.nick) out[nameKey(p.name)] = cleanName(p.nick);
  return out;
}

// ---------- rating (OpenSkill / Weng-Lin Plackett-Luce, one player per team) ----------

const MU = 25;
const SIGMA = MU / 3;
const BETA = SIGMA / 2;
const KAPPA = 0.0001;
const TAU = MU / 300;
const RATING_BASE = 1000;
const RATING_SCALE = 40;

// ratings: [{ mu, sigma }] in finishing order (index 0 won). Returns updated ratings.
export function rateGame(ratings) {
  const teams = ratings.map(r => ({ mu: r.mu, s2: r.sigma ** 2 + TAU ** 2 }));
  const c = Math.sqrt(teams.reduce((a, t) => a + t.s2 + BETA ** 2, 0));
  const e = teams.map(t => Math.exp(t.mu / c));
  const sumQ = teams.map((_, q) => e.slice(q).reduce((a, b) => a + b, 0));
  return teams.map((t, i) => {
    let omega = 0;
    let delta = 0;
    for (let q = 0; q <= i; q++) {
      const quotient = e[i] / sumQ[q];
      omega += q === i ? 1 - quotient : -quotient;
      delta += quotient * (1 - quotient);
    }
    const gamma = Math.sqrt(t.s2) / c;
    return {
      mu: t.mu + (t.s2 / c) * omega,
      sigma: Math.sqrt(t.s2 * Math.max(1 - gamma * (t.s2 / c ** 2) * delta, KAPPA)),
    };
  });
}

export function displayRating(mu, sigma) {
  return Math.round(RATING_BASE + RATING_SCALE * (mu - 3 * sigma));
}

// ---------- boards ----------

export function buildBoard(games, scope, nicks = {}) {
  const map = new Map();
  const get = name => {
    const k = nameKey(name);
    if (!map.has(k)) {
      map.set(k, { name: displayName(name, nicks), realName: cleanName(name), games: 0, p1: 0, p2: 0, p3: 0, points: 0, expected: 0, history: [], mu: MU, sigma: SIGMA });
    }
    return map.get(k);
  };

  for (const g of games) {
    const n = g.players.length;
    const ps = g.players.map(get);
    ps.forEach((p, i) => {
      const place = i + 1;
      const pts = pointsFor(place, n);
      p.games++;
      if (place === 1) p.p1++;
      else if (place === 2) p.p2++;
      else if (place === 3) p.p3++;
      p.points += pts;
      p.expected += 1 / n;
      p.history.push({ place, n, pts });
    });
    const next = rateGame(ps.map(p => ({ mu: p.mu, sigma: p.sigma })));
    ps.forEach((p, i) => { p.mu = next[i].mu; p.sigma = next[i].sigma; });
  }

  const players = [...map.values()].map(p => {
    const recent = p.history.slice(-5).reverse();
    return {
      name: p.name,
      realName: p.realName,
      games: p.games,
      p1: p.p1,
      p2: p.p2,
      p3: p.p3,
      points: p.points,
      winPct: p.p1 / p.games,
      podiumPct: (p.p1 + p.p2 + p.p3) / p.games,
      luck: p.p1 - p.expected,
      form: recent.map(h => h.place),
      formPts: recent.reduce((a, h) => a + h.pts, 0),
      rating: displayRating(p.mu, p.sigma),
    };
  });

  const qualified = players.filter(p => p.games >= MIN_GAMES);
  const fallback = players.length > 0 && qualified.length < MIN_QUALIFIED;
  const main = fallback ? players : qualified;
  const below = fallback ? [] : players.filter(p => p.games < MIN_GAMES);

  return {
    scope,
    gameCount: games.length,
    playerCount: players.length,
    last: games.length
      ? { ...games[games.length - 1], players: games[games.length - 1].players.map(n => displayName(n, nicks)) }
      : null,
    fallback,
    main: sortPlayers(main, scope),
    below: sortPlayers(below, scope),
  };
}

// ---------- sorting ----------

export const SORT_KEYS = {
  name: p => p.name,
  games: p => p.games,
  p1: p => p.p1,
  p2: p => p.p2,
  p3: p => p.p3,
  winPct: p => p.winPct,
  podiumPct: p => p.podiumPct,
  points: p => p.points,
  luck: p => p.luck,
  form: p => p.formPts,
  rating: p => p.rating,
};

export function defaultSortKey(scope) {
  return scope.type === 'ana' ? 'winPct' : 'points';
}

function tieBreaks(scope) {
  return scope.type === 'ana'
    ? [['winPct', -1], ['games', -1], ['podiumPct', -1], ['points', -1]]
    : [['points', -1], ['p1', -1], ['p2', -1], ['p3', -1], ['games', 1]];
}

function compare(a, b) {
  if (typeof a === 'string') return a.localeCompare(b, 'tr');
  return a < b ? -1 : a > b ? 1 : 0;
}

// dir: 'desc' or 'asc'. Ties fall back to the scope's default order, then the name.
export function sortPlayers(list, scope, key = defaultSortKey(scope), dir = 'desc') {
  const chain = [[key, dir === 'asc' ? 1 : -1], ...tieBreaks(scope)];
  return list.slice().sort((a, b) => {
    for (const [k, d] of chain) {
      const c = compare(SORT_KEYS[k](a), SORT_KEYS[k](b));
      if (c) return c * d;
    }
    return compare(a.name, b.name);
  });
}

// ---------- export ----------

function csvCell(v) {
  const s = String(v);
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// One row per player per game. Semicolons and a BOM so Turkish Excel opens it cleanly.
export function gamesCsv(games, nicks = {}) {
  const rows = [['tarih', 'oyun_no', 'lig', 'sira', 'oyuncu', 'nick', 'oyuncu_sayisi', 'puan']];
  for (const g of games) {
    const n = g.players.length;
    g.players.forEach((name, i) => {
      rows.push([formatDate(g.date), g.id, ligLabel(ligKey(g.date)), i + 1, name, nicks[nameKey(name)] || '', n, pointsFor(i + 1, n)]);
    });
  }
  return '﻿' + rows.map(r => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

// One player, game or log entry per line keeps the git history readable.
export function serializeDb(db) {
  const list = arr => (arr.length ? '\n' + arr.map(x => '    ' + JSON.stringify(x)).join(',\n') + '\n  ' : '');
  const players = (db.players || []).map(p => (p.nick ? { name: p.name, nick: p.nick } : { name: p.name }));
  return `{\n  "version": 1,\n  "players": [${list(players)}],\n  "games": [${list(db.games || [])}],\n  "log": [${list(db.log || [])}]\n}\n`;
}

// ---------- formatting ----------

export function fmtPct(x) {
  return `%${Math.round(x * 100)}`;
}

export function fmtSigned(x) {
  const r = Math.round(x * 10) / 10;
  const s = Math.abs(r).toFixed(1).replace('.', ',');
  return r > 0 ? `+${s}` : r < 0 ? `−${s}` : '0';
}
