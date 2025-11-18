import hash from 'object-hash';
import config from 'nconf';
import moment, { Moment } from 'moment';
import { AxiosResponse } from 'axios';
import manipulateTxs from './credit-cards.js';
import {
  createAccount,
  createTx,
  deleteTx,
  getAccounts,
  getAllTxs,
  getConfig,
  searchTxs,
  updateTx,
  upsertConfig,
  getOrCreateExpenseAccount,
} from '../firefly.js';
import {
  getFlatUsers,
  getLightResult,
  getSuccessfulScrappedUsers,
  logErrorResult,
  parseScrapResult,
  scrapAccounts,
} from './scrapper.js';
import logger from '../logger.js';
import { getStateWithLastImport } from './last-import-helper.js';
import {
  applyTransferDetection,
  convertCreditCardPayments,
} from './transfer-detector.js';

interface Account {
  id: string;
  kind: string;
  type: string;
}

interface AccountsMap {
  [key: string]: Account;
}

interface AccountDetails {
  kind: string;
  type: string;
}

interface ScrapperAccount {
  accountNumber: string;
  balance: number;
  txns: ScrappedTransaction[];
  accountDetails: AccountDetails;
}

interface ScrappedTransaction {
  status: string;
  chargedAmount: number;
  date: string;
  description: string;
  memo?: string;
  identifier: string;
  chargedCurrency?: string;
  originalCurrency?: string;
  processedDate: string;
  category?: string;
}

interface FormattedTransaction {
  type: string;
  date: string;
  amount: number;
  description?: string;
  notes?: string;
  source_id?: string;
  destination_id?: string;
  internal_reference?: string;
  external_id: string;
  currency_code?: string;
  process_date?: string;
  category_name?: string;
  tags?: string[];
  [key: string]: unknown;
}

interface ExistingTransaction {
  id: string;
  type: string;
  source_id?: string;
  destination_id?: string;
  description?: string;
}

interface ExistsTxMap {
  [key: string]: ExistingTransaction;
}

interface FireflyTransaction {
  id: string;
  attributes: {
    transactions: Array<{
      type: string;
      external_id?: string;
      date: string;
      description?: string;
      amount: string;
      source_id?: string;
      destination_id?: string;
    }>;
  };
}

interface ImportOptions {
  skipEdit?: boolean;
  onlyAccounts?: string[];
  cleanup?: boolean;
  since?: string;
  removeDuplicates?: boolean;
  listTransactions?: boolean;
  dryRun?: boolean;
  backfill?: boolean;
  dateTolerance?: number;
}

interface State {
  lastImport?: unknown;
  [key: string]: unknown;
}

interface FireflyAccountBalance {
  accountNumber: string;
  balance: number;
}

async function getMappedTransactions(
  scrapeFormattedTxs: FormattedTransaction[],
): Promise<ExistsTxMap> {
  const minimalDate = scrapeFormattedTxs
    .map((x) => moment(x.date))
    .reduce((m: Moment, x: Moment) => (x.isBefore(m) ? x : m), moment());
  const getTxSince = moment(minimalDate).subtract(1, 'day');
  const since = getTxSince.format('YYYY-MM-DD');
  logger().info({ since }, 'Getting firefly transactions to compare...');
  const workingTxs = (await searchTxs({
    date_after: since,
  })) as FireflyTransaction[];
  logger().debug(
    {
      numberOfTransactionsFromFirefly: workingTxs.length,
      since,
    },
    'Got transactions from firefly',
  );
  return getExistsTxMap(workingTxs);
}

function getCurrencyCode(x: ScrappedTransaction): string | undefined {
  const currency = x.chargedCurrency || x.originalCurrency;
  if (!currency) {
    return undefined;
  }
  const currencyMap: Record<string, string> = config.get('currencySymbolMap') || {};
  return currencyMap[currency] || currency;
}

async function getFireflyState(): Promise<State> {
  try {
    const axiosState: AxiosResponse = await getConfig();
    return JSON.parse(axiosState.data.data.attributes.data);
  } catch (err: unknown) {
    const error = err as { response?: { status?: number } };
    if (error?.response?.status === 404) {
      logger().debug(
        'Firefly previous state not found (its ok if its first run), using empty object.',
      );
      return {};
    }
    throw err;
  }
}

