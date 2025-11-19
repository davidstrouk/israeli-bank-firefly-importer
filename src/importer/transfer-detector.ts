import moment from 'moment';
import type { Provider as Config } from 'nconf';
import type { AxiosResponse } from 'axios';
import logger from '../logger.js';
import { createAccount, getAccounts } from '../firefly.js';

interface Account {
  id: string;
  kind: string;
  type?: string;
}

interface AccountsMap {
  [key: string]: Account;
}

interface Transaction {
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
  [key: string]: unknown;
}

interface ConversionResult {
  transfers: Transaction[];
  remaining: Transaction[];
  all: Transaction[];
}

interface ExtendedConversionResult extends ConversionResult {
  duplicatesOfExisting: DuplicatePair[];
}

interface DuplicatePair {
  deposit: Transaction;
  withdrawal: Transaction;
  existingTransfer: Transaction;
}

interface ExistingTransfer {
  id?: string;
  type: string;
  date: string;
  amount: number;
  source_id?: string;
  destination_id?: string;
  external_id?: string;
}

/**
 * Converts credit card payment withdrawals to transfers
 * Identifies withdrawals where internal_reference matches a credit card account
 */
export function convertCreditCardPayments(
  transactions: Transaction[],
  accountsMap?: AccountsMap,
): ConversionResult {
  if (!accountsMap) {
    logger().debug('No accountsMap provided for credit card payment detection');
    return {
      transfers: [],
      remaining: transactions,
      all: transactions,
    };
  }

  try {
    // Build a map of credit card account numbers (last 4 digits) to account IDs
    const ccAccountMap: Record<string, string> = {};
    Object.entries(accountsMap).forEach(([accountNumber, account]) => {
      if (account.kind === 'credit-card') {
        // Extract last 4 digits or use account number as-is
        const last4 = accountNumber.slice(-4);
        ccAccountMap[last4] = account.id;
        ccAccountMap[accountNumber] = account.id; // Also store full number
      }
    });

    logger().debug(
      {
        creditCardAccounts: Object.keys(ccAccountMap).length / 2,
      },
      'Built credit card account map for payment detection',
    );

    const convertedTransfers: Transaction[] = [];
    const processedTxIds = new Set<string>();
    const remainingTxs: Transaction[] = [];

    // Process each transaction
    transactions.forEach((tx) => {
      // Only process withdrawals
      if (tx.type !== 'withdrawal') {
        remainingTxs.push(tx);
        return;
      }

      // Check if internal_reference matches a credit card account
      const internalRef = tx.internal_reference;
      if (!internalRef) {
        remainingTxs.push(tx);
        return;
      }

      // Convert to string if needed
      const internalRefStr = String(internalRef);

      // Try to find matching credit card account
      const ccAccountId = ccAccountMap[internalRefStr] || ccAccountMap[internalRefStr.slice(-4)];

      if (ccAccountId) {
        // Convert to transfer
        const transfer: Transaction = {
          ...tx,
          type: 'transfer',
          destination_id: ccAccountId,
          description: tx.description || 'Credit card payment',
          notes: tx.notes
            ? `${tx.notes}\nCredit Card Payment (auto-detected)`
            : 'Credit Card Payment (auto-detected)',
        };

        convertedTransfers.push(transfer);
        processedTxIds.add(tx.external_id);

        logger().debug(
          {
            txId: tx.external_id,
            amount: tx.amount,
            internalRef,
            ccAccountId,
            sourceAccountId: tx.source_id,
          },
          'Converted credit card payment to transfer',
        );
      } else {
        remainingTxs.push(tx);
      }
    });

    if (convertedTransfers.length > 0) {
      logger().info(
        {
          convertedPayments: convertedTransfers.length,
          total: transactions.length,
        },
        'Converted credit card payments to transfers',
      );
    }

    return {
      transfers: convertedTransfers,
      remaining: remainingTxs,
      all: [...convertedTransfers, ...remainingTxs],
    };
  } catch (error: unknown) {
    const err = error as Error;
    logger().error(
      {
        error: err.message,
        stack: err.stack,
      },
      'Error in credit card payment detection',
    );

    return {
      transfers: [],
      remaining: transactions,
      all: transactions,
    };
  }
}

/**
 * Helper function to check if a day of month is within a range
 * @param day - Day of the month (1-31)
 * @param range - Range string like "1-4" or "15-20"
 * @returns true if day is within the range
 */
