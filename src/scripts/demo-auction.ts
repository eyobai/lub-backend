import { NestFactory } from '@nestjs/core';
import { RoleName } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { AppModule } from '../app.module';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../infra/prisma/prisma.service';
import { AuctionLifecycleProcessor } from '../modules/auctions/auction-lifecycle.processor';
import { AuctionsService } from '../modules/auctions/auctions.service';
import { PasswordService } from '../modules/auth/password.service';
import { BiddingService } from '../modules/bidding/bidding.service';
import { ProductsService } from '../modules/products/products.service';
import { WalletService } from '../modules/wallet/wallet.service';
import { WinnersService } from '../modules/winners/winners.service';

/**
 * Runs a complete demo auction through the real services, so every number (wallets, ledger, result, winners page)
 * is consistent: creates the product and auction, gives each sample bidder exactly one bid fee, places one bid per
 * bidder, closes the auction and verifies and publishes the winner.
 *
 * The amounts are chosen so DEMO_WIN_AMOUNT is the lowest amount bid exactly once: every amount below it is bid at
 * least twice. Sample bidders have phone numbers +251999000001… and a random password nobody knows.
 *
 *   DEMO_ADMIN_PHONE   an ADMIN or SUPER_ADMIN account that creates the auction and verifies the win (required)
 *   DEMO_BIDDERS       number of sample bidders, one bid each (default 6000)
 *   DEMO_WIN_AMOUNT    winning bid in ETB (default 9.30)
 *   DEMO_MIN_BID       smallest bid the auction accepts, in ETB (default 1)
 *   DEMO_BID_FEE       bid fee in ETB (default 80)
 *   DEMO_IMAGE_URL     product picture address (optional; can be added later in the admin site)
 *   DEMO_AUCTION_ID    continue a run that stopped part-way, instead of creating a new auction
 *   DEMO_CONCURRENCY   bids placed at the same time (default 2; they queue on the auction anyway)
 */

const TITLE = 'iPhone 18 Pro Max — 256GB — Burgundy';
const DESCRIPTION = `ቀለም፦ በርገንዲ (Burgundy)።
የማከማቻ አቅም፦ 256GB።
ስልኩ ከሳጥኑ ጋር ይቀርባል።

የስክሪን ጥራት
6.9 ኢንች Super Retina XDR OLED ስክሪን፣ እስከ 120Hz ProMotion፣ ከቤት ውጭ እስከ 3,000 nits ከፍተኛ የብርሃን አቅም እና አነስተኛ ዳይናሚክ አይላንድ (Dynamic Island)።

ፕሮሴሰር (Processor)
በ2nm ቴክኖሎጂ የተሠራ A20 Pro ቺፕ፣ 6-core CPU፣ 7-core GPU እና Dual 16-core Neural Engine።

የካሜራ ሲስተም
ሶስት ባለ 48MP ፕሮ ካሜራዎች፦ ዋና ካሜራ ከሚለዋወጥ የሌንስ ቀዳዳ (variable aperture f/1.48–f/4.0) ጋር፣ 48MP Ultra Wide እና 48MP ቴሌፎቶ። 4x ኦፕቲካል ዙም እና እስከ 8x ኦፕቲካል ጥራት ያለው ዙም (optical-quality zoom)።

የፊት ካሜራ
18MP Center Stage የፊት ካሜራ ከ auto-focus ጋር፣ ለጠራ ቪዲዮ ጥሪ እና ሴልፊ።

ባትሪ እና ቻርጅ
ለቀን ሙሉ አጠቃቀም የተዘጋጀ ባትሪ፣ ፈጣን ባለገመድ ቻርጅ እና እስከ 25W MagSafe / Qi2 ገመድ አልባ ቻርጅ። የባትሪ ቆይታ እንደ አጠቃቀም ይለያያል።

ግንኙነት (Connectivity)
ፈጣን Wi-Fi 7፣ USB-C (እስከ 10Gbps የመረጃ ማስተላለፊያ)፣ 2nd-gen UWB እና IP68 የውሃና የአቧራ መቋቋም አቅም።

ዝቅተኛና ያልተደገመ ዋጋ ያሸንፋል። በቅድሚያ የጨረታ አገልግሎት ክፍያ ብቻ ይከፍላሉ፤ አሸናፊው ያሸነፈበትን የጨረታ ዋጋ ይከፍላል።
ምስሉ ለማሳያ የተዘጋጀ ነው።`;

