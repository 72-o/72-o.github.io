import * as S from './stats.js';
import { esc, LEAGUE_NAME } from './card.js';

const REPO = '72-o/72-o.github.io';
const DATA_PATH = 'data/db.json';
const API = `https://api.github.com/repos/${REPO}`;
const LS_TOKEN = 'poker.token';
const LS_DETAIL = 'poker.detail';
const GAMES_PREVIEW = 20;
const HISTORY_PREVIEW = 30;

const view = document.getElementById('view');
const today = S.todayISO();

const state = {
  db: emptyDb(),
  build: null,
  loaded: false,
  loadError: null,
  sort: {},
  detail: lsGet(LS_DETAIL) === '1',
  pendingData: null,   // blob sha of data/db.json the build has not caught up with yet
  pendingStuck: false,
  pollTimer: null,
  png: {},             // prefetched share images, keyed by scope id + data sha
  showDeleted: false,
  gamesAll: false,
  historyAll: false,
  confirmDelete: null,
  playerEdit: null,    // key of the roster row being edited
  playerMsg: null,
  playerBusy: false,
  form: blankForm(),
};

function emptyDb() {
  return { version: 1, players: [], games: [], log: [] };
}

function blankForm() {
  return { editId: null, date: today, order: [], busy: false, msg: null };
}

// ---------- small helpers ----------

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage blocked */ } }
function token() { return lsGet(LS_TOKEN); }

async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

let toastTimer;
function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function orderText(players) {
  return players.map((n, i) => `<b>${i + 1}.</b> ${esc(n)}`).join(' &nbsp;');
}

function nicks() {
  return S.nickMap(state.db);
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

function userError(message) {
  return Object.assign(new Error(message), { userMessage: message });
}

// ---------- GitHub API (admin only) ----------

async function gh(path, opts = {}) {
  let r;
  try {
    r = await fetch(API + path, {
      ...opts,
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${token()}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  } catch {
    throw Object.assign(new Error('network'), { status: 0 });
  }
  if (!r.ok) throw Object.assign(new Error(`GitHub ${r.status}`), { status: r.status });
  return r.json();
}

async function readRemote() {
  const j = await gh(`/contents/${DATA_PATH}?ref=main`);
  return { db: { ...emptyDb(), ...JSON.parse(b64decode(j.content)) }, sha: j.sha };
}

// Applies the change to the newest file on GitHub, so two edits never overwrite each other.
async function mutate(change, messageOf) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { db, sha } = await readRemote();
    const info = change(db);
    const body = { message: messageOf(info), content: b64encode(S.serializeDb(db)), sha, branch: 'main' };
    try {
      const r = await gh(`/contents/${DATA_PATH}`, { method: 'PUT', body: JSON.stringify(body) });
      state.db = db;
      waitForBuild(r.content.sha);
      return info;
    } catch (e) {
      lastErr = e;
      if (e.status === 409 || e.status === 422) continue;
      throw e;
    }
  }
  throw lastErr;
}

function errorText(e) {
  if (e.userMessage) return e.userMessage;
  switch (e.status) {
    case 0: return 'Bağlantı kurulamadı. İnternetini kontrol edip tekrar dene.';
    case 401: return 'Anahtar geçersiz ya da süresi dolmuş. Yardım sekmesindeki adımlarla yeni bir anahtar oluştur.';
    case 403: return 'Anahtarın yazma izni yok. Anahtarda "Contents: Read and write" izni olmalı.';
    case 404: return 'Anahtar bu repoya erişemiyor. Anahtarı oluştururken 72-o.github.io reposunu seçtiğinden emin ol.';
    case 409: case 422: return 'Aynı anda başka bir değişiklik yapıldı. Sayfayı yenileyip tekrar dene.';
    default: return `Kaydedilemedi (${e.message}). Tekrar dene.`;
  }
}

// ---------- build polling ----------

function waitForBuild(dataSha) {
  state.pendingData = dataSha;
  state.pendingStuck = false;
  clearTimeout(state.pollTimer);
  let tries = 0;
  const tick = async () => {
    tries++;
    const b = await getJSON(`build.json?t=${Date.now()}`).catch(() => null);
    if (b && b.dataSha === state.pendingData) {
      state.build = b;
      state.pendingData = null;
      if (!isTyping()) render();
      return;
    }
    if (tries < 60) state.pollTimer = setTimeout(tick, 10000);
    else { state.pendingStuck = true; if (!isTyping()) render(); }
  };
  state.pollTimer = setTimeout(tick, 12000);
}

function isTyping() {
  const el = document.activeElement;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && view.contains(el);
}

// When the admin opens the site, prefer the newest data on GitHub over the deployed copy.
async function syncAdmin() {
  if (!token()) return;
  try {
    const { db, sha } = await readRemote();
    if (!state.build || state.build.dataSha !== sha) {
      state.db = db;
      waitForBuild(sha);
      render();
    }
  } catch { /* the deployed copy is still fine to show */ }
}

// ---------- routing ----------

function currentRoute() {
  return decodeURIComponent(location.hash.slice(1)) || 'ana';
}

function render() {
  const route = currentRoute();
  renderNav(route);
  if (!state.loaded) return;
  if (state.loadError) {
    view.innerHTML = `<div class="empty"><strong>Veri yüklenemedi</strong>Sayfayı yenilemeyi dene.</div>`;
    return;
  }
  if (route === 'yeni') return renderYeni();
  if (route === 'yardim') return renderYardim();
  const scope = S.findScope(state.db, route, today);
  if (!scope) {
    view.innerHTML = `<div class="empty"><strong>Sayfa bulunamadı</strong><a href="#ana">Ana Tablo'ya dön</a></div>`;
    return;
  }
  renderBoard(scope);
}

function renderNav(route) {
  const scopes = S.scopeList(state.db, today).filter(s => s.type === 'lig');
  const onLig = route.startsWith('lig-');
  document.querySelectorAll('.tab').forEach(t => {
    const tab = t.dataset.tab;
    t.classList.toggle('active', tab === route || (tab === 'lig' && onLig));
  });
  const current = scopes.find(s => s.id === route);
  document.getElementById('lig-btn-label').textContent = current ? current.label : 'Ligler';
  document.getElementById('lig-menu').innerHTML = scopes.map(s =>
    `<a href="#${s.id}" class="${s.id === route ? 'active' : ''}">${esc(s.label)}${s.current ? '<small>güncel</small>' : ''}</a>`).join('');
}

function setMenu(open) {
  document.getElementById('lig-menu').hidden = !open;
  document.getElementById('lig-btn').setAttribute('aria-expanded', String(open));
}

document.getElementById('lig-btn').addEventListener('click', e => {
  e.stopPropagation();
  setMenu(document.getElementById('lig-menu').hidden);
});
document.addEventListener('click', () => setMenu(false));
document.addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });
window.addEventListener('hashchange', () => {
  setMenu(false);
  state.confirmDelete = null;
  render();
  window.scrollTo(0, 0);
});

