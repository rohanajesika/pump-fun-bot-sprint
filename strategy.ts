// Ignition paper bot for the pump.fun replay (agent-fun/replay/v2).
//
// Idea: fresh pump.fun curves either ignite or die within minutes. This bot
// only buys an ignition it can see on the tape — demand accelerating into the
// curve, spread across many distinct buyers, price rising without going
// vertical — and then it refuses to fall in love with the position: a tight
// stop caps every loser, a stall rule exits flat positions quickly, a
// trailing stop banks runners, and a hard take-profit plus a short maximum
// hold keep the book turning over. Stakes are small (0.02 SOL) and the bot
// cycles through many coins, because the final window is only 6 hours and a
// paid place needs round trips on at least 20 distinct coins.
//
// Everything here is deterministic: no clock, no environment, no randomness.
// Decisions use only slot numbers and the trade tape the harness delivers,
// so two runs on the same data produce the same action log.
//
// Risk rules the bot enforces on itself, on top of the harness caps:
//   - at most 5 open positions (harness cap), at most 0.04 SOL per coin
//   - every buy is at least 0.01 SOL (the guardrail's minimum round trip)
//   - sells are always whole positions, at wide slippage, so exits fill
//   - a curve is entered at most once: after any sell it is done for good

import type {
  Batch,
  Bot,
  BotState,
  OrderInput,
  Pubkey,
} from './vendor/makefun-bot.ts';
import { LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';

const SOL = (n: number): bigint => BigInt(Math.round(n * 1e9));

// ------------------------------------------------------------------ params
export interface Params {
  /** Lookback for the entry window, in slots. */
  windowSlots: number;
  /** Minimum slots since the CreateEvent before an entry is allowed. */
  minAgeSlots: number;
  /** Real SOL reserve band a curve must sit in at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Net buy SOL (buys minus sells) inside the window. */
  minNetBuySol: number;
  /** Buy trades inside the window. */
  minBuys: number;
  /** Distinct buying wallets inside the window. */
  minBuyers: number;
  /** Price rise inside the window, as a fraction (0.03 = +3%). */
  minPriceUp: number;
  /** Same, upper bound: skip curves that already ran vertical. */
  maxPriceUp: number;
  /** Price now must be at least this share of the window high. */
  minNearHigh: number;
  /** Largest single buyer's share of the window's buy SOL. */
  maxBuyerShare: number;
  /** Buy SOL in the window's second half must be at least this multiple of
   *  the first half's: demand must be accelerating, not fading. */
  accelRatio: number;
  /** SOL for the first buy, for a pyramid add, and the per-coin total. */
  firstBuySol: number;
  addBuySol: number;
  maxPerCoinSol: number;
  /** Slippage allowed on buys, in bps. Sells always go out wide open. */
  buySlippageBps: number;
  /** Sell everything when the mark falls to this share of cost. */
  stopLoss: number;
  /** Arm the trailing stop once the mark reaches this multiple of cost. */
  trailArm: number;
  /** Once armed, sell when the mark falls to this share of its peak. */
  trailDrop: number;
  /** Sell everything at this multiple of cost. */
  takeProfit: number;
  /** Sell everything after this many slots held. */
  maxHoldSlots: number;
  /** Sell a flat position held longer than this many slots. */
  stallSlots: number;
  /** ...when its mark is still below this multiple of cost. */
  stallMark: number;
  /** Sell a flat-or-losing position when the recent net SOL falls below this. */
  fadeNetSol: number;
  /** Recent window (slots) for the fade check. */
  fadeWindowSlots: number;
  /** Real SOL must grow by at least this multiple from the first buy before an add. */
  addRqMultiple: number;
}

export const DEFAULT_PARAMS: Params = {
  windowSlots: 180,
  minAgeSlots: 30,
  minRqSol: 1.5,
  maxRqSol: 8.0,
  minNetBuySol: 0.5,
  minBuys: 8,
  minBuyers: 10,
  minPriceUp: 0.05,
  maxPriceUp: 0.5,
  minNearHigh: 0.85,
  maxBuyerShare: 0.7,
  accelRatio: 1.2,
  firstBuySol: 0.02,
  addBuySol: 0.03,
  maxPerCoinSol: 0.06,
  buySlippageBps: 2000,
  stopLoss: 0.88,
  trailArm: 1.6,
  trailDrop: 0.6,
  takeProfit: 4.0,
  maxHoldSlots: 2400,
  stallSlots: 300,
  stallMark: 1.15,
  fadeNetSol: -0.2,
  fadeWindowSlots: 120,
  addRqMultiple: 1.5,
};

// ------------------------------------------------------------------ tape
interface TapeTrade {
  slot: number;
  price: number;
  buy: boolean;
  sol: number;
  user: string;
}

interface Tape {
  mint: Pubkey;
  createdSlot: number | null;
  trades: TapeTrade[];
  lastSlot: number;
  /** Real SOL reserve at the latest trade seen. */
  lastRqSol: number;
  /** Real SOL reserve when the first buy filled (for pyramid rungs). */
  entryRqSol: number;
  /** Buy fills so far on this curve (first buy + adds). */
  buyFills: number;
  /** Best mark-to-cost multiple seen while holding. */
  peakMark: number;
  /** Slot the current position opened (first buy fill). */
  openedSlot: number;
  /** True once this curve has been sold out of and may not be re-entered. */
  done: boolean;
}

interface WindowStats {
  buySol: number;
  sellSol: number;
  buys: number;
  buyers: Set<string>;
  startPrice: number;
  endPrice: number;
  highPrice: number;
  topBuyerSol: number;
  /** Buy SOL in the first / second half of the window. */
  firstHalfBuySol: number;
  secondHalfBuySol: number;
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();

  function tapeFor(mint: Pubkey): Tape {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        mint,
        createdSlot: null,
        trades: [],
        lastSlot: -1,
        lastRqSol: 0,
        entryRqSol: 0,
        buyFills: 0,
        peakMark: 0,
        openedSlot: -1,
        done: false,
      };
      tapes.set(mint, t);
    }
    return t;
  }

  function windowStats(t: Tape, slot: number): WindowStats {
    const from = slot - params.windowSlots;
    const mid = from + params.windowSlots / 2;
    const s: WindowStats = {
      buySol: 0,
      sellSol: 0,
      buys: 0,
      buyers: new Set<string>(),
      startPrice: 0,
      endPrice: 0,
      highPrice: 0,
      topBuyerSol: 0,
      firstHalfBuySol: 0,
      secondHalfBuySol: 0,
    };
    const perBuyer = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot < from) continue;
      if (s.startPrice === 0) s.startPrice = tr.price;
      s.endPrice = tr.price;
      if (tr.price > s.highPrice) s.highPrice = tr.price;
      if (tr.buy) {
        s.buySol += tr.sol;
        s.buys += 1;
        s.buyers.add(tr.user);
        if (tr.slot < mid) s.firstHalfBuySol += tr.sol;
        else s.secondHalfBuySol += tr.sol;
        const tot = (perBuyer.get(tr.user) ?? 0) + tr.sol;
        perBuyer.set(tr.user, tot);
        if (tot > s.topBuyerSol) s.topBuyerSol = tot;
      } else {
        s.sellSol += tr.sol;
      }
    }
    return s;
  }

  /** Net buy SOL over the last `slots` slots of this curve's tape. */
  function recentNetSol(t: Tape, slot: number, slots: number): number {
    const from = slot - slots;
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i -= 1) {
      const tr = t.trades[i]!;
      if (tr.slot < from) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  }

  function entrySignal(t: Tape, slot: number): boolean {
    if (t.done || t.createdSlot === null) return false;
    if (slot - t.createdSlot < params.minAgeSlots) return false;
    if (t.lastRqSol < params.minRqSol || t.lastRqSol > params.maxRqSol) return false;
    const w = windowStats(t, slot);
    if (w.buySol - w.sellSol < params.minNetBuySol) return false;
    if (w.buys < params.minBuys) return false;
    if (w.buyers.size < params.minBuyers) return false;
    if (w.buySol > 0 && w.topBuyerSol / w.buySol > params.maxBuyerShare) return false;
    if (w.startPrice <= 0 || w.endPrice <= 0) return false;
    const up = w.endPrice / w.startPrice - 1;
    if (up < params.minPriceUp || up > params.maxPriceUp) return false;
    if (w.highPrice > 0 && w.endPrice / w.highPrice < params.minNearHigh) return false;
    // Acceleration: the second half of the window must carry at least as
    // much buy SOL as the first half — demand arriving, not leaving.
    if (w.secondHalfBuySol < w.firstHalfBuySol * params.accelRatio) return false;
    return true;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const slot = batch.slot;
      const orders: OrderInput[] = [];
      const touched = new Set<Pubkey>();

      // Fold this batch's events into the tapes. Only curves that traded in
      // this batch can change their entry signal, so entries are decided
      // from that set alone; exits are checked for every held position.
      // hello, batch, orders, slot: the harness speaks in batches per slot.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const t = tapeFor(e.mint);
          t.createdSlot = e.slot;
          continue;
        }
        if (e.event === 'CompleteEvent') {
          const t = tapes.get(e.mint);
          if (t !== undefined) t.done = true;
          continue;
        }
        if (e.event !== 'TradeEvent') continue;
        const t = tapeFor(e.mint);
        const price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        t.trades.push({
          slot: e.slot,
          price,
          buy: e.is_buy,
          sol: Number(BigInt(e.sol_amount)) / 1e9,
          user: e.user,
        });
        t.lastSlot = e.slot;
        t.lastRqSol = Number(BigInt(e.real_quote_reserves)) / 1e9;
        touched.add(e.mint);
      }

      // Prune tape trades older than the window, for curves touched here.
      // (Pruning is lazy and bounded: only touched curves, only old trades.)
      for (const mint of touched) {
        const t = tapes.get(mint);
        if (t === undefined) continue;
        const from = slot - params.windowSlots;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut].slot < from) cut += 1;
        if (cut > 0) t.trades.splice(0, cut);
      }

      // Learn from fills: a buy that landed opens (or adds to) a position;
      // a sell that landed closes the curve for good.
      for (const f of batch.fills) {
        if (f.status !== 'filled') continue;
        const t = tapes.get(f.mint);
        if (t === undefined) continue;
        if (f.side === 'buy') {
          t.buyFills += 1;
          if (t.openedSlot < 0) {
            t.openedSlot = slot;
            t.entryRqSol = t.lastRqSol;
            t.peakMark = 0;
          }
        } else if (f.side === 'sell') {
          t.done = true;
          t.openedSlot = -1;
          t.peakMark = 0;
        }
      }

      const txFee = state.txFeeLamports();
      let free = state.freeCashLamports();
      let slots = state.hello.caps.max_open_positions - state.committedPositionCount();
      const maxOrders = state.hello.caps.max_orders_per_batch;

      // ---- exits first: free a position slot before deciding new entries.
      for (const [mint, holding] of state.positions) {
        if (orders.length >= maxOrders) break;
        // A sell is already on its way for this mint: do not send another —
        // the first fill takes the tokens and a duplicate is rejected.
        const pendingSell = [...state.pending.values()].some(
          (p) => p.order.side === 'sell' && p.order.mint === mint,
        );
        if (pendingSell) continue;
        const curve = state.curves.get(mint);
        const t = tapes.get(mint);
        if (curve === undefined || curve.complete) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price <= 0) continue;
        const cost = Number(holding.cost_lamports) / 1e9;
        const mark = (Number(holding.token_amount) * price) / 1e9;
        if (cost <= 0) continue;
        const mult = mark / cost;
        if (t !== undefined && mult > t.peakMark) t.peakMark = mult;

        let exit = false;
        if (mult < params.stopLoss) exit = true; // hard stop: cap the loser
        else if (mult >= params.takeProfit) exit = true; // bank the runner
        else if (
          t !== undefined &&
          t.peakMark >= params.trailArm &&
          mult < t.peakMark * params.trailDrop
        ) {
          exit = true; // trailing stop: gave back too much of the run
        } else if (
          t !== undefined &&
          t.openedSlot >= 0 &&
          slot - t.openedSlot > params.maxHoldSlots
        ) {
          exit = true; // overstayed: time exit
        } else if (
          t !== undefined &&
          t.openedSlot >= 0 &&
          slot - t.openedSlot > params.stallSlots &&
          mult < params.stallMark
        ) {
          exit = true; // stalled flat: free the slot for a fresh ignition
        } else if (t !== undefined) {
          // Fade: heavy net selling lately while flat or losing — leave early.
          const net = recentNetSol(t, slot, params.fadeWindowSlots);
          if (net < params.fadeNetSol && mult < 1.05) exit = true;
        }
        if (!exit) continue;
        if (free < txFee) continue;
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: 10_000,
        });
        free -= txFee;
        // NOTE: no slots += 1 here — the position still counts against the
        // open-position cap until the sell fill lands two slots later, so a
        // buy decided in this same batch could not use the slot anyway.
      }

      // ---- entries and pyramid adds, in the batch's own event order.
      for (const mint of touched) {
        if (orders.length >= maxOrders || slots <= 0) break;
        const t = tapes.get(mint);
        const curve = state.curves.get(mint);
        if (t === undefined || curve === undefined || curve.complete) continue;
        const holding = state.positions.get(mint);
        const pendingBuy = [...state.pending.values()].some(
          (p) => p.order.side === 'buy' && p.order.mint === mint,
        );
        if (pendingBuy) continue;

        if (holding === undefined) {
          // Fresh entry: signal must hold now, and the size cap must allow
          // at least the minimum round trip.
          if (!entrySignal(t, slot)) continue;
          const cap = state.maxBuyLamports(mint);
          const amount = SOL(params.firstBuySol);
          if (cap < amount || free < amount + txFee) continue;
          orders.push({
            side: 'buy',
            mint,
            quote_lamports: amount,
            max_slippage_bps: params.buySlippageBps,
          });
          free -= amount + txFee;
          slots -= 1;
        } else if (t.buyFills < 2) {
          // Pyramid add: only into strength, once, and only while the
          // curve's real SOL has grown since the first buy.
          const spent = Number(holding.cost_lamports) / 1e9;
          if (spent >= params.maxPerCoinSol) continue;
          if (t.entryRqSol <= 0 || t.lastRqSol < t.entryRqSol * params.addRqMultiple) continue;
          if (!entrySignal(t, slot)) continue;
          const cap = state.maxBuyLamports(mint);
          const amount = SOL(params.addBuySol);
          if (cap < amount || free < amount + txFee) continue;
          orders.push({
            side: 'buy',
            mint,
            quote_lamports: amount,
            max_slippage_bps: params.buySlippageBps,
          });
          free -= amount + txFee;
        }
      }

      // Drop tapes for curves long quiet, unheld and untraded: bounds memory
      // over a long window without touching anything the bot still needs.
      if (tapes.size > 4000) {
        for (const [mint, t] of tapes) {
          if (
            slot - t.lastSlot > 3600 &&
            !state.positions.has(mint) &&
            t.openedSlot < 0
          ) {
            tapes.delete(mint);
          }
        }
      }

      return orders;
    },
  };
}
