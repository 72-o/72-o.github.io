// Builds the share image markup for one board. Used by card.html (screenshotted by the build).
import { MIN_GAMES, formatDate, fmtPct } from './stats.js';

export const LEAGUE_NAME = 'Poker Ligi';
export const SITE_URL = '72-o.github.io';

const MEDALS = ['var(--gold)', 'var(--silver)', 'var(--bronze)'];

export function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function cardHTML(board) {
  const isAna = board.scope.type === 'ana';
  const eyebrow = isAna ? 'Ana Tablo · Tüm zamanlar' : board.scope.label;
  const titleLines = LEAGUE_NAME.split(' ').map(esc).join('<br>');
  const head = `<header class="c-head">
      <div><div class="c-eyebrow">${esc(eyebrow)}</div><div class="c-title">${titleLines}</div></div>
      <div class="c-count"><b>${board.gameCount}</b><span>oyun${board.last ? ` · son oyun ${formatDate(board.last.date)}` : ''}</span></div>
    </header>`;

  if (!board.gameCount) {
    return `${head}<div class="c-empty">Henüz oyun yok</div>${foot(isAna)}`;
  }

  const last = board.last.players.map((n, i) => `<li><b>${i + 1}</b>${esc(n)}</li>`).join('');
  const th = `<div class="c-th">
      <span></span><span>Oyuncu</span><span class="c-g">Oyun</span>
      ${[1, 2, 3].map(i => `<span class="c-m"><span class="mh" style="--c:${MEDALS[i - 1]}">${i}.</span></span>`).join('')}
      <span class="c-s">${isAna ? 'Kazanma' : 'Puan'}</span>
    </div>`;
  const rows = board.main.map((p, i) => `<div class="c-row${i === 0 ? ' lead' : ''}">
      <span class="c-rank${i < 3 ? ' top' : ''}" style="--c:${MEDALS[i] || 'inherit'}">${i + 1}</span>
      <span class="c-name">${esc(p.name)}</span>
      <span class="c-g">${p.games}</span>
      ${[p.p1, p.p2, p.p3].map(x => `<span class="c-m${x ? '' : ' zero'}">${x || '–'}</span>`).join('')}
      <span class="c-s">${isAna ? fmtPct(p.winPct) : p.points}</span>
    </div>`).join('');

  let note = '';
  if (board.below.length) {
    const list = board.below.map(p => `<span><b>${esc(p.name)}</b> ${p.games} oyun</span>`).join(' · ');
    note = `<div class="c-note">Sıralamaya girmek için en az ${MIN_GAMES} oyun: ${list}</div>`;
  }

  return `${head}
    <section class="c-last"><span class="c-last-label">Son oyun</span><ol class="c-last-list">${last}</ol></section>
    <div class="c-table">${th}<div class="c-rows">${rows}</div></div>
    ${note}
    ${foot(isAna)}`;
}

function foot(isAna) {
  const rule = isAna
    ? `Sıralama: kazanma oranı · en az ${MIN_GAMES} oyun`
    : 'Puan: 1. = 5 · 2. = 4 · 3. = 3 · diğer = 1 · son = 0';
  return `<footer class="c-foot"><span><b>${SITE_URL}</b></span><span>${rule}</span></footer>`;
}

// Fit the rows into the space left by the header, strip and footer.
export function layoutCard(el) {
  const rows = el.querySelector('.c-rows');
  if (!rows) return;
  const n = rows.children.length || 1;
  const rh = Math.max(28, Math.min(78, Math.floor(rows.clientHeight / n)));
  el.style.setProperty('--rh', `${rh}px`);
}
