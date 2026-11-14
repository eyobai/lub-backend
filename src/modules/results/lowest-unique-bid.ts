import { AuctionOutcome } from '@prisma/client';
import { createHash } from 'node:crypto';

/** Recorded with every result, so a result can always be re-checked with the rules that produced it. */
export const ALGORITHM_VERSION = 'lub-1';

export interface AmountCount {
  amountMinor: bigint;
  /** How many bids were placed at exactly this amount. */
  count: number;
}

export interface Calculation {
  outcome: AuctionOutcome;
  /** The lowest amount bid exactly once, or null when there is none. */
  winningAmountMinor: bigint | null;
  totalBids: number;
  distinctAmounts: number;
  uniqueAmounts: number;
  /** The input, sorted by amount ascending. */
  histogram: AmountCount[];
  /** SHA-256 of the algorithm version and the sorted histogram. */
  inputHash: string;
}

/**
 * Lowest unique bid: of all amounts that were bid exactly once, the smallest wins. The result depends only on
 * how many bids each amount received — not on bid order, time or who placed them — so the same bids always
 * give the same result.
 */
export function calculateResult(counts: readonly AmountCount[]): Calculation {
  const histogram = [...counts].sort((a, b) =>
    a.amountMinor < b.amountMinor ? -1 : a.amountMinor > b.amountMinor ? 1 : 0,
  );
  histogram.forEach((entry, i) => {
    if (entry.amountMinor <= 0n) throw new RangeError('Bid amounts must be positive');
    if (!Number.isSafeInteger(entry.count) || entry.count < 1)
      throw new RangeError('Bid counts must be positive integers');
    if (i > 0 && histogram[i - 1].amountMinor === entry.amountMinor) throw new RangeError('An amount is listed twice');
  });

  const unique = histogram.filter((entry) => entry.count === 1);
  const winningAmountMinor = unique.length > 0 ? unique[0].amountMinor : null;
  const totalBids = histogram.reduce((sum, entry) => sum + entry.count, 0);
  const outcome =
    winningAmountMinor !== null
      ? AuctionOutcome.WINNER_FOUND
      : totalBids === 0
        ? AuctionOutcome.NO_BIDS
        : AuctionOutcome.NO_UNIQUE_BID;

  const canonical = [ALGORITHM_VERSION, ...histogram.map((entry) => `${entry.amountMinor}:${entry.count}`)].join('\n');
  return {
    outcome,
    winningAmountMinor,
    totalBids,
    distinctAmounts: histogram.length,
    uniqueAmounts: unique.length,
    histogram,
    inputHash: createHash('sha256').update(canonical).digest('hex'),
  };
}
