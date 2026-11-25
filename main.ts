// Pump.fun Bot Sprint: Make Bot And Win (make.fun).
//
// A paper-trading bot for the agent-fun/replay/v2 harness: it trades 10 SOL
// of paper money on a replay of pump.fun bonding-curve activity. The
// strategy lives in strategy.ts; this file only wires it into the harness
// through the kit's SDK shim (vendor/makefun-bot.ts).
//
// The grader runs `node /bot/main.ts`. Node 22 runs this TypeScript as-is;
// there is no build step, no install step, and no network access at grade
// time. The bot reads one JSON line per batch from stdin (hello, then one
// batch per slot, then done) and writes exactly one reply line per batch.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