const SPECIFICATIONS = {
  Color: 'Burgundy',
  Storage: '256GB',
  Display: '6.9" Super Retina XDR OLED, 120Hz ProMotion',
  Chip: 'A20 Pro (2nm)',
  Cameras: '48MP Main + 48MP Ultra Wide + 48MP Telephoto',
  'Front camera': '18MP Center Stage',
  Connectivity: 'Wi-Fi 7, USB-C 10Gbps, UWB (2nd gen)',
  'Water resistance': 'IP68',
  'In the box': 'Yes',
};

const etbToMinor = (value: string): bigint => {
  const [whole, fraction = ''] = value.trim().split('.');
  if (!/^\d+$/.test(whole) || !/^\d{0,2}$/.test(fraction)) throw new Error(`Not an ETB amount: ${value}`);
  return BigInt(whole + fraction.padEnd(2, '0'));
};

/** Small deterministic random numbers, so a run can be repeated with the same spread of bids. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One amount per bidder, in minor units, such that `win` is the lowest amount bid exactly once. People favour small
 * and round amounts, so those get more bids; every amount below `win` ends up with two or more.
 */
export function demoAmounts(bidders: number, win: number, min: number, max: number, rnd: () => number): number[] {
  if (win < min || win > max) throw new Error('The winning amount must be between the smallest and largest bid');
  if (bidders < 3) throw new Error('Need at least 3 bidders');
  const counts = new Map<number, number>();
  const add = (amount: number, n = 1) => counts.set(amount, (counts.get(amount) ?? 0) + n);
  const pick = (low: number, high: number) => {
    // Round amounts (whole birr, half birr) are picked more often.
    const r = rnd();
    const raw = low + Math.floor(Math.pow(rnd(), 1.6) * (high - low + 1));
    const amount = r < 0.25 ? Math.round(raw / 100) * 100 : r < 0.4 ? Math.round(raw / 50) * 50 : raw;
    return Math.min(high, Math.max(low, amount));
  };
  add(win);
  let left = bidders - 1;
  let below = win > min ? Math.min(left, Math.round(bidders * 0.62)) : 0;
  while (below > 0) {
    const amount = pick(min, win - 1);
    const n = Math.min(below, (counts.get(amount) ?? 0) === 0 ? 2 : 1); // a new amount below the winner starts at two
    add(amount, n);
    below -= n;
    left -= n;
  }
  while (left > 0) {
    const amount = pick(win + 1, max);
    add(amount);
    left -= 1;
  }
  // The last "below" step may have left one amount with a single bid: move one bid onto it from above.
  for (const [amount, n] of counts) {
    if (amount < win && n === 1) {
      const donor = [...counts.entries()].find(([a, c]) => a > win && c >= 1);
      if (!donor) throw new Error('Could not balance the demo amounts');
      counts.set(donor[0], donor[1] - 1);
      if (donor[1] - 1 === 0) counts.delete(donor[0]);
      add(amount);
    }
  }
  const amounts = [...counts.entries()].flatMap(([amount, n]) => Array<number>(n).fill(amount));
  for (let i = amounts.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [amounts[i], amounts[j]] = [amounts[j], amounts[i]];
  }
  return amounts;
}

async function inBatches<T>(items: T[], size: number, work: (item: T, index: number) => Promise<void>, label: string) {
  let done = 0;
  let next = 0;
  const started = Date.now();
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const index = next++;
        await work(items[index], index);
        done += 1;
        if (done % 500 === 0 || done === items.length) {
          console.log(`  ${label}: ${done}/${items.length} (${Math.round((Date.now() - started) / 1000)}s)`);
        }
      }
    }),
  );
}