export default async function doImport(options: ImportOptions): Promise<void> {
  const { skipEdit } = options;
  const { onlyAccounts } = options;
  const { cleanup } = options;
  const { since } = options;
  const { removeDuplicates } = options;
  const { listTransactions } = options;
  const { dryRun } = options;
  const { backfill } = options;
  const { dateTolerance } = options;

  if (cleanup) {
    await drop();
    return;
  }

  if (removeDuplicates) {
    await removeDuplicatesFromFirefly();
    return;
  }

  if (listTransactions) {
    await listAllTransactions();
    return;
  }

  // Handle backfill mode
  if (backfill) {
    await backfillTransfers(dryRun ?? false, dateTolerance ?? 2, since);
    return;
  }

  logger().info('Getting state from firefly...');
  const state = await getFireflyState();
  const lastImportState = state.lastImport;

  logger().info('Getting scrape data...');
  const flatUsers = getFlatUsers(
    onlyAccounts,
    lastImportState as Record<string, string> | undefined,
    since,
  );
  const scrapResult = await scrapAccounts(flatUsers);
  logErrorResult(scrapResult, flatUsers);
  if (logger().level === 'debug') {
    logger().debug({ results: getLightResult(scrapResult) }, 'Scrape result');
  }
  const accounts = parseScrapResult(
    scrapResult,
    flatUsers,
  ) as unknown as ScrapperAccount[];

  logger().info('Getting or creating accounts...');
  const accountsMaps = await createAndMapAccounts(accounts);

  type TxWithAccount = ScrappedTransaction & { account: Account };

  const scrapeFormattedTxs: FormattedTransaction[] = await accounts
    .flatMap((a: ScrapperAccount) => a.txns.map((tx: ScrappedTransaction) => ({
      ...tx,
      account: accountsMaps[a.accountNumber],
    })))
    .filter(
      (x): x is TxWithAccount => x.status === 'completed' && Boolean(x.account),
    )
    .filter((x) => x.chargedAmount)
    .reduce(async (promiseAcc, x) => {
      const acc = await promiseAcc;

      // For credit card withdrawals (spending), create/get expense account for merchant
      let destinationId = x.chargedAmount > 0 ? x.account.id : undefined;
      if (
        x.chargedAmount < 0
        && x.account.kind === 'credit-card'
        && x.description
      ) {
        try {
          destinationId = await getOrCreateExpenseAccount(
            x.description,
            dryRun ?? false,
          );
        } catch (error) {
          logger().warn(
            {
              error,
              description: x.description,
              accountId: x.account.id,
            },
            'Failed to create expense account for merchant, leaving destination empty',
          );
        }
      }

      acc.push({
        type: x.chargedAmount > 0 ? 'deposit' : 'withdrawal',
        date: x.date,
        amount: Math.abs(x.chargedAmount),
        description: x.description,
        notes: x.memo,
        source_id: x.chargedAmount > 0 ? undefined : x.account.id,
        destination_id: destinationId,
        internal_reference: x.identifier,
        external_id: getExternalId(x),
        currency_code: getCurrencyCode(x),
        process_date: x.processedDate,
        category_name: x.category,
      });

      return acc;
    }, Promise.resolve([] as FormattedTransaction[]));

  logger().info('Manipulating...');
  const preparedFireTxs = await manipulateTxs(scrapeFormattedTxs, accountsMaps);

  // First, detect and convert credit card payments to transfers
  logger().info(
    'Detecting and converting credit card payments to transfers...',
  );
  const ccPaymentResult = convertCreditCardPayments(
    preparedFireTxs,
    accountsMaps,
  );
  logger().debug(
    {
      ccPaymentsConverted: ccPaymentResult.transfers.length,
      remaining: ccPaymentResult.remaining.length,
    },
    'Credit card payment detection complete',
  );

  // Then, detect and convert matching deposit/withdrawal pairs to transfers
  logger().info(
    'Detecting and converting matching deposit/withdrawal pairs to transfers...',
  );
  // Fetch existing transfers from the same date range to check for duplicates
  const minimalDate = scrapeFormattedTxs
    .map((x) => moment(x.date))
    .reduce((m: Moment, x: Moment) => (x.isBefore(m) ? x : m), moment());
  const transferSince = moment(minimalDate)
    .subtract(3, 'days')
    .format('YYYY-MM-DD');
  logger().debug(
    { since: transferSince },
    'Fetching existing transfers for duplicate detection',
  );
  const existingTxs = (await searchTxs({
    date_after: transferSince,
  })) as FireflyTransaction[];
  const existingTransfers = existingTxs
    .filter((tx) => tx.attributes.transactions[0]?.type === 'transfer')
    .map((tx) => {
      const txData = tx.attributes.transactions[0];
      if (!txData) return null;
      return {
        id: tx.id,
        type: txData.type,
        date: txData.date,
        amount: parseFloat(txData.amount),
        source_id: txData.source_id,
        destination_id: txData.destination_id,
        external_id: txData.external_id,
      };
    })
    .filter((tx): tx is NonNullable<typeof tx> => tx !== null);
  logger().debug(
    { count: existingTransfers.length },
    'Found existing transfers',
  );

  // Apply transfer detection to remaining transactions (after credit card payment detection)
  const transferDetectedResult = applyTransferDetection(
    ccPaymentResult.remaining as unknown as Array<{
      type: string;
      date: string;
      amount: number;
      description?: string;
      notes?: string;
      source_id?: string;
      destination_id?: string;
      external_id: string;
      currency_code?: string;
      category_name?: string;
      internal_reference?: string;
      tags?: string[];
      process_date?: string;
    }>,
    config,
    existingTransfers as unknown as Array<{
      id?: string;
      type: string;
      date: string;
      amount: number;
      source_id?: string;
      destination_id?: string;
      external_id?: string;
    }>,
  );

  // Combine credit card payment transfers with regular transfers
  const transferDetectedTxs = [
    ...ccPaymentResult.transfers,
    ...transferDetectedResult,
  ];

  // Remove duplicates based on external_id, keeping only the first occurrence
  const seenExternalIds = new Set<string>();
  const deduplicatedTxs = transferDetectedTxs.filter((tx) => {
    if (seenExternalIds.has(tx.external_id)) {
      return false;
    }
    seenExternalIds.add(tx.external_id);
    return true;
  });

  const duplicatesCount = transferDetectedTxs.length - deduplicatedTxs.length;
  if (duplicatesCount > 0) {
    logger().info(
      {
        duplicatesRemoved: duplicatesCount,
        totalBefore: transferDetectedTxs.length,
        totalAfter: deduplicatedTxs.length,
      },
      'Removed duplicate transactions with same external_id',
    );
  }

  const currentTxMap = await getMappedTransactions(scrapeFormattedTxs);

  const toCreate = deduplicatedTxs.filter((x) => !currentTxMap[x.external_id]);
  const insertDebugData = logger().level === 'debug' ? { toCreate } : {};

  if (dryRun) {
    logger().info(
      { count: toCreate.length, ...insertDebugData },
      '🔍 DRY RUN - Would create transactions',
    );
  } else {
    logger().info(
      { count: toCreate.length, ...insertDebugData },
      'Creating transactions to firefly...',
    );
    await toCreate.reduce(
      (p, x, i) => p.then(() => innerCreateTx(x, i + 1)),
      Promise.resolve(),
    );
  }

  const toTypeUpdate = deduplicatedTxs.filter(
    (x) => currentTxMap[x.external_id]
      && currentTxMap[x.external_id]?.type !== x.type,
  );
  const updateDebugData = logger().level === 'debug' ? { toTypeUpdate } : {};

  if (dryRun) {
    logger().info(
      { count: toTypeUpdate.length, ...updateDebugData },
      '🔍 DRY RUN - Would update transaction types',
    );
  } else {
    logger().info(
      { count: toTypeUpdate.length, ...updateDebugData },
      'Updating transactions types to firefly...',
    );
    await toTypeUpdate.reduce((p, x, i) => {
      const existingTx = currentTxMap[x.external_id];
      if (!existingTx) return p;
      return p.then(() => innerUpdateTx(existingTx, x, i + 1));
    }, Promise.resolve());
  }

  // Check for existing credit card transactions without destination accounts
  // and add destination accounts based on merchant names
  const toAddDestination = deduplicatedTxs.filter((x) => {
    const existing = currentTxMap[x.external_id];
    if (!existing) return false;
    // Check if it's a credit card withdrawal that needs a destination account
    // The new transaction has a destination_id but the existing one doesn't
    return (
      existing.type === 'withdrawal'
      && x.type === 'withdrawal'
      && x.destination_id
      && !existing.destination_id
      && x.source_id === existing.source_id
    );
  });

  if (toAddDestination.length > 0) {
    const addDestinationDebugData = logger().level === 'debug' ? { toAddDestination } : {};

    if (dryRun) {
      logger().info(
        { count: toAddDestination.length, ...addDestinationDebugData },
        '🔍 DRY RUN - Would add destination accounts to existing credit card transactions',
      );
    } else {
      logger().info(
        { count: toAddDestination.length, ...addDestinationDebugData },
        'Adding destination accounts to existing credit card transactions...',
      );
      await toAddDestination.reduce((p, x, i) => {
        const existingTx = currentTxMap[x.external_id];
        if (!existingTx) return p;
        return p.then(() => innerUpdateTx(existingTx, x, i + 1));
      }, Promise.resolve());
    }
  }

  if (!skipEdit) {
    const toUpdate = deduplicatedTxs.filter(
      (x) => currentTxMap[x.external_id]
        && currentTxMap[x.external_id]?.type === x.type
        // Don't include transactions that are being updated for destination accounts
        && !toAddDestination.some((dest) => dest.external_id === x.external_id),
    );

    if (dryRun) {
      logger().info(
        { count: toUpdate.length },
        '🔍 DRY RUN - Would update transactions',
      );
    } else {
      logger().info(
        { count: toUpdate.length },
        'Updating transactions to firefly...',
      );
      await toUpdate.reduce((p, x, i) => {
        const existingTx = currentTxMap[x.external_id];
        if (!existingTx) return p;
        return p.then(() => innerUpdateTx(existingTx, x, i + 1));
      }, Promise.resolve());
    }
  }

  const accountsBalance = await getFireflyAccountsBalance();
  logBalanceOutOfSync(accountsBalance, accounts);

  if (!dryRun) {
    logger().info('Updating last import...');
    const scrappedUsers = getSuccessfulScrappedUsers(scrapResult, flatUsers);
    const updatedState = getStateWithLastImport(
      scrappedUsers as unknown as never[],
      state as never,
    );
    await upsertConfig(JSON.stringify(updatedState));
  } else {
    logger().info('🔍 DRY RUN - Skipping last import state update');
  }

  logger().info('Done.');
}

