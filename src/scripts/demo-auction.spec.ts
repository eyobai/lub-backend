import { demoAmounts } from './demo-auction';
import { calculateResult } from '../modules/results/lowest-unique-bid';

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

describe('demoAmounts', () => {
  it.each([
    [6000, 930],
    [300, 930],
    [7, 50],
    [5000, 1],
  ])('gives %i bidders one amount each, with %i the lowest amount bid exactly once', (bidders, win) => {
    const amounts = demoAmounts(bidders, win, 10000, rng(bidders + win));
    expect(amounts).toHaveLength(bidders);
    expect(amounts.every((a) => Number.isInteger(a) && a >= 1 && a <= 10000)).toBe(true);
    const counts = new Map<number, number>();
    for (const a of amounts) counts.set(a, (counts.get(a) ?? 0) + 1);
    const result = calculateResult([...counts].map(([amount, count]) => ({ amountMinor: BigInt(amount), count })));
    expect(result.winningAmountMinor).toBe(BigInt(win));
  });
});
