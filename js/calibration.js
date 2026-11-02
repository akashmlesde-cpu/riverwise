/* calibration.js — dev report: do bots play like their labels?
 * Logs every showdown: archetype, shown hand, whether the coach's tracked
 * range for that player even contained the hand (weight >= 2%), plus
 * per-archetype stat accumulation. View with PT.calibration.report().
 */
(function (PT) {
  const KEY = 'riverwise.calibration.v1';
  const store = typeof localStorage !== 'undefined' ? localStorage : { getItem: () => null, setItem: () => {}, removeItem: () => {} };

  function load() { try { return JSON.parse(store.getItem(KEY)) || { misses: [], stats: {} }; } catch { return { misses: [], stats: {} }; } }
  function save(d) { store.setItem(KEY, JSON.stringify({ misses: d.misses.slice(-200), stats: d.stats })); }

  // Convert shown hole cards to canonical key ("AKs", "77", "QJo").
  function canonKey(hole) {
    const [a, b] = hole.slice().sort((x, y) => y.ri - x.ri);
    if (a.ri === b.ri) return a.rank + b.rank;
    return a.rank + b.rank + (a.si === b.si ? 's' : 'o');
  }

  const cal = {
    // Called at showdown for each villain who showed.
    recordShowdown(player, trackerBeforeShowdown) {
      const d = load();
      const key = canonKey(player.hole);
      const w = trackerBeforeShowdown ? (trackerBeforeShowdown.range[key] || 0) : null;
      const miss = w !== null && w < 0.02;
      if (miss) {
        d.misses.push({
          when: new Date().toISOString(), archetype: player.archetype,
          name: player.name, hand: player.hole.map(c => c.id).join(' '), key, weight: w
        });
      }
      const s = d.stats[player.archetype] = d.stats[player.archetype] || { showdowns: 0, inRange: 0, misses: 0 };
      s.showdowns++;
      if (w !== null && w >= 0.02) s.inRange++;
      if (miss) s.misses++;
      save(d);
    },

    report() {
      const d = load();
      const lines = ['CALIBRATION REPORT — do bots play like their labels?'];
      for (const [arch, s] of Object.entries(d.stats)) {
        const pct = s.showdowns ? Math.round(100 * s.inRange / s.showdowns) : 0;
        lines.push(`${arch}: ${s.showdowns} showdowns, ${pct}% inside coach's predicted range, ${s.misses} misses`);
      }
      if (d.misses.length) {
        lines.push('', 'Recent misses (hand the coach gave <2% weight):');
        for (const m of d.misses.slice(-10))
          lines.push(`  ${m.name} (${m.archetype}) showed ${m.hand}`);
      }
      return lines.join('\n');
    },

    reset() { store.removeItem(KEY); }
  };

  PT.calibration = cal;
})(window.PT = window.PT || {});