function getExistsTxMap(fireflyData: FireflyTransaction[]): ExistsTxMap {
  return fireflyData
    .map((x) => ({
      type: x.attributes.transactions[0]?.type,
      ext_id: x.attributes.transactions[0]?.external_id,
      id: x.id,
      source_id: x.attributes.transactions[0]?.source_id,
      destination_id: x.attributes.transactions[0]?.destination_id,
      description: x.attributes.transactions[0]?.description,
    }))
    .reduce(
      (
        m: ExistsTxMap,
        {
          id, ext_id: extId, type, source_id, destination_id, description,
        },
      ) => {
        if (!extId || !type) return m;
        return {
          ...m,
          [extId]: {
            id,
            type,
            source_id,
            destination_id,
            description,
          },
        };
      },
      {},
    );
}

function calcMonthlyPaymentDate(account: ScrapperAccount): string {
  const sumMap = account.txns
    .map((x) => moment(x.processedDate).date())
    .reduce(
      (m: Record<number, number>, x: number) => ({
        ...m,
        [x]: (m[x] || 0) + 1,
      }),
      {},
    );

  const topDate = Object.keys(sumMap).reduce((m: number, x: string) => {
    const numX = parseInt(x, 10);
    return m && (sumMap[m] || 0) > (sumMap[numX] || 0) ? m : numX;
  }, 0);

  return moment().set('date', topDate).format('YYYY-MM-DD');
}

async function getFireflyAccountsBalance(): Promise<FireflyAccountBalance[]> {
  const rawAccounts: AxiosResponse = await getAccounts();
  return rawAccounts.data.data.map(
    (x: {
      attributes: { account_number: string; current_balance: string };
    }) => ({
      accountNumber: x.attributes.account_number,
      balance: parseFloat(x.attributes.current_balance),
    }),
  );
}

function logBalanceOutOfSync(
  fireflyAccounts: FireflyAccountBalance[],
  scrapeAccounts: ScrapperAccount[],
): void {
  const fireflyAccountsBalanceMap = fireflyAccounts.reduce(
    (m: Record<string, number>, x) => ({
      ...m,
      [x.accountNumber]: x.balance,
    }),
    {},
  );
  scrapeAccounts
    .map((x) => ({
      accountNumber: x.accountNumber,
      scrapeBalance: x.balance,
      fireflyBalance: fireflyAccountsBalanceMap[x.accountNumber],
    }))
    .filter((x) => x.scrapeBalance && x.scrapeBalance !== x.fireflyBalance)
    .forEach((x) => logger().warn(x, 'Non synced balance'));
}

