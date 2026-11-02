/* llm.js — LLM client for any OpenAI-compatible chat API (cloud or local) + prompts.
 *
 * Two consumers:
 *  - opponents: LLM sees the deciding player's OWN hole cards (legal info)
 *  - coach/tutor: LLM sees ONLY the sanitized coach view (no villain cards)
 */
(function (PT) {
  const W = typeof window !== 'undefined' ? window : {};
  const store = typeof localStorage !== 'undefined' ? localStorage : { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const SETTINGS_STORE = 'riverwise.ai';

  // Presets only pre-fill the base URL; every provider speaks the OpenAI chat-completions format.
  const PRESETS = {
    groq:       { label: 'Groq',       url: 'https://api.groq.com/openai/v1', needsKey: true,  hint: 'e.g. llama-3.3-70b-versatile' },
    openai:     { label: 'OpenAI',     url: 'https://api.openai.com/v1',      needsKey: true,  hint: 'e.g. gpt-4o-mini' },
    openrouter: { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1',   needsKey: true,  hint: 'e.g. meta-llama/llama-3.3-70b-instruct' },
    lmstudio:   { label: 'LM Studio',  url: 'http://localhost:1234/v1',      needsKey: false, hint: 'model id shown in LM Studio' },
    ollama:     { label: 'Ollama',     url: 'http://localhost:11434/v1',     needsKey: false, hint: 'e.g. qwen3:8b' },
    custom:     { label: 'Custom',     url: '',                              needsKey: false, hint: 'model id for your endpoint' }
  };

  const fileCfg = W.PT_AI || {};
  const saved = (() => { try { return JSON.parse(store.getItem(SETTINGS_STORE)) || {}; } catch { return {}; } })();
  const valid = p => (PRESETS[p] ? p : 'off');
  const settings = {
    analysis: valid(saved.analysis || fileCfg.analysis),
    opponents: valid(saved.opponents || fileCfg.opponents),
    providers: {}
  };
  for (const id of Object.keys(PRESETS))
    settings.providers[id] = { ...((fileCfg.providers || {})[id]), ...((saved.providers || {})[id]) };
  const save = () => store.setItem(SETTINGS_STORE, JSON.stringify(settings));

  const errors = { coach: null, opp: null };
  const compat = {};   // per-provider request fixes learned from 400 errors
  let lastNoteProblem = null;

  function conf(id) {
    const p = PRESETS[id];
    if (!p) return null;
    const s = settings.providers[id] || {};
    const url = (s.url || p.url).trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    const model = (s.model || '').trim(), key = (s.key || '').trim();
    const local = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(url);
    // An empty think block makes Qwen skip hidden reasoning (82 s -> ~2 s per call in LM Studio).
    const qwenNoThink = id === 'lmstudio' && /qwen/i.test(model);
    return {
      id, label: p.label, url, model, key, needsKey: p.needsKey, local, serial: local,
      missing: !url ? 'base URL' : !model ? 'model' : p.needsKey && !key ? 'API key' : null,
      timeoutMs: local ? 45000 : 20000, oppTimeoutMs: 12000, extraTokens: local ? 40 : 0,
      prefill: qwenNoThink ? '<think>\n\n</think>\n\n' : null,
      extra: qwenNoThink ? { chat_template_kwargs: { enable_thinking: false } } : {},
      compat: compat[id] || (compat[id] = {})
    };
  }

  const cfgFor = role => conf(role === 'opp' ? settings.opponents : settings.analysis);
  const enabledFor = role => { const c = cfgFor(role); return !!c && !c.missing; };

  function configure(id, values) {
    if (!PRESETS[id]) return;
    const s = settings.providers[id] || (settings.providers[id] = {});
    for (const k of ['url', 'model', 'key']) if (values[k] !== undefined) s[k] = String(values[k]).trim();
    compat[id] = {};
    errors.coach = errors.opp = null;
    save();
  }

  function setProvider(p) {
    settings.analysis = valid(p);
    errors.coach = null;
    save();
  }

  function setOppProvider(p) {
    settings.opponents = valid(p);
    errors.opp = null;
    save();
  }

  function providerSettings(id) {
    const p = PRESETS[id], s = settings.providers[id] || {};
    return p && { id, label: p.label, hint: p.hint, needsKey: p.needsKey, defaultUrl: p.url, url: s.url || p.url, model: s.model || '', key: s.key || '' };
  }

  // Model ids the provider offers (OpenAI-compatible GET /models), using unsaved form values if given.
  async function listModels(id, override = {}) {
    const p = PRESETS[id];
    if (!p) return [];
    const s = settings.providers[id] || {};
    const url = (override.url || s.url || p.url).trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    const key = (override.key !== undefined ? override.key : s.key || '').trim();
    if (!url || (p.needsKey && !key)) return [];
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url + '/models', { signal: ctrl.signal, headers: key ? { Authorization: 'Bearer ' + key } : {} });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.data || data.models || []).map(m => m.id || m.name).filter(Boolean).sort();
    } catch { return []; } finally { clearTimeout(to); }
  }

  // Sends a tiny request to check URL, model and key; resolves with the round-trip time.
  async function testProvider(id) {
    const c = conf(id);
    if (!c) throw new Error('unknown provider');
    if (c.missing) throw new Error(`add the ${c.missing}`);
    const t0 = Date.now();
    const reply = await chat([{ role: 'user', content: 'Reply with the single word OK.' }], 8, 0, 20000, { providerId: id, priority: PRIORITY.tutor });
    return { ms: Date.now() - t0, reply };
  }

  // Request priorities. A local server answers one request at a time, so order matters.
  // Each local server (by URL) gets its own queue; cloud providers are called directly.
  const PRIORITY = { coach: 1, opponent: 2, tutor: 3 };
  const queues = new Map();
  let seq = 0;

  function chat(messages, maxTokens, temperature, timeoutMs, opts = {}) {
    const role = opts.providerId ? 'test' : opts.priority === PRIORITY.opponent ? 'opp' : 'coach';
    const c = opts.providerId ? conf(opts.providerId) : cfgFor(role);
    if (!c || c.missing) return Promise.reject(new Error('LLM disabled'));
    const job = { c, role, messages, maxTokens, temperature, timeoutMs, priority: opts.priority || 0, isStale: opts.isStale, seq: seq++ };
    if (!c.serial) return send(job);
    const q = queues.get(c.url) || queues.set(c.url, { jobs: [], running: null }).get(c.url);
    return new Promise((resolve, reject) => {
      job.resolve = resolve; job.reject = reject;
      q.jobs.push(job);
      // Coach notes yield to anything more urgent; they restart later or get dropped as stale.
      if (q.running && q.running.priority === PRIORITY.coach && job.priority > q.running.priority) {
        q.running.preempted = true;
        q.running.ctrl.abort();
      }
      pump(q);
    });
  }

  function pump(q) {
    if (q.running || !q.jobs.length) return;
    q.jobs.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    const job = q.jobs.shift();
    if (job.isStale && job.isStale()) { job.reject(new Error('stale')); pump(q); return; }
    q.running = job;
    job.preempted = false;
    send(job)
      .then(job.resolve, err => { if (job.preempted) q.jobs.push(job); else job.reject(err); })
      .finally(() => { q.running = null; pump(q); });
  }

  function requestBody(job) {
    const { c, messages, maxTokens, temperature } = job;
    const body = { model: c.model, messages: c.prefill ? [...messages, { role: 'assistant', content: c.prefill }] : messages, ...c.extra };
    body[c.compat.maxCompletionTokens ? 'max_completion_tokens' : 'max_tokens'] = (maxTokens || 256) + c.extraTokens;
    if (!c.compat.noTemperature) body.temperature = temperature == null ? 0.4 : temperature;
    return JSON.stringify(body);
  }

  // Some APIs (e.g. newer OpenAI models) reject max_tokens or a custom temperature: adapt and retry.
  function adaptTo(c, errText) {
    if (/max_tokens/.test(errText) && !c.compat.maxCompletionTokens) return (c.compat.maxCompletionTokens = true);
    if (/temperature/.test(errText) && !c.compat.noTemperature) return (c.compat.noTemperature = true);
    return false;
  }

  async function send(job) {
    const { c } = job;
    job.ctrl = new AbortController();
    const to = setTimeout(() => job.ctrl.abort(), job.timeoutMs || c.timeoutMs);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (c.key) headers.Authorization = 'Bearer ' + c.key;
      for (;;) {
        let res;
        try {
          res = await fetch(c.url + '/chat/completions', { method: 'POST', signal: job.ctrl.signal, headers, body: requestBody(job) });
        } catch (err) {
          if (!job.preempted) errors[job.role] = err.name === 'AbortError' ? `${c.label} timed out` : `${c.label} unreachable`;
          throw err;
        }
        if (!res.ok) {
          const t = await res.text().catch(() => '');
          if (res.status === 400 && adaptTo(c, t)) continue;
          errors[job.role] = `${c.label} ${res.status}`;
          let detail = t;
          try { detail = JSON.parse(t).error.message || t; } catch { /* not JSON */ }
          throw new Error(`${c.label} ${res.status}: ${String(detail).slice(0, 200)}`);
        }
        const data = await res.json();
        errors[job.role] = null;
        return ((data.choices && data.choices[0] && data.choices[0].message.content) || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      }
    } finally { clearTimeout(to); }
  }

  /* ---------- opponent decision ---------- */

  // fullView contains THIS player's hole cards — legal: it's their own hand.
  // Other players' hole cards are never included (engine view only exposes
  // hero's; for AI seats we pass their own cards explicitly).
  async function decideForOpponent(engine, seat) {
    const p = engine.players[seat];
    const L = engine.legal(seat);
    const prof = PT.opponents.ARCHETYPES[p.archetype];
    const pot = engine.pot();
    const board = engine.board.map(c => c.id).join(' ') || 'none (preflop)';
    const toCall = L.toCall;

    const others = engine.players.filter((q, i) => i !== seat && !q.folded).map(q => {
      const style = q.isHero ? 'human' : PT.opponents.ARCHETYPES[q.archetype].label;
      return `${q.name} ${engine.positionName(q.id)} (${style}) ${q.allIn ? 'all-in' : q.stack.toFixed(0) + 'bb'}`;
    }).join('; ');

    // One compact line per street keeps the prompt short (prompt reading dominates local latency).
    const streets = {};
    for (const h of engine.history) {
      if (/posts|Hand #|^[A-Z]+:/.test(h.text)) continue;
      (streets[h.street] = streets[h.street] || []).push(h.text.replace(/ BB/g, '').replace(/\.$/, '').replace(/ and is all-in/, ' all-in'));
    }
    const actionLog = Object.entries(streets).map(([s, a]) => `${s}: ${a.join(', ')}`).join('\n');

    const legal = [];
    if (L.canFold) legal.push('fold');
    if (L.canCheck) legal.push('check');
    if (L.canCall) legal.push(`call ${L.toCall.toFixed(1)}`);
    if (L.canBetRaise) legal.push(`raise/bet to a TOTAL of ${L.minBetTo.toFixed(1)}–${L.maxBetTo.toFixed(1)} BB`);

    const sys = `You are ${p.name}, a ${prof.label} No-Limit Hold'em player. ${personaText(p.archetype)} ` +
      'Your strategy numbers below define your style: follow them, mixing only in close spots. ' +
      `Amounts are in big blinds. Reply with ONLY JSON: {"action":"fold|check|call|bet|raise","amount":<total bet for bet/raise, else 0>}.`;

    const usr = `Cards: ${p.hole.map(c => c.id).join(' ')} | ${engine.street}, board ${board} | pot ${pot.toFixed(1)}, to call ${toCall.toFixed(1)}, your stack ${p.stack.toFixed(0)} | you are ${engine.positionName(seat)}
Opponents: ${others}
${actionLog || 'No actions yet.'}
${mathFacts(engine, seat, toCall, pot)}
${styleGuide(engine, seat, prof, L, pot)}
Legal: ${legal.join(' | ')}`;

    const txt = await chat([{ role: 'system', content: sys }, { role: 'user', content: usr }], 80, 0.7, null, { priority: PRIORITY.opponent });
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no JSON in LLM reply');
    const d = JSON.parse(m[0]);
    if (!['fold', 'check', 'call', 'bet', 'raise'].includes(d.action)) throw new Error('bad action');
    // Map near-miss answers to the legal equivalent (e.g. "call" with nothing to call = check).
    if ((d.action === 'call' || d.action === 'fold') && L.canCheck) d.action = 'check';
    if (d.action === 'check' && !L.canCheck) d.action = 'fold';
    if ((d.action === 'bet' || d.action === 'raise') && !L.canBetRaise) d.action = L.canCall ? 'call' : 'check';
    if (d.action === 'bet' || d.action === 'raise') {
      const amt = PT.opponents.niceSize(+d.amount || 0, L);
      return { action: L.toCall > 0 || engine.currentBet > 0 ? 'raise' : 'bet', betTo: amt };
    }
    return { action: d.action };
  }

  // The style's concrete strategy for this spot: the same numbers the built-in bots play by.
  function styleGuide(engine, seat, prof, L, pot) {
    const p = engine.players[seat];
    const pc = x => Math.round(x * 100) + '%';
    const giveUp = L.canCheck ? 'check' : 'fold';
    if (engine.street === 'preflop') {
      const pos = PT.ranges.positionClass(engine, seat);
      const plan = PT.ranges.preflopPlan(prof, pos);
      const key = PT.opponents.handKey(p.hole);
      const raises = engine.history.filter(h => h.street === 'preflop' && / raises to /.test(h.text)).length;
      const pctl = PT.ranges.PREFLOP_PCTL[key];
      let s = `Your hand ${key} is in the top ${pc(Math.max(0.01, pctl))} of starting hands. Your strategy from this position: `;
      // LLMs compare percentages unreliably, so state which part of the strategy this hand falls in.
      const bucket = (raiseTop, callTop, raiseWord) => pctl < raiseTop ? `${raiseWord} range` : pctl < callTop ? 'calling range' : `outside your range (normally ${giveUp})`;
      if (raises === 0) s += `raise the top ${pc(plan.open)} to ${pos === 'late' ? 2.5 : 3} BB (+1 BB per limper)` +
        (plan.enter > plan.open ? `, just call with the next ${pc(plan.enter - plan.open)}` : '') + `, ${giveUp} the rest. ` +
        `This hand is in your ${bucket(plan.open, plan.enter, 'raising')}.`;
      else if (raises === 1) s += `facing one raise, re-raise the top ${pc(plan.threeBet)} to about ${pos === 'blinds' ? 4 : 3}x, call the next ${pc(plan.flat)}, ${giveUp} the rest. ` +
        `This hand is in your ${bucket(plan.threeBet, plan.threeBet + plan.flat, 're-raising')}.`;
      else s += `facing a re-raise, raise again with the top ${pc(plan.fourBet)}, call the next ${pc(plan.call3)}, ${giveUp} the rest. ` +
        `This hand is in your ${bucket(plan.fourBet, plan.fourBet + plan.call3, 're-raising')}.`;
      return s.replace('in your outside', 'outside');
    }
    const nLive = engine.livePlayers().length - 1;
    const k = p.archetype === 'station' ? 0.45 : (1.05 - prof.loose * 0.55) * (nLive >= 2 ? 1 + 0.35 * (nLive - 1) : 1);
    if (L.toCall > 0)
      return `Your style: continue when your equity is above ${pc(Math.min(0.95, PT.math.potOdds(L.toCall, pot) * k))}; raise for value with about ${pc(0.78 - prof.agg * 0.18)}+ equity.`;
    return `Your style: bet for value with about ${pc(nLive >= 2 ? 0.70 : 0.62)}+ equity, sized near ${pc(0.35 + prof.agg * 0.45)} of the pot; ` +
      `with weak hands bluff about ${pc(prof.bluff * (nLive >= 2 ? 0.15 : 0.45))} of the time, otherwise check.`;
  }

  // Only legal info: this player's own cards + ranges implied by public actions.
  function mathFacts(engine, seat, toCall, pot) {
    if (engine.street === 'preflop') {
      return toCall > 0 ? `Pot odds: you need ${(PT.math.potOdds(toCall, pot) * 100).toFixed(0)}% equity to call.` : '';
    }
    const trackers = PT.opponents.opponentTrackers(engine, seat);
    const eq = PT.coach.equityVsField(engine.players[seat].hole, engine.board, trackers, 400);
    const opp = Object.keys(trackers).length;
    let s = `Your equity vs the ${opp} remaining opponent(s)' likely ranges (from their actions): ~${(eq * 100).toFixed(0)}%.`;
    if (toCall > 0) s += ` Pot odds: you need ${(PT.math.potOdds(toCall, pot) * 100).toFixed(0)}% to call.`;
    if (opp >= 2) s += ' Multiway: bluffs rarely work and marginal hands lose value.';
    return s;
  }

  function personaText(arch) {
    const map = {
      recreational: 'You play for fun. You like seeing flops, chase draws too much, and hate folding pairs.',
      station: 'You call far too much and almost never raise without the nuts. You hate being bluffed.',
      nit: 'You are extremely tight. You fold everything but premium hands and rarely bluff.',
      lag: 'You are loose and very aggressive. You raise and bluff often, putting pressure on weak ranges.',
      tag: 'You are a solid tight-aggressive regular. Position-aware, disciplined, value-oriented.',
      gto: 'You think in ranges and frequencies. Balanced bet sizes, mixed strategies, mathematically grounded.',
      live: 'You are an exploitative live pro. You read situations and deviate to attack specific weaknesses.',
      pressure: 'You apply maximum pressure: big bets, frequent aggression, targeting capped ranges.',
      elite: 'You are an elite balanced professional: unexploitable baselines with sharp exploitative adjustments.',
      adaptive: 'You study your opponents and adjust. Against the human, exploit whatever tendency you have observed this session.'
    };
    return map[arch] || map.tag;
  }

  /* ---------- coach explanation ---------- */

  // coachCtx must be built from coachView-derived data ONLY.
  // Fix #5: the LLM receives ONLY computed facts and is forbidden from
  // inventing numbers or hand-strength claims. Output is validated.
  async function explainDecision(coachCtx, isStale) {
    const sys = 'You are a poker coach explaining a student\'s decision in No-Limit Hold\'em. ' +
      'You only know what the student knew at decision time (you never see opponents\' hole cards). ' +
      'CRITICAL RULES: (1) Do not state any number that is not in the provided data. ' +
      '(2) Do not make hand-strength ranking claims like "second-best hand" or "the nuts" unless the data includes a hand-rank line saying so. ' +
      '(3) Your explanation must be consistent with the given verdict — never call a mistake good or vice versa. ' +
      'Excellent/Good means the action is fine (at most a small, within-noise EV gap); never call it a mistake. ' +
      'Write 3-5 sentences of plain English: say whether the action was right, explain why USING the numbers given ' +
      '(compare the EVs of the options), and teach one transferable concept.';
    const usr = `Computed facts (the only numbers you may use):
Spot: ${coachCtx.spot}
Student's action: ${coachCtx.action}
Verdict: ${coachCtx.verdict}
Key numbers: ${coachCtx.numbers}
Hand strength: ${coachCtx.handRank || 'not computed'}
Opponent range estimate: ${coachCtx.ranges}
EV per action: ${coachCtx.evTable || 'not computed'}
Ranking: ${coachCtx.ranking || 'not computed'}
Explain the verdict to the student:`;
    const msgs = [{ role: 'system', content: sys }, { role: 'user', content: usr }];
    for (let attempt = 0; attempt < 2; attempt++) {
      const txt = await chat(msgs, 260, attempt ? 0.2 : 0.4, null, { priority: PRIORITY.coach, isStale });
      lastNoteProblem = explanationProblem(txt, coachCtx);
      if (!lastNoteProblem) return txt;
      msgs.push({ role: 'assistant', content: txt || '' },
        { role: 'user', content: `That explanation has a problem (${lastNoteProblem}). Rewrite it, using only the given numbers and agreeing with the verdict.` });
    }
    return null;
  }

  const ACTION_WORDS = { fold: 'fold(?:ing)?', check: 'check(?:ing)?', call: 'call(?:ing)?', bet: 'bet(?:ting)?', raise: 'rais(?:e|ing)' };

  // Why a coach explanation can't be shown (contradicts grade/EV ranking, invents numbers or hand ranks), or null.
  function explanationProblem(txt, ctx) {
    if (!txt) return 'empty answer';
    const t = txt.toLowerCase();
    const verdict = (ctx.verdict || '').toLowerCase();
    if (/mistake|blunder/.test(verdict) && /\b(good|correct|right|profitable|makes you money)\b/.test(t) && !/not|n't|would have been|instead/.test(t)) return 'praised a mistake';
    if (/excellent|good/.test(verdict) && (/\b(blunder|terrible|major mistake)\b/.test(t) ||
      /\b(was|is) (a |an )?(mistake|error|wrong|incorrect)\b/.test(t) && !/\b(not|n't|wasn't|isn't)\b[^.]*\b(mistake|error|wrong|incorrect)\b/.test(t))) return 'called a good play a mistake';
    if (/the nuts|second.best|third.best|second nuts|best possible hand/.test(t) && !/the nuts|second.best|best possible/.test((ctx.handRank || '').toLowerCase())) return 'unverified hand-rank claim';
    if (ctx.chosenIsBest === false && ACTION_WORDS[ctx.chosenAction] && ACTION_WORDS[ctx.bestAction]) {
      const chosen = ACTION_WORDS[ctx.chosenAction], best = ACTION_WORDS[ctx.bestAction];
      const praises = new RegExp(`${chosen}[^.]*\\b(better|more profitable|higher ev|the best|correct)\\b`).test(t);
      const hedged = new RegExp(`${chosen}[^.]*\\b(not|n't|worse|less|lower)\\b`).test(t);
      if (praises && !hedged) return `called ${ctx.chosenAction} the better play`;
      if (new RegExp(`\\b(better|more profitable)\\s+than\\s+${best}`).test(t)) return `called something better than ${ctx.bestAction}`;
    }
    const facts = [ctx.spot, ctx.action, ctx.verdict, ctx.numbers, ctx.handRank, ctx.ranges, ctx.evTable, ctx.ranking].join(' ');
    const known = knownNumbers(facts);
    for (const m of txt.matchAll(/(-?\d+(?:\.\d+)?)(\s*%)?/g)) {
      if (!m[2] && !m[1].includes('.')) continue;
      const n = Number(m[1]), tol = m[2] ? 1 : 0.15;
      if (!known(n, tol)) return `number ${m[0].trim()} not in the analysis`;
    }
    return null;
  }

  const validateExplanation = (txt, ctx) => !explanationProblem(txt, ctx);

  // facts: { text, best } built from the same cached engine evaluation the analysis uses.
  // locked: hero is facing a decision in Test mode, so the best action must not be revealed.
  async function tutorChat(question, facts, locked, history) {
    const rule = locked
      ? 'The student has NOT acted yet (Test mode): explain concepts and math, but never say which action to take.'
      : !facts.bestAction ? 'The hand is over: review the student\'s graded decisions; do not recommend a new action.'
      : `Only name a best action for the current spot if the student asks what to do; it must be "${facts.best}", never a different one.`;
    const sys = 'You are a poker tutor sitting beside a student in No-Limit Hold\'em. ' +
      'Answer the student\'s exact question directly in the first sentence, then support it with numbers. ' +
      'If they ask how they played, go through each graded decision this hand in order, using its grade and EVs. ' +
      'If they ask how a number was calculated, walk through its formula with the numbers given below. ' +
      'If they ask about sizing, explain how the sizes compare. Higher EV is better: never call a lower EV higher. ' +
      'Do not repeat earlier answers; address what is new in this question. ' +
      rule + ' You never see opponents\' hidden cards. Use only numbers from the analysis below (or simple arithmetic on them); ' +
      'never invent equities, odds or EVs. 2-6 plain-English sentences.\n\nEngine analysis:\n' + facts.text;
    const msgs = [{ role: 'system', content: sys }];
    for (const h of (history || []).slice(-6)) msgs.push({ role: h.role, content: h.text });
    msgs.push({ role: 'user', content: question });
    let problem = 'no answer';
    for (let attempt = 0; attempt < 2; attempt++) {
      const txt = await chat(msgs, 360, attempt ? 0.2 : 0.5, null, { priority: PRIORITY.tutor });
      problem = tutorProblem(txt, facts, locked, question);
      if (!problem) return txt;
      msgs.push({ role: 'assistant', content: txt || '' },
        { role: 'user', content: `That answer has a problem (${problem}). Answer my question again, using only the analysis numbers.` });
    }
    throw new Error('AI answer rejected (' + problem + ')');
  }

  const ACTION_FAMILY = { fold: 'fold', check: 'check', call: 'call', bet: 'aggr', raise: 'aggr', shove: 'aggr', jam: 'aggr', 'all-in': 'aggr' };
  const RECOMMEND = /(you should|i(?:'d| would) (?:recommend|suggest)|recommend(?:ed)?|best (?:play|move|action|option) (?:here )?is|the (?:right|correct) (?:play|move|action) is|go with)([^.]*?)\b(fold|check|call|bet|raise|shove|jam|all-in)\b/gi;

  // Returns why an AI tutor answer can't be shown, or null if it's consistent with the engine.
  function tutorProblem(txt, facts, locked, question) {
    if (!txt) return 'empty answer';
    for (const m of locked || facts.bestAction ? txt.matchAll(RECOMMEND) : []) {
      if (/\b(not|n't|never|instead of|if)\b/i.test(m[2])) continue;
      if (locked) return 'revealed the action in Test mode';
      if (ACTION_FAMILY[m[3].toLowerCase()] !== ACTION_FAMILY[facts.bestAction]) return `recommended ${m[3].toLowerCase()}, engine says ${facts.bestAction}`;
    }
    const known = knownNumbers(facts.text + ' ' + (question || ''));
    for (const m of txt.matchAll(/(-?\d+(?:\.\d+)?)(\s*%)?/g)) {
      if (!m[2] && !m[1].includes('.')) continue;
      const n = Number(m[1]), tol = m[2] ? 1 : 0.15;
      if (!known(n, tol)) return `number ${m[0].trim()} not in the analysis`;
    }
    return null;
  }

  // Numbers the tutor may quote: those in the analysis/question, plus one step of arithmetic on them
  // (so "14% × 24 = 3.4" or "100% − 62% = 38%" pass, but made-up equities don't).
  function knownNumbers(text) {
    const base = [...new Set((text.match(/-?\d+(?:\.\d+)?/g) || []).map(Number))];
    const vals = new Set(base);
    for (const a of base) {
      vals.add(100 - a); vals.add(a / 100); vals.add(a * 100);
      for (const b of base) {
        vals.add(a + b); vals.add(a - b); vals.add(a * b); vals.add(a * b / 100);
        if (b) { vals.add(a / b); vals.add(100 * a / b); }
      }
    }
    const arr = [...vals].filter(Number.isFinite);
    return (n, tol) => arr.some(v => Math.abs(v - n) <= tol);
  }

  const validateTutor = (txt, facts, locked, question) => !tutorProblem(txt, facts, locked, question);

  PT.llm = {
    get enabled() { return enabledFor('coach'); },
    get opponentsEnabled() { return enabledFor('opp'); },
    get provider() { return settings.analysis; },
    get oppProvider() { return settings.opponents; },
    get providerLabel() { return cfgFor('coach') ? cfgFor('coach').label : 'Offline'; },
    get providers() { return Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label })); },
    // What the chosen providers still need, e.g. "Groq: add the API key", or null when ready.
    get setupProblem() {
      for (const c of [cfgFor('coach'), cfgFor('opp')]) if (c && c.missing) return `${c.label}: add the ${c.missing}`;
      return null;
    },
    get oppTimeoutMs() { return cfgFor('opp') ? cfgFor('opp').oppTimeoutMs : 12000; },
    get coachSharesQueue() { const a = cfgFor('coach'), o = cfgFor('opp'); return !!(a && o && a.serial && a.url === o.url); },
    get lastError() { return errors.coach || errors.opp; },
    get errors() { return { ...errors }; },
    get lastNoteProblem() { return lastNoteProblem; },
    configure, providerSettings, listModels, testProvider, setProvider, setOppProvider,
    decideForOpponent, explainDecision, tutorChat, validateExplanation, validateTutor
  };
})(window.PT = window.PT || {});
