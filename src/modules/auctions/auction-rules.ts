import { AuctionStatus, ProductStatus } from '@prisma/client';
import type { NoUniqueBidPolicy } from '@prisma/client';
import { MAX_AMOUNT_MINOR } from '../../common/utils/money';

/** The bidding rules of an auction. Amounts are bigint minor units. */
export interface AuctionConfig {
  bidFeeMinor: bigint;
  minBidMinor: bigint;
  maxBidMinor: bigint;
  bidStepMinor: bigint;
  opensAt: Date;
  closesAt: Date;
}

/** What must be true before bidders may see or use an auction. */
export interface AuctionReadiness {
  noUniqueBidPolicy: NoUniqueBidPolicy | null;
  productStatus: ProductStatus;
  opensAt: Date;
  closesAt: Date;
}

/** Statuses in which every rule can still be edited: nobody has been able to bid yet. */
export const EDITABLE_STATUSES: AuctionStatus[] = [AuctionStatus.DRAFT, AuctionStatus.SCHEDULED];

/** Returns every reason the rules are inconsistent; an empty list means they are valid. */
export function configProblems(c: AuctionConfig): string[] {
  const problems: string[] = [];
  const tooLarge = (value: bigint) => value > MAX_AMOUNT_MINOR;

  if (c.bidFeeMinor < 0n || tooLarge(c.bidFeeMinor)) problems.push('bidFeeMinor is out of range');
  if (c.minBidMinor <= 0n || tooLarge(c.minBidMinor)) problems.push('minBidMinor must be greater than zero');
  if (c.bidStepMinor <= 0n || tooLarge(c.bidStepMinor)) problems.push('bidStepMinor must be greater than zero');
  if (tooLarge(c.maxBidMinor)) problems.push('maxBidMinor is out of range');
  if (c.maxBidMinor < c.minBidMinor) {
    problems.push('maxBidMinor must be greater than or equal to minBidMinor');
  } else if (c.bidStepMinor > 0n && (c.maxBidMinor - c.minBidMinor) % c.bidStepMinor !== 0n) {
    problems.push('maxBidMinor must be minBidMinor plus a whole number of bidStepMinor steps');
  }
  if (Number.isNaN(c.opensAt.getTime())) problems.push('opensAt is not a valid date');
  if (Number.isNaN(c.closesAt.getTime())) problems.push('closesAt is not a valid date');
  if (c.closesAt.getTime() <= c.opensAt.getTime()) problems.push('closesAt must be after opensAt');
  return problems;
}

/**
 * Returns every reason an auction cannot go public yet.
 * `schedule` opens it later at `opensAt`; `activate` opens it immediately, so `opensAt` may be in the past.
 */
export function readinessProblems(a: AuctionReadiness, now: Date, mode: 'schedule' | 'activate'): string[] {
  const problems: string[] = [];
  if (a.noUniqueBidPolicy === null) {
    problems.push('Choose what happens when no bid is unique (noUniqueBidPolicy)');
  }
  if (a.productStatus !== ProductStatus.AVAILABLE) {
    problems.push(`The product is ${a.productStatus}; it must be AVAILABLE`);
  }
  if (a.closesAt.getTime() <= now.getTime()) problems.push('closesAt is in the past');
  if (mode === 'schedule' && a.opensAt.getTime() <= now.getTime()) {
    problems.push('opensAt is in the past; change it or activate the auction to open it now');
  }
  return problems;
}