function isDayInRange(day: number, range: string): boolean {
  const parts = range.split('-');
  if (parts.length !== 2) {
    return false;
  }
  const start = parseInt(parts[0] || '', 10);
  const end = parseInt(parts[1] || '', 10);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return false;
  }
  return day >= start && day <= end;
}

/**
 * Helper function to get or create a credit card account
 * @param accountName - Account name/number
 * @param accountsMap - Current accounts map
 * @param accountKeyToId - Mapping of account keys to IDs
 * @returns Account ID
 */
async function getOrCreateCreditCardAccount(
  accountName: string,
  accountsMap: AccountsMap,
  accountKeyToId: Record<string, string>,
): Promise<string | undefined> {
  // Check local cache first
  if (accountKeyToId[accountName]) {
    logger().debug(
      { accountName, accountId: accountKeyToId[accountName] },
      'Using cached credit card account',
    );
    return accountKeyToId[accountName];
  }

  try {
    // Fetch all asset accounts (including credit cards) to check if account already exists
    logger().debug(
      { accountName },
      'Checking if credit card account exists in Firefly',
    );
    const allAssetAccounts: AxiosResponse = await getAccounts();
    const existingAccount = allAssetAccounts.data.data.find(
      (acc: {
        attributes: {
          account_number: string;
          name: string;
          account_role?: string;
        };
      }) => (acc.attributes.account_number === accountName
          || acc.attributes.name === accountName)
        && acc.attributes.account_role === 'ccAsset',
    );

    if (existingAccount) {
      const existingId = existingAccount.id;

      // Add to maps for future lookups
      // eslint-disable-next-line no-param-reassign
      accountsMap[accountName] = {
        id: existingId,
        kind: 'credit-card',
        type: accountName,
      };
      // eslint-disable-next-line no-param-reassign
      accountKeyToId[accountName] = existingId;

      logger().debug(
        { accountName, accountId: existingId },
        'Found existing credit card account',
      );

      return existingId;
    }

    // Account doesn't exist, create it
    logger().info(
      { accountName },
      'Credit card account not found in Firefly, creating it',
    );

    const result = await createAccount({
      name: accountName,
      account_number: accountName,
      type: 'asset',
      account_role: 'ccAsset',
      credit_card_type: 'monthlyFull',
      monthly_payment_date: moment().format('YYYY-MM-DD'),
    });

    const newAccountId = result.data.data.id;

    // Add to maps
    // eslint-disable-next-line no-param-reassign
    accountsMap[accountName] = {
      id: newAccountId,
      kind: 'credit-card',
      type: accountName,
    };
    // eslint-disable-next-line no-param-reassign
    accountKeyToId[accountName] = newAccountId;

    logger().info(
      { accountName, accountId: newAccountId },
      'Created new credit card account',
    );

    return newAccountId;
  } catch (error: unknown) {
    const err = error as { response?: { status?: number; data?: unknown } };

    // If we got a 422, the account was likely created by a parallel process
    // Try to fetch it one more time
    if (err?.response?.status === 422) {
      logger().debug(
        { accountName },
        'Got 422 error, account may have been created by another process. Fetching again...',
      );

      try {
        const allAssetAccounts: AxiosResponse = await getAccounts();
        const existingAccount = allAssetAccounts.data.data.find(
          (acc: {
            attributes: {
              account_number: string;
              name: string;
              account_role?: string;
            };
          }) => (acc.attributes.account_number === accountName
              || acc.attributes.name === accountName)
            && acc.attributes.account_role === 'ccAsset',
        );

        if (existingAccount) {
          const existingId = existingAccount.id;

          // Add to maps
          // eslint-disable-next-line no-param-reassign
          accountsMap[accountName] = {
            id: existingId,
            kind: 'credit-card',
            type: accountName,
          };
          // eslint-disable-next-line no-param-reassign
          accountKeyToId[accountName] = existingId;

          logger().info(
            { accountName, accountId: existingId },
            'Found existing credit card account after 422 error',
          );

          return existingId;
        }
      } catch (fetchError) {
        logger().error(
          { error: fetchError, accountName },
          'Failed to fetch account after 422 error',
        );
      }
    }

    logger().error(
      { error, accountName },
      'Failed to create or fetch credit card account',
    );
    return undefined;
  }
}

/**
 * Converts credit card charge withdrawals to transfers using manual mapping
 * Maps transactions based on description and source account to destination credit card account
 */
