import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";
import mercurysandbox from '@api/mercurysandbox';
import mercurylive from '@api/mercurytechnologies';
const mercury = process.env['SANDBOX'] ? mercurysandbox : mercurylive;

type NumStr = `${number}`;
interface MemberWeight {
  memberId: string;
  weight: NumStr;
}
interface SettleUpItem {
  amount: NumStr;
  forWhom: MemberWeight[];
}
interface SettleUpTransaction {
  category?: string;
  currencyCode: string;
  dateTime: number;
  exchangeRates?: Record<string, NumStr>;
  fixedExchangeRate?: boolean;
  items: [SettleUpItem];
  purpose?: string;
  timezone?: string;
  type: 'expense' | 'transfer';
  whoPaid: MemberWeight[];
}

interface SettleUpMember {
  active: boolean;
  defaultWeight: NumStr;
  name: string;
}

type MercuryTransaction = Exclude<Awaited<ReturnType<(typeof mercury)['transactions1']>>['data']['transactions'], undefined>[0];

const firebaseConfig = {
  apiKey: process.env['SANDBOX'] ? 'AIzaSyCfMEZut1bOgu9d1NHrJiZ7ruRdzfKEHbk' : process.env['SETTLEUP_API_KEY'],
  databaseURL: process.env['SANDBOX'] ? 'https://settle-up-sandbox.firebaseio.com' : 'https://settle-up-live.firebaseio.com',
}
//console.dir(process.env);
//console.dir(firebaseConfig);
const app = initializeApp(firebaseConfig);
const settleUpAuth = getAuth(app);

const mercuryToken = process.env['MERCURY_TOKEN'];
const email = process.env['SETTLEUP_EMAIL'];
const password = process.env['SETTLEUP_PASSWORD'];

interface SyncConfig {
  mercuryAccount: string;
  mercurySubstring: string;
  settleUpGroup: string;
  settleUpPayer: string;
  settleUpSplit?: Array<{
    memberId: string,
    weight: NumStr,
  }>; // if unspecified, fetches the Settle Up group's default weights
  numDaysHistory?: number; // default is 180
}
interface ImportedSyncConfig {
  mercuryAccount: string;
  mercurySubstring: string;
  settleUpGroup: string;
  settleUpPayer: string;
  settleUpSplit?: Array<{
    memberId: string,
    weight: string,
  }>; // if unspecified, fetches the Settle Up group's default weights
  numDaysHistory?: number; // default is 180
}
import configs__ from "../config.json" with { type: 'json' };
const configs_: ImportedSyncConfig[] = configs__;
const configs: SyncConfig[] = configs_ as SyncConfig[];