// ---------- board pages ----------

const COLS = [
  { key: 'games', label: 'Oyun', cell: p => p.games },
  { key: 'p1', label: '1.', medal: 'var(--gold)', cell: p => p.p1, zero: p => !p.p1 },
  { key: 'p2', label: '2.', medal: 'var(--silver)', cell: p => p.p2, zero: p => !p.p2 },
  { key: 'p3', label: '3.', medal: 'var(--bronze)', cell: p => p.p3, zero: p => !p.p3 },
  { key: 'winPct', label: 'Kazanma %', cell: p => S.fmtPct(p.winPct) },
  { key: 'podiumPct', label: 'Podyum %', cell: p => S.fmtPct(p.podiumPct) },
  { key: 'points', label: 'Lig puanı', cell: p => p.points },
  { key: 'luck', label: 'Şans farkı', detail: true, cell: p => S.fmtSigned(p.luck), cls: p => (p.luck >= 0.05 ? 'pos' : p.luck <= -0.05 ? 'neg' : '') },
  { key: 'form', label: 'Form', detail: true, cell: p => p.form.join('·'), cls: () => 'form' },
  { key: 'rating', label: 'Rating', detail: true, cell: p => p.rating },
];
const SORT_LABEL = { name: 'oyuncu adı', ...Object.fromEntries(COLS.map(c => [c.key, c.label.toLocaleLowerCase('tr')])) };

// The page's main metric sits right after the medal columns, so it stays on screen on phones.
function colsFor(scope) {
  const main = S.defaultSortKey(scope);
  const base = COLS.filter(c => ['games', 'p1', 'p2', 'p3'].includes(c.key));
  return [...base, ...COLS.filter(c => c.key === main), ...COLS.filter(c => !base.includes(c) && c.key !== main)];
}

function sortOf(scope) {
  return state.sort[scope.id] || { key: S.defaultSortKey(scope), dir: 'desc' };
}

function boardTable(players, scope, ranked) {
  const sort = sortOf(scope);
  const cols = colsFor(scope);
  const aria = key => (sort.key === key ? ` aria-sort="${sort.dir === 'asc' ? 'ascending' : 'descending'}"` : '');
  const detFirst = i => cols[i].detail && !cols[i - 1].detail;
  const head = `<tr>
      <th class="name" scope="col"${aria('name')}><span class="rk">#</span><button type="button" data-sort="name">Oyuncu</button></th>
      ${cols.map((c, i) => `<th scope="col" class="${c.detail ? 'det' : ''}${detFirst(i) ? ' det-first' : ''}"${aria(c.key)}>
        <button type="button" data-sort="${c.key}">${c.medal ? `<span class="mh" style="--c:${c.medal}">${c.label}</span>` : c.label}</button></th>`).join('')}
    </tr>`;
  const rows = players.map((p, i) => `<tr class="${ranked && i === 0 ? 'lead' : ''}">
      <td class="name"><span class="rk${ranked && i < 3 ? ` r${i + 1}` : ''}">${ranked ? i + 1 : '–'}</span>${esc(p.name)}</td>
      ${cols.map((c, j) => {
        const isZero = c.zero && c.zero(p);
        const cls = [c.detail ? 'det' : '', detFirst(j) ? 'det-first' : '', c.key === sort.key ? 'key' : '', isZero ? 'zero' : '', c.cls ? c.cls(p) : '']
          .filter(Boolean).join(' ');
        return `<td class="${cls}">${isZero ? '–' : c.cell(p)}</td>`;
      }).join('')}
    </tr>`).join('');
  return `<div class="table-wrap"><table class="board${state.detail ? ' show-det' : ''}"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
}

function fileBase(scope) {
  return scope.type === 'ana' ? 'poker-ligi-ana-tablo' : `poker-ligi-${scope.key}`;
}

function renderBoard(scope) {
  const games = S.gamesFor(state.db, scope);
  const board = S.buildBoard(games, scope, nicks());
  const sort = sortOf(scope);
  const isAna = scope.type === 'ana';
  const main = S.sortPlayers(board.main, scope, sort.key, sort.dir);
  const below = S.sortPlayers(board.below, scope, sort.key, sort.dir);
  const eyebrow = isAna ? 'Tüm zamanlar' : scope.current ? 'Güncel lig' : 'Geçmiş lig';
  const title = isAna ? 'Ana Tablo' : scope.label;

  const hero = `<section class="hero">
      <div><p class="eyebrow">${eyebrow}</p><h1>${esc(title)}</h1></div>
      <dl class="kpis">
        <div><dt>Oyun</dt><dd>${board.gameCount}</dd></div>
        <div><dt>Oyuncu</dt><dd>${board.playerCount}</dd></div>
        ${board.last ? `<div><dt>Son oyun</dt><dd class="date">${S.formatDate(board.last.date)}</dd></div>` : ''}
      </dl>
    </section>`;

  if (!board.gameCount) {
    view.innerHTML = `${hero}<div class="empty"><strong>Henüz oyun yok</strong>
      ${isAna ? 'İlk oyun eklendiğinde tablo burada oluşur.' : 'Bu ligin ilk oyunu eklendiğinde tablo burada oluşur.'}
      <br><a href="#yeni">Yeni Veri sekmesine git</a></div>`;
    return;
  }

  const last = `<section class="last"><span class="last-label">Son oyun · ${S.formatDate(board.last.date)}</span>
      <ol>${board.last.players.map((n, i) => `<li><b>${i + 1}</b>${esc(n)}</li>`).join('')}</ol></section>`;

  const sortedNote = sort.key === S.defaultSortKey(scope) && sort.dir === 'desc'
    ? `Sıralama: ${isAna ? 'kazanma oranı' : 'lig puanı'}`
    : `Sıralama: ${SORT_LABEL[sort.key]} · <button type="button" class="link" data-act="reset-sort">varsayılana dön</button>`;

  view.innerHTML = `${hero}${last}${sharePanel(scope)}
    <div class="toolbar">
      <p class="sorted">${sortedNote}</p>
      <button type="button" class="btn small toggle" data-act="detail" aria-expanded="${state.detail}">
        <span class="chev" aria-hidden="true">▸</span>Detaylı istatistikler</button>
    </div>
    ${boardTable(main, scope, true)}
    ${below.length ? `<section class="block"><div class="block-head"><h2>${board.minGames} oyundan az oynayanlar</h2></div>
      <p class="dim" style="margin:0">En az ${board.minGames} oyun oynayınca sıralamaya girerler.</p>
      ${boardTable(below, scope, false)}</section>` : ''}`;

  view.querySelectorAll('[data-sort]').forEach(b => b.addEventListener('click', () => {
    const key = b.dataset.sort;
    const cur = sortOf(scope);
    const dir = cur.key === key ? (cur.dir === 'desc' ? 'asc' : 'desc') : key === 'name' ? 'asc' : 'desc';
    state.sort[scope.id] = { key, dir };
    render();
  }));
  view.querySelector('[data-act="reset-sort"]')?.addEventListener('click', () => { delete state.sort[scope.id]; render(); });
  view.querySelector('[data-act="detail"]').addEventListener('click', () => {
    state.detail = !state.detail;
    lsSet(LS_DETAIL, state.detail ? '1' : '0');
    render();
  });
  bindShare(scope, games);
}

function sharePanel(scope) {
  const b = state.build;
  const has = !!b?.images?.includes(scope.id);
  const pending = !!state.pendingData;
  const ready = has && !pending;
  const src = has ? `out/${scope.id}.png?v=${b.dataSha.slice(0, 10)}` : '';
  let status;
  if (pending && state.pendingStuck) {
    status = `Görsel uzun süredir güncellenmedi. <a href="https://github.com/${REPO}/actions" target="_blank" rel="noopener">GitHub'daki çalışmalara bak</a>.`;
  } else if (pending) {
    status = 'Görsel güncelleniyor, 1–2 dakika içinde hazır olur.';
  } else if (!has) {
    status = 'Bu tablonun görseli henüz yok. Bir sonraki veri girişinde üretilecek.';
  } else {
    status = `Görsel güncel · ${fmtDateTime(b.builtAt)}`;
  }
  const canShare = typeof navigator.canShare === 'function';
  return `<section class="share">
      ${has ? `<a class="thumb" href="${src}" target="_blank" rel="noopener" aria-label="Görseli tam boyut aç"><img src="${src}" alt="${esc(scope.label)} görseli"></a>`
            : `<span class="thumb empty">Görsel yok</span>`}
      <div class="share-body">
        <p class="share-status${pending && !state.pendingStuck ? ' busy' : ''}">${status}</p>
        <div class="share-actions">
          <a class="btn${ready ? ' primary' : ''}" ${ready ? `href="${src}" download="${fileBase(scope)}.png"` : 'aria-disabled="true"'}>Görseli indir</a>
          <button type="button" class="btn" data-act="csv">CSV indir</button>
          ${canShare ? `<button type="button" class="btn" data-act="share">Paylaş</button>` : ''}
        </div>
      </div>
    </section>`;
}

