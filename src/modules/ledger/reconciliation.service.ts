import { Injectable } from '@nestjs/common';
import { LedgerAccountType, Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { debitNormalTypes } from './ledger.types';

export type ReconciliationIssueKind =
  | 'BALANCE_MISMATCH'
  | 'RUNNING_BALANCE_MISMATCH'
  | 'UNBALANCED_TRANSACTION'
  | 'NEGATIVE_BALANCE'
  | 'TRIAL_BALANCE_NOT_ZERO';

export interface ReconciliationIssue {
  kind: ReconciliationIssueKind;
  /** Ledger account code, journal id or currency the issue is about. */
  subject: string;
  detail: string;
}

export interface ReconciliationTotal {
  currency: string;
  accountType: LedgerAccountType;
  accounts: number;
  balanceMinor: bigint;
}

export interface ReconciliationReport {
  ok: boolean;
  checkedAt: Date;
  accounts: number;
  transactions: number;
  entries: number;
  totals: ReconciliationTotal[];
  /** At most ISSUE_LIMIT per kind. */
  issues: ReconciliationIssue[];
}

const ISSUE_LIMIT = 100;

/** Proves the cached balances from the immutable ledger lines. Read-only. */
@Injectable()
export class ReconciliationService {
  constructor(private readonly prisma: PrismaService) {}

  reconcile(): Promise<ReconciliationReport> {
    const debitNormal = debitNormalTypes();
    // One snapshot for all checks, so postings that commit mid-run cannot produce false alarms.
    return this.prisma.$transaction(
      async (tx) => {
        const issues: ReconciliationIssue[] = [];

        const mismatched = await tx.$queryRaw<{ code: string; cached: string; expected: string }[]>`
          SELECT code, balance_minor::text AS cached, expected::text AS expected
          FROM (
            SELECT a.code, a.balance_minor,
                   COALESCE(SUM(CASE WHEN (e.direction = 'DEBIT') = (a.type::text = ANY(${debitNormal}))
                                     THEN e.amount_minor ELSE -e.amount_minor END), 0) AS expected
            FROM ledger_accounts a
            LEFT JOIN ledger_entries e ON e.account_id = a.id
            GROUP BY a.id
          ) x
          WHERE balance_minor <> expected
          ORDER BY code
          LIMIT ${ISSUE_LIMIT}`;
        for (const row of mismatched) {
          issues.push({
            kind: 'BALANCE_MISMATCH',
            subject: row.code,
            detail: `cached balance ${row.cached} but ledger lines sum to ${row.expected}`,
          });
        }

        const running = await tx.$queryRaw<{ code: string; cached: string; last: string }[]>`
          SELECT a.code, a.balance_minor::text AS cached, l.balance_after_minor::text AS last
          FROM ledger_accounts a
          JOIN LATERAL (
            SELECT balance_after_minor FROM ledger_entries e
            WHERE e.account_id = a.id ORDER BY e.sequence DESC LIMIT 1
          ) l ON true
          WHERE l.balance_after_minor <> a.balance_minor
          ORDER BY a.code
          LIMIT ${ISSUE_LIMIT}`;
        for (const row of running) {
          issues.push({
            kind: 'RUNNING_BALANCE_MISMATCH',
            subject: row.code,
            detail: `cached balance ${row.cached} but the latest ledger line recorded ${row.last}`,
          });
        }

        const unbalanced = await tx.$queryRaw<{ transaction_id: string; debits: string; credits: string }[]>`
          SELECT transaction_id::text,
                 COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'DEBIT'), 0)::text AS debits,
                 COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'CREDIT'), 0)::text AS credits
          FROM ledger_entries
          GROUP BY transaction_id
          HAVING COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'DEBIT'), 0)
              <> COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'CREDIT'), 0)
          LIMIT ${ISSUE_LIMIT}`;
        for (const row of unbalanced) {
          issues.push({
            kind: 'UNBALANCED_TRANSACTION',
            subject: row.transaction_id,
            detail: `debits ${row.debits}, credits ${row.credits}`,
          });
        }

        const negative = await tx.ledgerAccount.findMany({
          where: { allowNegative: false, balanceMinor: { lt: 0 } },
          select: { code: true, balanceMinor: true },
          take: ISSUE_LIMIT,
        });
        for (const row of negative) {
          issues.push({ kind: 'NEGATIVE_BALANCE', subject: row.code, detail: `balance ${row.balanceMinor}` });
        }

        const grouped = await tx.ledgerAccount.groupBy({
          by: ['currency', 'type'],
          _sum: { balanceMinor: true },
          _count: { _all: true },
          orderBy: [{ currency: 'asc' }, { type: 'asc' }],
        });
        const totals: ReconciliationTotal[] = grouped.map((g) => ({
          currency: g.currency,
          accountType: g.type,
          accounts: g._count._all,
          balanceMinor: g._sum.balanceMinor ?? 0n,
        }));

        // Credit-normal balances minus debit-normal balances must net to zero in every currency.
        const net = new Map<string, bigint>();
        for (const t of totals) {
          const signed = debitNormal.includes(t.accountType) ? -t.balanceMinor : t.balanceMinor;
          net.set(t.currency, (net.get(t.currency) ?? 0n) + signed);
        }
        for (const [currency, value] of net) {
          if (value !== 0n) {
            issues.push({
              kind: 'TRIAL_BALANCE_NOT_ZERO',
              subject: currency,
              detail: `account balances are out of balance by ${value}`,
            });
          }
        }

        const [accounts, transactions, entries] = await Promise.all([
          tx.ledgerAccount.count(),
          tx.walletTransaction.count(),
          tx.ledgerEntry.count(),
        ]);
        return { ok: issues.length === 0, checkedAt: new Date(), accounts, transactions, entries, totals, issues };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10_000, timeout: 60_000 },
    );
  }
}