async function createAndMapAccounts(
  scrapperAccounts: ScrapperAccount[],
): Promise<AccountsMap> {
  const map = scrapperAccounts.reduce(
    (m: Record<string, ScrapperAccount>, x) => ({
      ...m,
      [x.accountNumber]: x,
    }),
    {},
  );

  const rawAccounts: AxiosResponse = await getAccounts();

  logger().debug(
    {
      totalFireflyAccounts: rawAccounts.data.data.length,
      scrapperAccountNumbers: Object.keys(map),
      allFireflyAccountNumbers: rawAccounts.data.data.map(
        (acc: {
          id: string;
          attributes: { account_number: string; name: string; type: string };
        }) => ({
          id: acc.id,
          account_number: acc.attributes.account_number,
          name: acc.attributes.name,
          type: acc.attributes.type,
        }),
      ),
    },
    'Starting account matching',
  );

  const accountsMap = rawAccounts.data.data
    .map(
      (x: {
        id: string;
        attributes: { account_number: string; name: string; type: string };
      }) => {
        // Try to match by account_number first, then by name
        const accountNumber = x.attributes.account_number;
        const accountName = x.attributes.name;
        const accountType = x.attributes.type;

        logger().debug(
          {
            fireflyAccountId: x.id,
            accountNumber,
            accountName,
            accountType,
            inScrapperByNumber: !!map[accountNumber],
            inScrapperByName: !!map[accountName],
          },
          'Checking Firefly account',
        );

        // Find matching scrapper account
        let matchedAccountNumber: string | undefined;
        if (accountNumber && map[accountNumber]) {
          matchedAccountNumber = accountNumber;
          logger().debug(
            { accountNumber, fireflyAccountId: x.id },
            'Matched by account_number',
          );
        } else if (accountName && map[accountName]) {
          matchedAccountNumber = accountName;
          logger().debug(
            { accountName, fireflyAccountId: x.id },
            'Matched by name',
          );
        } else {
          logger().debug(
            { accountNumber, accountName, fireflyAccountId: x.id },
            'No match found for Firefly account',
          );
        }

        if (!matchedAccountNumber) return null;

        return {
          id: x.id,
          accountNumber: matchedAccountNumber,
        };
      },
    )
    .filter(
      (
        x: { id: string; accountNumber: string } | null,
      ): x is { id: string; accountNumber: string } => x !== null,
    )
    .reduce((m: AccountsMap, x: { id: string; accountNumber: string }) => {
      const accountData = map[x.accountNumber];
      if (!accountData) return m;
      return {
        ...m,
        [x.accountNumber]: {
          ...accountData.accountDetails,
          id: x.id,
        },
      };
    }, {});

  logger().debug(
    {
      matchedAccounts: Object.keys(accountsMap),
      matchedCount: Object.keys(accountsMap).length,
    },
    'Account matching complete',
  );
  const missedAccounts = [
    ...new Set(
      scrapperAccounts
        .map((x) => x.accountNumber)
        .filter((x) => !accountsMap[x]),
    ),
  ];

  logger().debug(
    {
      allScrapperAccounts: scrapperAccounts.map((x) => x.accountNumber),
      matchedAccounts: Object.keys(accountsMap),
      missedAccounts,
    },
    'Account comparison complete',
  );

  if (missedAccounts.length === 0) {
    logger().debug('All scrapper accounts found in Firefly');
    return accountsMap;
  }

  logger().info(
    { missedAccounts },
    'Accounts are missing from Firefly, creating them...',
  );

  const results = await missedAccounts.reduce(
    (m, a) => m.then(async (x: AxiosResponse[]) => {
      const accountData = map[a];
      if (!accountData) return x;

      try {
        const result = await createAccount({
          name: a,
          account_number: a,
          type: 'asset',
          account_role:
              accountData.accountDetails.kind === 'bank'
                ? 'defaultAsset'
                : 'ccAsset',
          ...(accountData.accountDetails.kind !== 'bank'
            ? {
              credit_card_type: 'monthlyFull',
              monthly_payment_date: calcMonthlyPaymentDate(accountData),
            }
            : {}),
        });
        return [...x, result];
      } catch (error: unknown) {
        const err = error as {
            response?: { status?: number; data?: unknown };
          };
          // If account already exists (422), try to find it
        if (err?.response?.status === 422) {
          logger().warn(
            { accountNumber: a },
            'Account already exists in Firefly, fetching existing account',
          );

          // Re-fetch accounts to find the existing one
          const refreshedAccounts: AxiosResponse = await getAccounts();

          logger().debug(
            {
              lookingFor: a,
              totalAccountsInFirefly: refreshedAccounts.data.data.length,
            },
            'Searching for existing account in Firefly',
          );

          // Try to find by account_number first, then by name
          let existingAccount = refreshedAccounts.data.data.find(
            (acc: { attributes: { account_number: string; name: string } }) => acc.attributes.account_number === a,
          );

          if (existingAccount) {
            logger().debug(
              { accountNumber: a, fireflyAccountId: existingAccount.id },
              'Found account by account_number field',
            );
          }

          // If not found by account_number, try by name
          if (!existingAccount) {
            logger().debug(
              { accountNumber: a },
              'Not found by account_number, trying by name field',
            );

            existingAccount = refreshedAccounts.data.data.find(
              (acc: {
                  attributes: { account_number: string; name: string };
                }) => acc.attributes.name === a,
            );

            if (existingAccount) {
              logger().debug(
                { accountNumber: a, fireflyAccountId: existingAccount.id },
                'Found account by name field',
              );
            }
          }

          if (existingAccount) {
            logger().info(
              { accountNumber: a, accountId: existingAccount.id },
              'Found existing account',
            );
            // Return a mock AxiosResponse structure
            return [
              ...x,
              {
                data: { data: existingAccount },
                status: 200,
                statusText: 'OK',
                headers: {},
                config: {} as never,
              },
            ];
          }

          // If still not found, log all accounts for debugging
          logger().error(
            {
              accountNumber: a,
              totalAccounts: refreshedAccounts.data.data.length,
              sampleAccounts: refreshedAccounts.data.data.slice(0, 5).map(
                (acc: {
                    attributes: {
                      account_number: string;
                      name: string;
                      type: string;
                    };
                  }) => ({
                  account_number: acc.attributes.account_number,
                  name: acc.attributes.name,
                  type: acc.attributes.type,
                }),
              ),
            },
            'Account exists in Firefly but could not be found by account_number or name',
          );

          // Since the account exists (422 error), skip it and continue
          // This prevents the import from failing completely
          return x;
        }

        // Re-throw if not a 422 or if we couldn't find the account
        throw error;
      }
    }),
    Promise.resolve([] as AxiosResponse[]),
  );

  return results.reduce((m: AccountsMap, x: AxiosResponse) => {
    const accountNumber = x.data.data.attributes.account_number;
    const accountData = map[accountNumber];
    if (!accountData) return m;
    return {
      ...m,
      [accountNumber]: {
        ...accountData.accountDetails,
        id: x.data.data.id,
      },
    };
  }, accountsMap);
}