const sync = async (config: SyncConfig, settleUpToken: string) => {
  const transactionsNotSeen: string[] = [];
  const settleUpMembers: Record<string, SettleUpMember> = await fetch(`${firebaseConfig.databaseURL}/members/${config.settleUpGroup}.json?auth=${settleUpToken}`, {
  })
    .then((response) => response.json())
    .catch((error) => { console.error(error); return {}; });
  if (settleUpMembers[config.settleUpPayer] === undefined) {
    console.error(`Payer ${config.settleUpPayer} is not in the Settle Up group ${config.settleUpGroup}`);
    return false;
  }
  if (config.settleUpSplit === undefined) {
    config.settleUpSplit = [];
    for (const [id, member] of Object.entries(settleUpMembers)) {
      if (member.active) {
        config.settleUpSplit.push({ memberId: id, weight: member.defaultWeight });
      }
    }
  }
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - (config.numDaysHistory ?? 180));
  const mercuryQuery = {
    limit: 500,
    offset: 0,
    order: 'desc',
    id: config.mercuryAccount,
    start: startDate.toISOString(),
    search: config.mercurySubstring,
  } as Parameters<(typeof mercury)['transactions1']>[0];
  let mercuryOK = true;
  let { total, transactions } = await mercury.transactions1(mercuryQuery)
    .then(response => response.data)
    .catch((error) => { console.error(error); mercuryOK = false; return undefined; })
    ?? { total: 0, transactions: [] };
  while (total === 500) {
    mercuryQuery.offset! += 500;
    const { total: nextTotal, transactions: nextTransactions } = await mercury.transactions1(mercuryQuery)
      .then(response => response.data)
      .catch((error) => { console.error(error); mercuryOK = false; return undefined; })
      ?? { total: 0, transactions: [] };
    total = nextTotal;
    transactions = transactions?.concat(nextTransactions ?? []) ?? nextTransactions;
  }
  if (!mercuryOK) {
    console.error(`Encountered one or more errors fetching transactions with substring ${config.mercurySubstring} from Mercury account ${config.mercuryAccount}`);
    return false;
  }
  if (transactions === undefined || transactions.length === 0) {
    console.warn(`No transactions with substring ${config.mercurySubstring} found in Mercury account ${config.mercuryAccount} in the past 6 months`);
    return [[] as string[], [] as string[]] as const;
  }
  //console.log(JSON.stringify(transactions, null, 2));
  let settleUpError: unknown = undefined;
  const settleUpTransactions = await fetch(`${firebaseConfig.databaseURL}/transactions/${config.settleUpGroup}.json?auth=${settleUpToken}&orderBy="$key"&startAt="mercury-${startDate.valueOf()}"&endAt="mercury-\uf8ff"`, {
  }).then((response) => response.json() as Promise<Record<string, SettleUpTransaction>>)
    .catch((error) => { console.error(error); settleUpError = error; return {} as Record<string, SettleUpTransaction>; });
  if (settleUpError) {
    console.error(`Error fetching Settle Up transactions for group ${config.settleUpGroup}:`);
    console.error(settleUpError);
    // abort rather than risk overwriting data we couldn't retrieve
    return false;
  }
  //console.log(JSON.stringify(settleUpTransactions, null, 2));
  const mercuryTransactionsByID = new Map<string, MercuryTransaction>(
    transactions.map((transaction) => [`mercury-${new Date(transaction.createdAt!).valueOf()}-${transaction.id}`, transaction])
  );
  const newSettleUpTransactions: Record<string, SettleUpTransaction> = {};
  Object.entries(settleUpTransactions).forEach(([id, transaction]) => {
    const mercuryTransaction = mercuryTransactionsByID.get(id);
    if (mercuryTransaction === undefined) {
      //console.log(`No Mercury transaction found for id ${id}`);
      transactionsNotSeen.push(id);
      /*
      fetch(`${firebaseConfig.databaseURL}/transactions/${config.settleUpGroup}/${id}.json?auth=${settleUpToken}`, {
        method: 'DELETE',
      });
      */
      return;
    }
    if (checkMatching(transaction, mercuryTransaction, config)) {
      //console.log(`No change needed for id ${id}`);
      return;
    }
    //console.log(`Generating merged Settle Up transaction for id ${id}`);
    const generated = generateTransaction(mercuryTransaction, config.settleUpSplit!, config.settleUpPayer, config.mercurySubstring);
    if (generated === undefined) {
      //console.log(`No Settle Up transaction should be generated for id ${id}`);
      transactionsNotSeen.push(id);
      /*
      fetch(`${firebaseConfig.databaseURL}/transactions/${config.settleUpGroup}/${id}.json?auth=${settleUpToken}`, {
        method: 'DELETE',
      });
      */
      return;
    }
    newSettleUpTransactions[id] = {
      ...transaction,
      ...generated,
      items: [{
        amount: generated.items[0].amount,
        forWhom: transaction.items[0].forWhom, // preserve split if edited
        // TODO(extra): track previous split so we can change past transactions with wrong default split
      }]
    };
  });
  for (const [id, mercuryTransaction] of mercuryTransactionsByID.entries()) {
    if (settleUpTransactions[id] === undefined && newSettleUpTransactions[id] === undefined) {
      //console.log(`Generating new Settle Up transaction for id ${id}`);
      const generated = generateTransaction(mercuryTransaction, config.settleUpSplit!, config.settleUpPayer, config.mercurySubstring)!;
      if (generated === undefined) {
        //console.log(`No Settle Up transaction should be generated for id ${id}`);
      }
      else {
        newSettleUpTransactions[id] = generated;
      }
    }
  }

  //console.log(JSON.stringify(newSettleUpTransactions, null, 2));
  await fetch(`${firebaseConfig.databaseURL}/transactions/${config.settleUpGroup}.json?auth=${settleUpToken}`, {
    method: 'PATCH',
    body: JSON.stringify(newSettleUpTransactions),
  })/*.then(async (response) => console.log(JSON.stringify(await response.json(), null, 2))*/.catch((error) => console.error(error));

  return [[...mercuryTransactionsByID.keys()], transactionsNotSeen] as const;
}

(async () => {
  if (firebaseConfig.apiKey === undefined) {
    console.error('Either set $SANDBOX=1 or set $SETTLEUP_API_KEY to a production API key');
    return false;
  }
  if (email === undefined || password === undefined) {
    console.error('Provide $SETTLEUP_EMAIL and $SETTLEUP_PASSWORD for authentication');
    return false;
  }
  if (mercuryToken === undefined) {
    console.error('Provide a $MERCURY_TOKEN with read access to all accounts you want synced');
    console.log(`Generate a token at ${process.env['SANDBOX'] ? 'https://sandbox.mercury.com/settings/tokens' : 'https://mercury.com/settings/tokens'}`);
    return false;
  }
  mercury.auth(`${mercuryToken}`);
  const settleUpToken = await (await signInWithEmailAndPassword(settleUpAuth, email, password)).user.getIdToken();
  const seen = new Map<string, Set<string>>();
  const unseen = new Map<string, Set<string>>();
  const error = new Map<string, boolean>();
  for (const config of configs) {
    const result = await sync(config, settleUpToken);
    if (result) {
      const [newSeen, newUnseen] = result;
      seen.set(config.settleUpGroup, (seen.get(config.settleUpGroup) ?? new Set()).union(new Set(newSeen)));
      unseen.set(config.settleUpGroup, (unseen.get(config.settleUpGroup) ?? new Set()).union(new Set(newUnseen)));
    }
    else {
      error.set(config.settleUpGroup, true);
    }
  }
  for (const [group, unseenTransactions] of unseen.entries()) {
    if (error.get(group)) {
      console.warn(`Encountered one or more errors syncing with group ${group}; not deleting any transactions from Settle Up`);
      continue;
    }
    for (const id of unseenTransactions.difference(seen.get(group) ?? new Set())) {
      await fetch(`${firebaseConfig.databaseURL}/transactions/${group}/${id}.json?auth=${settleUpToken}`, {
        method: 'DELETE',
      });
    }
  }
})();

