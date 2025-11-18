# Transfer Detection Feature

## Overview
This feature automatically identifies matching deposit and withdrawal transactions from different accounts with the same amount on the same day, and converts them into a single transfer transaction.

## Implementation Details

### Core Module: `src/importer/transfer-detector.js`
This module contains the main logic for detecting and converting transfer pairs:

- **`detectAndConvertTransfers(transactions)`**: Main function that processes an array of transactions
  - Groups transactions by date
  - Identifies matching deposit/withdrawal pairs
  - Converts pairs to transfer transactions
  - Returns an object with transfers, remaining transactions, and all transactions

- **`applyTransferDetection(transactions, config)`**: Wrapper function that checks configuration before applying detection
  - Respects the `autoDetectTransfers` config option
  - Enabled by default

### Algorithm
1. **Validation Phase:**
   - Filter out transactions missing required fields (date, type, amount, external_id)
   - Log warnings for invalid transactions
   - Validate date formats using moment.js

2. **Sorting Phase:**
   - Sort all valid transactions by date for efficient processing

3. **Matching Phase:**
   - Separate transactions into deposits and withdrawals
   - For each deposit, look for a matching withdrawal where:
     - Dates are within the configured tolerance (default: 2 days)
     - Amounts match (within 0.01 tolerance for rounding differences)
     - Accounts are different
     - Neither transaction has been processed yet
   - **Duplicate Detection:**
     - Check if a matching transfer already exists for this deposit/withdrawal pair
     - Match criteria: same amount, same accounts, date within tolerance
     - If transfer exists: mark as duplicate (will not create new transfer)
     - If no transfer exists: create new transfer transaction
   - Mark both transactions as processed
   - Log the conversion or duplicate detection

4. **Error Handling:**
   - Wrap all operations in try-catch blocks
   - Gracefully handle date parsing errors
   - Return original transactions if fatal error occurs
   - Log detailed error information for debugging

### Integration Point
The feature is integrated into `src/importer/index.js`:
- Called after credit card manipulation (`manipulateTxs`)
- Called before deduplication
- Processes all transactions before they are sent to Firefly III

### Transfer Transaction Structure
When a matching pair is found, a new transfer transaction is created with:
- **Type**: `transfer`
- **Date**: From the withdrawal transaction
- **Amount**: The matched amount (same for both)
- **Source Account**: From the withdrawal transaction
- **Destination Account**: From the deposit transaction
- **Description**: Combined from both transactions (if different)
- **Notes**: Combined from both transactions (if both exist)
- **External ID**: `transfer_{withdrawal_external_id}_{deposit_external_id}`
- **Tags**: Combined unique tags from both transactions
- **Currency**: Inherited from either transaction

## Configuration

### YAML Configuration
Add to `config.yaml`:
```yaml
# Enable/disable auto-detect transfers (default: true)
autoDetectTransfers: true

# Number of days to look for matching pairs (default: 2)
# Set to 0 to only match transactions on the same day
# Set to 1-2 to account for processing delays between accounts
transferDateTolerance: 2
```

### Environment Variables
```bash
export AUTO_DETECT_TRANSFERS=false   # To disable
export TRANSFER_DATE_TOLERANCE=1     # To only match within 1 day
```

## Testing

### Test Script: `test-transfer-detection.js`
A comprehensive test utility that demonstrates various scenarios:
1. Matching deposit/withdrawal on same day (converts to transfer)
2. Different amounts on same day (no conversion)
3. Same amount but different days (no conversion)
4. Multiple matching pairs on same day (converts all)
5. Regular transactions (unaffected)

### Running Tests
```bash
npm run test:transfer-detection
```

Expected output: ✅ All tests passed! Transfer detection is working correctly.

## Benefits
1. **Accurate Account Balances**: Properly tracks money movement between accounts
2. **Reduced Transaction Count**: Converts two transactions into one
3. **Better Reporting**: Transfers are categorized differently from income/expenses
4. **Automatic Detection**: No manual intervention needed
5. **Configurable**: Can be disabled if not needed

## Use Cases
- Bank-to-bank transfers
- Moving money to/from savings accounts
- Credit card payments from checking accounts (complementary to existing credit card logic)
- Internal account transfers
- Cash withdrawals deposited to another account

## Firefly III API Integration
Uses existing Firefly III API endpoints through `src/firefly.js`:
- Creates transfer transactions using the standard transaction API
- Transfer type is natively supported by Firefly III
- No additional API endpoints needed

## Compatibility
- Works with all existing features (credit card detection, deduplication, etc.)
- Does not affect existing transactions in Firefly III
- Only processes new transactions during import
- Compatible with all supported Israeli banks and credit cards

## Future Enhancements (Optional)
- Configurable date tolerance (match transfers within 1-2 days)
- Configurable amount tolerance (for small differences due to fees)
- Support for partial transfers (different amounts with a known fee)
- UI to review and confirm detected transfers before importing
- Retroactive conversion of existing transaction pairs in Firefly III

## Backfilling Existing Transactions

A backfill script is provided to process existing transactions in Firefly III and convert matching pairs to transfers.

### Script: `backfill-transfers.js`

**Features:**
- Fetches all transactions from Firefly III
- Runs transfer detection algorithm on existing data
- Deletes original deposit/withdrawal pairs
- Creates new transfer transactions
- **Dry-run mode** to preview changes without making modifications
- Filter by date to only process recent transactions
- Configurable date tolerance

**Usage:**
```bash
# Dry run (recommended first step)
npm run backfill-transfers -- --dry-run

# Actual conversion
npm run backfill-transfers

# Only process transactions after a specific date
npm run backfill-transfers -- --since 2024-01-01

# Use custom date tolerance
npm run backfill-transfers -- --date-tolerance 1

# Combine options
npm run backfill-transfers -- --dry-run --since 2024-01-01 --date-tolerance 2
```

**Safety Features:**
- Dry-run mode shows exactly what would be changed
- Validates transactions before processing
- Detailed logging of all operations
- Skips existing transfer transactions
- Error handling for individual transaction failures

**Recommendations:**
1. Always run with `--dry-run` first
2. Backup your Firefly III database before running
3. Start with a recent date using `--since` to test on smaller dataset
4. Review the dry-run output carefully
5. This is a one-time operation - future imports will handle transfers automatically

## Files Modified/Created

### New Files
- `src/importer/transfer-detector.js` - Core transfer detection logic
- `test-transfer-detection.js` - Test utility for validation
- `backfill-transfers.js` - Backfill script for existing transactions

### Modified Files
- `src/importer/index.js` - Integration of transfer detection
- `config/default.json` - Added `autoDetectTransfers` and `transferDateTolerance` configs
- `config/basic.template.config.yaml` - Added config documentation
- `config/custom-environment-variables.yaml` - Added environment variable mapping
- `package.json` - Added test and backfill scripts
- `README.md` - Added feature and backfill documentation
- `CHANGELOG.md` - Added feature entry

## Documentation
- README includes comprehensive feature documentation
- Configuration examples provided in template config
- Test utility demonstrates usage and validates functionality
- Inline code comments explain algorithm and logic

