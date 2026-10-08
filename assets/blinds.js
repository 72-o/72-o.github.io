// Blind structure calculator. Pure functions only, so the math can be checked in Node.
//
// The idea (Harrington's M): what matters is how many big blinds everyone holds.
//   start BB  = S / d                (d = starting depth in BB)
//   end BB    = N·S / 20             (two players left would hold ~10 BB each: all-in or fold)
//   levels L  = ln(N·d/20) / ln r    (S cancels out: only N, d and r decide the length)
//   level min = target duration / L
// Blinds grow by multiplying, never by adding, and land on "round" values the chips can pay.

// Each speed is a ladder of round numbers per decade. Normal has a second ladder with the same
// rhythm shifted (25/50, 50/100, 75/150 … 250/500, 375/750), used when it fits the stack better.
export const SPEEDS = {
  yavas:  { label: 'Yavaş',  ladders: [[1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8]] },          // ~×1,26 per level
  normal: { label: 'Normal', ladders: [[1, 1.5, 2, 3, 4, 6, 8], [1, 1.5, 2, 3, 4, 5, 7.5]] }, // ×1,5 and ×4/3 in turn, ~×1,39
  hizli:  { label: 'Hızlı',  ladders: [[1, 1.5, 2.5, 4, 6]] },                         // ~×1,58
};
export const DEPTHS = [50, 75, 100];
export const END_DIVISOR = 20;   // the game should be decided once BB ≈ total chips / 20
export const HANDS_PER_HOUR = 25; // self-dealt home game, roughly 20–30
export const SPARE_LEVELS = 3;

export function speedRatio(speed) {
  return 10 ** (1 / SPEEDS[speed].ladders[0].length);
}

// Every round big blind whose small blind (BB/2) is a whole number of the smallest chip.
export function ladder(mantissas, unit) {
  const out = [];
  for (let exp = 0; exp <= 9; exp++) {
    for (const m of mantissas) {
      const exact = m * 10 ** exp;
      const bb = Math.round(exact);
      if (Math.abs(bb - exact) > 1e-9) continue;
      if (bb % (2 * unit) === 0) out.push(bb);
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

function nearestIndex(values, target, from = 0) {
  let best = from;
  for (let i = from; i < values.length; i++) {
    if (Math.abs(Math.log(values[i] / target)) < Math.abs(Math.log(values[best] / target))) best = i;
  }
  return best;
}

// input: { players, stack, unit, hours, depth, speed }
export function blindPlan(input) {
  const { players: n, stack: s, unit, hours, depth, speed } = input;
  const errors = [];
  if (!(n >= 2 && n <= 30 && Number.isInteger(n))) errors.push('Oyuncu sayısı 2 ile 30 arasında olmalı.');
  if (!(unit >= 1 && Number.isInteger(unit))) errors.push('En küçük çip 1 veya daha büyük bir tam sayı olmalı.');
  if (!(s > 0 && Number.isInteger(s))) errors.push('Başlangıç stack\'i pozitif bir tam sayı olmalı.');
  else if (unit >= 1 && s % unit !== 0) errors.push(`Başlangıç stack'i en küçük çipin (${unit}) katı olmalı.`);
  if (!(hours > 0)) errors.push('Hedef süreyi seç.');
  if (errors.length) return { errors };

  // Use whichever ladder starts closest to the wanted depth.
  const wanted = s / depth;
  const options = SPEEDS[speed].ladders.map(mantissas => {
    const values = ladder(mantissas, unit);
    const idx = nearestIndex(values, wanted);
    return { values, idx, miss: Math.abs(Math.log(values[idx] / wanted)) };
  });
  const { values, idx: startIdx } = options.reduce((a, b) => (b.miss < a.miss - 1e-9 ? b : a));
  const total = n * s;
  const endBB = total / END_DIVISOR;
  const endIdx = Math.max(startIdx + 1, nearestIndex(values, endBB, startIdx));
  if (endIdx >= values.length - SPARE_LEVELS) return { errors: ['Bu değerlerle mantıklı bir yapı çıkmıyor. Sayıları kontrol et.'] };

  const steps = endIdx - startIdx;
  const minutes = Math.max(1, Math.round((hours * 60) / steps));
  const levels = values.slice(startIdx, endIdx + SPARE_LEVELS + 1).map((bb, i, arr) => ({
    no: i + 1,
    at: i * minutes,
    sb: bb / 2,
    bb,
    rise: i ? bb / arr[i - 1] - 1 : null,
    depth: s / bb,
    kind: i < steps ? 'play' : i === steps ? 'target' : 'spare',
  }));

  const warnings = [];
  const startBB = values[startIdx];
  const realDepth = s / startBB;
  if (realDepth < depth * 0.75 || realDepth > depth * 1.34) {
    warnings.push(`Çiplere uyan en yakın başlangıç ${fmt(startBB / 2)}/${fmt(startBB)}, bu da ${Math.round(realDepth)} BB ediyor (hedef ${depth} BB). Stack'i ya da en küçük çipi değiştirmeyi düşün.`);
  }
  const handsPerLevel = (minutes * HANDS_PER_HOUR) / 60;
  if (handsPerLevel < n * 0.75) {
    warnings.push(`Seviye başına yaklaşık ${Math.round(handsPerLevel)} el oynanır; masada herkes bir kez bile büyük blind ödemeden blind artar. Süreyi uzatmayı, daha sığ başlamayı ya da daha hızlı artışı dene.`);
  }

  return {
    errors: [],
    warnings,
    total,
    startBB,
    endBB,
    realDepth,
    steps,
    minutes,
    ratio: speedRatio(speed),
    handsPerLevel,
    levels,
  };
}

export function fmt(x) {
  return Math.round(x).toLocaleString('tr-TR');
}

// "21:16" from a start time, or elapsed "1:04" when no start time is given.
export function clock(start, minutes) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(start || '');
  const p = v => String(v).padStart(2, '0');
  if (!m) return `${Math.floor(minutes / 60)}:${p(minutes % 60)}`;
  const t = (Number(m[1]) * 60 + Number(m[2]) + minutes) % (24 * 60);
  return `${p(Math.floor(t / 60))}:${p(t % 60)}`;
}
