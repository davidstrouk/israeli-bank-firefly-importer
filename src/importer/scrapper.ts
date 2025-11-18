import {
  CompanyTypes,
  createScraper,
  type ScraperScrapingResult as ScraperScrapResult,
} from 'israeli-bank-scrapers';
import config from 'nconf';
import moment, { Moment } from 'moment';
import logger from '../logger.js';
import { getLastImport } from './last-import-helper.js';
import manipulateScrapResult from './scrap-manipulater/index.js';

interface Credentials {
  [key: string]: string | undefined;
}

interface CreditCard {
  type: string;
  credentials: Credentials;
  name?: string;
}

interface Bank {
  type: string;
  credentials: Credentials;
  name?: string;
  creditCards?: CreditCard[];
}

interface UserOptions {
  type: string;
  credentials: Credentials;
  parentBankIndex?: number;
  name?: string;
  lastImport?: Moment | null;
  scrapFrom?: Moment;
}

interface AccountDetails {
  type: string;
  kind: string;
}

interface EnrichedAccount {
  accountNumber: string;
  accountDetails: AccountDetails;
  [key: string]: unknown;
}

interface State {
  [key: string]: string;
}

interface ScraperConfig {
  parallel: boolean;
  options?: {
    [key: string]: unknown;
  };
}

function toUserOptions(creditCard: CreditCard, index?: number): UserOptions {
  return {
    type: creditCard.type,
    credentials: creditCard.credentials,
    parentBankIndex: index,
    name: creditCard.name,
  };
}

function enrichAccount(
  accounts: unknown[],
  currentAccount: UserOptions,
): EnrichedAccount[] {
  const accountDetails: AccountDetails = currentAccount.parentBankIndex !== undefined
    ? {
      type: currentAccount.type,
      kind: 'credit-card',
    }
    : {
      type: currentAccount.type,
      kind: 'bank',
    };
  return (accounts as EnrichedAccount[]).map((x) => ({
    ...x,
    accountDetails,
  }));
}

function getScrapFrom(account: UserOptions): Moment {
  if (account.lastImport) {
    return moment(account.lastImport).subtract(7, 'days');
  }

  // Fallback to 5y ago
  return moment().subtract('5', 'years');
}

export function getFlatUsers(
  useOnlyAccounts: string[] | undefined,
  state: State | undefined,
  since: string | undefined,
): UserOptions[] {
  const banks: Bank[] = config.get('banks');
  if (!banks) {
    throw new Error('No banks in config');
  }
  return banks
    .flatMap((bank, i) => [
      toUserOptions(bank),
      ...(bank.creditCards || []).map((cc) => toUserOptions(cc, i)),
    ])
    .filter((x) => !useOnlyAccounts || useOnlyAccounts.includes(x.name || ''))
    .map((x) => ({
      ...x,
      lastImport: getLastImport(
        x as { type: string; credentials: Credentials },
        state,
        since,
      ),
    }))
    .map((x) => ({
      ...x,
      scrapFrom: getScrapFrom(x),
    }));
}

export function parseScrapResult(
  results: ScraperScrapResult[],
  flatUsers: UserOptions[],
): unknown[] {
  return results
    .reduce((m, x, i) => {
      const user = flatUsers[i];
      if (!user) return m;
      return [...m, ...enrichAccount(x.accounts || [], user)];
    }, [] as EnrichedAccount[])
    .map(manipulateScrapResult)
    .filter((x): x is EnrichedAccount => x !== null);
}

export function getSuccessfulScrappedUsers(
  results: ScraperScrapResult[],
  flatUsers: UserOptions[],
): UserOptions[] {
  return results
    .map((x, i) => (x.success ? flatUsers[i] : null))
    .filter((x): x is UserOptions => x !== null);
}

export function logErrorResult(
  results: ScraperScrapResult[],
  flatUsers: UserOptions[],
): void {
  const error = results
    .map((x, i) => (x.success
      ? null
      : {
        ...x,
        options: flatUsers[i],
      }))
    .filter(
      (x): x is ScraperScrapResult & { options: UserOptions } => x !== null,
    )
    .map(
      (x) => `${x.options.type} ${
        x.options.name ? ` (${x.options.name})` : ''
      } failed with type ${x.errorType || 'UNKNOWN'}: ${
        x.errorMessage || 'Unknown error'
      }`,
    )
    .join(', ');
  if (error) {
    logger().error({ error }, 'Scrapping failed. Ignoring...');
  }
}

interface LightAccount {
  txCount: number;
  txns?: undefined;
  [key: string]: unknown;
}

interface LightResult extends Omit<ScraperScrapResult, 'accounts'> {
  accounts?: LightAccount[];
}

export function getLightResult(results: ScraperScrapResult[]): LightResult[] {
  return results.map((r) => ({
    ...r,
    accounts: r.accounts?.map((a: { txns?: unknown[] }) => ({
      ...a,
      txCount: a.txns?.length || 0,
      txns: undefined,
    })),
  }));
}

export async function scrapAccounts(
  flatUsers: UserOptions[],
): Promise<ScraperScrapResult[]> {
  const scraperConfig: ScraperConfig = config.get('scraper');
  const actions = flatUsers
    .map((user, index) => {
      const options = {
        companyId: CompanyTypes[user.type as keyof typeof CompanyTypes],
        startDate: user.scrapFrom?.toDate(),
        ...scraperConfig.options,
      };

      if (!flatUsers[index]) return null;
      return () => scrape(options, flatUsers[index]!.credentials);
    })
    .filter(
      (action): action is () => Promise<ScraperScrapResult> => action !== null,
    );

  return runActions(actions, scraperConfig.parallel);
}

async function scrape(
  options: { companyId: unknown; startDate?: Date; [key: string]: unknown },
  credentials: Credentials,
): Promise<ScraperScrapResult> {
  const scraper = createScraper(options as never);
  logger().debug({ options }, 'Scrapping...');
  try {
    return await scraper.scrape(credentials as never);
  } catch (error: unknown) {
    const err = error as Error;
    logger().error({ error: err, options }, 'Unexpected error while scrapping');
    return {
      success: false,
      errorType: 'GENERAL_ERROR',
      errorMessage: err.message,
    } as ScraperScrapResult;
  }
}

function runActions(
  actions: Array<() => Promise<ScraperScrapResult>>,
  parallel: boolean,
): Promise<ScraperScrapResult[]> {
  if (parallel) {
    return Promise.all(actions.map((x) => x()));
  }
  return actions.reduce(
    (m, a) => m.then(async (x) => [...x, await a()]),
    Promise.resolve([] as ScraperScrapResult[]),
  );
}