function bindShare(scope, games) {
  const csvName = `${fileBase(scope)}.csv`;
  const csv = () => S.gamesCsv(games, nicks());
  view.querySelector('[data-act="csv"]')?.addEventListener('click', () => download(csvName, csv(), 'text/csv;charset=utf-8'));

  const b = state.build;
  const ready = b?.images?.includes(scope.id) && !state.pendingData;
  const pngKey = ready ? `${scope.id}@${b.dataSha}` : null;
  // Prefetch the image so the share sheet opens straight from the tap (iOS requires that).
  if (pngKey && !state.png[pngKey]) {
    state.png[pngKey] = 'loading';
    fetch(`out/${scope.id}.png?v=${b.dataSha.slice(0, 10)}`)
      .then(r => (r.ok ? r.blob() : Promise.reject()))
      .then(blob => { state.png[pngKey] = new File([blob], `${fileBase(scope)}.png`, { type: 'image/png' }); })
      .catch(() => { delete state.png[pngKey]; });
  }

  view.querySelector('[data-act="share"]')?.addEventListener('click', () => {
    const files = [];
    const png = pngKey && state.png[pngKey];
    if (png instanceof File) files.push(png);
    files.push(new File([csv()], csvName, { type: 'text/csv' }));
    let data = { files, title: `${LEAGUE_NAME} · ${scope.label}` };
    if (!navigator.canShare(data)) data = { files: files.filter(f => f.type === 'image/png') };
    if (!data.files.length || !navigator.canShare(data)) {
      toast(ready ? 'Bu cihaz dosya paylaşmayı desteklemiyor. İndir butonlarını kullan.' : 'Görsel hazır olunca paylaşabilirsin.');
      return;
    }
    navigator.share(data).catch(e => { if (e.name !== 'AbortError') toast('Paylaşılamadı. İndir butonlarını kullan.'); });
  });
}

// ---------- Yeni Veri ----------

function renderYeni() {
  const admin = !!token();
  view.innerHTML = `<section class="page-head">
      <p class="eyebrow">Veri</p><h1>Yeni Veri</h1>
      <p class="lede">Önce oyuncuları ekle, sonra maçın sıralamasını kaydet. Ana Tablo ve ilgili lig hemen güncellenir, görseller 1–2 dakika içinde hazır olur.</p>
    </section>
    ${admin ? '' : tokenHTML()}
    ${playersHTML(admin)}
    ${admin ? entryHTML() : ''}
    ${gamesHTML(admin)}
    ${historyHTML()}
    ${admin ? `<p class="token-line">Yönetici anahtarı bu tarayıcıda kayıtlı. <button type="button" class="link" data-act="forget-token">Anahtarı bu cihazdan kaldır</button></p>` : ''}`;
  if (admin) {
    bindPlayers();
    bindEntry();
    view.querySelector('[data-act="forget-token"]').addEventListener('click', () => {
      lsSet(LS_TOKEN, null);
      toast('Anahtar bu cihazdan kaldırıldı.');
      render();
    });
  } else {
    bindToken();
  }
  bindGames(admin);
}

