import { NoUniqueBidPolicy, PrizeDeliveryStatus } from '@prisma/client';
import {
  auctionCancelled,
  auctionEndedWithoutWinner,
  auctionEndedWithWinner,
  auctionWon,
  bidSubmitted,
  closingReminder,
  deliveryUpdated,
  lowBalance,
  walletCredited,
  winRejected,
  winVerified,
} from './notification-templates';

const auction = { id: 'auction-1', title: 'Win a phone' };
const etb = (amountMinor: bigint) => ({ amountMinor, currency: 'ETB', minorUnits: 2 });

describe('notification templates', () => {
  it('words one bid and several bids differently', () => {
    const one = bidSubmitted(auction, 'sub-1', 1, etb(7500n));
    expect(one).toMatchObject({ type: 'BID_SUBMITTED', title: 'Bid placed' });
    expect(one.body).toBe('Your bid in "Win a phone" was placed. ETB 75.00 was charged to your wallet.');

    const four = bidSubmitted(auction, 'sub-2', 4, etb(30000n));
    expect(four.title).toBe('Bids placed');
    expect(four.body).toBe('Your 4 bids in "Win a phone" were placed. ETB 300.00 was charged to your wallet.');
    expect(four.data).toEqual({
      auctionId: 'auction-1',
      bidSubmissionId: 'sub-2',
      bidCount: 4,
      totalFeeMinor: '30000',
    });
  });

  it('never puts the amounts a user bid into the bid confirmation', () => {
    const message = bidSubmitted(auction, 'sub-1', 2, etb(15000n));
    expect(JSON.stringify(message)).not.toMatch(/amountsMinor|"amountMinor"/);
  });

  it('formats money exactly, without floating point', () => {
    expect(walletCredited(etb(900719925474099399n), etb(5n), 'tx-1').body).toBe(
      'ETB 9007199254740993.99 was added to your wallet. Your balance is now ETB 0.05.',
    );
    expect(lowBalance(etb(2500n), etb(7500n)).body).toContain('ETB 25.00, which is less than one bid fee (ETB 75.00)');
  });

  it('respects the minor units of the currency', () => {
    const message = auctionWon(auction, 'winner-1', { amountMinor: 400n, currency: 'UGX', minorUnits: 0 });
    expect(message.body).toContain('Your bid of UGX 400 was the lowest unique bid');
  });

  it('tells the winner and the other bidders different things', () => {
    const won = auctionWon(auction, 'winner-1', etb(400n));
    expect(won).toMatchObject({ type: 'WINNER_ANNOUNCEMENT', title: 'You won!' });
    expect(won.data).toEqual({ auctionId: 'auction-1', winnerId: 'winner-1', amountMinor: '400' });

    const lost = auctionEndedWithWinner(auction, etb(400n));
    expect(lost).toMatchObject({ type: 'AUCTION_RESULT', title: 'Auction ended' });
    expect(lost.body).toBe(
      '"Win a phone" has ended. The lowest unique bid was ETB 4.00. Your bids did not win this time.',
    );
    expect(lost.data).toEqual({ auctionId: 'auction-1', outcome: 'WINNER_FOUND', winningAmountMinor: '400' });
  });

  it('says what happens to the fees when nobody wins', () => {
    expect(auctionEndedWithoutWinner(auction, NoUniqueBidPolicy.REFUND_BID_FEES).body).toMatch(
      /no winner\. Your bid fees are being returned to your wallet\.$/,
    );
    expect(auctionEndedWithoutWinner(auction, NoUniqueBidPolicy.NO_WINNER).body).toMatch(
      /no winner\. Bid fees are not refunded for this auction\.$/,
    );
    expect(auctionCancelled(auction).body).toBe(
      '"Win a phone" was cancelled. Your bid fees are being returned to your wallet.',
    );
  });

  it('words the closing reminder in hours or minutes', () => {
    const closesAt = new Date('2026-11-14T12:00:00.000Z');
    expect(closingReminder(auction, closesAt, 60).body).toContain('closes in less than 1 hour.');
    expect(closingReminder(auction, closesAt, 120).body).toContain('closes in less than 2 hours.');
    expect(closingReminder(auction, closesAt, 45).body).toContain('closes in less than 45 minutes.');
    expect(closingReminder(auction, closesAt, 1).body).toContain('closes in less than 1 minute.');
    expect(closingReminder(auction, closesAt, 60).data).toEqual({
      auctionId: 'auction-1',
      closesAt: '2026-11-14T12:00:00.000Z',
    });
  });

  it('reports verification without a reason', () => {
    expect(winVerified(auction, 'winner-1').data).toMatchObject({ verificationStatus: 'VERIFIED' });
    const rejected = winRejected(auction, 'winner-1');
    expect(rejected.data).toMatchObject({ verificationStatus: 'REJECTED' });
    expect(rejected.body).toBe('We could not confirm your win in "Win a phone". Please contact support for details.');
  });

  it('has a sentence for every delivery status', () => {
    for (const status of Object.values(PrizeDeliveryStatus)) {
      const message = deliveryUpdated(auction, 'winner-1', status, null);
      expect(message.type).toBe('PRIZE_DELIVERY_UPDATE');
      expect(message.body).toMatch(/^Your prize from "Win a phone" .+[.!]$/);
      expect(message.body).not.toMatch(/undefined|\.\./);
      expect(message.data).toEqual({ auctionId: 'auction-1', winnerId: 'winner-1', deliveryStatus: status });
    }
  });

  it('shows tracking details only once the prize is dispatched', () => {
    const tracking = 'EMS EE123456789ET';
    expect(deliveryUpdated(auction, 'w', PrizeDeliveryStatus.DISPATCHED, tracking).body).toBe(
      'Your prize from "Win a phone" is on its way. Tracking: EMS EE123456789ET',
    );
    expect(deliveryUpdated(auction, 'w', PrizeDeliveryStatus.DISPATCHED, null).body).toBe(
      'Your prize from "Win a phone" is on its way.',
    );
    expect(deliveryUpdated(auction, 'w', PrizeDeliveryStatus.VERIFIED, tracking).body).not.toContain(tracking);
  });

  it('keeps every title within the column limit', () => {
    const long = { id: 'a', title: 'x'.repeat(500) };
    const titles = [
      bidSubmitted(long, 's', 1, etb(1n)),
      auctionWon(long, 'w', etb(1n)),
      auctionEndedWithWinner(long, etb(1n)),
      auctionCancelled(long),
      closingReminder(long, new Date(), 60),
      deliveryUpdated(long, 'w', PrizeDeliveryStatus.DELIVERED, null),
    ].map((message) => message.title);
    for (const title of titles) expect(title.length).toBeLessThanOrEqual(200);
  });
});
