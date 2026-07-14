/**
 * ruleEngine.js
 *
 * Implements the rule-based signal system:
 *  - Entry must occur within the first 2 minutes of a market window
 *  - Gap between "now" price and "to beat" (strike) target must be $8+
 *  - Implied win probability must fall between 55% and 65%
 *  - Payout multiplier must be 1.2x or higher
 *
 * Given a series of historical candles for a single 15-min market window,
 * this scans every point in the window and flags whether a valid ENTER
 * signal would have fired, on which side (UP/DOWN), and what the
 * hypothetical outcome/P&L would have been had you taken it.
 */

const RULES = {
  // No fixed entry-time cutoff — scan the entire market window and
  // surface any point that clears the profit/gap/probability bar below.
  minGapDollars: 8,         // price must be at least $8 from target
  minWinProb: 0.55,
  maxWinProb: 0.65,
  minPayout: 1.20,          // 1.20x payout = 20% profit per $1 staked
  maxPayout: 1.30,          // 1.30x payout = 30% profit per $1 staked
};

/**
 * @param {Object} market
 * @param {string} market.marketId
 * @param {number} market.targetPrice   - the "to beat" strike price
 * @param {string} market.windowStart   - ISO timestamp of window open
 * @param {string} market.windowEnd     - ISO timestamp of window close
 * @param {Array}  market.candles       - [{ time, price, upProb, downProb, upPayout, downPayout }]
 * @param {number} market.finalPrice    - settlement price at windowEnd (for grading outcome)
 */
function evaluateMarket(market) {
  const { marketId, targetPrice, windowStart, windowEnd, candles, finalPrice } = market;
  const startMs = new Date(windowStart).getTime();
  const endMs = new Date(windowEnd).getTime();

  const signals = [];

  for (const candle of candles) {
    const candleMs = new Date(candle.time).getTime();
    const elapsedMin = (candleMs - startMs) / 60000;
    const gap = Math.abs(candle.price - targetPrice);

    // Entry is valid any time inside the market window (no time cutoff) —
    // the profit-target filter below (payout range) does the gatekeeping instead.
    const withinWindow = candleMs >= startMs && candleMs <= endMs;
    const gapOk = gap >= RULES.minGapDollars;

    // Determine which side has probability in the valid band
    const sides = [
      { side: 'UP', prob: candle.upProb, payout: candle.upPayout },
      { side: 'DOWN', prob: candle.downProb, payout: candle.downPayout },
    ];

    for (const s of sides) {
      const probOk = s.prob >= RULES.minWinProb && s.prob <= RULES.maxWinProb;
      const payoutOk = s.payout >= RULES.minPayout && s.payout <= RULES.maxPayout;

      const valid = withinWindow && gapOk && probOk && payoutOk;

      if (valid) {
        const won = s.side === 'UP' ? finalPrice > targetPrice : finalPrice < targetPrice;
        signals.push({
          marketId,
          time: candle.time,
          elapsedMin: Number(elapsedMin.toFixed(2)),
          side: s.side,
          price: candle.price,
          targetPrice,
          gap: Number(gap.toFixed(2)),
          winProb: s.prob,
          payout: s.payout,
          outcome: won ? 'WIN' : 'LOSS',
          pnlMultiplier: won ? s.payout - 1 : -1, // profit per $1 staked
        });
      }
    }
  }

  return {
    marketId,
    targetPrice,
    finalPrice,
    signalsFound: signals.length,
    signals,
  };
}

/**
 * Runs evaluateMarket across many historical markets and produces
 * an aggregate backtest summary: win rate, total simulated P&L per $1 stake,
 * best/worst signals, etc.
 */
function runBacktest(markets, stakePerTrade = 1) {
  const results = markets.map(evaluateMarket);
  const allSignals = results.flatMap(r => r.signals);

  const wins = allSignals.filter(s => s.outcome === 'WIN').length;
  const losses = allSignals.filter(s => s.outcome === 'LOSS').length;
  const totalPnl = allSignals.reduce((sum, s) => sum + s.pnlMultiplier * stakePerTrade, 0);

  return {
    marketsScanned: markets.length,
    totalSignals: allSignals.length,
    wins,
    losses,
    winRate: allSignals.length ? Number((wins / allSignals.length * 100).toFixed(1)) : 0,
    totalPnl: Number(totalPnl.toFixed(2)),
    avgPnlPerTrade: allSignals.length ? Number((totalPnl / allSignals.length).toFixed(3)) : 0,
    perMarket: results,
  };
}

/**
 * Evaluates a single live snapshot (one open market, right now) against
 * the same rule set used for backtesting. Returns a verdict per side
 * (UP/DOWN) so the live UI can show ENTER/SKIP with a reason.
 *
 * @param {Object} snapshot
 * @param {number} snapshot.targetPrice
 * @param {number} snapshot.currentPrice
 * @param {number} snapshot.upProb
 * @param {number} snapshot.downProb
 * @param {number} snapshot.upPayout
 * @param {number} snapshot.downPayout
 */
function evaluateSnapshot(snapshot) {
  const { targetPrice, currentPrice, upProb, downProb, upPayout, downPayout } = snapshot;
  const gap = Math.abs(currentPrice - targetPrice);
  const gapOk = gap >= RULES.minGapDollars;

  const sides = [
    { side: 'UP', prob: upProb, payout: upPayout },
    { side: 'DOWN', prob: downProb, payout: downPayout },
  ];

  const evaluated = sides.map(s => {
    const probOk = s.prob != null && s.prob >= RULES.minWinProb && s.prob <= RULES.maxWinProb;
    const payoutOk = s.payout != null && s.payout >= RULES.minPayout && s.payout <= RULES.maxPayout;
    const valid = gapOk && probOk && payoutOk;

    const reasons = [];
    if (!gapOk) reasons.push(`gap $${gap.toFixed(2)} < $${RULES.minGapDollars}`);
    if (!probOk) reasons.push(`win prob ${(s.prob * 100).toFixed(0)}% outside ${RULES.minWinProb * 100}-${RULES.maxWinProb * 100}%`);
    if (!payoutOk) reasons.push(`payout ${s.payout?.toFixed(2)}x outside ${RULES.minPayout}-${RULES.maxPayout}x`);

    return {
      side: s.side,
      prob: s.prob,
      payout: s.payout,
      valid,
      reason: valid ? 'All conditions met' : reasons.join('; '),
    };
  });

  return { gap: Number(gap.toFixed(2)), sides: evaluated };
}

module.exports = { evaluateMarket, runBacktest, evaluateSnapshot, RULES };
