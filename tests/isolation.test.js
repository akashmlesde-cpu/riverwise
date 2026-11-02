// isolation.test.js — no coach or LLM payload can contain hidden hole cards.
global.window = {};
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.fetch = async (url, opts) => { captured.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) }; };
let captured = [];
for (const f of ['deck', 'evaluator', 'pokermath', 'ranges', 'engine', 'opponents', 'coach', 'llm', 'stats']) require('../js/' + f + '.js');
const PT = global.window.PT;
let failures = 0;
const check = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' ' + n); if (!c) failures++; };

// Simulate a hand to river; capture what an opponent-LLM call would see.
const e = new PT.HoldemEngine({
  seats: [{ name: 'You', archetype: 'tag', isHero: true }, { name: 'Vik', archetype: 'nit' }],
  stackBB: 100, sb: 0.5, bb: 1
});
['log', 'hand', 'turn', 'street', 'done'].forEach(t => e.on(t, () => {}));
e.newHand();

// Intercept target pre-set above via global.fetch.

const heroHoleIds = e.players[0].hole.map(c => c.id);

// Build the coach context exactly as app.js does.
const view = e.coachView();
const coachCtx = `street=${view.street}, board=${view.board.map(c => c.id).join(' ') || 'none'}, heroCards=${view.players[0].hole.map(c => c.id).join(' ')}, opponents=${view.players.filter(p => !p.isHero).map(p => p.name).join(',')}`;

// Coach ctx MUST contain hero cards and MUST NOT contain villain cards.
const villainHole = e.players[1].hole.map(c => c.id);
check('coach ctx includes hero cards', heroHoleIds.every(id => coachCtx.includes(id)));
check('coach ctx excludes villain cards', villainHole.every(id => !coachCtx.includes(id)));

// engine.history text should never contain villain hole card ids pre-showdown.
const histText = e.history.map(h => h.text).join('\n');
check('history pre-showdown hides villain cards', villainHole.every(id => !histText.includes(id)));

// Opponent prompt builder: Vik deciding should see HIS cards, not hero's.
(async () => {
  PT.llm.setOppProvider('groq');
  PT.llm.configure('groq', { model: 'test-model', key: 'test-fake-key' }); // enable so the fetch stub captures the payload
  try {
    await PT.llm.decideForOpponent(e, 1);
  } catch (err) { /* JSON parse of '{}' fails action check — fine */ }
  const payload = JSON.stringify(captured);
  check('opponent LLM payload includes its own cards', e.players[1].hole.every(c => payload.includes(c.id)));
  check('opponent LLM payload includes its style strategy', /Your strategy from this position|Your style:/.test(payload));
  check('opponent LLM payload excludes hero cards', heroHoleIds.every(id => !payload.includes(id)));
  console.log(failures === 0 ? '\nISOLATION OK' : `\n${failures} FAILURES`);
  process.exit(failures ? 1 : 0);
})();
