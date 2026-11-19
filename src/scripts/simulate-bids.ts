import { NestFactory } from '@nestjs/core';
import { AuctionStatus, RoleName } from '@prisma/client';
import { randomBytes, randomUUID } from 'node:crypto';
import { AppModule } from '../app.module';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { formatMinor } from '../common/utils/money';
import { PrismaService } from '../infra/prisma/prisma.service';
import { PasswordService } from '../modules/auth/password.service';
import { BiddingService } from '../modules/bidding/bidding.service';
import { WalletService } from '../modules/wallet/wallet.service';

/**
 * Fills an open TEST auction with sample bidders, through the real bidding service (fees, ledger and limits all
 * apply). Each sample bidder gets exactly the money for its bid fees and places SIM_BIDS_PER_USER different amounts
 * between SIM_MIN and SIM_MAX. The auction stays open; nothing is closed or decided here.
 *
 * It refuses an auction in which a real account has bid: sample bids would take amounts from real bidders and change
 * who wins. Sample bidders have phone numbers +251998000001… and a random password nobody knows.
 *
 *   SIM_AUCTION_ID      the open (ACTIVE) test auction (required)
 *   SIM_USERS           number of sample bidders (default 20)
 *   SIM_BIDS_PER_USER   bids for each of them (default 30)
 *   SIM_MIN / SIM_MAX   bid amounts in ETB (default 1 and 5)
 */

const SAMPLE_PREFIX = '+251998';
const etbToMinor = (value: string): bigint => {
  const [whole, fraction = ''] = value.trim().split('.');
  if (!/^\d+$/.test(whole) || !/^\d{0,2}$/.test(fraction)) throw new Error(`Not an ETB amount: ${value}`);
  return BigInt(whole + fraction.padEnd(2, '0'));
};

