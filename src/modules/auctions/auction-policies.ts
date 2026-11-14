import { NoUniqueBidPolicy } from '@prisma/client';

/** EXTEND_AUCTION exists in the data model but needs extension rules that are not defined yet. */
export const SUPPORTED_NO_UNIQUE_BID_POLICIES: NoUniqueBidPolicy[] = [
  NoUniqueBidPolicy.NO_WINNER,
  NoUniqueBidPolicy.REFUND_BID_FEES,
];