export async function convertCreditCardCharges(
  transactions: Transaction[],
  accountsMap: AccountsMap | undefined,
  config: Config,
): Promise<ConversionResult> {
  if (!accountsMap) {
    logger().debug('No accountsMap provided for credit card charge detection');
    return {
      transfers: [],
      remaining: transactions,
      all: transactions,
    };
  }

  try {
    // Get creditCardChargeMapping configuration
    const chargeMappingConfig: Array<{
      transactionDesc: string;
      sourceAccount: string;
      destinationAccount: string;
      dayOfMonthRange?: string; // Optional: "1-4" means days 1-4 of the month
    }> = config?.get('creditCardChargeMapping') || [];

    if (chargeMappingConfig.length === 0) {
      logger().debug('No creditCardChargeMapping configuration found');
      return {
        transfers: [],
        remaining: transactions,
        all: transactions,
      };
    }

    // Build a reverse map from account ID to account number/name
    const accountIdToKey: Record<string, string> = {};
    Object.entries(accountsMap).forEach(([accountKey, account]) => {
      accountIdToKey[account.id] = accountKey;
    });

    // Build a map of account name/number to account ID
    const accountKeyToId: Record<string, string> = {};
    Object.entries(accountsMap).forEach(([accountKey, account]) => {
      accountKeyToId[accountKey] = account.id;
    });

    logger().info(
      {
        mappingRules: chargeMappingConfig.length,
        mappingRulesSample: chargeMappingConfig.slice(0, 5),
      },
      'Loaded credit card charge mapping configuration',
    );

    const convertedTransfers: Transaction[] = [];
    const processedTxIds = new Set<string>();
    const remainingTxs: Transaction[] = [];

    // Track statistics for debugging
    let withdrawalCount = 0;
    let matchedCount = 0;
    let unmatchedWithDescCount = 0;
    let createdAccountsCount = 0;

    // Process each transaction (using for loop to support async)
    // eslint-disable-next-line no-restricted-syntax
    for (const tx of transactions) {
      // Only process withdrawals
      if (tx.type !== 'withdrawal') {
        remainingTxs.push(tx);
        continue;
      }

      withdrawalCount += 1;

      // Get source account name/number
      const sourceAccountKey = tx.source_id
        ? accountIdToKey[tx.source_id]
        : undefined;

      if (!tx.description || !sourceAccountKey) {
        remainingTxs.push(tx);
        continue;
      }

      // Get day of month from transaction date
      const txDate = moment(tx.date);
      const dayOfMonth = txDate.isValid() ? txDate.date() : 0;

      // Try to find a matching rule
      const matchingRule = chargeMappingConfig.find((rule) => {
        // Check basic fields match
        if (
          rule.transactionDesc !== tx.description
          || rule.sourceAccount !== sourceAccountKey
        ) {
          return false;
        }

        // If dayOfMonthRange is specified, check if transaction day is in range
        if (rule.dayOfMonthRange) {
          if (
            dayOfMonth === 0
            || !isDayInRange(dayOfMonth, rule.dayOfMonthRange)
          ) {
            return false;
          }
        }

        return true;
      });

      if (matchingRule) {
        // Find or create destination account ID
        let destinationAccountId = accountKeyToId[matchingRule.destinationAccount];

        // If account doesn't exist, create it
        if (!destinationAccountId) {
          const wasCreated = !accountKeyToId[matchingRule.destinationAccount];
          // eslint-disable-next-line no-await-in-loop
          destinationAccountId = await getOrCreateCreditCardAccount(
            matchingRule.destinationAccount,
            accountsMap,
            accountKeyToId,
          );
          if (wasCreated && destinationAccountId) {
            createdAccountsCount += 1;
          }
        }

        if (destinationAccountId) {
          // Convert to transfer
          const transfer: Transaction = {
            ...tx,
            type: 'transfer',
            destination_id: destinationAccountId,
            description: tx.description,
            notes: tx.notes
              ? `${tx.notes}\nCredit Card Charge (mapped)`
              : 'Credit Card Charge (mapped)',
          };

          convertedTransfers.push(transfer);
          processedTxIds.add(tx.external_id);
          matchedCount += 1;

          logger().debug(
            {
              txId: tx.external_id,
              amount: tx.amount,
              description: tx.description,
              sourceAccount: sourceAccountKey,
              destinationAccount: matchingRule.destinationAccount,
              destinationAccountId,
              dayOfMonth: matchingRule.dayOfMonthRange ? dayOfMonth : undefined,
              dayOfMonthRange: matchingRule.dayOfMonthRange,
            },
            'Converted credit card charge to transfer using mapping',
          );
        } else {
          logger().warn(
            {
              txId: tx.external_id,
              description: tx.description,
              sourceAccount: sourceAccountKey,
              destinationAccount: matchingRule.destinationAccount,
            },
            'Destination account not found in accountsMap',
          );
          remainingTxs.push(tx);
        }
      } else {
        // Check if this transaction has a creditCardDesc description but no mapping
        const creditCardDescConfig: Array<{
          desc: string;
          creditCard: string;
        }> = config?.get('creditCardDesc') || [];
        const creditCardDescriptions = new Set(
          creditCardDescConfig.map((entry) => entry.desc),
        );

        if (creditCardDescriptions.has(tx.description)) {
          unmatchedWithDescCount += 1;
          if (unmatchedWithDescCount <= 3) {
            logger().info(
              {
                txId: tx.external_id,
                description: tx.description,
                sourceAccount: sourceAccountKey,
                dayOfMonth,
                date: tx.date,
              },
              'Transaction has creditCardDesc but no mapping rule',
            );
          }
        }
        remainingTxs.push(tx);
      }
    }

    // Log statistics
    logger().info(
      {
        totalTransactions: transactions.length,
        withdrawals: withdrawalCount,
        matchedAndConverted: matchedCount,
        unmatchedWithCreditCardDesc: unmatchedWithDescCount,
        createdAccounts: createdAccountsCount,
        convertedCharges: convertedTransfers.length,
      },
      'Credit card charge detection statistics',
    );

    if (convertedTransfers.length > 0) {
      logger().info(
        {
          convertedCharges: convertedTransfers.length,
          total: transactions.length,
        },
        'Converted credit card charges to transfers',
      );
    }

    return {
      transfers: convertedTransfers,
      remaining: remainingTxs,
      all: [...convertedTransfers, ...remainingTxs],
    };
  } catch (error: unknown) {
    const err = error as Error;
    logger().error(
      {
        error: err.message,
        stack: err.stack,
      },
      'Error in credit card charge detection',
    );

    return {
      transfers: [],
      remaining: transactions,
      all: transactions,
    };
  }
}