/** A slow database can let one transaction run past its time limit; the same request is safe to send again. */
async function withRetry<T>(work: () => Promise<T>, what: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= 5) throw error;
      const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
      console.log(`  retrying ${what} (${attempt}/4): ${reason.slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

async function main(): Promise<void> {
  const adminPhone = process.env.DEMO_ADMIN_PHONE;
  if (!adminPhone) throw new Error('Set DEMO_ADMIN_PHONE to the phone number of an ADMIN or SUPER_ADMIN account');
  const bidders = Number(process.env.DEMO_BIDDERS ?? 6000);
  const winMinor = etbToMinor(process.env.DEMO_WIN_AMOUNT ?? '9.30');
  const feeMinor = etbToMinor(process.env.DEMO_BID_FEE ?? '80');
  const imageUrl = process.env.DEMO_IMAGE_URL?.trim();
  let minBidMinor = etbToMinor(process.env.DEMO_MIN_BID ?? '1');
  let maxBidMinor = 10000n; // 100 ETB
  const resumeId = process.env.DEMO_AUCTION_ID?.trim();
  const concurrency = Math.max(1, Math.min(8, Number(process.env.DEMO_CONCURRENCY ?? 2)));
  if (!Number.isInteger(bidders) || bidders < 3 || bidders > 20000) throw new Error('DEMO_BIDDERS must be 3–20000');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const prisma = app.get(PrismaService);
    const client = { userAgent: 'demo-auction script' };
    const admin = await prisma.user.findUnique({
      where: { phoneNumber: adminPhone },
      include: { roles: { include: { role: true } } },
    });
    const adminRoles = admin?.roles.map((r) => r.role.name) ?? [];
    if (!admin || !adminRoles.some((r) => r === RoleName.ADMIN || r === RoleName.SUPER_ADMIN)) {
      throw new Error(`${adminPhone} is not an ADMIN or SUPER_ADMIN account`);
    }

    let auctionId: string;
    let feeToFund = feeMinor;
    if (resumeId) {
      const existing = await prisma.auction.findUnique({ where: { id: resumeId } });
      if (!existing) throw new Error(`No auction ${resumeId}`);
      if (existing.status !== 'ACTIVE')
        throw new Error(`Auction ${resumeId} is ${existing.status}; only an open one can be continued`);
      auctionId = existing.id;
      feeToFund = existing.bidFeeMinor;
      // The plan must be the one the stopped run used: the auction's own limits.
      minBidMinor = existing.minBidMinor;
      maxBidMinor = existing.maxBidMinor;
      console.log(`1/6 Continuing auction ${auctionId} "${existing.title}"`);
    } else {
      console.log(`1/6 Creating the product and auction "${TITLE}"`);
      const product = await app.get(ProductsService).create(
        admin.id,
        {
          name: TITLE,
          description: DESCRIPTION,
          brand: 'Apple',
          model: 'iPhone 18 Pro Max',
          specifications: SPECIFICATIONS,
          images: imageUrl ? [{ url: imageUrl, altText: TITLE }] : undefined,
        },
        client,
      );
      const auctions = app.get(AuctionsService);
      const auction = await auctions.create(
        admin.id,
        {
          productId: product.id,
          title: TITLE,
          description: DESCRIPTION,
          bidFeeMinor: feeMinor.toString(),
          minBidMinor: minBidMinor.toString(),
          maxBidMinor: maxBidMinor.toString(),
          bidStepMinor: '1',
          maxBidsPerUser: null,
          opensAt: new Date(Date.now() + 60_000).toISOString(),
          closesAt: new Date(Date.now() + 86_400_000).toISOString(),
          noUniqueBidPolicy: 'NO_WINNER',
        } as never,
        client,
      );
      auctionId = auction.id;
      await auctions.activate(admin.id, auctionId, client);
      console.log(`  auction ${auctionId} is open. If this run stops, continue it with DEMO_AUCTION_ID=${auctionId}`);
    }

    console.log(`2/6 Creating ${bidders} sample bidders`);
    const passwordHash = await app.get(PasswordService).hash(randomBytes(24).toString('base64'));
    const phones = Array.from({ length: bidders }, (_, i) => `+251999${String(i + 1).padStart(6, '0')}`);
    await prisma.user.createMany({
      data: phones.map((phoneNumber) => ({ phoneNumber, passwordHash })),
      skipDuplicates: true,
    });
    const users = await prisma.user.findMany({
      where: { phoneNumber: { in: phones } },
      select: { id: true, phoneNumber: true },
      orderBy: { phoneNumber: 'asc' },
    });
    const userRole = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.USER } });
    await prisma.userRole.createMany({
      data: users.map((u) => ({ userId: u.id, roleId: userRole.id })),
      skipDuplicates: true,
    });

    console.log(`3/6 Giving each bidder ${feeToFund / 100n} ETB for the bid fee`);
    const wallets = app.get(WalletService);
    await inBatches(
      users,
      Math.min(4, concurrency * 2),
      async (u) => {
        await withRetry(
          () =>
            wallets.deposit({
              userId: u.id,
              amountMinor: feeToFund,
              idempotencyKey: `demo:${auctionId}:${u.id}`,
              description: 'Demo top-up',
            }),
          `top-up for ${u.phoneNumber}`,
        );
      },
      'top-ups',
    );

    console.log('4/6 Placing one bid per bidder');
    const amounts = demoAmounts(users.length, Number(winMinor), Number(minBidMinor), Number(maxBidMinor), random(930));
    const bidding = app.get(BiddingService);
    // A continued run: bids already placed must be the ones this plan gives, or the winner would not be as asked.
    const placed = new Map(
      (await prisma.bid.findMany({ where: { auctionId }, select: { userId: true, amountMinor: true } })).map((b) => [
        b.userId,
        b.amountMinor,
      ]),
    );
    const mismatched = users.filter((u, i) => placed.has(u.id) && placed.get(u.id) !== BigInt(amounts[i])).length;
    if (mismatched > 0) {
      throw new Error(
        `${mismatched} bids already in this auction differ from the plan (another bidder count?). ` +
          'Run again with the same DEMO_BIDDERS, or without DEMO_AUCTION_ID to start a new auction.',
      );
    }
    if (placed.size > 0) console.log(`  ${placed.size} bids were already placed; placing the rest`);
    const todo = users.map((u, i) => ({ u, amount: amounts[i] })).filter(({ u }) => !placed.has(u.id));
    await inBatches(
      todo,
      concurrency,
      async ({ u, amount }) => {
        const user: AuthenticatedUser = {
          id: u.id,
          phoneNumber: u.phoneNumber,
          roles: [RoleName.USER],
          sessionId: 'demo',
          mustChangePassword: false,
        };
        await withRetry(
          () => bidding.place(user, auctionId, [String(amount)], `demo-${auctionId}`, client),
          `bid for ${u.phoneNumber}`,
        );
      },
      'bids',
    );

    console.log('5/6 Closing the auction and computing the result');
    await prisma.auction.update({ where: { id: auctionId }, data: { closesAt: new Date(Date.now() - 1000) } });
    const processor = app.get(AuctionLifecycleProcessor);
    let winner = null;
    for (let i = 0; i < 10 && !winner; i++) {
      await processor.process();
      winner = await prisma.winner.findUnique({ where: { auctionId: auctionId }, include: { user: true } });
      if (!winner) await new Promise((r) => setTimeout(r, 2000));
    }
    if (!winner) throw new Error('The auction closed but no winner was recorded; check the admin site');
    if (winner.amountMinor !== winMinor) throw new Error(`Unexpected winning amount ${winner.amountMinor}`);

    console.log('6/6 Verifying and publishing the winner');
    const winners = app.get(WinnersService);
    await winners.verify({ id: admin.id, client }, winner.id, 'Demo auction');
    await winners.publish({ id: admin.id, client }, winner.id);

    const result = await prisma.auctionResult.findUniqueOrThrow({ where: { auctionId: auctionId } });
    console.log('\nDone.');
    console.log(`  Auction:        ${auctionId}`);
    console.log(
      `  Bids:           ${result.totalBids} (${result.distinctAmounts} different amounts, ${result.uniqueAmounts} bid once)`,
    );
    console.log(`  Winner:         ${winner.user.phoneNumber} with ${Number(winMinor) / 100} ETB`);
    console.log('  See it on the Winners page of the site.');
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
