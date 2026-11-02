/* ranges.js — weighted hand ranges.
 * A Range is a map from combo key ("AKs", "77", "QJo") to weight 0..1.
 * Ranges START from an archetype prior and NARROW after every observed action.
 * This is what both the opponent AI (for its own decisions) and the coach
 * (for EV estimates) use — replacing the broken "any two cards" assumption.
 */
(function (PT) {
  const RANKS = 'AKQJT98765432';

  // All 169 canonical hold'em combos with a rough strength percentile.
  function canonicalCombos() {
    const combos = [];
    for (let i = 0; i < 13; i++) {
      for (let j = 0; j < 13; j++) {
        if (i === j) combos.push({ key: RANKS[i] + RANKS[j], type: 'pair', hi: 14 - i, lo: 14 - j });
        else if (i < j) combos.push({ key: RANKS[i] + RANKS[j] + 's', type: 'suited', hi: 14 - i, lo: 14 - j });
        else combos.push({ key: RANKS[j] + RANKS[i] + 'o', type: 'offsuit', hi: 14 - j, lo: 14 - i });
      }
    }
    return combos;
  }

  // Chen-formula-ish score 0..~20 used only for ordering combos into percentiles.
  function comboScore(c) {
    const hi = c.hi, lo = c.lo;
    let score = hi >= 14 ? 10 : hi >= 13 ? 8 : hi >= 12 ? 7 : hi >= 11 ? 6 : hi / 2;
    if (c.type === 'pair') score = Math.max(7, hi);
    if (c.type === 'suited') score += 2;
    const gap = hi - lo - 1;
    if (c.type !== 'pair') {
      if (gap === 0) score += 1;
      else if (gap === 1) score -= 1;
      else if (gap === 2) score -= 2;
      else if (gap >= 4) score -= 5;
      else score -= 4;
      if (gap < 3 && hi < 13) score += 1;
    }
    return Math.max(0, score);
  }

  const ALL = canonicalCombos().map(c => ({ ...c, score: comboScore(c) }))
    .sort((a, b) => b.score - a.score);

  const nCombos = key => key.length === 2 ? 6 : key[2] === 's' ? 4 : 12;

  // Combo-weighted preflop percentile: 0 = best hand, 1 = worst.
  const PREFLOP_PCTL = (() => {
    const map = {};
    let cum = 0;
    for (const c of ALL) { const n = nCombos(c.key); map[c.key] = (cum + n / 2) / 1326; cum += n; }
    return map;
  })();

  const inTop = (pctl, pct) => pctl < pct ? 1 : pctl < pct + 0.05 ? 0.5 : 0;

  function openingRange(pct) {
    const r = {};
    for (const c of ALL) r[c.key] = inTop(PREFLOP_PCTL[c.key], pct);
    return r;
  }

  function fullRange() {
    const r = {};
    for (const c of ALL) r[c.key] = 1;
    return r;
  }

  function positionClass(view, id) {
    if (id === view.sbSeat || id === view.bbSeat) return 'blinds';
    const n = view.players.length;
    const off = (id - view.button + n) % n;
    if (n <= 4 || off === 0 || off === n - 1) return 'late';
    return 'early';
  }

  // A style's preflop strategy for a position class. Bots play it and the coach reads opponents with it.
  function preflopPlan(prof, position) {
    const p = prof.pre;
    const open = p.open[position === 'early' ? 0 : position === 'late' ? 1 : 2];
    return {
      open, enter: Math.min(0.85, open + p.limp),
      threeBet: p.threeBet, fourBet: p.threeBet * 0.35,
      flat: Math.min(0.6, p.flat * (position === 'blinds' ? 2 : 1)), call3: p.call3
    };
  }

  function openPct(prof, position) {
    return preflopPlan(prof, position).open;
  }

  // Postflop hand-class of a 2-card combo on a board, for range updates.
  // Returns {made: 0..8 strength tier, draw: 0..1}
  const COMBO_CACHE = {};
  function concreteCombos(key) {
    if (COMBO_CACHE[key]) return COMBO_CACHE[key];
    const mk = (rank, suit) => ({ rank, suit, ri: PT.RANKS.indexOf(rank), si: PT.SUITS.indexOf(suit), id: rank + suit });
    const S = PT.SUITS, out = [];
    if (key.length === 2) {
      for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) out.push([mk(key[0], S[i]), mk(key[1], S[j])]);
    } else if (key[2] === 's') {
      for (const s of S) out.push([mk(key[0], s), mk(key[1], s)]);
    } else {
      for (const s1 of S) for (const s2 of S) if (s1 !== s2) out.push([mk(key[0], s1), mk(key[1], s2)]);
    }
    return (COMBO_CACHE[key] = out);
  }

  function pickIndex(cum, r) {
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < r) lo = mid + 1; else hi = mid; }
    return lo;
  }

  // made = share of all possible holdings (given the board) this combo beats right now.
  const PCT_CACHE = {};
  function boardPercentiles(board) {
    const bk = board.map(c => c.id).join('');
    if (PCT_CACHE[bk]) return PCT_CACHE[bk];
    if (Object.keys(PCT_CACHE).length > 300) for (const k of Object.keys(PCT_CACHE)) delete PCT_CACHE[k];
    const used = new Set(board.map(c => c.id));
    const entries = [];
    for (const c of ALL) for (const cards of concreteCombos(c.key)) {
      if (used.has(cards[0].id) || used.has(cards[1].id)) continue;
      entries.push({ id: cards[0].id + cards[1].id, rank: PT.eval.bestHand([...cards, ...board]) });
    }
    entries.sort((a, b) => PT.eval.compareRank(a.rank, b.rank));
    const n = entries.length, map = {};
    for (let i = 0; i < n;) {
      let j = i;
      while (j + 1 < n && PT.eval.compareRank(entries[j + 1].rank, entries[i].rank) === 0) j++;
      const pct = (i + (j - i) / 2) / Math.max(1, n - 1);
      for (let k = i; k <= j; k++) map[entries[k].id] = pct;
      i = j + 1;
    }
    return (PCT_CACHE[bk] = map);
  }

  const CLASS_CACHE = {};
  function comboClassOnBoard(key, board) {
    if (board.length < 3) return { made: pairTier(key), draw: 0 };
    const ck = key + '|' + board.map(c => c.id).join('');
    if (CLASS_CACHE[ck]) return CLASS_CACHE[ck];
    if (Object.keys(CLASS_CACHE).length > 20000) for (const k of Object.keys(CLASS_CACHE)) delete CLASS_CACHE[k];
    const pct = boardPercentiles(board);
    const used = new Set(board.map(c => c.id));
    let made = 0, draw = 0, n = 0;
    for (const cards of concreteCombos(key)) {
      if (used.has(cards[0].id) || used.has(cards[1].id)) continue;
      made += pct[cards[0].id + cards[1].id];
      draw += board.length < 5 ? drawStrength(cards, board) : 0;
      n++;
    }
    return (CLASS_CACHE[ck] = n ? { made: made / n, draw: draw / n } : { made: 0, draw: 0 });
  }

  function pairTier(key) {
    if (key.length === 2) { const r = 14 - RANKS.indexOf(key[0]); return r >= 12 ? 0.9 : r >= 9 ? 0.7 : 0.55; }
    return 0.2;
  }

  // Expand "AKs"/"QJo"/"77" into concrete cards not conflicting with board.
  function expandCombo(key, board) {
    const used = new Set(board.map(c => c.id));
    const pick = (rank, suit) => ({ rank, suit, ri: PT.RANKS.indexOf(rank), si: PT.SUITS.indexOf(suit), id: rank + suit });
    const trySuits = (r1, r2, suited) => {
      for (const s1 of PT.SUITS) for (const s2 of PT.SUITS) {
        if (suited && s1 !== s2) continue;
        if (!suited && s1 === s2) continue;
        const a = pick(r1, s1), b = pick(r2, s2);
        if (!used.has(a.id) && !used.has(b.id)) return [a, b];
      }
      return null;
    };
    if (key.length === 2) {
      for (const s1 of PT.SUITS) for (const s2 of PT.SUITS) {
        if (s1 === s2) continue;
        const a = pick(key[0], s1), b = pick(key[1], s2);
        if (!used.has(a.id) && !used.has(b.id)) return [a, b];
      }
      return null;
    }
    const suited = key.endsWith('s');
    return trySuits(key[0], key[1], suited);
  }

  function drawStrength(cards, board) {
    const all = [...cards, ...board];
    // flush draw
    const suitCount = {};
    all.forEach(c => suitCount[c.suit] = (suitCount[c.suit] || 0) + 1);
    const fd = Object.values(suitCount).some(n => n === 4) ? 0.35 : 0;
    // straight draw (crude: count distinct ranks in window)
    const ranks = [...new Set(all.map(c => c.ri))].sort((a, b) => a - b);
    let oesd = 0;
    for (let w = 0; w <= ranks.length - 4; w++) {
      if (ranks[w + 3] - ranks[w] <= 4) {
        // 4 distinct within a 5-window => at least a gutshot; exact OESD check:
        const seg = ranks.slice(w, w + 4);
        if (seg[3] - seg[0] === 3) oesd = Math.max(oesd, 0.3); else oesd = Math.max(oesd, 0.15);
      }
    }
    return Math.min(1, fd + oesd);
  }

  class RangeTracker {
    // archetype: key from opponents.ARCHETYPES; position: 'early'|'late'|'blinds'
    constructor(archetype, position) {
      this.range = fullRange();
      this.archetype = archetype;
      this.position = position || 'late';
    }

    // Narrow after an observed action. street: 'preflop'|'flop'|'turn'|'river'
    // facing = bets/raises already made this street before this action (2+ means calling a raise).
    update(street, action, board, facing) {
      const prof = PT.opponents.ARCHETYPES[this.archetype];
      const next = {};
      for (const key of Object.keys(this.range)) {
        const w0 = this.range[key];
        if (w0 <= 0) { next[key] = 0; continue; }
        let keep = w0;
        if (street === 'preflop') {
          const pctl = PREFLOP_PCTL[key];
          const plan = preflopPlan(prof, this.position);
          if (action === 'raise' || action === 'bet') {
            keep *= inTop(pctl, plan.open);
          } else if (action === '3bet') {
            keep *= inTop(pctl, facing >= 2 ? plan.fourBet : plan.threeBet);
          } else if (action === 'call') {
            // Callers rarely hold the top of their range: those hands would have raised.
            if (!facing) keep *= inTop(pctl, plan.enter) * (pctl < plan.open * 0.5 ? 0.3 : 1);
            else if (facing === 1) keep *= inTop(pctl, plan.threeBet + plan.flat) * (pctl < plan.threeBet ? 0.35 : 1);
            else keep *= inTop(pctl, plan.fourBet + plan.call3) * (pctl < plan.fourBet ? 0.5 : 1);
          } else if (action === 'check') {
            keep *= pctl < 0.08 ? 0.35 : 1;
          }
        } else {
          const cls = comboClassOnBoard(key, board);
          if (action === 'bet' || action === 'raise') {
            if (cls.made >= 0.8) keep *= 1;
            else if (cls.made >= 0.6) keep *= 0.45 + prof.agg * 0.35;
            else keep *= 0.06 + prof.bluff * 1.2 * (0.25 + cls.draw * 1.5);
          } else if (action === 'call') {
            const need = ({ flop: 0.5, turn: 0.6, river: 0.68 }[street] || 0.5) - (prof.loose - 0.25) * 0.4 + (facing >= 2 ? 0.17 : 0);
            const continues = cls.made >= need || cls.draw >= (facing >= 2 ? 0.3 : 0.25);
            keep *= continues ? 1 : 0.12 + prof.loose * 0.75;
            if (cls.made >= 0.93) keep *= 0.8;
          } else if (action === 'check') {
            if (cls.made >= 0.9) keep *= 0.75;
          }
        }
        next[key] = Math.min(1, Math.max(0, keep));
      }
      this.range = next;
      return this;
    }

    // Sample a concrete 2-card hand from the current weighted range, avoiding `used` cards.
    sample(usedIds, rng) {
      const flat = this._flatCombos();
      if (!flat.total) return null;
      // Rejection sampling over real combos == exact distribution conditioned on unblocked cards.
      for (let tries = 0; tries < 60; tries++) {
        const c = flat.list[pickIndex(flat.cum, rng() * flat.total)];
        if (!usedIds.has(c[0].id) && !usedIds.has(c[1].id)) return c;
      }
      const open = flat.list.map((c, i) => [c, flat.w[i]]).filter(([c]) => !usedIds.has(c[0].id) && !usedIds.has(c[1].id));
      const tot = open.reduce((s, x) => s + x[1], 0);
      if (!tot) return null;
      let r = rng() * tot;
      for (const [c, w] of open) { r -= w; if (r <= 0) return c; }
      return open[open.length - 1][0];
    }

    _flatCombos() {
      if (this._flat && this._flatSrc === this.range) return this._flat;
      const list = [], w = [], cum = [];
      let total = 0;
      for (const k of Object.keys(this.range)) {
        const wk = this.range[k];
        if (!(wk > 0)) continue;
        for (const c of concreteCombos(k)) { list.push(c); w.push(wk); total += wk; cum.push(total); }
      }
      this._flatSrc = this.range;
      return (this._flat = { list, w, cum, total });
    }

    // Distribution summary for display: {value, draws, air} as fractions of real combos.
    breakdown(board) {
      let v = 0, d = 0, a = 0, tot = 0;
      for (const k of Object.keys(this.range)) {
        const wk = this.range[k]; if (wk <= 0) continue;
        const w = wk * concreteCombos(k).length;
        tot += w;
        if (board.length >= 3) {
          const cls = comboClassOnBoard(k, board);
          if (cls.made >= 0.7) v += w; else if (cls.draw >= 0.15) d += w; else a += w;
        } else {
          const p = PREFLOP_PCTL[k];
          if (p < 0.08) v += w; else if (p < 0.35) d += w; else a += w;
        }
      }
      return tot ? { value: v / tot, draws: d / tot, air: a / tot } : { value: 0, draws: 0, air: 0 };
    }

    sizePct() {
      let tot = 0;
      for (const k of Object.keys(this.range)) tot += this.range[k] * concreteCombos(k).length;
      return tot / 1326;
    }
  }

  // Equity of heroHole vs a tracked range (weighted sampling).
  function equityVsRange(heroHole, board, tracker, iters) {
    iters = iters || 600;
    if (board.length === 5) return null;
    let win = 0, tie = 0, tot = 0;
    const used0 = new Set([...heroHole, ...board].map(c => c.id));
    const deckBase = PT.math.fullDeckMinus([...heroHole, ...board]);
    for (let it = 0; it < iters; it++) {
      const vh = tracker.sample(used0, Math.random);
      if (!vh) continue;
      const remaining = deckBase.filter(c => c.id !== vh[0].id && c.id !== vh[1].id);
      const runout = board.slice();
      while (runout.length < 5) runout.push(remaining[Math.floor(Math.random() * remaining.length)]);
      const hb = PT.eval.bestHand([...heroHole, ...runout]);
      const vb = PT.eval.bestHand([...vh, ...runout]);
      const cmp = PT.eval.compareRank(hb, vb);
      tot++;
      if (cmp > 0) win++; else if (cmp === 0) tie++;
    }
    return tot ? (win + tie / 2) / tot : null;
  }

  // Replay public actions into trackers. `state` needs players, history, board, button, sbSeat, bbSeat.
  function replay(state, trackers) {
    let raises = 0, street = 'preflop', board = [];
    const dealt = { preflop: 0, flop: 3, turn: 4, river: 5 };
    for (const h of state.history) {
      if (h.street !== street) { street = h.street; raises = 0; board = state.board.slice(0, dealt[street]); }
      const m = h.text.match(/^(.+?) (bets|raises to|calls|checks|folds)/);
      if (!m) continue;
      const verb = m[2];
      const facing = raises;
      if (verb === 'bets' || verb === 'raises to') raises++;
      const actor = state.players.find(p => p.name === m[1]);
      if (!actor || !trackers[actor.id]) continue;
      const action = verb === 'raises to' ? (facing >= 1 && street === 'preflop' ? '3bet' : 'raise')
        : verb === 'bets' ? 'bet' : verb === 'calls' ? 'call' : verb === 'checks' ? 'check' : 'fold';
      if (action !== 'fold') trackers[actor.id].update(street, action, board, facing);
    }
    return trackers;
  }

  PT.ranges = { ALL, RangeTracker, equityVsRange, openingRange, comboClassOnBoard, positionClass, openPct, preflopPlan, replay, PREFLOP_PCTL, nCombos };
})(window.PT = window.PT || {});