const transactionTypes = new Map<string, 'expense' | 'transfer' | undefined>([
  ['externalTransfer', 'expense'], //TODO(extra): autodetect transfers to group members
  ['internalTransfer', undefined],
  ['outgoingPayment', 'expense'],
  ['creditCardCredit', 'expense'],
  ['creditCardTransaction', 'expense'],
  ['debitCardTransaction', 'expense'],
  ['incomingDomesticWire', 'expense'],
  ['checkDeposit', 'expense'],
  ['incomingInternationalWire', 'expense'],
  ['treasuryTransfer', undefined],
  ['wireFee', 'expense'],
  ['cardInternationalTransactionFee', 'expense'],
  ['other', 'expense'],
]);
const transactionLabels = new Map<string, string>([
  ['externalTransfer', "Transfer"],
  ['internalTransfer', "Transfer"],
  ['outgoingPayment', "Payment"],
  ['creditCardCredit', "Refund"],
  ['creditCardTransaction', "Card Payment"],
  ['debitCardTransaction', "Card Payment"],
  ['incomingDomesticWire', "Wire"],
  ['checkDeposit', "Check"],
  ['incomingInternationalWire', "Wire"],
  ['treasuryTransfer', "Transfer"],
  ['wireFee', "Wire Fee"],
  ['cardInternationalTransactionFee', "Card Fee"],
  ['other', "Payment"],
]);
const mercuryTransactionPurpose = (m: MercuryTransaction, searchString: string) => (
  (`Mercury: ${(
    `${m.note || ""}`.replace(searchString, '').replace(dollarAmountRegex, '').trim() || m.externalMemo)
    ?? `${transactionLabels.get(m.kind!) ?? "Payment"} ${m.amount! > 0 ? 'from' : 'to'} ${m.counterpartyNickname ?? m.counterpartyName}`
  }`).substring(0, 128)
);

const dollarAmountRegex = /\$(\d+(?:\.\d+)?)/;
function parseDollarAmount(note: string): number | null {
  const match = note.match(dollarAmountRegex)
  
  if (match) {
    // match[1] contains the number part without the $
    return parseFloat(match[1]);
  }
  
  return null;
}

const generateTransaction = (
  m: MercuryTransaction,
  split: MemberWeight[],
  payer: string,
  searchString: string,
): SettleUpTransaction | undefined => {
  if (m.kind === undefined
    || m.amount === undefined
    || m.createdAt === undefined
  ) {
    return undefined;
  }
  const type = transactionTypes.get(m.kind!);
  if (type === undefined) return undefined;
  if (!(m.status === 'pending' || m.status === 'sent')) return undefined;
  return {
    dateTime: new Date(m.createdAt!).valueOf(),
    currencyCode: 'USD', // TODO(extra): support multiple currencies / exchange rate data
    items: [{
      amount: `${(parseDollarAmount(m.note as string) ?? m.amount!) * -1}`,
      forWhom: split,
    }],
    type, 
    whoPaid: [{ memberId: payer, weight: `${m.amount! * -1}` }],
    purpose: mercuryTransactionPurpose(m, searchString),
    exchangeRates: {
      USD: "1",
    },
    fixedExchangeRate: false,
    // TODO(extra): support receipt upload syncing
  }
}
const checkMatching = (
  s: SettleUpTransaction,
  m: MercuryTransaction,
  config: SyncConfig,
) => {
  const amountDifference = Number.parseFloat(s.items[0].amount) + (parseDollarAmount(m.note as string) ?? m.amount!);
  //console.log(`${s.items[0].amount} + ${m.amount} = ${amountDifference}`);
  //console.log(`${s.type} === ${transactionTypes.get(m.kind!)}`);
  //console.log(`${s.purpose} === ${mercuryTransactionPurpose(m, searchString)}`);
  //console.log(`m.status = ${m.status}`);
  return (
    amountDifference < 0.01
    && amountDifference > -0.01
    && s.type === transactionTypes.get(m.kind!)
    && s.purpose === mercuryTransactionPurpose(m, config.mercurySubstring)
    && (m.status === 'pending' || m.status === 'sent')
    && s.whoPaid[0].memberId === config.settleUpPayer
  );
}
