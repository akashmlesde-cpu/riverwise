// llm.test.js — provider switching, tutor grounding and answer validation.
global.window = {};
global.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
let lastReq = null, reply = '';
global.fetch = async (url, opts) => { lastReq = { url, opts, body: JSON.parse(opts.body) }; return { ok: true, json: async () => ({ choices: [{ message: { content: reply } }] }) }; };
for (const f of ['deck', 'evaluator', 'pokermath', 'ranges', 'engine', 'opponents', 'coach', 'spot', 'llm', 'stats']) require('../js/' + f + '.js');
const PT = global.window.PT;
let failures = 0;
const check = (n, c, extra) => { console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' — ' + extra : '')); if (!c) failures++; };
const card = (r, s) => ({ rank: r, suit: s, ri: PT.RANKS.indexOf(r), si: PT.SUITS.indexOf(s), id: r + s });

function spot() {
  const seats = [{ name: 'You', archetype: 'tag', isHero: true }, { name: 'Mara', archetype: 'elite' }, { name: 'Ben', archetype: 'elite' },
    { name: 'Sofia', archetype: 'elite' }, { name: 'Theo', archetype: 'elite' }, { name: 'Iris', archetype: 'adaptive' }];
  const e = new PT.HoldemEngine({ seats, stackBB: 100, sb: 0.5, bb: 1 });
  ['log', 'hand', 'turn', 'street', 'done'].forEach(t => e.on(t, () => {}));
  e.button = 0; e.newHand();
  e.players[0].hole = [card('T', '♦'), card('K', '♣')];
  e.act(4, 'fold'); e.act(5, 'call');
  return e;
}

