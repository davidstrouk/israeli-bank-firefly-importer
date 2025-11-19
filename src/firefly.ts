/* eslint-disable no-await-in-loop */
import config from 'nconf';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import logger from './logger.js';

let fireflyAxios: AxiosInstance;

export function init(): void {
  const baseURL = config.get('firefly:baseUrl');
  fireflyAxios = axios.create({
    headers: getHeader(),
    baseURL,
  });
  logger().info({ baseURL }, 'Firefly API client initialized');
}

interface SearchOptions {
  [key: string]: string | number;
}

export async function searchTxs(options: SearchOptions): Promise<unknown[]> {
  const query = Object.keys(options)
    .reduce((m, x) => `${m} ${x}:${options[x]}`, '')
    .trim();
  logger().debug({ options, query }, 'Searching transactions');
  const results = await paginate('/api/v1/search/transactions', query);
  logger().debug({ count: results.length }, 'Search transactions complete');
  return results;
}

async function paginate(url: string, query?: string): Promise<unknown[]> {
  const fireFlyData: unknown[] = [];
  const urlSearchParams = new URLSearchParams({
    limit: config.get('firefly:limit'),
    ...(query ? { query } : {}),
  });
  // Use & if URL already has query params, otherwise use ?
  const separator = url.includes('?') ? '&' : '?';
  let nextPage: string | null = `${url}${separator}${urlSearchParams}`;
  let pageCount = 0;

  logger().debug(
    {
      url,
      query,
      limit: config.get('firefly:limit'),
    },
    'Starting pagination',
  );

  while (nextPage) {
    let res: AxiosResponse<{ data: unknown[]; links: { next: string | null } }>;
    try {
      pageCount += 1;
      logger().debug({ page: pageCount, url: nextPage }, 'Fetching page');
      res = await fireflyAxios.get(nextPage);
    } catch (e: unknown) {
      const error = e as { response?: { status?: number }; message?: string };
      if (error?.response?.status === 404) {
        logger().debug({ url, query }, 'No results found (404)');
        return [];
      }
      logger().error(
        {
          url,
          query,
          error: error.message,
          status: error?.response?.status,
        },
        'Error during pagination',
      );
      throw e;
    }

    const pageDataCount = res.data.data.length;
    fireFlyData.push(...res.data.data);
    nextPage = res.data.links.next;

    logger().debug(
      {
        page: pageCount,
        itemsOnPage: pageDataCount,
        totalSoFar: fireFlyData.length,
        hasNextPage: !!nextPage,
      },
      'Page fetched',
    );
  }

  logger().debug(
    {
      url,
      query,
      totalPages: pageCount,
      totalItems: fireFlyData.length,
    },
    'Pagination complete',
  );

  return fireFlyData;
}

export async function getAllTxs(): Promise<unknown[]> {
  logger().debug('Getting all transactions from Firefly');
  const results = await paginate('/api/v1/transactions');
  logger().info(
    { count: results.length },
    'Retrieved all transactions from Firefly',
  );
  return results;
}

const getTxsByTagCache: Record<string, Promise<unknown[]>> = {};

export async function getTxsByTag(tag: string): Promise<unknown[]> {
  logger().debug({ tag }, 'Getting transactions by tag');
  if (!getTxsByTagCache[tag]) {
    getTxsByTagCache[tag] = paginate(`/api/v1/tags/${tag}/transactions`);
  }
  const results = await getTxsByTagCache[tag];
  logger().debug({ tag, count: results.length }, 'Got transactions by tag');
  return results;
}

interface Transaction {
  [key: string]: unknown;
}

export async function createTx(
  transactions: Transaction[] | unknown[],
): Promise<AxiosResponse> {
  logger().debug({ count: transactions.length }, 'Creating transactions');
  try {
    const result = await fireflyAxios.post('/api/v1/transactions', {
      transactions,
    });
    logger().debug(
      { count: transactions.length },
      'Transactions created successfully',
    );
    return result;
  } catch (e: unknown) {
    const error = e as {
      response?: { status?: number; data?: unknown };
      message?: string;
    };
    logger().error(
      {
        error: error.message,
        status: error?.response?.status,
        data: error?.response?.data,
      },
      'Error creating transactions',
    );
    throw e;
  }
}

export async function updateTx(
  id: string,
  transactions: Transaction[] | unknown[],
): Promise<AxiosResponse> {
  logger().debug({ id, count: transactions.length }, 'Updating transaction');
  try {
    const result = await fireflyAxios.put(`/api/v1/transactions/${id}`, {
      transactions,
    });
    logger().debug({ id }, 'Transaction updated successfully');
    return result;
  } catch (e: unknown) {
    const error = e as {
      response?: { status?: number; data?: unknown };
      message?: string;
    };
    logger().error(
      {
        id,
        error: error.message,
        status: error?.response?.status,
        data: error?.response?.data,
      },
      'Error updating transaction',
    );
    throw e;
  }
}

export async function deleteTx(id: string): Promise<AxiosResponse> {
  logger().debug({ id }, 'Deleting transaction');
  try {
    const result = await fireflyAxios.delete(`/api/v1/transactions/${id}`);
    logger().debug({ id }, 'Transaction deleted successfully');
    return result;
  } catch (e: unknown) {
    const error = e as { response?: { status?: number }; message?: string };
    logger().error(
      {
        id,
        error: error.message,
        status: error?.response?.status,
      },
      'Error deleting transaction',
    );
    throw e;
  }
}