async function withRetry<T>(work: () => Promise<T>, what: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= 4) throw error;
      const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
      console.log(`  retrying ${what} (${attempt}/3): ${reason.slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

/** `count` different amounts from `pool`, chosen at random, leaving out the ones in `taken`. */
function pick(pool: bigint[], count: number, taken: Set<bigint>): bigint[] {
  const free = pool.filter((a) => !taken.has(a));
  for (let i = free.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [free[i], free[j]] = [free[j], free[i]];
  }
  return free.slice(0, count).sort((a, b) => (a < b ? -1 : 1));
}

async function main(): Promise<void> {
  const auctionId = process.env.SIM_AUCTION_ID?.trim();
  if (!auctionId) throw new Error('Set SIM_AUCTION_ID to the id of an open test auction');
  const users = Number(process.env.SIM_USERS ?? 20);
  const perUser = Number(process.env.SIM_BIDS_PER_USER ?? 30);
  const minMinor = etbToMinor(process.env.SIM_MIN ?? '1');
  const maxMinor = etbToMinor(process.env.SIM_MAX ?? '5');
  if (!Number.isInteger(users) || users < 1 || users > 2000) throw new Error('SIM_USERS must be 1–2000');
  if (!Number.isInteger(perUser) || perUser < 1 || perUser > 500) throw new Error('SIM_BIDS_PER_USER must be 1–500');
  if (minMinor > maxMinor) throw new Error('SIM_MIN is larger than SIM_MAX');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const prisma = app.get(PrismaService);
    const auction = await prisma.auction.findUnique({
      where: { id: auctionId },
      include: { currencyRef: { select: { minorUnits: true } } },
    });
    if (!auction) throw new Error(`No auction ${auctionId}`);
    if (auction.status !== AuctionStatus.ACTIVE)
      throw new Error(`Auction is ${auction.status}; it must be open (ACTIVE)`);
    const money = (minor: bigint) => `${auction.currency} ${formatMinor(minor, auction.currencyRef.minorUnits)}`;

    // Never mix sample bids with real ones.
    const real = await prisma.bid.count({
      where: { auctionId, user: { phoneNumber: { not: { startsWith: SAMPLE_PREFIX } } } },
    });
    if (real > 0) {
      throw new Error(
        `This auction already has ${real} bids from real accounts. Sample bids would change their outcome, so ` +
          'nothing was done. Use a separate test auction.',
      );
    }

    // The amounts the auction accepts inside the asked range.
    const step = auction.bidStepMinor;
    const low = minMinor > auction.minBidMinor ? minMinor : auction.minBidMinor;
    const high = maxMinor < auction.maxBidMinor ? maxMinor : auction.maxBidMinor;
    const first = ((low - auction.minBidMinor + step - 1n) / step) * step + auction.minBidMinor;
    const pool: bigint[] = [];
    for (let a = first; a <= high; a += step) pool.push(a);
    if (pool.length === 0) throw new Error(`No allowed amount between ${money(low)} and ${money(high)}`);
    let wanted = perUser;
    if (auction.maxBidsPerUser !== null && auction.maxBidsPerUser < wanted) {
      console.log(`  this auction allows ${auction.maxBidsPerUser} bids per person; using that`);
      wanted = auction.maxBidsPerUser;
    }
    if (pool.length < wanted) {
      console.log(`  only ${pool.length} different amounts fit the range; each bidder places that many`);
      wanted = pool.length;
    }

    console.log(
      `Auction "${auction.title}", fee ${money(auction.bidFeeMinor)}, amounts ${money(pool[0])}–${money(pool[pool.length - 1])}`,
    );
    console.log(`1/3 ${users} sample bidders`);
    const passwordHash = await app.get(PasswordService).hash(randomBytes(24).toString('base64'));
    const phones = Array.from({ length: users }, (_, i) => `${SAMPLE_PREFIX}${String(i + 1).padStart(6, '0')}`);
    await prisma.user.createMany({
      data: phones.map((phoneNumber) => ({ phoneNumber, passwordHash })),
      skipDuplicates: true,
    });
    const accounts = await prisma.user.findMany({
      where: { phoneNumber: { in: phones } },
      select: { id: true, phoneNumber: true },
      orderBy: { phoneNumber: 'asc' },
    });
    const userRole = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.USER } });
    await prisma.userRole.createMany({
      data: accounts.map((u) => ({ userId: u.id, roleId: userRole.id })),
      skipDuplicates: true,
    });

    console.log(`2/3 Placing ${wanted} bids for each (${money(auction.bidFeeMinor * BigInt(wanted))} in fees each)`);
    const wallets = app.get(WalletService);
    const bidding = app.get(BiddingService);
    const client = { userAgent: 'simulate-bids script' };
    const run = randomUUID();
    let placed = 0;
    for (const [i, u] of accounts.entries()) {
      const before = await prisma.bid.findMany({ where: { auctionId, userId: u.id }, select: { amountMinor: true } });
      const room = auction.maxBidsPerUser === null ? wanted : Math.min(wanted, auction.maxBidsPerUser - before.length);
      const amounts = pick(pool, room, new Set(before.map((b) => b.amountMinor)));
      if (amounts.length === 0) continue;
      await withRetry(
        () =>
          wallets.deposit({
            userId: u.id,
            amountMinor: auction.bidFeeMinor * BigInt(amounts.length),
            idempotencyKey: `sim:${run}:${u.id}`,
            description: 'Sample bidder funds',
          }),
        `funds for ${u.phoneNumber}`,
      );
      const user: AuthenticatedUser = {
        id: u.id,
        phoneNumber: u.phoneNumber,
        roles: [RoleName.USER],
        sessionId: 'simulation',
        mustChangePassword: false,
      };
      for (let at = 0, part = 0; at < amounts.length; at += auction.maxBidsPerRequest, part++) {
        const chunk = amounts.slice(at, at + auction.maxBidsPerRequest).map(String);
        await withRetry(
          () => bidding.place(user, auctionId, chunk, `sim-${run}-${part}`, client),
          `bids for ${u.phoneNumber}`,
        );
        placed += chunk.length;
      }
      if ((i + 1) % 5 === 0 || i + 1 === accounts.length)
        console.log(`  ${i + 1}/${accounts.length} bidders, ${placed} bids`);
    }

    console.log('3/3 Where the auction stands now');
    const counts = await prisma.bid.groupBy({
      by: ['amountMinor'],
      where: { auctionId },
      _count: true,
      orderBy: { amountMinor: 'asc' },
    });
    const total = counts.reduce((sum, c) => sum + c._count, 0);
    const unique = counts.filter((c) => c._count === 1);
    console.log(`  ${total} bids on ${counts.length} different amounts; ${unique.length} amounts bid exactly once`);
    console.log(`  lowest unique so far: ${unique[0] ? money(unique[0].amountMinor) : 'none'}`);
    console.log('\nDone. The auction is still open; see it in the admin site.');
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