(async () => {
  // Provider switching
  PT.llm.setProvider('off');
  check('off: AI disabled', !PT.llm.enabled);
  PT.llm.setProvider('lmstudio');
  check('lmstudio without a model asks for one', !PT.llm.enabled && /LM Studio: add the model/.test(PT.llm.setupProblem), PT.llm.setupProblem);
  PT.llm.configure('lmstudio', { model: 'qwen3.8-27b-mlx' });
  check('lmstudio: enabled without a key', PT.llm.enabled && !PT.llm.setupProblem);
  reply = '<think>scratch work</think>\n\nFolding is cheap here.';
  const view = spot().coachView();
  const facts = PT.coach.tutorFacts(view, 0, false);
  reply = `Raising is the recommended play: ${facts.text.match(/Recommended: ([^(]+)/)[1].trim()}.`;
  await PT.llm.tutorChat('what should I do?', facts, false, []).catch(() => null);
  check('lmstudio: posts to localhost:1234', lastReq.url === 'http://localhost:1234/v1/chat/completions', lastReq.url);
  check('lmstudio: model qwen3.8-27b-mlx', lastReq.body.model === 'qwen3.8-27b-mlx', lastReq.body.model);
  check('lmstudio: thinking disabled, no auth header', lastReq.body.chat_template_kwargs?.enable_thinking === false && !lastReq.opts.headers.Authorization);
  const lastMsg = lastReq.body.messages[lastReq.body.messages.length - 1];
  check('lmstudio: empty think block pre-filled', lastMsg.role === 'assistant' && /<think>\s*<\/think>/.test(lastMsg.content));
  reply = '<think>long reasoning</think>\n\n{"action":"fold","amount":0}';
  const e2 = spot();
  PT.llm.setOppProvider('lmstudio');
  const d = await PT.llm.decideForOpponent(e2, 1);
  check('lmstudio: <think> blocks stripped before parsing', d.action === 'fold', JSON.stringify(d));
  PT.llm.setProvider('groq');
  PT.llm.setOppProvider('groq');
  check('groq without settings asks for them', /Groq: add the model/.test(PT.llm.setupProblem), PT.llm.setupProblem);
  PT.llm.configure('groq', { model: 'test-model', key: 'gsk_test' });
  await PT.llm.decideForOpponent(spot(), 1).catch(() => null);
  check('groq: posts to Groq with bearer key', /api\.groq\.com/.test(lastReq.url) && lastReq.opts.headers.Authorization === 'Bearer gsk_test');
  check('cloud models get no local-only parameters', !lastReq.body.chat_template_kwargs && lastReq.body.messages.at(-1).role !== 'assistant');

  // Any OpenAI-compatible endpoint
  PT.llm.configure('custom', { url: 'https://llm.example.com/v1/chat/completions/', model: 'my-model', key: 'k-123' });
  PT.llm.setOppProvider('custom');
  await PT.llm.decideForOpponent(spot(), 1).catch(() => null);
  check('custom: URL normalised to <base>/chat/completions', lastReq.url === 'https://llm.example.com/v1/chat/completions', lastReq.url);
  check('custom: model and key used', lastReq.body.model === 'my-model' && lastReq.opts.headers.Authorization === 'Bearer k-123');
  PT.llm.configure('ollama', { model: 'qwen3:8b' });
  PT.llm.setProvider('ollama'); PT.llm.setOppProvider('ollama');
  check('local servers share one queue only with themselves', PT.llm.coachSharesQueue);
  PT.llm.setOppProvider('lmstudio');
  check('different local servers do not wait on each other', !PT.llm.coachSharesQueue);

  // APIs that reject max_tokens are retried with max_completion_tokens
  const realFetch = global.fetch, bodies = [];
  global.fetch = async (url, opts) => {
    const b = JSON.parse(opts.body); bodies.push(b);
    if ('max_tokens' in b) return { ok: false, status: 400, text: async () => "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead." };
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) };
  };
  PT.llm.configure('openai', { model: 'some-model', key: 'sk-test' });
  const t = await PT.llm.testProvider('openai').catch(err => ({ err }));
  check('rejected max_tokens is retried with max_completion_tokens', t.reply === 'OK' && bodies.length === 2 && 'max_completion_tokens' in bodies[1], JSON.stringify(t));

  // Model suggestions come from the provider's /models list, using unsaved form values
  let modelsReq = null;
  global.fetch = async (url, opts) => { modelsReq = { url, opts }; return { ok: true, json: async () => ({ data: [{ id: 'b-model' }, { id: 'a-model' }] }) }; };
  const models = await PT.llm.listModels('groq', { key: 'gsk_typed' });
  check('model list fetched from <base>/models with the typed key', modelsReq.url === 'https://api.groq.com/openai/v1/models' && modelsReq.opts.headers.Authorization === 'Bearer gsk_typed', modelsReq.url);
  check('model list sorted', JSON.stringify(models) === '["a-model","b-model"]', JSON.stringify(models));
  check('no model lookup for a cloud provider without a key', (await PT.llm.listModels('openrouter', { key: '' })).length === 0);
  global.fetch = realFetch;
  PT.llm.setProvider('groq'); PT.llm.setOppProvider('groq');

  // Analysis and opponents pick their AI independently
  PT.llm.setProvider('groq'); PT.llm.setOppProvider('lmstudio');
  await PT.llm.decideForOpponent(spot(), 1).catch(() => null);
  check('opponents on LM Studio while analysis is on Groq', /localhost:1234/.test(lastReq.url), lastReq.url);
  await PT.llm.tutorChat('explain SPR', { text: 'SPR 5.', best: 'folding', bestAction: 'fold' }, false, []).catch(() => null);
  check('tutor on Groq while opponents are on LM Studio', /api\.groq\.com/.test(lastReq.url), lastReq.url);
  PT.llm.setOppProvider('off');
  check('opponents offline, analysis still on', !PT.llm.opponentsEnabled && PT.llm.enabled);
  check('Groq analysis notes are sent immediately', !PT.llm.coachSharesQueue);
  PT.llm.setProvider('lmstudio'); PT.llm.setOppProvider('lmstudio');
  check('notes wait only when both share LM Studio', PT.llm.coachSharesQueue);
  PT.llm.setOppProvider('groq');
  check('LM Studio notes are immediate when opponents use Groq', !PT.llm.coachSharesQueue);
  PT.llm.setProvider('off'); PT.llm.setOppProvider('groq');
  check('analysis offline, opponents still on', PT.llm.opponentsEnabled && !PT.llm.enabled);
  await PT.llm.tutorChat('x', { text: '', best: 'folding', bestAction: 'fold' }, false, []).then(() => check('offline analysis makes no AI call', false), () => check('offline analysis makes no AI call', true));
  PT.llm.setProvider('groq');

  // Tutor and analysis agree: same cached evaluation
  const e3 = spot();
  const v3 = e3.coachView();
  const f3 = PT.coach.tutorFacts(v3, 0, false);
  const local = PT.coach.tutorReply('what should I do?', v3, 0, false);
  const g3 = PT.coach.grade(v3, 0, f3.bestAction, f3.bestAction === 'raise' || f3.bestAction === 'bet' ? PT.coach.evaluateActions(v3, 0).best.amount : undefined, 'Essential');
  check('tutor facts, local tutor and grade share one best action', local.includes(f3.best) && g3.best.action === f3.bestAction, `${f3.best} | ${g3.best.action}`);
  check('following the tutor recommendation grades good/excellent', ['excellent', 'good'].includes(g3.grade), g3.label);
  const evA = PT.coach.evaluateActions(v3, 0), evB = PT.coach.evaluateActions(v3, 0);
  check('repeat evaluations of the same spot are identical', evA.equity === evB.equity && evA.best === evB.best);

  // Tutor validator
  const other = f3.bestAction === 'fold' ? 'call' : 'fold';
  check('validator rejects recommending a different action', !PT.llm.validateTutor(`You should ${other} here.`, f3, false));
  check('validator rejects any recommendation while Test mode is locked', !PT.llm.validateTutor(`You should ${f3.bestAction} here.`, f3, true));
  check('validator accepts the engine recommendation', PT.llm.validateTutor(`I would recommend ${f3.best} here.`, f3, false), f3.best);
  const locked = PT.coach.tutorFacts(v3, 0, true);
  check('locked facts omit the recommendation', !/Recommended:|EV per action/.test(locked.text));
  check('locked local tutor does not reveal the action', /won't name the play/.test(PT.coach.tutorReply('what should I do?', v3, 0, true)));

  // Tutor answers the question asked, with the EV derivation available
  check('facts include how each EV is computed', /EV = /.test(f3.text) && /How bet sizes are chosen/.test(f3.text));
  check('locked facts hide per-action EV formulas', !/EV = P\(everyone folds\)/.test(locked.text));
  const sizeAns = PT.coach.tutorReply('how do i decide my raise amount', v3, 0, false);
  const evAns = PT.coach.tutorReply('how did you calculate this ev for raise', v3, 0, false);
  check('built-in tutor answers sizing questions about sizing', /compares/.test(sizeAns), sizeAns);
  check('built-in tutor answers EV questions with the formula', /How each EV is computed/.test(evAns), evAns);
  check('sizing and EV answers differ', sizeAns !== evAns);
  check('tutor may quote a number from the question', PT.llm.validateTutor('The 18.7 you see is just the raise EV.', f3, false, 'why ev 18.7'));
  check('tutor may do arithmetic on analysis numbers', PT.llm.validateTutor('Folds 40% of the time: 0.4 x 12.5 = 5.0 BB.', { text: 'pot 12.5 BB, folds 40%', bestAction: 'check', best: 'check' }, false, ''));
  check('tutor still rejects invented numbers', !PT.llm.validateTutor('Your equity is 73.4%.', { text: 'pot 2 BB, call 1 BB', bestAction: 'check', best: 'check' }, false, ''));

  // Coach note must not call a Good/Excellent decision a mistake
  const goodCtx = { spot: '', action: 'fold', verdict: 'Good (local engine)', numbers: '', handRank: '', ranges: '', evTable: '', ranking: '', chosenIsBest: false, chosenAction: 'fold', bestAction: 'raise' };
  check('coach note rejects "your fold was a mistake" on a Good card', !PT.llm.validateExplanation('Your fold was a mistake because raising is optimal.', goodCtx));
  check('coach note accepts "your fold was not a mistake" on a Good card', PT.llm.validateExplanation('Your fold was not a mistake; raising is only slightly better.', goodCtx));

  // Tutor prompt: facts in system message, the bare question last, history kept
  let tutorMsgs = null;
  global.fetch = async (url, opts) => { tutorMsgs = JSON.parse(opts.body).messages; return { ok: true, json: async () => ({ choices: [{ message: { content: 'Bigger sizes get more folds but risk more.' } }] }) }; };
  await PT.llm.tutorChat('how do i decide my raise amount', f3, false, [{ role: 'user', text: 'earlier q' }, { role: 'assistant', text: 'earlier a' }]);
  const lastUser = tutorMsgs.filter(m => m.role === 'user').pop();
  check('tutor: analysis lives in the system prompt', /Engine analysis/.test(tutorMsgs[0].content));
  check('tutor: last user message is the bare question', lastUser.content === 'how do i decide my raise amount', lastUser.content);
  check('tutor: chat history is passed', tutorMsgs.some(m => m.content === 'earlier a'));

  console.log(failures === 0 ? '\nALL LLM TESTS PASSED' : `\n${failures} FAILURES`);
  process.exit(failures ? 1 : 0);
})();