async function listAllTransactions(): Promise<void> {
  logger().info('Getting all transactions from Firefly...');
  const fireflyData = (await getAllTxs()) as FireflyTransaction[];

  logger().info(
    {
      totalTransactions: fireflyData.length,
    },
    'Total transactions in Firefly',
  );

  // Group and count by external_id
  const externalIdCounts: Record<string, unknown[]> = {};
  const transactionsWithoutExternalId: unknown[] = [];

  fireflyData.forEach((tx) => {
    const txData = tx.attributes.transactions[0];
    const externalId = txData?.external_id;

    if (!externalId || !txData) {
      if (txData) {
        transactionsWithoutExternalId.push({
          id: tx.id,
          date: txData.date,
          description: txData.description,
          amount: txData.amount,
        });
      }
    } else {
      if (!externalIdCounts[externalId]) {
        externalIdCounts[externalId] = [];
      }
      externalIdCounts[externalId].push({
        id: tx.id,
        date: txData.date,
        description: txData.description,
        amount: txData.amount,
      });
    }
  });

  const withExternalId = Object.keys(externalIdCounts).length;
  const duplicates = Object.entries(externalIdCounts).filter(
    ([, txs]) => txs.length > 1,
  );

  logger().info(
    {
      withExternalId,
      withoutExternalId: transactionsWithoutExternalId.length,
      duplicateGroups: duplicates.length,
      totalDuplicateTransactions: duplicates.reduce(
        (sum, [, txs]) => sum + txs.length - 1,
        0,
      ),
    },
    'Transaction statistics',
  );

  // Show first 20 transactions for inspection
  /* eslint-disable no-console */
  console.log('\n=== First 20 Transactions ===');
  fireflyData.slice(0, 20).forEach((tx) => {
    const txData = tx.attributes.transactions[0];
    if (!txData) return;
    console.log(
      JSON.stringify(
        {
          id: tx.id,
          external_id: txData.external_id || 'NULL',
          date: txData.date,
          description: txData.description?.substring(0, 50),
          amount: txData.amount,
        },
        null,
        2,
      ),
    );
  });

  // Show duplicates if any
  if (duplicates.length > 0) {
    console.log('\n=== Duplicate External IDs ===');
    duplicates.slice(0, 10).forEach(([externalId, txs]) => {
      console.log(`\nExternal ID: ${externalId} (${txs.length} transactions)`);
      (
        txs as {
          id: string;
          date: string;
          amount: string;
          description?: string;
        }[]
      ).forEach((tx) => {
        console.log(
          `  - ID: ${tx.id}, Date: ${tx.date}, Amount: ${
            tx.amount
          }, Desc: ${tx.description?.substring(0, 40)}`,
        );
      });
    });
  }

  // Show transactions without external_id if any
  if (transactionsWithoutExternalId.length > 0) {
    console.log('\n=== Transactions Without External ID (first 10) ===');
    (
      transactionsWithoutExternalId.slice(0, 10) as {
        id: string;
        date: string;
        amount: string;
        description?: string;
      }[]
    ).forEach((tx) => {
      console.log(
        `  - ID: ${tx.id}, Date: ${tx.date}, Amount: ${
          tx.amount
        }, Desc: ${tx.description?.substring(0, 40)}`,
      );
    });
  }
  /* eslint-enable no-console */
}

async function removeDuplicatesFromFirefly(): Promise<void> {
  logger().info('Getting all transactions from Firefly to find duplicates...');
  const fireflyData = (await getAllTxs()) as FireflyTransaction[];

  logger().info(
    {
      totalTransactions: fireflyData.length,
    },
    'Total transactions retrieved from Firefly',
  );

  // Group transactions by external_id
  const transactionsByExternalId: Record<
    string,
    Array<{
      id: string;
      date: string;
      description?: string;
      amount: string;
    }>
  > = {};
  let withExternalId = 0;
  let withoutExternalId = 0;

  fireflyData.forEach((tx) => {
    const txData = tx.attributes.transactions[0];
    const externalId = txData?.external_id;
    if (!externalId || !txData) {
      withoutExternalId += 1;
      if (logger().level === 'debug' && withoutExternalId <= 5 && txData) {
        logger().debug(
          {
            id: tx.id,
            description: txData.description,
            date: txData.date,
          },
          'Transaction without external_id (showing first 5)',
        );
      }
      return; // Skip transactions without external_id
    }
    withExternalId += 1;
    if (!transactionsByExternalId[externalId]) {
      transactionsByExternalId[externalId] = [];
    }
    transactionsByExternalId[externalId].push({
      id: tx.id,
      date: txData.date,
      description: txData.description,
      amount: txData.amount,
    });
  });

  logger().info(
    {
      withExternalId,
      withoutExternalId,
      uniqueExternalIds: Object.keys(transactionsByExternalId).length,
    },
    'Transaction external_id statistics',
  );

  // Find duplicates (external_ids with more than one transaction)
  const duplicateGroups = Object.entries(transactionsByExternalId).filter(
    ([, txs]) => txs.length > 1,
  );

  if (duplicateGroups.length === 0) {
    logger().info('No duplicate transactions found in Firefly.');
    if (logger().level === 'debug') {
      // Show some sample external_ids for debugging
      const sampleExternalIds = Object.keys(transactionsByExternalId).slice(
        0,
        10,
      );
      logger().debug(
        {
          sampleExternalIds,
          sampleCount: sampleExternalIds.length,
        },
        'Sample of unique external_ids found',
      );
    }
    return;
  }

  // For each duplicate group, keep the first one and delete the rest
  const toDelete: Array<{
    id: string;
    date: string;
    description?: string;
    amount: string;
  }> = [];
  duplicateGroups.forEach(([externalId, txs]) => {
    // Sort by date to keep the earliest transaction
    const sorted = txs.sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    );
    const toKeep = sorted[0];
    if (!toKeep) return;
    const duplicates = sorted.slice(1);

    logger().info(
      {
        externalId,
        keeping: {
          id: toKeep.id,
          date: toKeep.date,
          description: toKeep.description,
        },
        deleting: duplicates.map((d) => ({ id: d.id, date: d.date })),
      },
      'Found duplicate transactions',
    );

    toDelete.push(...duplicates);
  });

  logger().info(
    {
      duplicateGroups: duplicateGroups.length,
      totalDuplicates: toDelete.length,
      totalTransactions: fireflyData.length,
    },
    'Removing duplicate transactions from Firefly...',
  );

  let count = 0;
  await toDelete.reduce(
    (p, tx) => p.then(async () => {
      await deleteTx(tx.id);
      count += 1;
      if (count % 50 === 0) {
        logger().info(
          { currentAmount: count, total: toDelete.length },
          'Duplicate transactions deleted',
        );
      }
    }),
    Promise.resolve(),
  );

  logger().info(
    { totalDeleted: count },
    'Finished removing duplicate transactions.',
  );
}

async function drop(): Promise<void> {
  logger().info('Getting data for drop');
  const fireflyData = (await getAllTxs()) as FireflyTransaction[];
  const toDrop = fireflyData.map((x) => ({
    id: x.id,
    ...x.attributes.transactions[0],
  }));

  logger().info(
    {
      count: toDrop.length,
      total: fireflyData.length,
    },
    'Dropping transactions',
  );

  let count = 1;
  await toDrop.reduce(
    (p, tx) => p.then(async () => {
      await deleteTx(tx.id);
      count += 1;
      if (count % 50 === 0) {
        logger().info({ currentAmount: count }, 'Transactions deleted');
      }
    }),
    Promise.resolve(),
  );
}