/**
 * Checks if a transfer already exists that matches the deposit/withdrawal pair
 */
function findMatchingExistingTransfer(
  deposit: Transaction,
  withdrawal: Transaction,
  existingTransfers: ExistingTransfer[],
  dateTolerance: number,
): ExistingTransfer | undefined {
  return existingTransfers.find((transfer) => {
    try {
      // Check amount match
      const amountDiff = Math.abs(transfer.amount - deposit.amount);
      if (amountDiff > 0.01) {
        return false;
      }

      // Check accounts match
      if (
        transfer.source_id !== withdrawal.source_id
        || transfer.destination_id !== deposit.destination_id
      ) {
        return false;
      }

      // Check date is within tolerance
      const transferDate = moment(transfer.date);
      const depositDate = moment(deposit.date);
      const withdrawalDate = moment(withdrawal.date);

      if (
        !transferDate.isValid()
        || !depositDate.isValid()
        || !withdrawalDate.isValid()
      ) {
        return false;
      }

      const daysDiffDeposit = Math.abs(transferDate.diff(depositDate, 'days'));
      const daysDiffWithdrawal = Math.abs(
        transferDate.diff(withdrawalDate, 'days'),
      );

      return (
        daysDiffDeposit <= dateTolerance && daysDiffWithdrawal <= dateTolerance
      );
    } catch {
      return false;
    }
  });
}

/**
 * Detects matching deposit and withdrawal transactions within a date range
 * with the same amount and converts them to transfer transactions.
 */
