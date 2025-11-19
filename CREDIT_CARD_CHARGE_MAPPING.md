# Credit Card Charge to Transfer Mapping

## Overview

This feature automatically converts withdrawal transactions to transfer transactions when they represent credit card charges being paid from a bank account to a credit card account.

## How It Works

When the importer encounters a withdrawal transaction:

1. It checks if the transaction description matches one of the configured `creditCardDesc` descriptions
2. It looks up the transaction in the `creditCardChargeMapping` configuration
3. If a matching rule is found (based on transaction description + source account), it converts the withdrawal to a transfer
4. The transfer shows money moving from the source bank account to the destination credit card account

## Configuration

### Step 1: Identify Your Transactions

First, identify which transaction descriptions represent credit card charges. These are typically already configured in `creditCardDesc` in `default.json`:

```json
"creditCardDesc": [
  {
    "desc": "ל.מאסטרקרד(יש)",
    "creditCard": "isracard"
  },
  {
    "desc": "ישראכרט-י",
    "creditCard": "isracard"
  },
  {
    "desc": "ויזה כ.א.ל-י",
    "creditCard": "visaCal"
  }
]
```

### Step 2: Find Your Account Names

You need to know the account names/numbers for the accounts:

- **Source account (bank)**: Must exist in Firefly III - these should match what you configured in your `config.yaml` under the `banks` section, or what Firefly automatically created.
- **Destination account (credit card)**: Can be any name or number. If the account doesn't exist in Firefly III, it will be **automatically created** as a credit card asset account.

For example:

- Source account (bank): `"12345"` or `"Bank Account Name"` - must exist
- Destination account (credit card): `"1234"` or `"Credit Card Name"` - will be created if needed

### Step 3: Add Mapping Rules

In your `config.yaml`, add the mapping rules under `creditCardChargeMapping`:

```yaml
creditCardChargeMapping:
  - transactionDesc: "ל.מאסטרקרד(יש)"
    sourceAccount: "123456789" # Your bank account number/name
    destinationAccount: "1234" # Your credit card last 4 digits or name

  - transactionDesc: "ישראכרט-י"
    sourceAccount: "987654321"
    destinationAccount: "5678"

  - transactionDesc: "ויזה כ.א.ל-י"
    sourceAccount: "Bank Account Name"
    destinationAccount: "Visa Card 9999"
```

**Important Notes:**

- `transactionDesc` must exactly match a description from `creditCardDesc` in `default.json`
- `sourceAccount` must exactly match the account number or name in Firefly III (must exist)
- `destinationAccount` can be any account name/number - will be **automatically created** as a credit card account if it doesn't exist
- Account matching is case-sensitive and must be exact
- `dayOfMonthRange` (optional): Specify days of month like `"1-4"` to differentiate between same transaction/account combinations based on when they occur

## How to Test

### Dry Run

Test your configuration without making any changes:

```bash
npm start -- --backfill --dryRun
```

This will show you what would be converted without actually making changes.

### Check Logs

When running, look for these log messages:

```
[INFO] Loaded credit card charge mapping configuration
    mappingRules: 3

[INFO] Credit card charge detection statistics
    totalTransactions: 1987
    withdrawals: 1867
    matchedAndConverted: 48
    unmatchedWithCreditCardDesc: 0

[INFO] Converted credit card charges to transfers
    convertedCharges: 48
```

If you see `unmatchedWithCreditCardDesc > 0`, it means there are transactions with credit card descriptions that don't have mapping rules. The first 3 will be logged with details so you can add them to your config.

### Apply Changes

Once you've verified the configuration works:

**For existing transactions (backfill):**

```bash
npm start -- --backfill
```

**For new transactions:**
Just run the regular import:

```bash
npm start
```

The mapping will be applied automatically to all new transactions.

## Troubleshooting

### No transactions are being converted

Check the logs for:

```
[INFO] Transaction has creditCardDesc but no mapping rule
    description: "ויזה כ.א.ל-י"
    sourceAccount: "123456789"
```

This tells you which combinations need mapping rules.

### Destination account not found

```
[WARN] Destination account not found in accountsMap
    destinationAccount: "1234"
```

This means the destination account doesn't exist in Firefly III or the name doesn't match exactly. Check:

1. The account exists in Firefly III
2. The account name/number matches exactly (case-sensitive)
3. For credit cards, you may need to use the full account number or the name as shown in Firefly

### Finding Account Names

To see what account names are available, look at the logs when running with backfill:

```
[INFO] Built accounts map with credit card details
    creditCardAccountDetails: [
      { accountNumber: "12345", accountId: "123", accountName: "...", last4: "2345" },
      { accountNumber: "67890", accountId: "456", accountName: "...", last4: "7890" }
    ]
```

Use the `accountNumber` value in your mapping configuration.

## Example Configuration

Complete example for a typical setup:

```yaml
# In config.yaml

creditCardChargeMapping:
  # Isracard charges from Leumi account to Isracard
  - transactionDesc: "ישראכרט-י"
    sourceAccount: "12345-67-890"
    destinationAccount: "1234"

  # Visa Cal charges from Leumi account to Visa card
  - transactionDesc: "ויזה כ.א.ל-י"
    sourceAccount: "12345-67-890"
    destinationAccount: "5678"

  # Max card charges from Poalim account to Max card
  - transactionDesc: "מקס איט פיננ-י"
    sourceAccount: "98765-43-210"
    destinationAccount: "9999"

  # Mastercard charges from Leumi account to Isracard
  - transactionDesc: "ל.מאסטרקרד(יש)"
    sourceAccount: "12345-67-890"
    destinationAccount: "1234"

  # Example with dayOfMonthRange - when you have different cards for same description/account
  # but charges occur on different days of the month
  - transactionDesc: "כרטיסי אשראי-י"
    sourceAccount: "12345-67-890"
    dayOfMonthRange: "1-10" # For charges on days 1-10
    destinationAccount: "4567" # Goes to first card

  - transactionDesc: "כרטיסי אשראי-י"
    sourceAccount: "12345-67-890"
    dayOfMonthRange: "11-31" # For charges on days 11-31
    destinationAccount: "8901" # Goes to second card
```

## Benefits

1. **Cleaner Reports**: Transfers show the money flow between accounts correctly
2. **Better Budgeting**: Credit card payments are no longer counted as expenses
3. **Accurate Balances**: Both bank and credit card balances are tracked correctly
4. **Automatic**: Once configured, works automatically for all future transactions
5. **Backfill Support**: Can convert existing historical transactions
6. **Auto-Create Accounts**: Destination credit card accounts are automatically created if they don't exist
7. **Flexible Mapping**: Use `dayOfMonthRange` to handle multiple cards with the same transaction description
