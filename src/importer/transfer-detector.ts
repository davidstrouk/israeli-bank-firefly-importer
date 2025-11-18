import moment from "moment";
import type { Provider as Config } from "nconf";
import logger from "../logger.js";

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
  accountsMap?: AccountsMap
): ConversionResult {
  if (!accountsMap) {
    logger().debug("No accountsMap provided for credit card payment detection");
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
      if (account.kind === "credit-card") {
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
      "Built credit card account map for payment detection"
    );

    const convertedTransfers: Transaction[] = [];
    const processedTxIds = new Set<string>();
    const remainingTxs: Transaction[] = [];

    // Process each transaction
    transactions.forEach((tx) => {
      // Only process withdrawals
      if (tx.type !== "withdrawal") {
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
      const ccAccountId =
        ccAccountMap[internalRefStr] || ccAccountMap[internalRefStr.slice(-4)];

      if (ccAccountId) {
        // Convert to transfer
        const transfer: Transaction = {
          ...tx,
          type: "transfer",
          destination_id: ccAccountId,
          description: tx.description || "Credit card payment",
          notes: tx.notes
            ? `${tx.notes}\nCredit Card Payment (auto-detected)`
            : "Credit Card Payment (auto-detected)",
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
          "Converted credit card payment to transfer"
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
        "Converted credit card payments to transfers"
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
      "Error in credit card payment detection"
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
  dateTolerance: number
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
        transfer.source_id !== withdrawal.source_id ||
        transfer.destination_id !== deposit.destination_id
      ) {
        return false;
      }

      // Check date is within tolerance
      const transferDate = moment(transfer.date);
      const depositDate = moment(deposit.date);
      const withdrawalDate = moment(withdrawal.date);

      if (
        !transferDate.isValid() ||
        !depositDate.isValid() ||
        !withdrawalDate.isValid()
      ) {
        return false;
      }

      const daysDiffDeposit = Math.abs(transferDate.diff(depositDate, "days"));
      const daysDiffWithdrawal = Math.abs(
        transferDate.diff(withdrawalDate, "days")
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
  existingTransfers: ExistingTransfer[] = []
): ExtendedConversionResult {
  try {
    logger().debug(
      {
        count: transactions.length,
        dateTolerance,
      },
      "Starting transfer detection"
    );

    // Validate and filter transactions with required fields
    const validTxs = transactions.filter((tx) => {
      const isValid =
        tx && tx.date && tx.type && tx.amount !== undefined && tx.external_id;

      if (!isValid && logger().level === "debug") {
        logger().debug(
          { tx },
          "Skipping invalid transaction in transfer detection"
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
        "Some transactions skipped due to missing required fields"
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
    const deposits = sortedTxs.filter((tx) => tx.type === "deposit");
    const withdrawals = sortedTxs.filter((tx) => tx.type === "withdrawal");

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

          const daysDiff = Math.abs(depositDate.diff(withdrawalDate, "days"));
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
            "Error comparing transactions"
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
            dateTolerance
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
              "Found duplicate deposit/withdrawal pair for existing transfer"
            );
          } else {
            // Create a new transfer transaction
            const transfer = createTransferTransaction(
              deposit,
              matchingWithdrawal
            );
            convertedTransfers.push(transfer);

            // Mark both transactions as processed
            processedTxIds.add(deposit.external_id);
            processedTxIds.add(matchingWithdrawal.external_id);

            const daysDiff = Math.abs(
              moment(deposit.date).diff(moment(matchingWithdrawal.date), "days")
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
              "Converted deposit/withdrawal pair to transfer"
            );
          }
        } catch (err) {
          logger().error(
            {
              error: (err as Error).message,
              deposit: deposit.external_id,
              withdrawal: matchingWithdrawal.external_id,
            },
            "Error creating transfer transaction"
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
      "Transfer detection complete"
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
      "Fatal error in transfer detection - returning original transactions"
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
  withdrawal: Transaction
): Transaction {
  // Combine external IDs to create a unique identifier for the transfer
  const transferExternalId = `transfer_${withdrawal.external_id}_${deposit.external_id}`;

  // Use the withdrawal description as primary, or combine both if different
  const { description: withdrawalDescription, notes: withdrawalNotes } =
    withdrawal;

  let description = withdrawalDescription;
  if (deposit.description && deposit.description !== withdrawalDescription) {
    description = `${withdrawalDescription} → ${deposit.description}`;
  }

  // Combine notes if both exist
  let notes = withdrawalNotes || "";
  if (deposit.notes && deposit.notes !== withdrawalNotes) {
    notes = notes ? `${notes}\n---\n${deposit.notes}` : deposit.notes;
  }

  return {
    type: "transfer",
    date: withdrawal.date, // Use withdrawal date as primary
    amount: deposit.amount, // Amount should be the same
    description,
    notes: notes || undefined,
    source_id: withdrawal.source_id,
    destination_id: deposit.destination_id,
    external_id: transferExternalId,
    currency_code: deposit.currency_code || withdrawal.currency_code,
    category_name: undefined, // Transfers typically don't have categories
    internal_reference: `${withdrawal.internal_reference || ""}_${
      deposit.internal_reference || ""
    }`,
    tags: combineTransferTags(withdrawal, deposit),
  };
}

/**
 * Combines tags from both transactions
 */
function combineTransferTags(
  withdrawal: Transaction,
  deposit: Transaction
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
  existingTransfers: ExistingTransfer[] = []
): Transaction[] {
  // Check if transfer detection is enabled (default: true)
  const enabled = config?.get("autoDetectTransfers") !== false;

  if (!enabled) {
    logger().debug("Auto-detect transfers is disabled");
    return transactions;
  }

  // Get date tolerance from config (default: 2 days)
  const dateTolerance = config?.get("transferDateTolerance") || 2;

  const result = detectAndConvertTransfers(
    transactions,
    dateTolerance,
    existingTransfers
  );

  // Log if duplicates were found
  if (result.duplicatesOfExisting.length > 0) {
    logger().info(
      {
        duplicatePairs: result.duplicatesOfExisting.length,
      },
      "Found duplicate deposit/withdrawal pairs for existing transfers - they will not be imported"
    );
  }

  return result.all;
}