export function detectAndConvertTransfers(
  transactions: Transaction[],
  dateTolerance: number = 2,
  existingTransfers: ExistingTransfer[] = [],
): ExtendedConversionResult {
  try {
    logger().debug(
      {
        count: transactions.length,
        dateTolerance,
      },
      'Starting transfer detection',
    );

    // Validate and filter transactions with required fields
    const validTxs = transactions.filter((tx) => {
      const isValid = tx && tx.date && tx.type && tx.amount !== undefined && tx.external_id;

      if (!isValid && logger().level === 'debug') {
        logger().debug(
          { tx },
          'Skipping invalid transaction in transfer detection',
        );
      }

      return isValid;
    });

    if (validTxs.length < transactions.length) {
      logger().warn(
        {
          total: transactions.length,
          valid: validTxs.length,
          invalid: transactions.length - validTxs.length,
        },
        'Some transactions skipped due to missing required fields',
      );
    }

    // Sort transactions by date for efficient processing
    const sortedTxs = [...validTxs].sort((a, b) => {
      const dateA = moment(a.date);
      const dateB = moment(b.date);

      if (!dateA.isValid() || !dateB.isValid()) {
        return 0;
      }

      return dateA.valueOf() - dateB.valueOf();
    });

    // Separate deposits and withdrawals
    const deposits = sortedTxs.filter((tx) => tx.type === 'deposit');
    const withdrawals = sortedTxs.filter((tx) => tx.type === 'withdrawal');

    const convertedTransfers: Transaction[] = [];
    const duplicatesOfExistingTransfers: DuplicatePair[] = [];
    const processedTxIds = new Set<string>();
    const remainingTxs: Transaction[] = [];

    // Find matching pairs with date tolerance
    deposits.forEach((deposit) => {
      if (processedTxIds.has(deposit.external_id)) {
        return; // Already processed
      }

      // Look for matching withdrawal within date tolerance
      const matchingWithdrawal = withdrawals.find((withdrawal) => {
        if (processedTxIds.has(withdrawal.external_id)) {
          return false;
        }

        try {
          // Check if dates are within tolerance
          const depositDate = moment(deposit.date);
          const withdrawalDate = moment(withdrawal.date);

          if (!depositDate.isValid() || !withdrawalDate.isValid()) {
            return false;
          }

          const daysDiff = Math.abs(depositDate.diff(withdrawalDate, 'days'));
          if (daysDiff > dateTolerance) {
            return false;
          }

          // Check if amounts match (allowing for small floating point differences)
          const amountDiff = Math.abs(deposit.amount - withdrawal.amount);
          if (amountDiff > 0.01) {
            return false;
          }

          // Check if accounts are different
          if (deposit.destination_id === withdrawal.source_id) {
            return false; // Same account, not a transfer
          }

          return true;
        } catch (err) {
          logger().debug(
            {
              error: (err as Error).message,
              deposit: deposit.external_id,
              withdrawal: withdrawal.external_id,
            },
            'Error comparing transactions',
          );
          return false;
        }
      });

      if (matchingWithdrawal) {
        try {
          // Check if a matching transfer already exists
          const existingTransfer = findMatchingExistingTransfer(
            deposit,
            matchingWithdrawal,
            existingTransfers,
            dateTolerance,
          );

          if (existingTransfer) {
            // Transfer already exists - mark these as duplicates to be removed
            duplicatesOfExistingTransfers.push({
              deposit,
              withdrawal: matchingWithdrawal,
              existingTransfer: existingTransfer as Transaction,
            });

            // Mark both transactions as processed
            processedTxIds.add(deposit.external_id);
            processedTxIds.add(matchingWithdrawal.external_id);

            logger().debug(
              {
                depositDate: deposit.date,
                withdrawalDate: matchingWithdrawal.date,
                amount: deposit.amount,
                existingTransferId:
                  existingTransfer.id || existingTransfer.external_id,
                depositDesc: deposit.description,
                withdrawalDesc: matchingWithdrawal.description,
              },
              'Found duplicate deposit/withdrawal pair for existing transfer',
            );
          } else {
            // Create a new transfer transaction
            const transfer = createTransferTransaction(
              deposit,
              matchingWithdrawal,
            );
            convertedTransfers.push(transfer);

            // Mark both transactions as processed
            processedTxIds.add(deposit.external_id);
            processedTxIds.add(matchingWithdrawal.external_id);

            const daysDiff = Math.abs(
              moment(deposit.date).diff(moment(matchingWithdrawal.date), 'days'),
            );
            logger().debug(
              {
                depositDate: deposit.date,
                withdrawalDate: matchingWithdrawal.date,
                daysDifference: daysDiff,
                amount: deposit.amount,
                from: matchingWithdrawal.source_id,
                to: deposit.destination_id,
                depositDesc: deposit.description,
                withdrawalDesc: matchingWithdrawal.description,
              },
              'Converted deposit/withdrawal pair to transfer',
            );
          }
        } catch (err) {
          logger().error(
            {
              error: (err as Error).message,
              deposit: deposit.external_id,
              withdrawal: matchingWithdrawal.external_id,
            },
            'Error creating transfer transaction',
          );
        }
      }
    });

    // Collect remaining transactions that weren't converted
    transactions.forEach((tx) => {
      if (tx && tx.external_id && !processedTxIds.has(tx.external_id)) {
        remainingTxs.push(tx);
      }
    });

    logger().info(
      {
        originalCount: transactions.length,
        convertedPairs: convertedTransfers.length,
        duplicatesOfExisting: duplicatesOfExistingTransfers.length,
        remainingCount: remainingTxs.length,
        dateTolerance,
      },
      'Transfer detection complete',
    );

    return {
      transfers: convertedTransfers,
      duplicatesOfExisting: duplicatesOfExistingTransfers,
      remaining: remainingTxs,
      all: [...convertedTransfers, ...remainingTxs],
    };
  } catch (error: unknown) {
    const err = error as Error;
    logger().error(
      {
        error: err.message,
        stack: err.stack,
      },
      'Fatal error in transfer detection - returning original transactions',
    );

    // Return original transactions if something goes wrong
    return {
      transfers: [],
      duplicatesOfExisting: [],
      remaining: transactions,
      all: transactions,
    };
  }
}

