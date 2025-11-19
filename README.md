# Israeli Bank Firefly iii Importer
This project is in early stage! Please feel free to share your ideas and thoughts by creating an [issue](https://github.com/itairaz1/israeli-bank-firefly-importer/issues/new).

Using [Israeli bank scrapper](https://github.com/eshaham/israeli-bank-scrapers) and import the data into free and open source [Firefly iii](https://www.firefly-iii.org/). All this solution is for local installation (self-hosted), so you are not coupled with SaaS provider, but you will have to make sure your host is secured (On your own risk!).

## Features
1. Import all the transactions from your israeli bank site and israeli credit-cards sites into firefly iii.
2. Every run imports only the missing transactions.
3. Locate credit-card end-of-period transactions in your bank account, and change it to transfer transaction to the correct credit-card inorder to keep credit-card balance correct.
4. Optionally periodically running using CRON.
5. Automatically prevents duplicate transactions during import.
6. Remove duplicate transactions that already exist in Firefly based on external ID.
7. **Auto-detect transfers**: Automatically identifies if there's a deposit and withdrawal from two different accounts with the same amount within a few days, and converts them into a single transfer transaction between accounts.
8. **Auto-detect credit card payments**: Automatically identifies bank withdrawals that are credit card payments (by matching internal reference to credit card account number) and converts them to transfer transactions.
9. **Credit card charge mapping**: Manually map credit card charge transactions to convert them from withdrawals to transfers. Configure which bank account charges should be converted to transfers to which credit card account. See [Credit Card Charge Mapping Guide](CREDIT_CARD_CHARGE_MAPPING.md).
10. **Credit card merchant accounts**: Credit card transactions automatically create expense accounts based on merchant names, making it easier to track where you spent money. 

## Installing
### Prerequisite
1. [Firefly iii](https://www.firefly-iii.org/) is required in order to import data into - [getting started](https://github.com/firefly-iii/firefly-iii#getting-started).
2. Dedicated host (server) to install Firefly iii and this importer.
3. Supported accounts (Banks and credit-cards): [currently supported](#supported-accounts).
4. You will have to provide usernames and passwords for your accounts (Locally), so make sure your host is secured.

### Steps (Quick start)
1. Run `npm install -g israeli-bank-firefly-importer`.
2. Create API Token in firefly iii by - 
   1. Go to your hosted Firefly iii user interface.
   2. Click on 'Options' on the left.
   3. Click on 'Profile' in the sub menu.
   4. Click on 'OAuth' tab.
   5. Under 'Personal Access Tokens' click on 'Create new token'.
   6. Give a name and click create.
   7. Keep the token for later stage.
3. Copy [config template](config/basic.template.config.yaml) to working directory, change the name to `config.yaml` and edit it based on the comments
   ```shell
   wget https://raw.githubusercontent.com/itairaz1/israeli-bank-firefly-importer/main/config/basic.template.config.yaml
   mv basic.template.config.yaml config.yaml
   vi config.yaml
   ```
4. Start by running `israeli-bank-firefly-importer` in your terminal.

### Using docker
You can build docker using following command:
```shell
docker build image-name:tag
```
Or you can just use the official docker `itair86/israel-bank-firefly-importer` and run it by the following command:
```shell
docker run -v path-to/config.yaml:/home/pptruser/app/config.yaml itair86/israel-bank-firefly-importer:latest
```
While `path-to/config.yaml` is path to your config file (See [installing steps](#steps-quick-start), step #3)

### Using Home Assistant
Check [israeli-bank-firefly-importer-hass-addon](https://github.com/itairaz1/israeli-bank-firefly-importer-hass-addon) repository.

## Command-Line Options

The importer supports various command-line options to customize its behavior:

```bash
israeli-bank-firefly-importer [options]
```

### Available Options

| Option | Description | Example |
|--------|-------------|---------|
| `--help`, `-h` | Show help message with all available options | `israeli-bank-firefly-importer --help` |
| `--dry-run` | Preview what would be imported without making changes | `israeli-bank-firefly-importer --dry-run` |
| `--since YYYY-MM-DD` | Process transactions since this date | `israeli-bank-firefly-importer --since 2024-01-01` |
| `--backfill` | Backfill existing transactions (convert to transfers) | `israeli-bank-firefly-importer --backfill` |
| `--date-tolerance N` | Days tolerance for matching transfers (default: 2) | `israeli-bank-firefly-importer --backfill --date-tolerance 3` |
| `--cleanup` | Drop all state and clean up | `israeli-bank-firefly-importer --cleanup` |
| `--remove-duplicates` | Remove duplicate transactions | `israeli-bank-firefly-importer --remove-duplicates` |
| `--list-transactions` | List all transactions | `israeli-bank-firefly-importer --list-transactions` |
| `--only-accounts A,B,C` | Process only specific accounts (comma-separated) | `israeli-bank-firefly-importer --only-accounts leumi,isracard` |
| `--skip-edit` | Skip editing existing transactions | `israeli-bank-firefly-importer --skip-edit` |

### Usage Examples

```bash
# Normal import (production)
israeli-bank-firefly-importer

# Preview import without changes
israeli-bank-firefly-importer --dry-run

# Import transactions since January 1st, 2024
israeli-bank-firefly-importer --since 2024-01-01

# Backfill existing transactions (preview first)
israeli-bank-firefly-importer --backfill --dry-run
israeli-bank-firefly-importer --backfill

# Backfill with custom date tolerance
israeli-bank-firefly-importer --backfill --date-tolerance 3

# Backfill only recent transactions
israeli-bank-firefly-importer --backfill --since 2024-01-01

# Remove duplicates
israeli-bank-firefly-importer --remove-duplicates

# List all transactions
israeli-bank-firefly-importer --list-transactions

# Import only specific accounts
israeli-bank-firefly-importer --only-accounts leumi,isracard
```

## Schedule
If you want to let `israeli-bank-firefly-importer` running recurrently, you can set [cron expression](https://crontab.guru/) in `CRON` environment variable.

**Note:** Scheduled runs will only execute in normal import mode (not dry-run, backfill, cleanup, etc.).

## Auto-Detect Transfers
The importer includes two automatic transfer detection features that help keep your accounts balanced correctly:

1. **Account-to-Account Transfers**: Detects when you transfer money between your accounts
2. **Credit Card Payments**: Detects when you pay your credit card bill from your bank account

### Account-to-Account Transfer Detection

The importer automatically detects when you have a deposit and withdrawal transaction from two different accounts with the same amount within a few days, and converts them into a single transfer transaction. This feature helps keep your accounts balanced correctly when you move money between your accounts, accounting for processing delays that can take 1-2 business days.

#### How it works
1. Sorts all transactions by date
2. Identifies matching pairs where:
   - One transaction is a deposit and the other is a withdrawal
   - Both have the same amount (within 0.01 tolerance for rounding)
   - They occur within the configured date tolerance (default: 2 days)
   - They are from different accounts
3. Converts the pair into a single transfer transaction from source account to destination account
4. Combines descriptions and notes from both transactions

#### Configuration
This feature is enabled by default with a 2-day date tolerance. To customize it, add the following to your `config.yaml`:

```yaml
# Enable/disable auto-detect transfers (default: true)
autoDetectTransfers: true

# Number of days to look for matching pairs (default: 2)
# Set to 0 to only match transactions on the same day
# Set to 1-2 to account for processing delays between accounts
transferDateTolerance: 2
```

Or you can set environment variables:

```bash
export AUTO_DETECT_TRANSFERS=false  # To disable
export TRANSFER_DATE_TOLERANCE=1    # To only match within 1 day
```

**Note:** 
- This feature checks for existing transfers to avoid creating duplicates
- If a matching transfer already exists, the duplicate deposit/withdrawal pair will not be imported
- This helps maintain data consistency when running imports multiple times or after manual transfer creation

#### Examples
- **Same day**: Withdrawal on Jan 15, Deposit on Jan 15 → ✓ Converts to transfer
- **1 day apart**: Withdrawal on Jan 15, Deposit on Jan 16 → ✓ Converts to transfer
- **2 days apart**: Withdrawal on Jan 15, Deposit on Jan 17 → ✓ Converts to transfer (with default settings)
- **3+ days apart**: Withdrawal on Jan 15, Deposit on Jan 18 → ✗ Kept as separate transactions (exceeds default tolerance)

### Credit Card Payment Detection

The importer automatically detects credit card payment transactions and converts them to transfers. When you pay your credit card bill from your bank account, the bank typically records the payment with the credit card number (e.g., "6943") in the internal reference field. This feature identifies these transactions and converts them to proper transfer transactions between your bank account and credit card account.

#### How it works
1. Scans all withdrawal transactions from bank accounts
2. Checks if the `internal_reference` field matches a credit card account number
3. Matches by:
   - Full credit card account number, or
   - Last 4 digits of the credit card account number
4. Converts the withdrawal to a transfer from the bank account to the credit card account
5. Adds a note indicating it was auto-detected as a credit card payment

#### Examples
- **Bank withdrawal** with internal reference "6943" → ✓ Converts to transfer to credit card account ending in 6943
- **Bank withdrawal** with internal reference matching full CC account number → ✓ Converts to transfer to that credit card
- **Bank withdrawal** with no internal reference → ✗ Kept as withdrawal transaction

**Note:**
- This feature runs before account-to-account transfer detection
- It only processes withdrawal transactions from bank accounts
- Credit card accounts must be properly configured in Firefly III with account numbers
- The feature is always enabled and does not require additional configuration

### Credit Card Merchant Accounts

When importing credit card transactions, the importer automatically creates expense accounts for each merchant (transaction description). This makes it easier to track and categorize your spending by merchant.

#### How it works
1. When a credit card transaction is imported (e.g., a purchase at a store)
2. The merchant name (transaction description) is used to create or find an expense account
3. The transaction is recorded as a withdrawal from your credit card to that merchant's expense account
4. If the merchant account doesn't exist, it's automatically created as an expense account in Firefly III
5. Future transactions with the same merchant will reuse the existing account

#### Benefits
- **Better categorization**: See all transactions grouped by merchant
- **Spending insights**: Easily track how much you spend at specific stores or services
- **Automatic organization**: No manual account creation needed
- **Consistent data**: Same merchant names always use the same account

#### Examples
- Credit card purchase at "SuperPharm" → Creates expense account "SuperPharm" (if it doesn't exist)
- Credit card purchase at "Shufersal" → Creates expense account "Shufersal" (if it doesn't exist)
- Credit card purchase at "Gas Station" → Creates expense account "Gas Station" (if it doesn't exist)

**Note:**
- The feature uses an in-memory cache to avoid redundant API calls when processing multiple transactions from the same merchant
- If account creation fails for any reason, the transaction is still imported but without a destination account
- Merchant accounts are created as "expense" type accounts in Firefly III
- **Dry-run mode**: When using `--dry-run` flag, the importer will search for existing expense accounts but will NOT create new ones, allowing you to preview which accounts would be created

#### Updating Existing Transactions
If you have existing credit card transactions in Firefly III that were imported without destination accounts, the importer will automatically detect and update them on the next run:

1. During import, the importer checks for existing transactions with the same external ID
2. If an existing credit card withdrawal has no destination account but the new import would create one
3. The transaction is updated to add the merchant's expense account as the destination
4. This happens automatically without creating duplicates

**Example:**
- You have an existing transaction: Credit card withdrawal of ₪50 to "SuperPharm" (no destination account)
- On next import: The same transaction is detected, merchant account "SuperPharm" is created/found
- Result: The existing transaction is updated with "SuperPharm" as the destination account

This ensures all your credit card transactions have proper merchant tracking, even if they were imported before this feature was added.

### Backfilling Existing Transactions
If you already have transactions in Firefly III and want to convert existing matching deposit/withdrawal pairs to transfers, use the backfill mode:

```bash
# Dry run first to see what would be changed
israeli-bank-firefly-importer --backfill --dry-run

# Run the actual conversion
israeli-bank-firefly-importer --backfill

# Only process transactions after a specific date
israeli-bank-firefly-importer --backfill --since 2024-01-01

# Use custom date tolerance
israeli-bank-firefly-importer --backfill --date-tolerance 1

# Combine options
israeli-bank-firefly-importer --backfill --dry-run --since 2024-01-01 --date-tolerance 3
```

**If running with npm:**
```bash
npm start -- --backfill --dry-run
```

**Using docker:**
```bash
# Dry run
docker run -v path-to/config.yaml:/home/pptruser/app/config.yaml itair86/israel-bank-firefly-importer:latest --backfill --dry-run

# Actual run
docker run -v path-to/config.yaml:/home/pptruser/app/config.yaml itair86/israel-bank-firefly-importer:latest --backfill
```

**Options:**
- `--backfill`: Enable backfill mode (process existing Firefly transactions)
- `--dry-run`: Preview what would be converted without making changes
- `--date-tolerance N`: Number of days to look for matches (default: 2)
- `--since YYYY-MM-DD`: Only process transactions after this date

**⚠️ Important:** 
- Always run with `--dry-run` first to review the changes
- The backfill will delete the original deposit and withdrawal transactions and create new transfer transactions
- Make sure you have a backup of your Firefly III database before running
- This is a one-time operation - future imports will automatically detect transfers

## Removing Duplicate Transactions
If you've accidentally imported duplicate transactions into Firefly, you can remove them using the duplicate removal mode. This tool:
- Identifies all transactions with duplicate external IDs
- Keeps the earliest transaction (by date) for each duplicate group
- Automatically deletes the rest

### Usage

```bash
# Remove duplicate transactions
israeli-bank-firefly-importer --remove-duplicates
```

**If running with npm:**
```bash
npm start -- --remove-duplicates
```

**Using docker:**
```bash
docker run -v path-to/config.yaml:/home/pptruser/app/config.yaml itair86/israel-bank-firefly-importer:latest --remove-duplicates
```

The tool will:
1. Fetch all transactions from Firefly
2. Group them by external_id
3. Display which duplicates were found
4. Keep the earliest transaction in each group
5. Delete all other duplicates

**Note:** This is a one-time operation. Future imports will automatically prevent duplicates from being created.

## Listing Transactions
To view all transactions in Firefly III:

```bash
# List all transactions
israeli-bank-firefly-importer --list-transactions
```

**If running with npm:**
```bash
npm start -- --list-transactions
```

**Using docker:**
```bash
docker run -v path-to/config.yaml:/home/pptruser/app/config.yaml itair86/israel-bank-firefly-importer:latest --list-transactions
```

## Dry Run Mode
You can preview what would be imported without making any changes:

```bash
# Normal import in dry run mode
israeli-bank-firefly-importer --dry-run

# Backfill in dry run mode
israeli-bank-firefly-importer --backfill --dry-run

# Import since a specific date in dry run mode
israeli-bank-firefly-importer --since 2024-01-01 --dry-run
```

Dry run mode will:
- Show all transactions that would be created or updated
- Search for existing expense accounts but not create new ones
- Display which merchant expense accounts would be created (logged with 🔍 prefix)
- Not make any changes to Firefly III
- Not update the last import state
- Display a summary of what would happen

## Supported accounts
### Supported and tested accounts
1. Leumi
2. Isracard
3. Cal
4. Max

### Supported by [Israeli bank scrapper](https://github.com/eshaham/israeli-bank-scrapers) but not yet tested ([Report an issue](https://github.com/itairaz1/israeli-bank-firefly-importer/issues/new))
[Support list](https://github.com/eshaham/israeli-bank-scrapers#whats-here)

## Changing settings
The accounts and transactions that created are being created with some details and settings that you can change. For example, you can remove `Include in net worth` from credit card accounts, if you wish. There are some details that you don't want to change, since this importer is using them in order to keep track:
1. Account's number.
2. Transaction's Tags.
3. If exists, transaction's External ID.
4. If transaction's External ID not exists - All transactions settings shouldn't be change except budget.

## Development

### TypeScript

This project is written in TypeScript and includes type definitions for all modules. The source code is in the `src/` directory with `.ts` files, and compiled JavaScript output goes to the `dist/` directory.

#### Available Scripts

```bash
# Build the project
npm run build

# Build and watch for changes
npm run build:watch

# Clean build artifacts
npm run clean

# Run in development mode with watch
npm run dev

# Run the compiled production build
npm run start:prod

# Run TypeScript directly with tsx
npm start

# Run with options (examples)
npm start -- --dry-run
npm start -- --backfill --dry-run
npm start -- --remove-duplicates
npm start -- --list-transactions
npm start -- --since 2024-01-01
npm start -- --help
```

#### TypeScript Configuration

The project uses strict TypeScript settings with the following features:
- ES2022 target and module system
- Strict type checking enabled
- Source maps and declaration files generated
- ESM module interop for compatibility

#### Project Structure

```
src/
  ├── index.ts                 # Main entry point
  ├── firefly.ts              # Firefly III API client
  ├── logger.ts               # Logging utilities
  ├── load-config.ts          # Configuration loader
  └── importer/
      ├── index.ts            # Import orchestration
      ├── scrapper.ts         # Bank scraping logic
      ├── credit-cards.ts     # Credit card processing
      ├── transfer-detector.ts # Transfer detection algorithms
      ├── last-import-helper.ts # Import state management
      └── scrap-manipulater/
          ├── index.ts        # Data manipulation
          └── leumi.ts        # Bank-specific handlers

dist/                         # Compiled JavaScript output
config/                       # Configuration templates
```

#### Type Definitions

All major interfaces and types are defined in their respective modules:
- `Transaction`: Transaction data structure
- `FormattedTransaction`: Formatted transaction for Firefly API
- `AccountsMap`: Map of account numbers to account details
- `ConversionResult`: Transfer detection results

## Missing features and known issues
1. Test all banks and credit cards.
2. Code quality: Add tests, error handling, and more.
3. Support changing config after first run.
4. Support multi banks.
5. Make it more CLI friendly.
6. Refund is not getting deleted.

## Report a bug
To report a bug please [create an issue](https://github.com/itairaz1/israeli-bank-firefly-importer/issues/new) with the following details:
1. Detailed bug description
2. Israel Bank Firefly Importer version
3. Firefly iii version
4. Operating system
5. Installation type (Native / Docker / HA addon)
6. Sensitized debug log - example of how to turn on debug logs [here](https://github.com/itairaz1/israeli-bank-firefly-importer/blob/main/config/example.yaml#L34). Make sure you going through the logs and remove any sensitive data.

## License
[MIT License](LICENSE)
