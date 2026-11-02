/* pokermath.js — equity, pot odds, SPR, MDF, outs. Pure math, no game state. */
(function (PT) {
  const { RANKS, SUITS } = PT;

  function fullDeckMinus(used) {
    const seen = new Set(used.map(c => c.id));
    const d = [];
    for (let r = 0; r < 13; r++) for (let s = 0; s < 4; s++) {
      const c = { rank: RANKS[r], suit: SUITS[s], ri: r, si: s, id: RANKS[r] + SUITS[s] };
      if (!seen.has(c.id)) d.push(c);
    }
    return d;
  }

  // Monte Carlo equity of heroHole vs `villains` unknown hands, given board (0-5 cards).
  // IMPORTANT: only uses hero's cards + board — never real villain cards. Info-isolated.
  function equity(heroHole, board, villains, iters) {
    iters = iters || 800;
    if (board.length === 5) {
      // exact
      const h = PT.eval.bestHand([...heroHole, ...board]);
      return { win: 1, tie: 0, equity: 1, exact: false, note: 'river' };
    }
    let win = 0, tie = 0, tot = 0;
    const base = fullDeckMinus([...heroHole, ...board]);
    for (let it = 0; it < iters; it++) {
      const deck = base.slice();
      // partial Fisher-Yates for (villains*2 + cardsNeeded)
      const need = villains * 2 + (5 - board.length);
      for (let i = 0; i < need; i++) {
        const j = i + Math.floor(Math.random() * (deck.length - i));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      let k = 0;
      const vHands = [];
      for (let v = 0; v < villains; v++) { vHands.push([deck[k++], deck[k++]]); }
      const runout = board.slice();
      while (runout.length < 5) runout.push(deck[k++]);
      const heroBest = PT.eval.bestHand([...heroHole, ...runout]);
      let result = 1; // 1 win, 0.5 tie, 0 loss
      for (const vh of vHands) {
        const vb = PT.eval.bestHand([...vh, ...runout]);
        const cmp = PT.eval.compareRank(heroBest, vb);
        if (cmp < 0) { result = 0; break; }
        if (cmp === 0) result = Math.min(result, 0.5);
      }
      tot++;
      if (result === 1) win++;
      else if (result === 0.5) tie++;
    }
    return { equity: (win + tie / 2) / tot, win: win / tot, tie: tie / tot, iters: tot };
  }

  const potOdds = (toCall, pot) => toCall / (pot + toCall); // required equity to break even on a call
  const spr = (effectiveStack, pot) => pot > 0 ? effectiveStack / pot : Infinity;
  const mdf = (pot, bet) => pot / (pot + bet); // minimum defense frequency vs a bet
  const breakEvenBluff = (bet, pot) => bet / (pot + bet); // how often a bluff must work

  // Count outs: simple draw detection (flush draw, OESD, gutshot, overcards, pair->set etc.)
  function countOuts(heroHole, board) {
    if (board.length < 3 || board.length > 4) return null;
    const used = [...heroHole, ...board];
    const remaining = fullDeckMinus(used);
    const curBest = PT.eval.bestHand(used);
    let outs = 0;
    const improving = [];
    for (const c of remaining) {
      const nb = PT.eval.bestHand([...used, c]);
      if (PT.eval.compareRank(nb, curBest) > 0) { outs++; improving.push(c.id); }
    }
    return { outs, improving };
  }

  PT.math = { equity, potOdds, spr, mdf, breakEvenBluff, countOuts, fullDeckMinus };
})(window.PT = window.PT || {});