function tokenHTML() {
  return `<section class="panel">
      <h2>Yönetici anahtarı</h2>
      <p class="dim" style="margin:10px 0 0">Oyuncu ve maç eklemek için bu cihazda bir kez yönetici anahtarını girmen gerekiyor. Anahtar sadece bu tarayıcıda saklanır. Nasıl alınacağı <a href="#yardim">Yardım</a> sekmesinde anlatılıyor.</p>
      <form class="token-form" id="token-form">
        <input type="password" id="t-input" autocomplete="off" spellcheck="false" placeholder="github_pat_…" aria-label="Yönetici anahtarı">
        <button class="btn primary" type="submit" id="t-save">Anahtarı kaydet</button>
      </form>
      <div id="t-msg"></div>
    </section>`;
}

function bindToken() {
  document.getElementById('token-form').addEventListener('submit', async e => {
    e.preventDefault();
    const val = document.getElementById('t-input').value.trim();
    if (!val) return;
    const btn = document.getElementById('t-save');
    btn.disabled = true;
    lsSet(LS_TOKEN, val);
    try {
      await readRemote();
      toast('Anahtar kaydedildi.');
      render();
      syncAdmin();
    } catch (err) {
      lsSet(LS_TOKEN, null);
      document.getElementById('t-msg').innerHTML = `<p class="msg err">${esc(errorText(err))}</p>`;
      btn.disabled = false;
    }
  });
}

// ----- players (roster and nicknames) -----

function rosterSorted() {
  return S.playerList(state.db).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'tr'));
}

// Returns an error message, or null when the name/nick pair can be saved.
function validatePlayer(db, name, nick, selfKey) {
  const roster = S.playerList(db).filter(p => p.key !== selfKey);
  const nameK = S.nameKey(name);
  const nickK = S.nameKey(nick);
  if (!nameK) return 'İsim boş olamaz.';
  if (name.length > 30) return 'İsim en fazla 30 karakter olabilir.';
  if (nick.length > 24) return 'Nick en fazla 24 karakter olabilir.';
  const sameName = roster.find(p => p.key === nameK);
  if (sameName) return `"${sameName.name}" adında bir oyuncu zaten var.`;
  if (nickK) {
    const clash = roster.find(p => S.nameKey(p.nick) === nickK || p.key === nickK);
    if (clash) return `"${nick}" zaten ${clash.name} için kullanılıyor.`;
  }
  return null;
}

function playersHTML(admin) {
  const roster = rosterSorted();
  const msg = state.playerMsg ? `<p class="msg ${state.playerMsg.ok ? 'ok' : 'err'}">${esc(state.playerMsg.text)}</p>` : '';
  const rows = roster.map(p => {
    if (admin && state.playerEdit === p.key) {
      return `<tr class="editing-row">
          <td><input type="text" id="pe-name" value="${esc(p.name)}" maxlength="30" aria-label="İsim"${p.count ? ' disabled title="Oyunu olan oyuncunun ismi değiştirilemez"' : ''}></td>
          <td><input type="text" id="pe-nick" value="${esc(p.nick)}" maxlength="24" placeholder="Nick" aria-label="Nick"></td>
          <td class="num">${p.count}</td>
          <td><span class="acts"><button type="button" class="btn small primary" data-p-save="${esc(p.key)}">Kaydet</button>
            <button type="button" class="btn small" data-p-cancel>Vazgeç</button></span></td>
        </tr>`;
    }
    const acts = admin
      ? `<td><span class="acts"><button type="button" class="btn small" data-p-edit="${esc(p.key)}">Düzenle</button>
          ${p.count === 0 && p.registered ? `<button type="button" class="btn small" data-p-del="${esc(p.key)}">Sil</button>` : ''}</span></td>`
      : '';
    return `<tr><td class="pname">${esc(p.name)}</td><td class="pnick">${p.nick ? esc(p.nick) : '<span class="dim">–</span>'}</td><td class="num">${p.count}</td>${acts}</tr>`;
  }).join('');
  return `<section class="block" id="players">
      <div class="block-head"><h2>Oyuncular</h2><span class="dim">${roster.length} oyuncu</span></div>
      <p class="dim" style="margin:0">Tablolarda ve görsellerde nick görünür, nick boşsa isim görünür. Gerçek adıyla görünmek isteyenin nick kısmı boş kalabilir.</p>
      ${admin ? `<form class="add-row" id="p-add">
          <input type="text" id="p-name" maxlength="30" placeholder="İsim" aria-label="Yeni oyuncunun ismi" autocapitalize="words">
          <input type="text" id="p-nick" maxlength="24" placeholder="Nick (isteğe bağlı)" aria-label="Yeni oyuncunun nicki">
          <button type="submit" class="btn primary" id="p-add-btn"${state.playerBusy ? ' disabled' : ''}>Oyuncu ekle</button>
        </form>` : ''}
      <div id="p-msg">${msg}</div>
      ${roster.length ? `<div class="table-wrap"><table class="players">
          <thead><tr><th>İsim</th><th>Nick</th><th>Oyun</th>${admin ? '<th></th>' : ''}</tr></thead>
          <tbody>${rows}</tbody></table></div>`
        : `<div class="empty" style="margin-top:0">Henüz oyuncu yok.${admin ? ' Yukarıdan ilk oyuncuyu ekle.' : ''}</div>`}
    </section>`;
}

async function playerChange(change, message, success) {
  state.playerBusy = true;
  view.querySelectorAll('#players .btn').forEach(b => { b.disabled = true; });
  try {
    await mutate(change, () => message);
    state.playerMsg = { ok: true, text: success };
    state.playerEdit = null;
  } catch (e) {
    state.playerMsg = { ok: false, text: errorText(e) };
  }
  state.playerBusy = false;
  render();
}

