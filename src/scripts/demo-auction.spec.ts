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
    [6000, 930, 100],
    [5421, 930, 100],
    [6000, 930, 1],
    [300, 930, 1],
    [7, 50, 1],
    [5000, 100, 100],
  ])('gives %i bidders one amount each, %i the lowest bid exactly once, none below %i', (bidders, win, min) => {
    const amounts = demoAmounts(bidders, win, min, 10000, rng(bidders + win));
    expect(amounts).toHaveLength(bidders);
    expect(amounts.every((a) => Number.isInteger(a) && a >= min && a <= 10000)).toBe(true);
    const counts = new Map<number, number>();
    for (const a of amounts) counts.set(a, (counts.get(a) ?? 0) + 1);
    const result = calculateResult([...counts].map(([amount, count]) => ({ amountMinor: BigInt(amount), count })));
    expect(result.winningAmountMinor).toBe(BigInt(win));
  });
});