async function innerCreateTx(
  tx: FormattedTransaction,
  count: number,
): Promise<void> {
  try {
    await createTx([tx]);
    if (count % 50 === 0) {
      logger().info({ currentAmount: count }, 'Transactions created.');
    }
  } catch (e: unknown) {
    const error = e as { response?: { data?: { message?: string } } };
    logger().error(
      {
        message: error?.response?.data?.message,
        error: e,
        tx,
      },
      'Error creating transaction',
    );
  }
}

async function innerUpdateTx(
  existingTx: ExistingTransaction,
  tx: FormattedTransaction,
  count: number,
): Promise<void> {
  try {
    if (existingTx.type !== tx.type) {
      await deleteTx(existingTx.id);
      await createTx([tx]);
    } else {
      await updateTx(existingTx.id, [tx]);
    }
    if (count % 50 === 0) {
      logger().info({ currentAmount: count }, 'Transactions updated.');
    }
  } catch (e: unknown) {
    const error = e as { response?: { data?: { message?: string } } };
    logger().error(
      {
        message: error?.response?.data?.message,
        error: e,
        tx,
      },
      'Error updating transaction',
    );
  }
}

const getters: Record<
  string,
  (x: ScrappedTransaction & { account: Account }) => string
> = {
  hash: (x) => hash(omitFields(x)),
  identifier: (x) => x.identifier,
};

function omitFields(
  tx: ScrappedTransaction & { account: Account },
): Omit<typeof tx, 'account' | 'category'> {
  const { account: _account, category: _category, ...rest } = tx;
  return rest;
}

function getExternalId(tx: ScrappedTransaction & { account: Account }): string {
  const identifyMethodMap: Record<string, string> = config.get('identifyMethod') || {};
  const accountType = tx.account.type || '';
  const identifyMethod = identifyMethodMap[accountType] || 'identifier';
  const getter = getters[identifyMethod] ?? getters.identifier;
  if (!getter) {
    throw new Error(`No getter function found for method: ${identifyMethod}`);
  }
  return getter(tx);
}

/**
 * Backfill existing transactions in Firefly III and convert matching pairs to transfers
 */
