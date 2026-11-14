import { PrizeDeliveryStatus as S } from '@prisma/client';
import { allowedNextStatuses, canMove, noteRequired, recipientRequired, winnerCanEditDetails } from './delivery-rules';

describe('delivery rules', () => {
  it('moves forward one step at a time', () => {
    const path = [S.PENDING, S.CONTACTED, S.VERIFIED, S.DISPATCHED, S.DELIVERED];
    path.slice(1).forEach((to, i) => expect(canMove(path[i], to)).toBe(true));
    expect(canMove(S.PENDING, S.DISPATCHED)).toBe(false);
    expect(canMove(S.CONTACTED, S.DELIVERED)).toBe(false);
    expect(canMove(S.DELIVERED, S.PENDING)).toBe(false);
    expect(canMove(S.VERIFIED, S.CONTACTED)).toBe(false);
  });

  it('never allows a status to move to itself', () => {
    for (const status of Object.values(S)) expect(canMove(status, status)).toBe(false);
  });

  it('allows a dispute from every step and a way back out of it', () => {
    for (const status of Object.values(S).filter((s) => s !== S.DISPUTED))
      expect(canMove(status, S.DISPUTED)).toBe(true);
    expect(allowedNextStatuses(S.DISPUTED)).toEqual([S.CONTACTED, S.VERIFIED, S.DISPATCHED, S.DELIVERED]);
  });

  it('requires a note to raise or settle a dispute, and recipient details to dispatch or deliver', () => {
    expect(noteRequired(S.CONTACTED, S.DISPUTED)).toBe(true);
    expect(noteRequired(S.DISPUTED, S.DELIVERED)).toBe(true);
    expect(noteRequired(S.PENDING, S.CONTACTED)).toBe(false);
    expect([S.DISPATCHED, S.DELIVERED].map(recipientRequired)).toEqual([true, true]);
    expect([S.CONTACTED, S.VERIFIED, S.DISPUTED].map(recipientRequired)).toEqual([false, false, false]);
  });

  it('lets the winner edit delivery details only before they are confirmed', () => {
    expect(Object.values(S).filter(winnerCanEditDetails)).toEqual([S.PENDING, S.CONTACTED]);
  });
});
