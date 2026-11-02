/* stats.js — session analytics for the hero. */
(function (PT) {
  class SessionStats {
    constructor() { this.reset(); }
    reset() {
      this.hands = 0;
      this.vpipN = 0; this.vpipD = 0;     // voluntary $ preflop / opportunities
      this.pfrN = 0; this.pfrD = 0;
      this.threeBetN = 0; this.threeBetD = 0;
      this.foldToBetN = 0; this.foldToBetD = 0;
      this.aggrActs = 0; this.passiveActs = 0;
      this.cbetN = 0; this.cbetD = 0;
      this.showdowns = 0; this.showdownWins = 0;
      this.mistakes = [];                  // {handNo, street, label, evLoss, summary}
      this.evLost = 0;
      this.gradeCounts = {};
    }
    vpip() { return this.vpipD ? this.vpipN / this.vpipD : 0; }
    pfr() { return this.pfrD ? this.pfrN / this.pfrD : 0; }
    threeBet() { return this.threeBetD ? this.threeBetN / this.threeBetD : 0; }
    foldToBet() { return this.foldToBetD ? this.foldToBetN / this.foldToBetD : 0; }
    aggFactor() { return this.passiveActs ? this.aggrActs / this.passiveActs : this.aggrActs; }
    cbet() { return this.cbetD ? this.cbetN / this.cbetD : 0; }

    recordDecision(verdict, handNo, street) {
      this.gradeCounts[verdict.label] = (this.gradeCounts[verdict.label] || 0) + 1;
      if (verdict.evLoss > 3) {
        this.mistakes.push({ handNo, street, label: verdict.label, evLoss: verdict.evLoss, summary: verdict.lines[0] });
        this.evLost += verdict.evLoss;
      }
    }

    report() {
      const weaknesses = [];
      if (this.hands >= 15) {
        if (this.vpip() > 0.4) weaknesses.push('Playing too many hands preflop (VPIP high) — tighten early positions.');
        if (this.vpip() < 0.15) weaknesses.push('Too tight (VPIP low) — you\'re folding playable hands in position.');
        if (this.pfr() < this.vpip() * 0.4) weaknesses.push('Too much calling, not enough raising preflop — prefer raise-or-fold.');
        if (this.foldToBet() > 0.65) weaknesses.push('Over-folding to bets — learn MDF and defend wider vs small bets.');
        if (this.cbetD >= 8 && this.cbet() > 0.85) weaknesses.push('C-betting near 100% — check back some flops that favor the caller.');
        if (this.cbetD >= 8 && this.cbet() < 0.25) weaknesses.push('Rarely c-betting — you\'re giving up fold equity you earned as the raiser.');
      }
      const big = this.mistakes.filter(m => m.label.includes('blunder')).length;
      if (big) weaknesses.push(`${big} blunder(s) this session — review them in the Hands tab.`);
      if (!weaknesses.length) weaknesses.push('No major leaks detected yet — play more hands for a reliable read.');
      return {
        headline: `${this.hands} hands · est. EV lost to mistakes: ${this.evLost.toFixed(1)} BB`,
        weaknesses,
        gradeCounts: this.gradeCounts
      };
    }
  }

  PT.SessionStats = SessionStats;
})(window.PT = window.PT || {});