export async function getAccounts(): Promise<AxiosResponse> {
  logger().debug('Getting accounts from Firefly');
  try {
    // Use pagination to get all accounts
    const allAccounts = await paginate('/api/v1/accounts');
    logger().debug({ count: allAccounts.length }, 'Got accounts from Firefly');
    // Return in the same format as before
    return {
      data: { data: allAccounts },
    } as AxiosResponse;
  } catch (e: unknown) {
    const error = e as { response?: { status?: number }; message?: string };
    logger().error(
      {
        error: error.message,
        status: error?.response?.status,
      },
      'Error getting accounts',
    );
    throw e;
  }
}

interface AccountData {
  name: string;
  account_number: string;
  type: string;
  account_role: string;
  credit_card_type?: string;
  monthly_payment_date?: string;
}

export async function createAccount(data: AccountData): Promise<AxiosResponse> {
  logger().debug({ accountName: data.name }, 'Creating account in Firefly');
  try {
    const result = await fireflyAxios.post('/api/v1/accounts', data);
    logger().info(
      {
        accountName: data.name,
        accountId: result.data.data.id,
      },
      'Account created successfully',
    );
    return result;
  } catch (e: unknown) {
    const error = e as {
      response?: { status?: number; data?: unknown };
      message?: string;
    };
    logger().error(
      {
        accountName: data.name,
        error: error.message,
        status: error?.response?.status,
        data: error?.response?.data,
      },
      'Error creating account',
    );
    throw e;
  }
}

// Cache for expense accounts to avoid repeated API calls
const expenseAccountCache = new Map<string, string>();

export async function getOrCreateExpenseAccount(
  merchantName: string,
  dryRun: boolean = false,
): Promise<string | undefined> {
  // Check cache first
  if (expenseAccountCache.has(merchantName)) {
    const cachedId = expenseAccountCache.get(merchantName);
    if (cachedId) {
      logger().debug(
        { merchantName, accountId: cachedId },
        'Using cached expense account',
      );
      return cachedId;
    }
  }

  try {
    // Get ALL expense accounts (using pagination to ensure we get everything)
    const allExpenseAccounts = await paginate('/api/v1/accounts?type=expense');

    // Look for exact name match
    const existingAccount = allExpenseAccounts.find(
      (account: any) => account.attributes?.name === merchantName,
    ) as { id: string; attributes: { name: string } } | undefined;

    if (existingAccount) {
      const accountId = existingAccount.id;
      logger().debug(
        { merchantName, accountId },
        'Found existing expense account',
      );
      expenseAccountCache.set(merchantName, accountId);
      return accountId;
    }

    // Account doesn't exist, need to create it
    if (dryRun) {
      logger().info(
        { merchantName },
        '🔍 DRY RUN - Would create new expense account',
      );
      return undefined;
    }

    // Create new expense account
    logger().debug({ merchantName }, 'Creating new expense account');
    const createResponse = await fireflyAxios.post('/api/v1/accounts', {
      name: merchantName,
      type: 'expense',
    });

    const accountId = createResponse.data.data.id;
    logger().info({ merchantName, accountId }, 'Created new expense account');

    expenseAccountCache.set(merchantName, accountId);
    return accountId;
  } catch (error: unknown) {
    const err = error as {
      response?: { status?: number; data?: unknown };
      message?: string;
    };

    // If we got a 422, the account was likely created by a parallel process
    // Try to fetch it one more time
    if (err?.response?.status === 422) {
      logger().debug(
        { merchantName },
        'Got 422 error, account may have been created by another process. Fetching again...',
      );

      try {
        const allExpenseAccounts = await paginate(
          '/api/v1/accounts?type=expense',
        );
        const existingAccount = allExpenseAccounts.find(
          (account: any) => account.attributes?.name === merchantName,
        ) as { id: string; attributes: { name: string } } | undefined;

        if (existingAccount) {
          const accountId = existingAccount.id;
          logger().info(
            { merchantName, accountId },
            'Found existing expense account after 422 error',
          );
          expenseAccountCache.set(merchantName, accountId);
          return accountId;
        }
      } catch (retryError) {
        logger().error(
          { merchantName, error: retryError },
          'Failed to fetch account after 422 error',
        );
      }
    }

    logger().error(
      {
        merchantName,
        error: err.message,
        status: err?.response?.status,
        data: err?.response?.data,
      },
      'Error getting or creating expense account',
    );
    return undefined;
  }
}

export async function upsertConfig(state: string): Promise<AxiosResponse> {
  logger().debug('Upserting config to Firefly');
  try {
    const result = await fireflyAxios.post('/api/v1/preferences', {
      name: 'israeli-bank-importer',
      data: state,
    });
    logger().debug('Config upserted successfully');
    return result;
  } catch (e: unknown) {
    const error = e as { response?: { status?: number }; message?: string };
    logger().error(
      {
        error: error.message,
        status: error?.response?.status,
      },
      'Error upserting config',
    );
    throw e;
  }
}

export async function getConfig(): Promise<AxiosResponse> {
  logger().debug('Getting config from Firefly');
  try {
    const result = await fireflyAxios.get(
      '/api/v1/preferences/israeli-bank-importer',
    );
    logger().debug('Got config from Firefly');
    return result;
  } catch (e: unknown) {
    const error = e as { response?: { status?: number }; message?: string };
    if (error?.response?.status === 404) {
      logger().debug('Config not found in Firefly (404)');
    } else {
      logger().error(
        {
          error: error.message,
          status: error?.response?.status,
        },
        'Error getting config',
      );
    }
    throw e;
  }
}

function getHeader(): Record<string, string> {
  return { Authorization: `Bearer ${config.get('firefly:tokenApi')}` };
}
