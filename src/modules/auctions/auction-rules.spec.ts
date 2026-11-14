import { NoUniqueBidPolicy, ProductStatus } from '@prisma/client';
import { MAX_AMOUNT_MINOR } from '../../common/utils/money';
import { configProblems, readinessProblems } from './auction-rules';
import type { AuctionConfig, AuctionReadiness } from './auction-rules';

const at = (iso: string) => new Date(iso);

describe('configProblems', () => {
  const valid: AuctionConfig = {
    bidFeeMinor: 7500n,
    minBidMinor: 100n,
    maxBidMinor: 100000n,
    bidStepMinor: 100n,
    opensAt: at('2027-01-01T09:00:00Z'),
    closesAt: at('2027-01-02T09:00:00Z'),
  };

  it('accepts consistent rules and a single allowed amount', () => {
    expect(configProblems(valid)).toEqual([]);
    expect(configProblems({ ...valid, minBidMinor: 500n, maxBidMinor: 500n })).toEqual([]);
  });

  it.each<[string, Partial<AuctionConfig>, RegExp]>([
    ['a negative fee', { bidFeeMinor: -1n }, /bidFeeMinor/],
    ['a zero fee', { bidFeeMinor: 0n }, /bidFeeMinor must be greater than zero/],
    ['an oversized fee', { bidFeeMinor: MAX_AMOUNT_MINOR + 1n }, /bidFeeMinor/],
    ['a zero minimum', { minBidMinor: 0n }, /minBidMinor must be greater than zero/],
    ['a zero step', { bidStepMinor: 0n }, /bidStepMinor/],
    ['max below min', { maxBidMinor: 99n }, /greater than or equal to minBidMinor/],
    ['an oversized max', { maxBidMinor: MAX_AMOUNT_MINOR + 100n }, /maxBidMinor is out of range/],
    ['a max that is not on a step', { maxBidMinor: 100050n }, /whole number of bidStepMinor steps/],
    ['closing before opening', { closesAt: at('2027-01-01T08:59:59Z') }, /closesAt must be after opensAt/],
    ['closing at the opening instant', { closesAt: at('2027-01-01T09:00:00Z') }, /closesAt must be after opensAt/],
    ['an invalid date', { opensAt: new Date('nope') }, /opensAt is not a valid date/],
  ])('rejects %s', (_name, override, message) => {
    expect(configProblems({ ...valid, ...override }).join('; ')).toMatch(message);
  });

  it('reports every problem at once', () => {
    expect(configProblems({ ...valid, minBidMinor: 0n, bidStepMinor: 0n, bidFeeMinor: -5n })).toHaveLength(3);
  });
});

describe('readinessProblems', () => {
  const now = at('2027-01-01T12:00:00Z');
  const ready: AuctionReadiness = {
    noUniqueBidPolicy: NoUniqueBidPolicy.NO_WINNER,
    productStatus: ProductStatus.AVAILABLE,
    opensAt: at('2027-01-01T13:00:00Z'),
    closesAt: at('2027-01-02T13:00:00Z'),
  };

  it('accepts a complete auction that opens in the future', () => {
    expect(readinessProblems(ready, now, 'schedule')).toEqual([]);
    expect(readinessProblems(ready, now, 'activate')).toEqual([]);
  });

  it('requires an explicit no-unique-bid policy', () => {
    expect(readinessProblems({ ...ready, noUniqueBidPolicy: null }, now, 'schedule')).toEqual([
      expect.stringContaining('noUniqueBidPolicy'),
    ]);
  });

  it.each([ProductStatus.RESERVED, ProductStatus.UNAVAILABLE, ProductStatus.ARCHIVED])(
    'requires an AVAILABLE product (%s)',
    (productStatus) => {
      expect(readinessProblems({ ...ready, productStatus }, now, 'activate')).toEqual([
        expect.stringContaining('must be AVAILABLE'),
      ]);
    },
  );

  it('lets an auction whose opening time has passed be activated but not scheduled', () => {
    const late = { ...ready, opensAt: at('2027-01-01T11:00:00Z') };
    expect(readinessProblems(late, now, 'activate')).toEqual([]);
    expect(readinessProblems(late, now, 'schedule')).toEqual([expect.stringContaining('opensAt is in the past')]);
    expect(readinessProblems({ ...ready, opensAt: now }, now, 'schedule')).toHaveLength(1);
  });

  it('never opens an auction that has already ended', () => {
    const over = { ...ready, opensAt: at('2026-12-30T00:00:00Z'), closesAt: at('2027-01-01T12:00:00Z') };
    expect(readinessProblems(over, now, 'activate')).toEqual([expect.stringContaining('closesAt is in the past')]);
    expect(readinessProblems(over, now, 'schedule')).toHaveLength(2);
  });
});