async function backfillTransfers(
  isDryRun: boolean,
  dateTolerance: number,
  sinceDate?: string,
): Promise<void> {
  logger().info(
    {
      isDryRun,
      dateTolerance,
      sinceDate,
    },
    'Starting transfer detection backfill',
  );

  if (isDryRun) {
    logger().info('🔍 DRY RUN MODE - No changes will be made to Firefly');
  }

  // Get all accounts from Firefly to build accountsMap
  logger().info('Fetching all accounts from Firefly...');
  const accountsResponse = await getAccounts();
  const allAccounts = accountsResponse.data.data;
  logger().info(
    { count: allAccounts.length },
    'Retrieved accounts from Firefly',
  );

  // Build accountsMap in the same format as used in the importer
  const accountsMap: AccountsMap = {};
  allAccounts.forEach(
    (account: {
      id: string;
      attributes: {
        account_number?: string;
        name: string;
        type: string;
        account_role?: string;
      };
    }) => {
      const accountData = account.attributes;
      const accountNumber = accountData.account_number || accountData.name;
      accountsMap[accountNumber] = {
        id: account.id,
        type: accountData.name,
        kind:
          accountData.type === 'asset' && accountData.account_role === 'ccAsset'
            ? 'credit-card'
            : accountData.type,
      };
    },
  );

  logger().debug(
    {
      totalAccounts: Object.keys(accountsMap).length,
      creditCards: Object.values(accountsMap).filter(
        (a) => a.kind === 'credit-card',
      ).length,
    },
    'Built accounts map',
  );

  // Get all transactions from Firefly
  logger().info('Fetching all transactions from Firefly...');
  const allFireflyTxs = (await getAllTxs()) as Array<{
    id: string;
    attributes: {
      transactions: Array<{
        type: string;
        date: string;
        amount: string;
        description?: string;
        notes?: string;
        source_id?: string;
        destination_id?: string;
        external_id?: string;
        currency_code?: string;
        category_name?: string;
        internal_reference?: string;
        tags?: string[];
      }>;
    };
  }>;
  logger().info(
    { count: allFireflyTxs.length },
    'Retrieved transactions from Firefly',
  );

  // Filter transactions if since date is provided
  let transactionsToProcess = allFireflyTxs;
  if (sinceDate) {
    const sinceMoment = moment(sinceDate);
    if (!sinceMoment.isValid()) {
      logger().error(
        { sinceDate },
        'Invalid since date format. Use YYYY-MM-DD',
      );
      throw new Error('Invalid since date format');
    }

    transactionsToProcess = allFireflyTxs.filter((tx) => {
      const txDate = moment(tx.attributes.transactions[0]?.date);
      return txDate.isSameOrAfter(sinceMoment);
    });

    logger().info(
      {
        total: allFireflyTxs.length,
        filtered: transactionsToProcess.length,
        sinceDate,
      },
      'Filtered transactions by date',
    );
  }

  // Convert Firefly transactions to internal format
  const allFormattedTxs = transactionsToProcess
    .map((tx) => {
      const txData = tx.attributes.transactions[0];
      if (!txData) return null;
      return {
        id: tx.id,
        type: txData.type,
        date: txData.date,
        amount: parseFloat(txData.amount),
        description: txData.description || '',
        notes: txData.notes || '',
        source_id: txData.source_id,
        destination_id: txData.destination_id,
        external_id: txData.external_id || '',
        currency_code: txData.currency_code,
        category_name: txData.category_name,
        internal_reference: txData.internal_reference,
        tags: txData.tags || [],
      };
    })
    .filter(
      (tx): tx is NonNullable<typeof tx> => tx !== null,
    ) as FormattedTransaction[];

  // Separate transfers from deposits/withdrawals
  const existingTransfers = allFormattedTxs.filter(
    (tx) => tx.type === 'transfer',
  );
  const formattedTxs = allFormattedTxs.filter(
    (tx) => tx.type === 'deposit' || tx.type === 'withdrawal',
  );

  logger().info(
    {
      total: transactionsToProcess.length,
      depositsAndWithdrawals: formattedTxs.length,
      existingTransfers: existingTransfers.length,
    },
    'Prepared transactions for transfer detection',
  );

  if (formattedTxs.length === 0) {
    logger().info('No deposit/withdrawal transactions found to process');
    return;
  }

  // First, detect and convert credit card payments to transfers
  logger().info('Running credit card payment detection...');
  const ccPaymentResult = convertCreditCardPayments(
    formattedTxs as unknown as Array<{
      type: string;
      date: string;
      amount: number;
      description?: string;
      notes?: string;
      source_id?: string;
      destination_id?: string;
      external_id: string;
      currency_code?: string;
      category_name?: string;
      internal_reference?: string;
      tags?: string[];
      process_date?: string;
    }>,
    accountsMap,
  );

  logger().info(
    {
      originalCount: formattedTxs.length,
      ccPaymentsConverted: ccPaymentResult.transfers.length,
      remaining: ccPaymentResult.remaining.length,
    },
    'Credit card payment detection complete',
  );

  // Import detectAndConvertTransfers from transfer-detector
  const { detectAndConvertTransfers } = await import('./transfer-detector.js');

  // Then run transfer detection on remaining transactions
  logger().info(
    'Running transfer detection algorithm on remaining transactions...',
  );
  const transferResult = detectAndConvertTransfers(
    ccPaymentResult.remaining as unknown as Array<{
      type: string;
      date: string;
      amount: number;
      description?: string;
      notes?: string;
      source_id?: string;
      destination_id?: string;
      external_id: string;
      currency_code?: string;
      category_name?: string;
      internal_reference?: string;
      tags?: string[];
      process_date?: string;
    }>,
    dateTolerance,
    existingTransfers as unknown as Array<{
      id?: string;
      type: string;
      date: string;
      amount: number;
      source_id?: string;
      destination_id?: string;
      external_id?: string;
    }>,
  );

  logger().info(
    {
      convertedPairs: transferResult.transfers.length,
      duplicatesOfExisting: transferResult.duplicatesOfExisting.length,
      remainingCount: transferResult.remaining.length,
    },
    'Transfer detection complete',
  );

  // Combine results
  interface DuplicatePair {
    deposit: FormattedTransaction & { id: string };
    withdrawal: FormattedTransaction & { id: string };
    existingTransfer: {
      id?: string;
      [key: string]: unknown;
    };
  }

  interface TransferResult {
    transfers: FormattedTransaction[];
    duplicatesOfExisting: DuplicatePair[];
    remaining: FormattedTransaction[];
  }

  const result: TransferResult & { ccPayments: FormattedTransaction[] } = {
    transfers: [
      ...ccPaymentResult.transfers,
      ...transferResult.transfers,
    ] as unknown as FormattedTransaction[],
    duplicatesOfExisting:
      transferResult.duplicatesOfExisting as unknown as DuplicatePair[],
    remaining: transferResult.remaining as unknown as FormattedTransaction[],
    ccPayments: ccPaymentResult.transfers as unknown as FormattedTransaction[],
  };

  if (
    result.transfers.length === 0
    && result.duplicatesOfExisting.length === 0
  ) {
    logger().info('✅ No matching transfer pairs found');
    return;
  }

  // Calculate transfer counts for display and processing
  const regularTransfers = result.transfers.filter(
    (t) => !result.ccPayments.includes(t),
  );
  const ccPaymentCount = result.ccPayments.length;
  const transactionsToDelete = ccPaymentCount
    + regularTransfers.length * 2
    + result.duplicatesOfExisting.length * 2;

  // Display found transfers
  /* eslint-disable no-console */
  if (result.ccPayments.length > 0) {
    console.log('\n=== Credit Card Payments to Convert ===\n');
    result.ccPayments.forEach((transfer, index) => {
      // Find original transaction
      const originalTx = formattedTxs.find(
        (tx) => tx.external_id === transfer.external_id,
      );

      console.log(`${index + 1}. Credit Card Payment:`);
      console.log(
        `   Amount: ${transfer.amount} ${transfer.currency_code || ''}`,
      );
      console.log(`   Date: ${transfer.date}`);
      console.log(`   Description: ${transfer.description}`);
      console.log(`   From: Account ${transfer.source_id}`);
      console.log(`   To: Credit Card ${transfer.destination_id}`);
      console.log(`   Internal Reference: ${transfer.internal_reference}`);
      if (originalTx) {
        console.log(`   Will delete withdrawal transaction: ${originalTx.id}`);
      }
      console.log('');
    });
  }

  if (regularTransfers.length > 0) {
    console.log('\n=== New Transfer Pairs to Create ===\n');
    regularTransfers.forEach((transfer, index) => {
      const originalWithdrawalId = transfer.external_id.split('_')[1];
      const originalDepositId = transfer.external_id.split('_')[2];

      // Find original transaction IDs
      const withdrawalTx = formattedTxs.find(
        (tx) => tx.external_id === originalWithdrawalId,
      );
      const depositTx = formattedTxs.find(
        (tx) => tx.external_id === originalDepositId,
      );

      const daysDiff = Math.abs(
        moment(transfer.date).diff(moment(depositTx?.date), 'days'),
      );

      console.log(
        `${index + 1}. Transfer (${daysDiff} day${
          daysDiff !== 1 ? 's' : ''
        } apart):`,
      );
      console.log(
        `   Amount: ${transfer.amount} ${transfer.currency_code || ''}`,
      );
      console.log(`   Date: ${transfer.date}`);
      console.log(`   Description: ${transfer.description}`);
      console.log(`   From: Account ${transfer.source_id}`);
      console.log(`   To: Account ${transfer.destination_id}`);
      if (withdrawalTx) {
        console.log(
          `   Will delete withdrawal transaction: ${withdrawalTx.id}`,
        );
      }
      if (depositTx) {
        console.log(`   Will delete deposit transaction: ${depositTx.id}`);
      }
      console.log('');
    });
  }

  if (result.duplicatesOfExisting.length > 0) {
    console.log('\n=== Duplicate Transactions for Existing Transfers ===\n');
    result.duplicatesOfExisting.forEach((dup, index) => {
      const daysDiff = Math.abs(
        moment(dup.deposit.date).diff(moment(dup.withdrawal.date), 'days'),
      );

      console.log(
        `${index + 1}. Duplicate pair (${daysDiff} day${
          daysDiff !== 1 ? 's' : ''
        } apart):`,
      );
      console.log(
        `   Amount: ${dup.deposit.amount} ${dup.deposit.currency_code || ''}`,
      );
      console.log(`   Matching existing transfer: ${dup.existingTransfer.id}`);
      console.log(
        `   Will delete withdrawal transaction: ${dup.withdrawal.id}`,
      );
      console.log(`   Will delete deposit transaction: ${dup.deposit.id}`);
      console.log('');
    });
  }
  /* eslint-enable no-console */

  if (isDryRun) {
    logger().info(
      {
        ccPayments: ccPaymentCount,
        regularTransfers: regularTransfers.length,
        duplicatePairs: result.duplicatesOfExisting.length,
        transactionsToDelete,
        transfersToCreate: result.transfers.length,
      },
      '🔍 DRY RUN - Would process these transactions',
    );
    return;
  }

  // Confirm before proceeding
  logger().warn(
    {
      ccPayments: ccPaymentCount,
      regularTransfers: regularTransfers.length,
      duplicatePairs: result.duplicatesOfExisting.length,
      transactionsToDelete,
      transfersToCreate: result.transfers.length,
    },
    'Ready to process transactions',
  );

  // First, process duplicates of existing transfers (just delete)
  logger().info('Removing duplicate transactions for existing transfers...');
  let duplicateDeleteCount = 0;
  let duplicateErrorCount = 0;

  /* eslint-disable no-await-in-loop */
  for (let i = 0; i < result.duplicatesOfExisting.length; i += 1) {
    const dup = result.duplicatesOfExisting[i];
    if (!dup) continue;

    try {
      // Delete the two duplicate transactions
      await deleteTx(dup.withdrawal.id);
      await deleteTx(dup.deposit.id);

      duplicateDeleteCount += 1;
      if (duplicateDeleteCount % 10 === 0) {
        logger().info(
          {
            completed: duplicateDeleteCount,
            total: result.duplicatesOfExisting.length,
          },
          'Duplicate deletion progress',
        );
      }
    } catch (error: unknown) {
      const err = error as Error;
      logger().error(
        {
          error: err.message,
          existingTransferId: dup.existingTransfer.id,
          withdrawalId: dup.withdrawal.id,
          depositId: dup.deposit.id,
        },
        'Error deleting duplicate transaction pair',
      );
      duplicateErrorCount += 1;
    }
  }

  if (result.duplicatesOfExisting.length > 0) {
    logger().info(
      {
        successCount: duplicateDeleteCount,
        errorCount: duplicateErrorCount,
        total: result.duplicatesOfExisting.length,
      },
      'Duplicate deletion complete',
    );
  }

  // Now process new transfers
  logger().info('Converting transactions to transfers...');
  let successCount = 0;
  let errorCount = 0;

  // Process credit card payments first (only delete withdrawal, no deposit to delete)
  for (let i = 0; i < result.ccPayments.length; i += 1) {
    const transfer = result.ccPayments[i];
    if (!transfer) continue;

    const originalTx = formattedTxs.find(
      (tx) => tx.external_id === transfer.external_id,
    );

    if (!originalTx || !originalTx.id) {
      logger().error(
        {
          transfer: transfer.external_id,
        },
        'Could not find original credit card payment transaction',
      );
      errorCount += 1;
      continue;
    }

    try {
      // Delete the original withdrawal transaction
      await deleteTx(originalTx.id as string);

      // Create the transfer transaction
      await createTx([transfer as unknown as { [key: string]: unknown }]);

      successCount += 1;
      if (successCount % 10 === 0) {
        logger().info(
          {
            completed: successCount,
            total: result.transfers.length,
          },
          'Progress update',
        );
      }
    } catch (error: unknown) {
      const err = error as Error;
      logger().error(
        {
          error: err.message,
          transfer: transfer.external_id,
          originalId: originalTx.id,
        },
        'Error converting credit card payment',
      );
      errorCount += 1;
    }
  }

  // Process regular transfer pairs (delete both withdrawal and deposit)
  for (let i = 0; i < regularTransfers.length; i += 1) {
    const transfer = regularTransfers[i];
    if (!transfer) continue;

    const originalWithdrawalId = transfer.external_id.split('_')[1];
    const originalDepositId = transfer.external_id.split('_')[2];

    const withdrawalTx = formattedTxs.find(
      (tx) => tx.external_id === originalWithdrawalId,
    );
    const depositTx = formattedTxs.find(
      (tx) => tx.external_id === originalDepositId,
    );

    if (!withdrawalTx || !depositTx || !withdrawalTx.id || !depositTx.id) {
      logger().error(
        {
          transfer: transfer.external_id,
          withdrawalFound: !!withdrawalTx,
          depositFound: !!depositTx,
        },
        'Could not find original transactions',
      );
      errorCount += 1;
      continue;
    }

    try {
      // Delete the two original transactions
      await deleteTx(withdrawalTx.id as string);
      await deleteTx(depositTx.id as string);

      // Create the transfer transaction
      await createTx([transfer as unknown as { [key: string]: unknown }]);

      successCount += 1;
      if (successCount % 10 === 0) {
        logger().info(
          {
            completed: successCount,
            total: result.transfers.length,
          },
          'Progress update',
        );
      }
    } catch (error: unknown) {
      const err = error as Error;
      logger().error(
        {
          error: err.message,
          transfer: transfer.external_id,
          withdrawalId: withdrawalTx.id,
          depositId: depositTx.id,
        },
        'Error converting transaction pair',
      );
      errorCount += 1;
    }
  }
  /* eslint-enable no-await-in-loop */

  logger().info(
    {
      transfersCreated: successCount,
      transferErrors: errorCount,
      duplicatesDeleted: duplicateDeleteCount,
      duplicateErrors: duplicateErrorCount,
    },
    'Transfer backfill complete',
  );

  /* eslint-disable no-console */
  console.log('\n=== Summary ===');
  console.log(`✅ Successfully converted to transfers: ${successCount}`);
  console.log(`   - Credit card payments: ${result.ccPayments.length}`);
  console.log(`   - Regular transfer pairs: ${regularTransfers.length}`);
  console.log(
    `✅ Successfully removed duplicates: ${duplicateDeleteCount} pairs`,
  );
  if (errorCount > 0 || duplicateErrorCount > 0) {
    console.log(`❌ Errors: ${errorCount + duplicateErrorCount}`);
  }

  // Calculate transaction reduction
  // CC payments: 1 withdrawal -> 1 transfer (no reduction)
  // Regular transfers: 1 withdrawal + 1 deposit -> 1 transfer (reduction of 1)
  // Duplicates: 1 withdrawal + 1 deposit -> deleted (reduction of 2)
  const regularTransferCount = regularTransfers.length;
  const totalBefore = ccPaymentCount + regularTransferCount * 2 + duplicateDeleteCount * 2;
  const totalAfter = ccPaymentCount + regularTransferCount;
  const totalReduction = totalBefore - totalAfter;

  console.log(
    `📊 Total transactions: ${totalBefore} → ${totalAfter} (reduced by ${totalReduction})`,
  );
  /* eslint-enable no-console */
}