function bindPlayers() {
  document.getElementById('p-add').addEventListener('submit', e => {
    e.preventDefault();
    const name = S.cleanName(document.getElementById('p-name').value);
    const nick = S.cleanName(document.getElementById('p-nick').value);
    const err = validatePlayer(state.db, name, nick, null);
    if (err) {
      document.getElementById('p-msg').innerHTML = `<p class="msg err">${esc(err)}</p>`;
      return;
    }
    playerChange(db => {
      const again = validatePlayer(db, name, nick, null);
      if (again) throw userError(again);
      db.players.push(nick ? { name, nick } : { name });
      db.log.push({ at: new Date().toISOString(), action: 'player-add', after: { name, nick } });
    }, `Oyuncu eklendi: ${name}`, `${name} eklendi.`);
  });

  view.querySelectorAll('[data-p-edit]').forEach(b => b.addEventListener('click', () => {
    state.playerEdit = b.dataset.pEdit;
    state.playerMsg = null;
    render();
    document.getElementById('pe-nick')?.focus();
  }));
  view.querySelector('[data-p-cancel]')?.addEventListener('click', () => { state.playerEdit = null; render(); });

  view.querySelector('[data-p-save]')?.addEventListener('click', e => {
    const key = e.currentTarget.dataset.pSave;
    const current = S.playerList(state.db).find(p => p.key === key);
    if (!current) return;
    const nameEl = document.getElementById('pe-name');
    const name = current.count ? current.name : S.cleanName(nameEl.value);
    const nick = S.cleanName(document.getElementById('pe-nick').value);
    if (name === current.name && nick === current.nick) { state.playerEdit = null; render(); return; }
    const err = validatePlayer(state.db, name, nick, key);
    if (err) {
      document.getElementById('p-msg').innerHTML = `<p class="msg err">${esc(err)}</p>`;
      return;
    }
    playerChange(db => {
      const fresh = S.playerList(db).find(p => p.key === key);
      if (!fresh) throw userError('Oyuncu bulunamadı. Sayfayı yenile.');
      const newName = fresh.count ? fresh.name : name;
      const again = validatePlayer(db, newName, nick, key);
      if (again) throw userError(again);
      let entry = db.players.find(p => S.nameKey(p.name) === key);
      if (!entry) { entry = { name: fresh.name }; db.players.push(entry); }
      entry.name = newName;
      if (nick) entry.nick = nick; else delete entry.nick;
      db.log.push({ at: new Date().toISOString(), action: 'player-edit', before: { name: fresh.name, nick: fresh.nick }, after: { name: newName, nick } });
    }, `Oyuncu düzeltildi: ${current.name}`, `${name} güncellendi.`);
  });

  view.querySelectorAll('[data-p-del]').forEach(b => b.addEventListener('click', () => {
    const key = b.dataset.pDel;
    const p = S.playerList(state.db).find(x => x.key === key);
    if (!p) return;
    playerChange(db => {
      const fresh = S.playerList(db).find(x => x.key === key);
      if (!fresh) throw userError('Oyuncu bulunamadı. Sayfayı yenile.');
      if (fresh.count) throw userError('Oyunu olan oyuncu silinemez.');
      db.players = db.players.filter(x => S.nameKey(x.name) !== key);
      db.log.push({ at: new Date().toISOString(), action: 'player-delete', before: { name: fresh.name, nick: fresh.nick } });
    }, `Oyuncu silindi: ${p.name}`, `${p.name} silindi.`);
  }));
}

// ----- match entry -----

function analyzeGame() {
  const f = state.form;
  const errors = [];
  const warnings = [];
  if (!S.isValidISODate(f.date)) errors.push('Geçerli bir tarih seç.');
  else if (f.date > today) errors.push('Gelecekteki bir tarih seçilemez.');
  if (f.order.length < S.MIN_PLAYERS) errors.push(`En az ${S.MIN_PLAYERS} oyuncu seç.`);
  if (S.isValidISODate(f.date)) {
    const same = (state.db.games || []).filter(g => !g.deleted && g.date === f.date && g.id !== f.editId);
    if (same.length) warnings.push(`Bu tarihte zaten ${same.map(g => `#${g.id}`).join(', ')} numaralı oyun var. İkinci bir oyunsa sorun yok.`);
  }
  if (f.editId) {
    const g = state.db.games.find(x => x.id === f.editId);
    if (g && g.date === f.date && g.players.join('\n') === f.order.join('\n')) errors.push('Henüz bir değişiklik yapmadın.');
  }
  return { errors, warnings };
}

function entryHTML() {
  const f = state.form;
  const msg = f.msg ? `<p class="msg ${f.msg.ok ? 'ok' : 'err'}">${f.msg.html}</p>` : '';
  return `<section class="block" id="entry">
      <div class="block-head"><h2>${f.editId ? `Oyun #${f.editId} düzenleniyor` : 'Maç kaydet'}</h2>
        ${f.editId ? '<button type="button" class="btn small" data-act="cancel-edit">Düzenlemeden çık</button>' : ''}</div>
      <div class="panel">
        <div class="entry-grid">
          <div>
            <div class="field">
              <label for="f-date">Tarih</label>
              <input type="date" id="f-date" value="${esc(f.date)}" max="${today}">
            </div>
            <div class="field">
              <span class="label">Oyuncular <span class="hint">· bitiş sırasına göre dokun: önce 1., sonra 2. …</span></span>
              <div class="chips" id="f-chips"></div>
            </div>
          </div>
          <div>
            <span class="label">Sıralama</span>
            <ol class="ranking" id="f-rank"></ol>
            <ul class="issues" id="f-issues"></ul>
            <div class="save-row">
              <button type="button" class="btn primary" id="f-save">${f.editId ? 'Değişikliği kaydet' : 'Oyunu kaydet'}</button>
              <button type="button" class="btn" data-act="clear-order">Sıralamayı temizle</button>
            </div>
            <div id="f-msg">${msg}</div>
          </div>
        </div>
      </div>
    </section>`;
}

function bindEntry() {
  const f = state.form;
  const dateEl = document.getElementById('f-date');
  dateEl.addEventListener('input', () => { f.date = dateEl.value; f.msg = null; updateEntry(); });
  document.getElementById('f-save').addEventListener('click', saveGame);
  view.querySelector('[data-act="clear-order"]').addEventListener('click', () => { f.order = []; f.msg = null; updateEntry(); });
  view.querySelector('[data-act="cancel-edit"]')?.addEventListener('click', () => { state.form = blankForm(); render(); });
  updateEntry();
}

function updateEntry() {
  const f = state.form;
  const nk = nicks();
  const roster = rosterSorted();
  const used = new Set(f.order.map(S.nameKey));
  const label = name => {
    const nick = nk[S.nameKey(name)];
    return nick ? `${esc(nick)} <small>${esc(name)}</small>` : esc(name);
  };

  const chipsEl = document.getElementById('f-chips');
  chipsEl.innerHTML = roster.length
    ? roster.map(p => `<button type="button" class="chip" data-add="${esc(p.name)}"${used.has(p.key) ? ' disabled' : ''}>${label(p.name)}</button>`).join('')
    : '<span class="hint">Önce yukarıdaki Oyuncular bölümünden oyuncu ekle.</span>';
  chipsEl.querySelectorAll('[data-add]').forEach(c => c.addEventListener('click', () => {
    f.order.push(c.dataset.add);
    f.msg = null;
    updateEntry();
  }));

  const n = f.order.length;
  const rankEl = document.getElementById('f-rank');
  rankEl.innerHTML = n
    ? f.order.map((name, i) => `<li>
        <span class="pl">${i + 1}</span>
        <span class="nm">${label(name)}</span>
        <span class="pt">${S.pointsFor(i + 1, n)}<small>puan</small></span>
        <span class="mv">
          <button type="button" class="icon" data-up="${i}" aria-label="${esc(name)} yukarı"${i === 0 ? ' disabled' : ''}>↑</button>
          <button type="button" class="icon" data-down="${i}" aria-label="${esc(name)} aşağı"${i === n - 1 ? ' disabled' : ''}>↓</button>
          <button type="button" class="icon" data-rm="${i}" aria-label="${esc(name)} çıkar">✕</button>
        </span></li>`).join('')
    : '<li class="placeholder">Oyunculara dokundukça sıralama burada puanlarıyla oluşur.</li>';
  const move = (i, j) => { [f.order[i], f.order[j]] = [f.order[j], f.order[i]]; f.msg = null; updateEntry(); };
  rankEl.querySelectorAll('[data-up]').forEach(b => b.addEventListener('click', () => move(+b.dataset.up, +b.dataset.up - 1)));
  rankEl.querySelectorAll('[data-down]').forEach(b => b.addEventListener('click', () => move(+b.dataset.down, +b.dataset.down + 1)));
  rankEl.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => { f.order.splice(+b.dataset.rm, 1); f.msg = null; updateEntry(); }));

  const a = analyzeGame();
  const shown = a.errors.filter(e => n > 0 || !e.startsWith('En az'));
  document.getElementById('f-issues').innerHTML =
    shown.map(e => `<li class="err">${esc(e)}</li>`).join('') + a.warnings.map(w => `<li class="warn">${esc(w)}</li>`).join('');
  document.getElementById('f-save').disabled = f.busy || a.errors.length > 0;
}

async function saveGame() {
  const f = state.form;
  if (analyzeGame().errors.length || f.busy) return;
  const players = f.order.slice();
  const date = f.date;
  const editId = f.editId;
  f.busy = true;
  const btn = document.getElementById('f-save');
  btn.disabled = true;
  btn.textContent = 'Kaydediliyor…';
  try {
    const info = await mutate(db => {
      const roster = new Set(S.playerList(db).map(p => p.key));
      const missing = players.filter(n => !roster.has(S.nameKey(n)));
      if (missing.length) throw userError(`Oyuncu listesinde yok: ${missing.join(', ')}. Sayfayı yenile.`);
      const at = new Date().toISOString();
      if (editId) {
        const g = db.games.find(x => x.id === editId);
        if (!g) throw userError(`Oyun #${editId} bulunamadı. Sayfayı yenile.`);
        const before = { date: g.date, players: g.players };
        g.date = date;
        g.players = players;
        db.log.push({ at, action: 'edit', id: editId, before, after: { date, players } });
        return { text: `Oyun #${editId} düzeltildi` };
      }
      const id = db.games.reduce((m, g) => Math.max(m, g.id), 0) + 1;
      db.games.push({ id, date, players });
      db.log.push({ at, action: 'add', id, after: { date, players } });
      return { text: `Oyun #${id} eklendi` };
    }, info => `${info.text} (${S.formatDate(date)})`);
    const key = S.ligKey(date);
    state.form = blankForm();
    state.form.msg = { ok: true, html: `${info.text}. Tablolar güncellendi, görseller 1–2 dakika içinde hazır olur. <a href="#lig-${key}">${esc(S.ligLabel(key))}</a> · <a href="#ana">Ana Tablo</a>` };
  } catch (e) {
    f.busy = false;
    f.msg = { ok: false, html: esc(errorText(e)) };
  }
  render();
  document.getElementById('entry')?.scrollIntoView({ block: 'start' });
}

