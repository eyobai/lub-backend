import { calculateResult } from './lowest-unique-bid';

const counts = (...pairs: [number, number][]) =>
  pairs.map(([amount, count]) => ({ amountMinor: BigInt(amount), count }));

describe('calculateResult', () => {
  it('picks the lowest amount bid exactly once (ETB 1×5, 2×3, 3×2, 4×1, 5×1 → ETB 4)', () => {
    const result = calculateResult(counts([100, 5], [200, 3], [300, 2], [400, 1], [500, 1]));

    expect(result).toMatchObject({
      outcome: 'WINNER_FOUND',
      winningAmountMinor: 400n,
      totalBids: 12,
      distinctAmounts: 5,
      uniqueAmounts: 2,
    });
  });

  it('lets the lowest bid win when it is unique', () => {
    expect(calculateResult(counts([100, 1], [200, 1], [300, 4])).winningAmountMinor).toBe(100n);
  });

  it('lets a single bid win', () => {
    expect(calculateResult(counts([99900, 1]))).toMatchObject({ outcome: 'WINNER_FOUND', winningAmountMinor: 99900n });
  });

  it('reports no unique bid when every amount was bid more than once', () => {
    expect(calculateResult(counts([100, 2], [200, 3]))).toMatchObject({
      outcome: 'NO_UNIQUE_BID',
      winningAmountMinor: null,
      totalBids: 5,
      uniqueAmounts: 0,
    });
  });

  it('reports no bids for an empty auction', () => {
    expect(calculateResult([])).toMatchObject({ outcome: 'NO_BIDS', winningAmountMinor: null, totalBids: 0 });
  });

  it('gives the same result and hash whatever order the input arrives in', () => {
    const a = calculateResult(counts([100, 5], [200, 3], [400, 1], [500, 1]));
    const b = calculateResult(counts([500, 1], [400, 1], [100, 5], [200, 3]));

    expect(b).toEqual(a);
    expect(a.histogram.map((entry) => entry.amountMinor)).toEqual([100n, 200n, 400n, 500n]);
    expect(a.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes the hash when any count or amount changes', () => {
    const base = calculateResult(counts([100, 2], [200, 1])).inputHash;
    expect(calculateResult(counts([100, 3], [200, 1])).inputHash).not.toBe(base);
    expect(calculateResult(counts([100, 2], [300, 1])).inputHash).not.toBe(base);
    // "1:23" and "12:3" must not collide.
    expect(calculateResult(counts([1, 23])).inputHash).not.toBe(calculateResult(counts([12, 3])).inputHash);
  });

  it('compares amounts as exact integers beyond the float-safe range', () => {
    const big = 900_000_000_000_000_000n;
    const result = calculateResult([
      { amountMinor: big + 1n, count: 1 },
      { amountMinor: big, count: 2 },
      { amountMinor: big + 2n, count: 1 },
    ]);
    expect(result.winningAmountMinor).toBe(big + 1n);
  });

  it.each([
    ['a zero count', counts([100, 0])],
    ['a fractional count', counts([100, 1.5])],
    ['a non-positive amount', counts([0, 1])],
    ['the same amount twice', counts([100, 1], [100, 1])],
  ])('refuses %s', (_name, input) => {
    expect(() => calculateResult(input)).toThrow(RangeError);
  });
});
