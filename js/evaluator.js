/* evaluator.js — 7-card Texas Hold'em hand evaluation. */
(function (PT) {
  const HAND_NAMES = ['High card', 'One pair', 'Two pair', 'Three of a kind', 'Straight',
    'Flush', 'Full house', 'Four of a kind', 'Straight flush'];

  // Returns a rank array; higher (lexicographic) wins.
  function rank5(cs) {
    const vals = cs.map(c => c.ri + 2).sort((a, b) => b - a);
    const counts = {};
    vals.forEach(v => counts[v] = (counts[v] || 0) + 1);
    const groups = Object.entries(counts).map(([v, n]) => [+n, +v])
      .sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    const flush = cs.every(c => c.si === cs[0].si);
    const uniq = [...new Set(vals)];
    if (uniq[0] === 14) uniq.push(1); // wheel
    let straight = 0;
    for (let i = 0; i <= uniq.length - 5; i++)
      if (uniq[i] - uniq[i + 4] === 4) { straight = uniq[i]; break; }
    let cat, kickers;
    if (flush && straight) { cat = 8; kickers = [straight]; }
    else if (groups[0][0] === 4) { cat = 7; kickers = [groups[0][1], groups[1][1]]; }
    else if (groups[0][0] === 3 && groups[1][0] === 2) { cat = 6; kickers = [groups[0][1], groups[1][1]]; }
    else if (flush) { cat = 5; kickers = vals; }
    else if (straight) { cat = 4; kickers = [straight]; }
    else if (groups[0][0] === 3) { cat = 3; kickers = [groups[0][1], ...groups.filter(g => g[0] === 1).map(g => g[1]).sort((a, b) => b - a)]; }
    else if (groups[0][0] === 2 && groups[1][0] === 2) {
      cat = 2;
      const ps = groups.filter(g => g[0] === 2).map(g => g[1]).sort((a, b) => b - a);
      kickers = [ps[0], ps[1], groups.find(g => g[0] === 1)[1]];
    }
    else if (groups[0][0] === 2) { cat = 1; kickers = [groups[0][1], ...groups.filter(g => g[0] === 1).map(g => g[1]).sort((a, b) => b - a)]; }
    else { cat = 0; kickers = vals; }
    return [cat, ...kickers];
  }

  function compareRank(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] || 0) - (b[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  function bestOf7(cards) {
    let best = null;
    for (let a = 0; a < 3; a++) for (let b = a + 1; b < 4; b++) for (let c = b + 1; c < 5; c++)
      for (let d = c + 1; d < 6; d++) for (let e = d + 1; e < 7; e++) {
        const r = rank5([cards[a], cards[b], cards[c], cards[d], cards[e]]);
        if (!best || compareRank(r, best) > 0) best = r;
      }
    return best;
  }

  // Works for 5, 6, or 7 cards.
  function bestHand(cards) {
    if (cards.length === 7) return bestOf7(cards);
    if (cards.length === 5) return rank5(cards);
    let best = null;
    const n = cards.length;
    for (let a = 0; a < n - 4; a++) for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++) for (let d = c + 1; d < n - 1; d++)
        for (let e = d + 1; e < n; e++) {
          const r = rank5([cards[a], cards[b], cards[c], cards[d], cards[e]]);
          if (!best || compareRank(r, best) > 0) best = r;
        }
    return best;
  }

  PT.eval = { rank5, bestHand, compareRank, HAND_NAMES };
})(window.PT = window.PT || {});