// ---------- games list and history ----------

function gamesHTML(admin) {
  const nk = nicks();
  const all = (state.db.games || [])
    .filter(g => state.showDeleted || !g.deleted)
    .slice()
    .sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : b.id - a.id));
  const games = state.gamesAll ? all : all.slice(0, GAMES_PREVIEW);
  const deletedCount = (state.db.games || []).filter(g => g.deleted).length;
  const rows = games.map(g => {
    let acts = '';
    if (admin) {
      if (state.confirmDelete === g.id) {
        acts = `<span class="confirm">Silinsin mi? <button type="button" class="btn small danger" data-del-yes="${g.id}">Evet, sil</button>
          <button type="button" class="btn small" data-del-no>Vazgeç</button></span>`;
      } else if (g.deleted) {
        acts = `<span class="acts"><button type="button" class="btn small" data-restore="${g.id}">Geri al</button></span>`;
      } else {
        acts = `<span class="acts"><button type="button" class="btn small" data-edit="${g.id}">Düzelt</button>
          <button type="button" class="btn small" data-del="${g.id}">Sil</button></span>`;
      }
    }
    return `<tr class="${g.deleted ? 'deleted' : ''}">
        <td class="num">${g.id}</td>
        <td>${S.formatDate(g.date)}</td>
        <td>${esc(S.ligKey(g.date).replace('-', '–'))}</td>
        <td>${g.players.length}</td>
        <td class="order">${orderText(g.players.map(n => S.displayName(n, nk)))}${g.deleted ? ' <span class="tag dup">silindi</span>' : ''}</td>
        ${admin ? `<td>${acts}</td>` : ''}
      </tr>`;
  }).join('');
  return `<section class="block" id="games">
      <div class="block-head">
        <h2>Tüm oyunlar</h2>
        <div class="share-actions">
          ${deletedCount ? `<label class="check"><input type="checkbox" id="g-deleted"${state.showDeleted ? ' checked' : ''}> Silinenleri göster (${deletedCount})</label>` : ''}
          <button type="button" class="btn small" data-act="csv-all"${all.length ? '' : ' disabled'}>CSV indir</button>
        </div>
      </div>
      ${all.length ? `<div class="table-wrap"><table class="games">
        <thead><tr><th>#</th><th>Tarih</th><th>Lig</th><th>Kişi</th><th style="text-align:left">Sıralama</th>${admin ? '<th></th>' : ''}</tr></thead>
        <tbody>${rows}</tbody></table></div>`
        : '<div class="empty" style="margin-top:0">Henüz oyun girilmedi.</div>'}
      ${all.length > games.length ? `<div><button type="button" class="btn small" data-act="games-all">Tümünü göster (${all.length})</button></div>` : ''}
    </section>`;
}

