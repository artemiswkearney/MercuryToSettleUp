# Mercury to Settle Up Bridge

A script to sync transactions from one or more [Mercury](https://mercury.com/) accounts to [Settle Up](https://settleup.app/).

Can also be used to mass-edit transaction splits for a timeframe.

## First-Time Setup

Requires npm and node.js version 22+.

```bash
npm run setup
```

## Configuration

Create the file `config.json` in the project root, containing an array of configs meeting the type signature:
```ts
interface SyncConfig {
  mercuryAccount: string; // Mercury account ID
  mercurySubstring: string; // string to search for in transactions' notes (only matching transactions will be synced; must be specified, may be empty)
  settleUpGroup: string; // Settle Up group ID
  settleUpPayer: string; // Settle Up member ID of the user who should be credited as having paid for synced transactions
  settleUpSplit?: Array<{
    memberId: string,
    weight: `${number}`, // number of shares this member owes; for whatever reason, this is expected to be a string containing a number
  }>; // how synced expenses should be split; if unspecified, fetches the Settle Up group's default weights
  numDaysHistory?: number; // max number of days ago to sync transactions from; default is 180
}
```
Your Mercury account ID can be found by going to [your Accounts page](https://mercury.com/accounts), clicking on the account you want to sync, and copying the account ID from the last segment of the URL. To find the ID for your Mercury Credit account, find a transaction that interacted with it, then click "Mercury Credit" in the panel on the right (you should see the hover text "View all transactions"). The ID is enclosed in `["` / `"]`.

Your Settle Up group ID is after `/groups` in the URL. To find your member ID, go to the Members tab, click your name, then click "Transactions with this member"; the ID is the last segment of the URL.

## Usage

To authenticate with Mercury, generate a token [in your Mercury settings](https://mercury.com/settings/tokens) and provide it in environment variable `MERCURY_TOKEN`.

To authenticate with Settle Up, provide environment variables `SETTLEUP_EMAIL` and `SETTLEUP_PASSWORD`. (Yes, I know. They use Firebase, and apparently it's either that or OAuth.)

In addition, to work with a real Settle Up account/group, you'll need to [request a production API key for Settle Up](https://docs.google.com/document/d/18mxnyYSm39cbceA2FxFLiOfyyanaBY6ogG7oscgghxU/edit?tab=t.0#heading=h.ki5b28f4sinr) and provide it in the environment variable `SETTLEUP_API_KEY`.

Alternatively, set `SANDBOX=1` to run the script against [Mercury](https://docs.mercury.com/reference/using-the-mercury-sandbox-for-api-testing) and [Settle Up](https://docs.google.com/document/d/18mxnyYSm39cbceA2FxFLiOfyyanaBY6ogG7oscgghxU/edit?tab=t.0#heading=h.6vuelsvh29rn)'s sandbox instances. (This is probably a good idea while you're testing out your config.)

Run the script with `npm run start`. You may want to run this command on some sort of schedule, such as a cron job.

The script is designed to run against the same group(s) repeatedly; each time it runs, it will resynchronize all transactions within the specified timeframe, creating any transactions found in Mercury but not present on Settle Up, updating any that have changed since the last sync (or that would look different with your current config), and deleting any that have been canceled / failed, have been deleted, or no longer contain `mercurySubstring` in their note. Edits such as assigning a category or changing a transaction's split on Settle Up will be preserved in future syncs. (This does mean that updating the `settleUpSplit` section of a config won't update existing synced transactions; to force an update, you can delete the transaction on Settle Up and sync again to regenerate it.) Transactions older than `numDaysHistory` will be left untouched.

As a precaution, if any error is encountered processing any config for a given Settle Up group, or if no transactions are found within the specified time period for any config for a given Settle Up group, no transactions will be deleted in that group during that run. Errors will be logged to stderr as they occur; if you see any, try to fix them and sync again to remove any transactions that should have been deleted. (New and edited transactions will still be synced in groups with errors.)

## Configuration (Mass Edit Splits)
Create the file `resplits.json` in the project root, containing an array of configs meeting the type signature:
```ts
interface MassResplitConfig {
  settleUpGroup: string; // Settle Up group ID
  startDate: string; // Start of the timespan in which splits will be adjusted, in any format parseable by the `Date` constructor
  endDate: string; // End of the timespan in which splits will be adjusted, in any format parseable by the `Date` constructor
  splitToMatch: Array<{ // All transactions with this split between `startDate` and `endDate` will be adjusted
    memberId: string,
    weight: `${number}`,
  }>;
  newSplit: Array<{ // The split to overwrite `splitToMatch` with on all matched transactions
    memberId: string,
    weight: `${number}`,
  }>;
}
```
To generate a template mass resplit config, run the script with argument `createTemplate`. You must either have at least one sync config in config.json, or provide a group ID as the next command line argument. The script must be able to authenticate with Settle Up, as it retrieves the first and last transactions in the group (to fill in `startDate` and `endDate`) and the group's default split (to fill in `splitToMatch` and `newSplit`).

Running the script as normal will also apply all specified resplits in the order they appear in `resplits.json`. For this to succeed, the script must be able to authenticate with Settle Up; however, it does not need to be able to authenticate with Mercury if `configs.json` contains no sync configs. If both files contain configs of the relevant types, all sync configs will be processed before all resplit configs (meaning any synced transactions will be affected by any applicable resplits in the same run that they're created).

## Developing

All the code lives in `src/index.ts`. After making changes, recompile with `npm run build`. (Config changes won't require a recompile.)

`npm run build:live` will automatically rerun the script for you every time you save your changes to the file.

## About

This script was written as freelance work. Bug reports will be investigated and pull requests may be reviewed, but any feature requests will have to be paid. (`// TODO(extra)` comments indicate places where I could imagine adding a feature, but would want to be paid to do so.) Support for filtering by Mercury tag rather than searching in notes is planned, once Mercury adds tags to their API in some fashion.
