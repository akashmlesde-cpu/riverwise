// queue.test.js — local-server request queue: priorities, preemption of coach notes, stale drops.
global.window = {};
global.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
const order = [];
let inFlight = 0, maxInFlight = 0;
global.fetch = (url, opts) => new Promise((resolve, reject) => {
  const sys = JSON.parse(opts.body).messages[0].content;
  const kind = /tutor/.test(sys) ? 'tutor' : /coach/.test(sys) ? 'coach' : 'opponent';
  inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
  const t = setTimeout(() => { inFlight--; order.push(kind); resolve({ ok: true, json: async () => ({ choices: [{ message: { content: kind === 'opponent' ? '{"action":"fold","amount":0}' : 'ok' } }] }) }); }, 60);
  opts.signal.addEventListener('abort', () => { clearTimeout(t); inFlight--; order.push(kind + '(aborted)'); const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
});
for (const f of ['deck', 'evaluator', 'pokermath', 'ranges', 'engine', 'opponents', 'coach', 'spot', 'llm', 'stats']) require('../js/' + f + '.js');
const PT = global.window.PT;
let failures = 0;
const check = (n, c, extra) => { console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' — ' + extra : '')); if (!c) failures++; };
const card = (r, s) => ({ rank: r, suit: s, ri: PT.RANKS.indexOf(r), si: PT.SUITS.indexOf(s), id: r + s });

(async () => {
  PT.llm.configure('lmstudio', { model: 'test-model' });
  PT.llm.setProvider('lmstudio');
  PT.llm.setOppProvider('lmstudio');
  const e = new PT.HoldemEngine({ seats: [{ name: 'You', archetype: 'tag', isHero: true }, { name: 'Ben', archetype: 'tag' }, { name: 'Mara', archetype: 'nit' }], stackBB: 100, sb: 0.5, bb: 1 });
  ['log', 'hand', 'turn', 'street', 'done'].forEach(t => e.on(t, () => {}));
  e.newHand();
  const ctx = { spot: 's', action: 'a', verdict: 'Good', numbers: '', ranges: '', evTable: '', ranking: '' };

  // A coach note starts, then an opponent decision arrives: the opponent must not wait for it.
  const coach = PT.llm.explainDecision(ctx, () => false);
  await new Promise(r => setTimeout(r, 10));
  const opp = PT.llm.decideForOpponent(e, e.current);
  await opp;
  await coach;
  check('opponent preempts a running coach note', order[0] === 'coach(aborted)' && order[1] === 'opponent', order.join(' > '));
  check('preempted coach note still completes afterwards', order[2] === 'coach', order.join(' > '));
  check('never more than one request at a time on the local server', maxInFlight === 1, `max ${maxInFlight}`);

  // Queued work runs by priority: tutor, then opponent, then coach.
  order.length = 0;
  const blocker = PT.llm.decideForOpponent(e, e.current);
  const c2 = PT.llm.explainDecision(ctx, () => false);
  const o2 = PT.llm.decideForOpponent(e, e.current);
  const t2 = PT.llm.tutorChat('explain SPR', { text: 'SPR 5.', best: 'folding', bestAction: 'fold' }, false, []).catch(() => null);
  await Promise.all([blocker, c2, o2, t2]);
  check('queued requests run tutor > opponent > coach', order.join(' > ') === 'opponent > tutor > opponent > coach', order.join(' > '));

  // A coach note for a decision that's already been superseded is dropped, not sent.
  order.length = 0;
  const b3 = PT.llm.decideForOpponent(e, e.current);
  const stale = PT.llm.explainDecision(ctx, () => true).catch(err => err.message);
  await b3;
  check('stale coach note is dropped without a request', (await stale) === 'stale' && order.join() === 'opponent', order.join(' > '));

  console.log(failures === 0 ? '\nALL QUEUE TESTS PASSED' : `\n${failures} FAILURES`);
  process.exit(failures ? 1 : 0);
})();