const ACT = {
  add: ['add', 'Eklendi'], edit: ['edit', 'Düzeltildi'], delete: ['delete', 'Silindi'], restore: ['restore', 'Geri alındı'],
  'player-add': ['add', 'Oyuncu eklendi'], 'player-edit': ['edit', 'Oyuncu düzeltildi'], 'player-delete': ['delete', 'Oyuncu silindi'],
};

function personText(p) {
  return p ? `${esc(p.name)}${p.nick ? ` · nick: ${esc(p.nick)}` : ''}` : '';
}

function historyHTML() {
  const log = (state.db.log || []).slice().reverse();
  const list = state.historyAll ? log : log.slice(0, HISTORY_PREVIEW);
  const items = list.map(l => {
    const [cls, label] = ACT[l.action] || ['edit', l.action];
    let what;
    let detail;
    if (l.action.startsWith('player-')) {
      what = esc((l.after || l.before).name);
      detail = l.action === 'player-edit'
        ? `<s>${personText(l.before)}</s> → ${personText(l.after)}`
        : personText(l.after || l.before);
    } else {
      what = `Oyun #${l.id}`;
      const snap = l.after || l.before;
      detail = snap ? `${S.formatDate(snap.date)} · ${orderText(snap.players)}` : '';
      if (l.action === 'edit' && l.before) {
        const b = l.before;
        detail = `<s>${S.formatDate(b.date)} · ${b.players.map((n, i) => `${i + 1}. ${esc(n)}`).join(' ')}</s><br>${S.formatDate(l.after.date)} · ${orderText(l.after.players)}`;
      }
    }
    return `<li><time datetime="${esc(l.at)}">${fmtDateTime(l.at)}</time>
        <span class="what"><span class="act ${cls}">${label}</span>${what}</span>
        <span class="detail">${detail}</span></li>`;
  }).join('');
  return `<section class="block" id="history">
      <div class="block-head"><h2>Değişiklik geçmişi</h2></div>
      <p class="dim" style="margin:0">Her ekleme, düzeltme ve silme kalıcı olarak kaydedilir. Bağımsız kanıt için
        <a href="https://github.com/${REPO}/commits/main/${DATA_PATH}" target="_blank" rel="noopener">GitHub'daki kayıtlara</a> bakılabilir.</p>
      ${log.length ? `<ol class="history">${items}</ol>` : '<div class="empty" style="margin-top:0">Henüz değişiklik yok.</div>'}
      ${log.length > list.length ? `<div><button type="button" class="btn small" data-act="history-all">Tümünü göster (${log.length})</button></div>` : ''}
    </section>`;
}

function bindGames(admin) {
  view.querySelector('#g-deleted')?.addEventListener('change', e => { state.showDeleted = e.target.checked; render(); });
  view.querySelector('[data-act="csv-all"]')?.addEventListener('click', () =>
    download('poker-ligi-tum-oyunlar.csv', S.gamesCsv(S.activeGames(state.db), nicks()), 'text/csv;charset=utf-8'));
  view.querySelector('[data-act="games-all"]')?.addEventListener('click', () => { state.gamesAll = true; render(); });
  view.querySelector('[data-act="history-all"]')?.addEventListener('click', () => { state.historyAll = true; render(); });
  if (!admin) return;

  view.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
    const g = state.db.games.find(x => x.id === Number(b.dataset.edit));
    state.form = { ...blankForm(), editId: g.id, date: g.date, order: g.players.slice() };
    render();
    document.getElementById('entry').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  view.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => { state.confirmDelete = Number(b.dataset.del); render(); }));
  view.querySelector('[data-del-no]')?.addEventListener('click', () => { state.confirmDelete = null; render(); });
  view.querySelector('[data-del-yes]')?.addEventListener('click', e => setDeleted(Number(e.currentTarget.dataset.delYes), true));
  view.querySelectorAll('[data-restore]').forEach(b => b.addEventListener('click', () => setDeleted(Number(b.dataset.restore), false)));
}

async function setDeleted(id, deleted) {
  view.querySelectorAll('.games .btn').forEach(b => { b.disabled = true; });
  try {
    await mutate(db => {
      const g = db.games.find(x => x.id === id);
      if (!g) throw userError(`Oyun #${id} bulunamadı. Sayfayı yenile.`);
      const snap = { date: g.date, players: g.players };
      if (deleted) {
        g.deleted = true;
        db.log.push({ at: new Date().toISOString(), action: 'delete', id, before: snap });
      } else {
        delete g.deleted;
        db.log.push({ at: new Date().toISOString(), action: 'restore', id, after: snap });
      }
      return { text: deleted ? `Oyun #${id} silindi` : `Oyun #${id} geri alındı` };
    }, info => info.text);
    toast(deleted ? `Oyun #${id} silindi. "Silinenleri göster" ile geri alabilirsin.` : `Oyun #${id} geri alındı.`);
  } catch (e) {
    toast(errorText(e));
  }
  state.confirmDelete = null;
  if (state.form.editId === id) state.form = blankForm();
  render();
}

// ---------- Yardım ----------