/**
 * Creates a transfer transaction from a matching deposit and withdrawal
 */
function createTransferTransaction(
  deposit: Transaction,
  withdrawal: Transaction,
): Transaction {
  // Combine external IDs to create a unique identifier for the transfer
  const transferExternalId = `transfer_${withdrawal.external_id}_${deposit.external_id}`;

  // Use the withdrawal description as primary, or combine both if different
  const { description: withdrawalDescription, notes: withdrawalNotes } = withdrawal;

  let description = withdrawalDescription;
  if (deposit.description && deposit.description !== withdrawalDescription) {
    description = `${withdrawalDescription} → ${deposit.description}`;
  }

  // Combine notes if both exist
  let notes = withdrawalNotes || '';
  if (deposit.notes && deposit.notes !== withdrawalNotes) {
    notes = notes ? `${notes}\n---\n${deposit.notes}` : deposit.notes;
  }

  return {
    type: 'transfer',
    date: withdrawal.date, // Use withdrawal date as primary
    amount: deposit.amount, // Amount should be the same
    description,
    notes: notes || undefined,
    source_id: withdrawal.source_id,
    destination_id: deposit.destination_id,
    external_id: transferExternalId,
    currency_code: deposit.currency_code || withdrawal.currency_code,
    category_name: undefined, // Transfers typically don't have categories
    internal_reference: `${withdrawal.internal_reference || ''}_${
      deposit.internal_reference || ''
    }`,
    tags: combineTransferTags(withdrawal, deposit),
  };
}

/**
 * Combines tags from both transactions
 */
function combineTransferTags(
  withdrawal: Transaction,
  deposit: Transaction,
): string[] | undefined {
  const tags = new Set<string>();

  if (withdrawal.tags) {
    withdrawal.tags.forEach((tag) => tags.add(tag));
  }

  if (deposit.tags) {
    deposit.tags.forEach((tag) => tags.add(tag));
  }

  const tagArray = Array.from(tags);
  return tagArray.length > 0 ? tagArray : undefined;
}

/**
 * Applies transfer detection to a list of transactions if enabled in config
 */
export function applyTransferDetection(
  transactions: Transaction[],
  config: Config,
  existingTransfers: ExistingTransfer[] = [],
): Transaction[] {
  // Check if transfer detection is enabled (default: true)
  const enabled = config?.get('autoDetectTransfers') !== false;

  if (!enabled) {
    logger().debug('Auto-detect transfers is disabled');
    return transactions;
  }

  // Get date tolerance from config (default: 2 days)
  const dateTolerance = config?.get('transferDateTolerance') || 2;

  const result = detectAndConvertTransfers(
    transactions,
    dateTolerance,
    existingTransfers,
  );

  // Log if duplicates were found
  if (result.duplicatesOfExisting.length > 0) {
    logger().info(
      {
        duplicatePairs: result.duplicatesOfExisting.length,
      },
      'Found duplicate deposit/withdrawal pairs for existing transfers - they will not be imported',
    );
  }

  return result.all;
}
