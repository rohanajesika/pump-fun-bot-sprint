# pump-fun-bot-sprint

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rohanajesika/pump-fun-bot-sprint/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rohanajesika/pump-fun-bot-sprint/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

An ignition paper-trading bot for pump.fun-style Solana markets, built for make.fun's "Pump.fun Bot Sprint: Make Bot And Win" bounty. It trades 10 SOL of paper money on a replay of pump.fun bonding-curve activity, ranked on net PnL — no real money, no real SOL, no coin launch.

## Strategy

Fresh pump.fun curves either ignite or die within minutes. The bot buys only an ignition it can see on the tape — demand accelerating into the curve, spread across many distinct buyers, price rising without going vertical — then refuses to fall in love with the position:

- **Entry:** fresh curve (age ≥ 30 slots), real SOL reserve 1.5–8 SOL, net buy flow ≥ 0.5 SOL, ≥ 8 buys from ≥ 10 distinct buyers in a 180-slot window, price +5% to +50% and at least 85% of its window high, no single buyer over 70% of buy flow, and buy flow accelerating into the second half of the window.
- **Size:** 0.02 SOL first buy, one 0.03 SOL pyramid add only into strength (real SOL grown 1.5× since entry), max 0.06 SOL per coin, max 5 open positions.
- **Exits:** 12% stop-loss, 4× take-profit, trailing stop armed at 1.6× (sell below 60% of peak), 2400-slot max hold, stall exit (below 1.15× after 300 slots), and a fade exit on heavy recent net selling.
- **Discipline:** one entry per curve ever; after any sell the curve is done for good. Fully deterministic — no clock, no environment, no randomness — so two runs on the same replay produce the same action log.

## Run it

```sh
node main.ts
```

The harness feeds the bot one JSON line per batch on stdin (`hello`, then one `batch` per slot, then `done`) and the bot replies with one line of orders per batch. Node 22 runs the TypeScript as-is; there is no build step and no network access at grade time. `vendor/makefun-bot.ts` is the kit's SDK shim, copied byte-identical from the competition kit.

## Local grading

With the competition kit unpacked, grade the bot on the dev window the way the server does:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=ronasika&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