function renderYardim() {
  view.innerHTML = `<div class="help">
    <section class="page-head"><p class="eyebrow">Nasıl çalışır</p><h1>Yardım</h1>
      <p class="lede">Bu sayfadaki her şey girilen oyun sonuçlarından otomatik hesaplanır. Yapılması gereken tek şey her oyundan sonra sıralamayı kaydetmek.</p></section>

    <section><h2>Sekmeler</h2>
      <dl class="defs">
        <dt>Ana Tablo</dt><dd>Bütün zamanların tablosu. Hiç sıfırlanmaz, açılışta kazanma oranına göre sıralıdır.</dd>
        <dt>Ligler</dt><dd>Her lig 1 Ekim'de başlar, 30 Eylül'de biter. Yeni lig kendiliğinden açılır, geçmiş ligler menüde kalır. Açılışta lig puanına göre sıralıdır.</dd>
        <dt>Yeni Veri</dt><dd>Oyuncular ve nickleri, maç kaydı, bütün oyunların listesi, CSV ve değişiklik geçmişi.</dd>
      </dl></section>

    <section><h2>Lig puanı</h2>
      <ul class="pts"><li><b>5</b>1.</li><li><b>4</b>2.</li><li><b>3</b>3.</li><li><b>1</b>diğerleri</li><li><b>0</b>sonuncu</li></ul>
      <p>Puanlar ligin bütün oyunlarında toplanır. Az kişili bir oyunda 3. aynı zamanda sonuncuysa 3 puan alır. Puan eşitse önce 1.lik, sonra 2.lik, sonra 3.lük sayısı fazla olan öne geçer.</p></section>

    <section><h2>Sütunlar</h2>
      <dl class="defs">
        <dt>Oyun</dt><dd>Oynadığı oyun sayısı.</dd>
        <dt>1. · 2. · 3.</dt><dd>Birincilik, ikincilik ve üçüncülük sayısı.</dd>
        <dt>Kazanma %</dt><dd>Birincilik ÷ oyun.</dd>
        <dt>Podyum %</dt><dd>İlk üçe girme ÷ oyun.</dd>
        <dt>Lig puanı</dt><dd>Yukarıdaki puanların toplamı.</dd>
        <dt>Şans farkı</dt><dd>Gerçek galibiyet ile beklenen galibiyet arasındaki fark. 6 kişilik masada herkesin kazanma şansı 1/6'dır; bu şanslar toplanır ve gerçek galibiyetten çıkarılır. Artı değer beklenenden fazla kazandığını gösterir.</dd>
        <dt>Form</dt><dd>Son 5 oyundaki sıraları, en yenisi solda. Bu sütuna göre sıralayınca son 5 oyunun puan toplamı esas alınır.</dd>
        <dt>Rating</dt><dd>Rakiplerin gücünü de hesaba katan beceri puanı (OpenSkill). Herkes 1000 civarından başlar; güçlü bir masada iyi bitirmek daha çok puan getirir. Az oyun oynayanın puanı temkinli tutulur.</dd>
      </dl>
      <p>Her sütun başlığına dokununca tablo o sütuna göre sıralanır, ikinci dokunuş sırayı ters çevirir. Şans farkı, Form ve Rating "Detaylı istatistikler" düğmesiyle açılıp kapanır.</p></section>

    <section><h2>Sıralamaya girme</h2>
      <p>Sıralamaya girmek için o tablodaki toplam oyunların en az <strong>%${S.MIN_SHARE}'unu</strong> oynamış olmak gerekir (yukarı yuvarlanır). Örneğin 10 oyunluk tabloda 3, 20 oyunlukta 6 oyun. Eşik her tablo için ayrı hesaplanır ve oyun sayısı arttıkça yükselir. Daha az oynayanlar tablonun altında ayrı listelenir. Bu, bir kez gelip kazanan birinin en üste çıkmasını önler.</p>
      <p>Lig başında henüz <strong>${S.MIN_QUALIFIED} kişi</strong> eşiğe ulaşmamışsa herkes aynı tabloda sıralanır; eşik o kişi sayısına ulaşılınca kendiliğinden devreye girer.</p></section>

    <section><h2>Oyuncular ve nickler</h2>
      <p>Yeni biri geldiğinde önce <strong>Yeni Veri → Oyuncular</strong> bölümünden ismini ekle. Nick isteğe bağlı; tablolarda ve görsellerde nick görünür, nick boşsa isim görünür. Nick istediğin zaman <strong>Düzenle</strong> ile değiştirilebilir; geçmiş oyunlar etkilenmez. Hiç oyunu olmayan oyuncu silinebilir.</p></section>

    <section><h2>Maç kaydetme ve düzeltme</h2>
      <ol>
        <li><strong>Yeni Veri → Maç kaydet</strong> bölümünde tarihi seç.</li>
        <li>Oyunculara bitiş sırasına göre dokun: önce 1., sonra 2. olan… Sıralama sağda puanlarıyla oluşur; ↑ ↓ ile yer değiştirebilir, ✕ ile çıkarabilirsin.</li>
        <li><strong>Oyunu kaydet</strong>. Tablolar hemen, görseller 1–2 dakika içinde güncellenir.</li>
      </ol>
      <p>Yanlış girilen oyunu <strong>Tüm oyunlar</strong> listesinde <strong>Düzelt</strong> ile değiştirebilir, <strong>Sil</strong> ile kaldırabilirsin. Silinen oyun kaybolmaz, "Silinenleri göster" ile görünür ve <strong>Geri al</strong> ile geri gelir. Geçmiş tarihli oyunlar da girilebilir; doğru lige ve sıraya kendiliğinden yerleşir.</p></section>

    <section><h2>Görsel ve paylaşım</h2>
      <p>Ana Tablo ve her lig için paylaşmaya hazır bir görsel üretilir. Tablonun üstündeki <strong>Görseli indir</strong> ve <strong>CSV indir</strong> düğmeleri dosyaları indirir. Telefonda <strong>Paylaş</strong> düğmesi görseli ve CSV'yi birlikte WhatsApp'a gönderebilir.</p></section>

    <section><h2>Yönetici anahtarı</h2>
      <p>Veri eklemek için her cihazda bir kez anahtar girmek gerekir. Anahtar sadece o tarayıcıda saklanır, kimseyle paylaşma. Oluşturmak için:</p>
      <ol>
        <li><strong>72-o</strong> hesabıyla GitHub'a gir ve <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">yeni anahtar sayfasını</a> aç.</li>
        <li><strong>Token name</strong>: <code>Poker Ligi</code>. <strong>Expiration</strong>: en uzun süreyi seç.</li>
        <li><strong>Repository access</strong>: <code>Only select repositories</code> → <code>72-o/72-o.github.io</code>.</li>
        <li><strong>Permissions</strong> → <strong>Contents</strong>: <code>Read and write</code>.</li>
        <li><strong>Generate token</strong> de, çıkan <code>github_pat_…</code> anahtarını kopyala ve Yeni Veri sekmesindeki kutuya yapıştır.</li>
      </ol>
      <p>Anahtarın süresi dolunca kayıt sırasında uyarı çıkar; aynı adımlarla yenisini oluşturman yeterli.</p></section>
  </div>`;
}

// ---------- boot ----------

async function boot() {
  render();
  try {
    const [db, build] = await Promise.all([
      getJSON(`${DATA_PATH}?t=${Date.now()}`),
      getJSON(`build.json?t=${Date.now()}`).catch(() => null),
    ]);
    state.db = { ...emptyDb(), ...db };
    state.build = build;
  } catch (e) {
    state.loadError = e;
  }
  state.loaded = true;
  render();
  syncAdmin();
}

boot();
