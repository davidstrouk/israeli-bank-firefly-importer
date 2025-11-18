import moment from 'moment';
import config from 'nconf';
import { getTxsByTag } from '../firefly.js';
import logger from '../logger.js';

interface Account {
  id: string;
  kind: string;
  type: string;
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

interface CcDescEntry {
  ids: string[];
  method: string;
}

interface CcDescMap {
  [key: string]: CcDescEntry;
}

interface CcConfigEntry {
  desc: string;
  creditCard: string;
  method?: string;
}

interface TypeToIds {
  [key: string]: string[];
}

interface FireflyTransaction {
  attributes: {
    transactions: Array<{
      type: string;
      amount: string;
    }>;
  };
}

export default function manipulateTxs(
  txs: Transaction[],
  accountsMap: AccountsMap,
): Promise<Transaction[]> {
  const ccDesc = getCcDesc(accountsMap);
  return txs.reduce(
    (m, tx) => m.then(async (x) => [...x, await manipulateTx(tx, ccDesc, accountsMap)]),
    Promise.resolve([] as Transaction[]),
  );
}

async function manipulateTx(
  tx: Transaction,
  ccDesc: CcDescMap,
  accountsMap: AccountsMap,
): Promise<Transaction> {
  let newTx = tx;
  newTx = {
    ...newTx,
    tags: ccTag(tx, accountsMap),
  };
  newTx = await ccTransfer(newTx, ccDesc, accountsMap);
  return newTx;
}

function getCcDesc(accountsMap: AccountsMap): CcDescMap {
  const typeToIds = Object.values(accountsMap)
    .filter((x) => x.kind === 'credit-card')
    .map((x) => ({
      type: x.type,
      id: x.id,
    }))
    .reduce((m, x) => ({
      ...m,
      [x.type]: [...(m[x.type] || []), x.id],
    }), {} as TypeToIds);

  const creditCardDescConfig: CcConfigEntry[] = config.get('creditCardDesc') || [];
  return creditCardDescConfig
    .reduce((m, x) => ({
      ...m,
      [x.desc]: {
        ids: typeToIds[x.creditCard] || [],
        method: x.method || 'process-date',
      },
    }), {} as CcDescMap);
}

function ccTag(tx: Transaction, accountsMap: AccountsMap): string[] | undefined {
  const isCc = Object.values(accountsMap)
    .some((x) => x.kind === 'credit-card' && (x.id === tx.source_id || x.id === tx.destination_id));
  if (!isCc) {
    return undefined;
  }
  const accountId = tx.source_id || tx.destination_id;
  const processDate = tx.process_date;
  return [`${accountId}_${processDate}`];
}

type ProcessMethod = (
  tx: Transaction,
  ccAccountsIds: string[],
  accountsMap: AccountsMap,
) => Promise<string | null>;

const methods: Record<string, ProcessMethod> = {
  'process-date': processByProcessDate,
  reference: processByReference,
};

async function processByReference(
  tx: Transaction,
  _ccAccountsIds: string[],
  accountsMap: AccountsMap,
): Promise<string | null> {
  const accountNumber = tx.internal_reference;
  if (!accountNumber || !accountsMap[accountNumber]) {
    return null;
  }
  return accountsMap[accountNumber].id;
}

async function processByProcessDate(
  tx: Transaction,
  ccAccountsIds: string[],
): Promise<string | null> {
  const processDate = tx.process_date;
  if (!processDate || !ccAccountsIds || ccAccountsIds.length === 0) {
    return null;
  }

  let index: number;
  if (ccAccountsIds.length === 1) {
    const amount = await getTxAmount(processDate, ccAccountsIds[0] || '');
    if (amount === 0) {
      return null;
    }

    index = 0;
  } else {
    const amountsByIndex = await Promise.all(ccAccountsIds.map((x) => getTxAmount(processDate, x || '')));
    const nonAbsAmount = (tx.type === 'deposit' ? 1 : -1) * tx.amount;
    index = amountsByIndex.indexOf(nonAbsAmount);
    if (index === -1) {
      return null;
    }
  }

  return ccAccountsIds[index] || null;
}

async function ccTransfer(
  tx: Transaction,
  ccDesc: CcDescMap,
  accountsMap: AccountsMap,
): Promise<Transaction> {
  if (tx.type === 'transfer') {
    return tx;
  }
  if (!tx.description || !ccDesc[tx.description]) {
    return tx;
  }

  logger().debug({ tx: tx.description }, 'Found credit card transaction');
  const ccAccountsIds = ccDesc[tx.description];
  if (!ccAccountsIds || !ccAccountsIds.method) {
    return tx;
  }

  const process = methods[ccAccountsIds.method];
  if (!process) {
    return tx;
  }

  const accountId = await process(tx, ccAccountsIds.ids || [], accountsMap);
  if (accountId === null) {
    logger()
      .warn({ tx: tx.description, ccAccountsIds }, 'Couldn\'t find credit card billing period for transaction');
    return tx;
  }
  return {
    ...tx,
    type: 'transfer',
    source_id: tx.source_id || accountId,
    destination_id: tx.destination_id || accountId,
  };
}

async function getTxAmount(processDate: string, accountId: string): Promise<number> {
  let res = await getTxsByTag(`${accountId}_${processDate}`) as FireflyTransaction[];
  if (res.length === 0) {
    const yd = moment(processDate)
      .subtract(1, 'day')
      .toISOString();
    res = await getTxsByTag(`${accountId}_${yd}`) as FireflyTransaction[];
  }
  const txs = res.map((x) => x?.attributes?.transactions?.[0]).filter(Boolean);
  const sum = txs.reduce((m, x) => (x && x.type === 'deposit' ? 1 : -1) * (x ? parseFloat(x.amount) : 0) + m, 0);
  return Math.round(sum * 100) / 100;
}
