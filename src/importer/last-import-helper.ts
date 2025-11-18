import moment, { Moment } from 'moment';

interface Credentials {
  username?: string;
  id?: string;
  userCode?: string;
}

interface User {
  type: string;
  credentials: Credentials;
  name?: string;
}

interface State {
  [key: string]: string;
}

type IdentifyAccountFunction = (c: Credentials) => string | undefined;

const identifyAccountByType: Record<string, IdentifyAccountFunction> = {
  leumi: (c) => c.username,
  visaCal: (c) => c.username,
  beinleumi: (c) => c.username,
  mizrahi: (c) => c.username,
  massad: (c) => c.username,
  max: (c) => c.username,
  amex: (c) => c.username,
  yahav: (c) => c.username,
  'otsar-hahayal': (c) => c.username,
  isracard: (c) => c.id,
  discount: (c) => c.id,
  'beyahad-bishvilha': (c) => c.id,
  hapoalim: (c) => c.userCode,
};

function getAccountIdentification(user: User): string {
  const identifyFn = identifyAccountByType[user.type];
  if (!identifyFn) {
    return user.type;
  }
  return `${user.type}_${identifyFn(user.credentials)}`;
}

export function getLastImport(
  account: User,
  state: State | undefined,
  since: string | undefined,
): Moment | null {
  // When override
  if (since) {
    return moment(since);
  }

  // First run, when no state
  if (!state) {
    return null;
  }

  const accountIdentification = getAccountIdentification(account);
  if (state[accountIdentification]) {
    return moment(state[accountIdentification]);
  }

  return null;
}

interface StateWithLastImport {
  lastImport: State;
  [key: string]: unknown;
}

export function getStateWithLastImport(
  users: User[],
  state: Partial<StateWithLastImport>,
): StateWithLastImport {
  const now = moment().toISOString();
  const lastState = typeof state.lastImport === 'string' ? {} : state.lastImport || {};
  const newLastImport = users.reduce(
    (m, u) => ({
      ...m,
      [getAccountIdentification(u)]: now,
    }),
    lastState,
  );
  return { ...state, lastImport: newLastImport };
}
