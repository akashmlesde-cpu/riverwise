/* engine.js — No-Limit Texas Hold'em engine.
 * Owns the COMPLETE game state. Exposes:
 *   - state()        : full internal state (engine/AI use only)
 *   - playerView()   : what the human may see
 *   - coachView()    : what the coach may see (== playerView + tendencies, NO villain hole cards)
 * Coaching logic lives elsewhere and must only consume coachView().
 * The interface (newHand/legal/act/events) is variant-agnostic so PLO can slot in later.
 */
(function (PT) {
  class HoldemEngine {
    // cfg: { seats: [{name, archetype, isHero}], stackBB, sb, bb }
    constructor(cfg) {
      this.cfg = cfg;
      this.players = cfg.seats.map((s, i) => ({
        id: i, name: s.name, archetype: s.archetype, isHero: !!s.isHero,
        stack: cfg.stackBB, hole: [], folded: false, allIn: false,
        streetBet: 0, totalBet: 0, acted: false, lastAction: ''
      }));
      this.button = -1;
      this.handNo = 0;
      this.history = [];   // full action log for the hand
      this.listeners = {}; // event name -> [handler]
      this.over = false;
    }

    on(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    emit(type, data) { (this.listeners[type] || []).forEach(fn => fn(data)); }
    log(text) { this.history.push({ street: this.street, text }); this.emit('log', text); }

    livePlayers() { return this.players.filter(p => !p.folded); }
    canActPlayers() { return this.livePlayers().filter(p => !p.allIn); }
    pot() { return this.players.reduce((s, p) => s + p.totalBet, 0); }

    nextSeat(from, pred) {
      for (let x = 1; x <= this.players.length; x++) {
        const i = (from + x) % this.players.length;
        if (pred(this.players[i])) return i;
      }
      return -1;
    }

    positionName(i) {
      const n = this.players.length;
      if (i === this.button) return 'BTN';
      if (i === this.sbSeat) return 'SB';
      if (i === this.bbSeat) return 'BB';
      const off = (i - this.button + n) % n;
      if (n > 3 && off === 3) return 'UTG';
      if (n > 4 && off === 4) return 'UTG+1';
      if (off === n - 1) return 'CO';
      if (off === n - 2) return 'HJ';
      return 'MP';
    }

    newHand() {
      this.handNo++;
      this.deck = new PT.Deck();
      this.board = [];
      this.street = 'preflop';
      this.history = [];
      this.streetHistory = { preflop: [], flop: [], turn: [], river: [] };
      this.currentBet = 0;
      this.minRaise = this.cfg.bb;
      this.over = false;
      this.showdown = null;

      for (const p of this.players) {
        p.hole = []; p.folded = p.stack <= 0; p.allIn = p.stack <= 0;
        p.streetBet = 0; p.totalBet = 0; p.acted = false; p.lastAction = '';
      }

      // Move button to next player with chips.
      this.button = this.nextSeat(this.button, p => p.stack > 0);
      const headsUp = this.players.filter(p => p.stack > 0).length === 2;
      this.sbSeat = headsUp ? this.button : this.nextSeat(this.button, p => p.stack > 0);
      this.bbSeat = this.nextSeat(this.sbSeat, p => p.stack > 0);

      // Deal 2 cards each, starting left of button (dealing order irrelevant to fairness, kept for realism).
      for (let r = 0; r < 2; r++)
        for (let x = 1; x <= this.players.length; x++) {
          const i = (this.button + x) % this.players.length;
          if (this.players[i].stack > 0) this.players[i].hole.push(this.deck.draw());
        }

      this.post(this.sbSeat, this.cfg.sb, 'small blind');
      this.post(this.bbSeat, this.cfg.bb, 'big blind');
      this.currentBet = Math.max(...this.players.map(p => p.streetBet));
      this.minRaise = this.cfg.bb;

      this.log(`Hand #${this.handNo} — blinds ${this.cfg.sb}/${this.cfg.bb} BB. Button: ${this.players[this.button].name}.`);
      // Preflop action starts left of BB.
      this.current = this.nextSeat(this.bbSeat, p => !p.folded && !p.allIn);
      this.emit('hand', this.playerView());
      this.emit('turn', this.current);
    }

    post(i, amt, label) {
      const p = this.players[i];
      const paid = Math.min(p.stack, amt);
      p.stack -= paid; p.streetBet += paid; p.totalBet += paid;
      if (p.stack <= 0) p.allIn = true;
      p.lastAction = `posts ${label} ${paid}`;
      this.log(`${p.name} posts ${label} ${paid} BB.`);
    }

    // Legal actions for seat i. betTo = total street bet target.
    legal(i) {
      const p = this.players[i];
      const toCall = Math.max(0, this.currentBet - p.streetBet);
      const canCheck = toCall === 0;
      const canCall = toCall > 0 && p.stack > 0;
      const minBetTo = this.currentBet === 0
        ? Math.min(this.cfg.bb, p.streetBet + p.stack)
        : Math.min(this.currentBet + this.minRaise, p.streetBet + p.stack);
      const maxBetTo = p.streetBet + p.stack;
      const canBetRaise = p.stack > toCall && maxBetTo > this.currentBet;
      return {
        canFold: toCall > 0, canCheck, canCall,
        toCall: Math.min(toCall, p.stack),
        canBetRaise, minBetTo, maxBetTo,
        pot: this.pot(),
        effectiveStack: Math.min(...this.livePlayers().map(q => q.stack + q.streetBet))
      };
    }

    // action: 'fold' | 'check' | 'call' | 'bet' | 'raise' ; betTo required for bet/raise.
    // Returns { ok, error? } — illegal actions are rejected, never silently mutated.
    act(i, action, betTo) {
      if (this.over) return { ok: false, error: 'Hand is over.' };
      if (i !== this.current) return { ok: false, error: 'Not your turn.' };
      const p = this.players[i];
      const L = this.legal(i);

      if (action === 'fold') {
        if (!L.canFold && L.canCheck) return { ok: false, error: 'You can check — folding costs nothing.' };
        p.folded = true; p.lastAction = 'folds';
        this.log(`${p.name} folds.`);
      } else if (action === 'check') {
        if (!L.canCheck) return { ok: false, error: `Cannot check — ${L.toCall} BB to call.` };
        p.lastAction = 'checks';
        this.log(`${p.name} checks.`);
      } else if (action === 'call') {
        if (!L.canCall) return { ok: false, error: 'Nothing to call.' };
        const amt = Math.round(Math.min(L.toCall, p.stack) * 100) / 100;
        p.stack = Math.round((p.stack - amt) * 100) / 100;
        p.streetBet = Math.round((p.streetBet + amt) * 100) / 100;
        p.totalBet = Math.round((p.totalBet + amt) * 100) / 100;
        if (p.stack <= 0) p.allIn = true;
        p.lastAction = p.allIn ? `calls ${amt} (all-in)` : `calls ${amt}`;
        this.log(`${p.name} calls ${amt} BB${p.allIn ? ' and is all-in' : ''}.`);
      } else if (action === 'bet' || action === 'raise') {
        if (!L.canBetRaise) return { ok: false, error: 'Cannot bet/raise here.' };
        const target = Math.round(betTo * 100) / 100;
        if (target < L.minBetTo - 1e-9 && target < L.maxBetTo - 1e-9)
          return { ok: false, error: `Minimum is ${L.minBetTo} BB.` };
        const to = Math.min(target, L.maxBetTo);
        const verb = this.currentBet > 0 ? 'raises to' : 'bets';
        const put = Math.round((to - p.streetBet) * 100) / 100;
        const raiseBy = to - this.currentBet;
        const isFullRaise = this.currentBet === 0 ? to >= this.cfg.bb : raiseBy >= this.minRaise;
        p.stack = Math.round((p.stack - put) * 100) / 100;
        p.streetBet = to;
        p.totalBet = Math.round((p.totalBet + put) * 100) / 100;
        if (p.stack <= 0) p.allIn = true;
        if (isFullRaise) {
          this.minRaise = this.currentBet === 0 ? to : raiseBy;
          this.currentBet = to;
          // Full raise reopens action: everyone else must act again.
          for (const q of this.players) if (q !== p) q.acted = q.folded || q.allIn;
        } else {
          this.currentBet = Math.max(this.currentBet, to); // all-in below min-raise
        }
        p.lastAction = `${verb} ${to}${p.allIn ? ' (all-in)' : ''}`;
        this.log(`${p.name} ${verb} ${to} BB${p.allIn ? ' and is all-in' : ''}.`);
      } else {
        return { ok: false, error: 'Unknown action.' };
      }
      p.acted = true;
      this.emit('action', { seat: i, action, player: p.name });
      this.advance();
      return { ok: true };
    }

    advance() {
      const live = this.livePlayers();
      if (live.length === 1) { this.winUncontested(live[0]); return; }

      const actors = this.canActPlayers();
      const roundDone = actors.every(p => p.acted && Math.abs(p.streetBet - this.currentBet) < 1e-9);

      if (!roundDone) {
        this.current = this.nextSeat(this.current, p => !p.folded && !p.allIn && (!p.acted || p.streetBet < this.currentBet));
        if (this.current === -1) { this.nextStreet(); return; }
        this.emit('turn', this.current);
        return;
      }
      this.nextStreet();
    }

    nextStreet() {
      for (const p of this.players) { p.streetBet = 0; p.acted = p.folded || p.allIn; }
      this.currentBet = 0; this.minRaise = this.cfg.bb;

      const order = ['preflop', 'flop', 'turn', 'river'];
      const nextIdx = order.indexOf(this.street) + 1;
      if (nextIdx >= order.length) { this.runShowdown(); return; }

      this.street = order[nextIdx];
      const deal = this.street === 'flop' ? 3 : 1;
      for (let d = 0; d < deal; d++) this.board.push(this.deck.draw());
      this.log(`${this.street.toUpperCase()}: ${this.board.map(c => c.id).join(' ')}`);
      this.emit('street', this.street);

      // If ≤1 player can act (everyone else all-in), keep dealing out.
      if (this.canActPlayers().length <= 1) { this.nextStreet(); return; }

      this.current = this.nextSeat(this.button, p => !p.folded && !p.allIn);
      this.emit('turn', this.current);
    }

    // Side pot construction from totalBet contributions.
    // Classic layer-cake: sort contribution levels, each level forms a pot
    // contested by everyone who contributed at least that much and didn't fold.
    buildPots() {
      const levels = [...new Set(this.players.filter(p => p.totalBet > 0).map(p => p.totalBet))]
        .sort((a, b) => a - b);
      const pots = [];
      let prev = 0;
      for (const level of levels) {
        let amount = 0;
        for (const p of this.players) amount += Math.min(p.totalBet, level) - Math.min(p.totalBet, prev);
        const eligible = this.players.filter(p => !p.folded && p.totalBet >= level).map(p => p.id);
        if (amount > 0 && eligible.length) pots.push({ amount: Math.round(amount * 100) / 100, eligible });
        prev = level;
      }
      return pots;
    }

    winUncontested(winner) {
      const total = Math.round(this.pot() * 100) / 100;
      winner.stack += total;
      winner.stack = Math.round(winner.stack * 100) / 100;
      this.over = true;
      this.log(`${winner.name} wins ${total} BB uncontested.`);
      this.emit('done', { winners: [winner.id], pot: total, showdown: false });
    }

    runShowdown() {
      const live = this.livePlayers();
      const ranks = {};
      for (const p of live) ranks[p.id] = PT.eval.bestHand([...p.hole, ...this.board]);

      const pots = this.buildPots();
      const winnings = {};
      const detail = [];
      for (const pot of pots) {
        let best = null, winners = [];
        for (const id of pot.eligible) {
          const r = ranks[id];
          const cmp = best ? PT.eval.compareRank(r, best) : 1;
          if (cmp > 0) { best = r; winners = [id]; }
          else if (cmp === 0) winners.push(id);
        }
        const share = Math.floor((pot.amount / winners.length) * 100) / 100;
        for (const id of winners) {
          winnings[id] = (winnings[id] || 0) + share;
          this.players[id].stack = Math.round((this.players[id].stack + share) * 100) / 100;
        }
        detail.push({ amount: pot.amount, winners, hand: PT.eval.HAND_NAMES[best[0]] });
      }
      for (const p of live)
        this.log(`${p.name} shows ${p.hole.map(c => c.id).join(' ')} — ${PT.eval.HAND_NAMES[ranks[p.id][0]]}.`);
      // Merge per-pot win lines into one line per winner with breakdown (#8).
      const byWinner = {};
      for (const d of detail)
        for (const id of d.winners) {
          byWinner[id] = byWinner[id] || { total: 0, parts: [], hand: d.hand };
          byWinner[id].total += d.amount;
          byWinner[id].parts.push(`${d.amount} BB (${d.hand})`);
        }
      for (const [id, w] of Object.entries(byWinner)) {
        const total = Math.round(w.total * 100) / 100;
        this.log(`${this.players[id].name} wins ${total} BB${w.parts.length > 1 ? ' — ' + w.parts.join(' + ') : ` with ${w.hand}`}.`);
      }

      this.over = true;
      this.showdown = { ranks, detail, winnings };
      this.emit('done', { winners: Object.keys(winnings).map(Number), pot: this.pot(), showdown: true, detail });
    }

    /* ---------- information-isolated views ---------- */

    // What the human at the table can legitimately see.
    playerView() {
      return {
        handNo: this.handNo, street: this.street, board: this.board.slice(),
        pot: this.pot(), currentBet: this.currentBet, minRaise: this.minRaise,
        button: this.button, sbSeat: this.sbSeat, bbSeat: this.bbSeat, current: this.current,
        players: this.players.map(p => ({
          id: p.id, name: p.name, archetype: p.archetype, isHero: p.isHero,
          stack: p.stack, streetBet: p.streetBet, totalBet: p.totalBet,
          folded: p.folded, allIn: p.allIn, lastAction: p.lastAction,
          // hole cards only for hero, or revealed at showdown
          hole: (p.isHero || (this.over && this.showdown)) && !p.folded ? p.hole.slice() : null
        })),
        history: this.history.slice(),
        over: this.over, showdown: this.showdown
      };
    }

    // Coach view: identical to player view + opponent archetype/tendency labels.
    // Deliberately built FROM playerView so hidden cards can never leak.
    coachView() {
      const v = this.playerView();
      v.opponentProfiles = this.players
        .filter(p => !p.isHero)
        .map(p => ({ id: p.id, name: p.name, archetype: p.archetype }));
      return v;
    }
  }

  PT.HoldemEngine = HoldemEngine;
})(window.PT = window.PT || {});
