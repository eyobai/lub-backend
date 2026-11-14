import { PrizeDeliveryStatus as S } from '@prisma/client';

/**
 * Allowed prize-delivery steps. Delivery moves forward one step at a time; a dispute can be raised at any
 * point and, once settled, the delivery resumes at whichever step applies.
 */
const NEXT: Record<S, S[]> = {
  [S.PENDING]: [S.CONTACTED, S.DISPUTED],
  [S.CONTACTED]: [S.VERIFIED, S.DISPUTED],
  [S.VERIFIED]: [S.DISPATCHED, S.DISPUTED],
  [S.DISPATCHED]: [S.DELIVERED, S.DISPUTED],
  [S.DELIVERED]: [S.DISPUTED],
  [S.DISPUTED]: [S.CONTACTED, S.VERIFIED, S.DISPATCHED, S.DELIVERED],
};

export const allowedNextStatuses = (from: S): S[] => NEXT[from];
export const canMove = (from: S, to: S): boolean => NEXT[from].includes(to);

/** Raising a dispute and settling one must both be explained. */
export const noteRequired = (from: S, to: S): boolean => from === S.DISPUTED || to === S.DISPUTED;

/** The prize cannot leave (or be marked as received) without knowing who gets it and where. */
export const recipientRequired = (to: S): boolean => to === S.DISPATCHED || to === S.DELIVERED;

/** The winner may fill in their own delivery details only before the details have been confirmed. */
export const winnerCanEditDetails = (status: S): boolean => status === S.PENDING || status === S.CONTACTED;
