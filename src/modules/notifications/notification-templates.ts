import { NoUniqueBidPolicy, NotificationType, PrizeDeliveryStatus } from '@prisma/client';
import { formatMinor } from '../../common/utils/money';
import type { NotificationMessage } from './notification.types';

/**
 * Every notification text lives here, so wording (and later translations) can change without touching
 * the code that raises them. Titles are short and fixed; names and amounts go in the body.
 */
export interface Money {
  amountMinor: bigint;
  currency: string;
  minorUnits: number;
}
interface AuctionRef {
  id: string;
  title: string;
}

const money = (m: Money) => `${m.currency} ${formatMinor(m.amountMinor, m.minorUnits)}`;

export const bidSubmitted = (
  auction: AuctionRef,
  submissionId: string,
  bidCount: number,
  fee: Money,
): NotificationMessage => ({
  type: NotificationType.BID_SUBMITTED,
  title: bidCount === 1 ? 'Bid placed' : 'Bids placed',
  body: `Your ${bidCount === 1 ? 'bid' : `${bidCount} bids`} in "${auction.title}" ${bidCount === 1 ? 'was' : 'were'} placed. ${money(fee)} was charged to your wallet.`,
  data: { auctionId: auction.id, bidSubmissionId: submissionId, bidCount, totalFeeMinor: fee.amountMinor.toString() },
});

export const lowBalance = (balance: Money, bidFee: Money): NotificationMessage => ({
  type: NotificationType.LOW_BALANCE,
  title: 'Low wallet balance',
  body: `Your wallet balance is ${money(balance)}, which is less than one bid fee (${money(bidFee)}). Add funds to keep bidding.`,
  data: { availableMinor: balance.amountMinor.toString(), currency: balance.currency },
});

export const walletCredited = (amount: Money, balance: Money, transactionId: string): NotificationMessage => ({
  type: NotificationType.DEPOSIT_SUCCEEDED,
  title: 'Wallet credited',
  body: `${money(amount)} was added to your wallet. Your balance is now ${money(balance)}.`,
  data: { transactionId, amountMinor: amount.amountMinor.toString(), currency: amount.currency },
});

const duration = (minutes: number) =>
  minutes % 60 === 0
    ? `${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}`
    : `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;

export const closingReminder = (auction: AuctionRef, closesAt: Date, withinMinutes: number): NotificationMessage => ({
  type: NotificationType.AUCTION_CLOSING_REMINDER,
  title: 'Auction closing soon',
  body: `"${auction.title}" closes in less than ${duration(withinMinutes)}. You can still place bids until then.`,
  data: { auctionId: auction.id, closesAt: closesAt.toISOString() },
});

export const auctionWon = (auction: AuctionRef, winnerId: string, amount: Money): NotificationMessage => ({
  type: NotificationType.WINNER_ANNOUNCEMENT,
  title: 'You won!',
  body: `Your bid of ${money(amount)} was the lowest unique bid in "${auction.title}". We will confirm the result and contact you about your prize.`,
  data: { auctionId: auction.id, winnerId, amountMinor: amount.amountMinor.toString() },
});

export const auctionEndedWithWinner = (auction: AuctionRef, winningAmount: Money): NotificationMessage => ({
  type: NotificationType.AUCTION_RESULT,
  title: 'Auction ended',
  body: `"${auction.title}" has ended. The lowest unique bid was ${money(winningAmount)}. Your bids did not win this time.`,
  data: { auctionId: auction.id, outcome: 'WINNER_FOUND', winningAmountMinor: winningAmount.amountMinor.toString() },
});

export const auctionEndedWithoutWinner = (auction: AuctionRef, policy: NoUniqueBidPolicy): NotificationMessage => ({
  type: NotificationType.AUCTION_RESULT,
  title: 'Auction ended without a winner',
  body:
    `"${auction.title}" has ended and no bid was unique, so there is no winner. ` +
    (policy === NoUniqueBidPolicy.REFUND_BID_FEES
      ? 'Your bid fees are being returned to your wallet.'
      : 'Bid fees are not refunded for this auction.'),
  data: { auctionId: auction.id, outcome: 'NO_UNIQUE_BID', policy },
});

export const auctionCancelled = (auction: AuctionRef): NotificationMessage => ({
  type: NotificationType.AUCTION_RESULT,
  title: 'Auction cancelled',
  body: `"${auction.title}" was cancelled. Your bid fees are being returned to your wallet.`,
  data: { auctionId: auction.id, outcome: 'CANCELLED' },
});

export const winVerified = (auction: AuctionRef, winnerId: string): NotificationMessage => ({
  type: NotificationType.WINNER_ANNOUNCEMENT,
  title: 'Your win is confirmed',
  body: `Your win in "${auction.title}" has been confirmed. Please send your delivery details so we can get the prize to you.`,
  data: { auctionId: auction.id, winnerId, verificationStatus: 'VERIFIED' },
});

export const winRejected = (auction: AuctionRef, winnerId: string): NotificationMessage => ({
  type: NotificationType.WINNER_ANNOUNCEMENT,
  title: 'Your win could not be confirmed',
  body: `We could not confirm your win in "${auction.title}". Please contact support for details.`,
  data: { auctionId: auction.id, winnerId, verificationStatus: 'REJECTED' },
});

const DELIVERY_TEXT: Record<PrizeDeliveryStatus, string> = {
  [PrizeDeliveryStatus.PENDING]: 'is being prepared',
  [PrizeDeliveryStatus.CONTACTED]: 'is being arranged; our team has tried to reach you',
  [PrizeDeliveryStatus.VERIFIED]: 'has its delivery details confirmed',
  [PrizeDeliveryStatus.DISPATCHED]: 'is on its way',
  [PrizeDeliveryStatus.DELIVERED]: 'has been delivered. Enjoy!',
  [PrizeDeliveryStatus.DISPUTED]: 'is on hold while an issue is looked into; our team will contact you',
};

export const deliveryUpdated = (
  auction: AuctionRef,
  winnerId: string,
  status: PrizeDeliveryStatus,
  trackingInfo: string | null,
): NotificationMessage => ({
  type: NotificationType.PRIZE_DELIVERY_UPDATE,
  title: 'Prize delivery update',
  body:
    `Your prize from "${auction.title}" ${DELIVERY_TEXT[status]}` +
    (status === PrizeDeliveryStatus.DELIVERED ? '' : '.') +
    (status === PrizeDeliveryStatus.DISPATCHED && trackingInfo ? ` Tracking: ${trackingInfo}` : ''),
  data: { auctionId: auction.id, winnerId, deliveryStatus: status },
});
