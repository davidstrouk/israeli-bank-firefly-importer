# Credit Card Merchant Accounts Feature

## Overview

This feature automatically creates expense accounts in Firefly III based on merchant names (transaction descriptions) when importing credit card transactions. This provides better spending insights and automatic categorization by merchant.

## How It Works

### For New Transactions

When a credit card transaction is imported:

1. **Detection**: The importer identifies credit card withdrawals (spending)
2. **Merchant Name**: Uses the transaction description as the merchant name
3. **Account Lookup**: Searches for an existing expense account with that merchant name
4. **Account Creation**: If not found, creates a new expense account with the merchant name
5. **Transaction Recording**: Records the transaction as a withdrawal from the credit card to the merchant's expense account

### For Existing Transactions

The importer also handles transactions that were imported before this feature was added:

1. **Comparison**: On each import, compares new transactions with existing ones using external IDs
2. **Detection**: Identifies existing credit card withdrawals without destination accounts
3. **Update**: If the new import would add a destination account, updates the existing transaction
4. **No Duplicates**: Smart logic ensures no duplicate transactions are created

## Technical Implementation

### Key Functions

#### `getOrCreateExpenseAccount(merchantName: string): Promise<string>`

Located in: `src/firefly.ts`

- **Purpose**: Gets or creates an expense account for a merchant
- **Caching**: Uses in-memory cache to avoid redundant API calls
- **Process**:
  1. Checks cache first
  2. Searches Firefly III for existing expense account by name
  3. Creates new expense account if not found
  4. Updates cache and returns account ID

#### Transaction Processing Logic

Located in: `src/importer/index.ts`

**During Transaction Formatting:**
```typescript
// For credit card withdrawals, create/get expense account for merchant
if (x.chargedAmount < 0 && x.account.kind === 'credit-card' && x.description) {
  try {
    destinationId = await getOrCreateExpenseAccount(x.description);
  } catch (error) {
    // Graceful error handling - transaction still imported
    logger().warn(...);
  }
}
```

**During Transaction Updates:**
```typescript
// Check for existing credit card transactions without destination accounts
const toAddDestination = deduplicatedTxs.filter((x) => {
  const existing = currentTxMap[x.external_id];
  if (!existing) return false;
  return (
    existing.type === 'withdrawal' &&
    x.type === 'withdrawal' &&
    x.destination_id &&
    !existing.destination_id &&
    x.source_id === existing.source_id
  );
});
```

### Data Structures

#### ExistingTransaction Interface
```typescript
interface ExistingTransaction {
  id: string;
  type: string;
  source_id?: string;
  destination_id?: string;  // Added to support merchant account updates
  description?: string;     // Added to support merchant account updates
}
```

## Benefits

1. **Better Categorization**: All transactions grouped by merchant automatically
2. **Spending Insights**: Easy tracking of spending by store/service
3. **Automatic Organization**: No manual account creation needed
4. **Consistent Data**: Same merchant always uses same account
5. **Backward Compatible**: Updates old transactions automatically

## Usage

No configuration needed! The feature works automatically for:

- **New imports**: Merchant accounts created on first transaction
- **Subsequent imports**: Existing merchant accounts reused
- **Old transactions**: Updated automatically on next import

## Examples

### First Import
```
Transaction: Credit card withdrawal ₪50 - "SuperPharm"
Action: Creates expense account "SuperPharm"
Result: Withdrawal from credit card → "SuperPharm"
```

### Recurring Merchant
```
Transaction: Credit card withdrawal ₪75 - "SuperPharm"
Action: Finds existing expense account "SuperPharm"
Result: Withdrawal from credit card → "SuperPharm" (same account)
```

### Updating Old Transaction
```
Existing: Credit card withdrawal ₪50 - "SuperPharm" (no destination)
New Import: Same transaction detected
Action: Creates/finds "SuperPharm" account, updates existing transaction
Result: Existing transaction now has "SuperPharm" as destination
```

## Logging

The feature includes comprehensive logging:

- **Debug**: Cache hits, account lookups
- **Info**: Account creation, transaction updates
- **Warn**: Failed account creation (graceful degradation)
- **Error**: API errors with full context

### Example Logs

```
[DEBUG] Looking for expense account { merchantName: 'SuperPharm' }
[INFO] Created new expense account { merchantName: 'SuperPharm', accountId: '123' }
[INFO] Adding destination accounts to existing credit card transactions... { count: 15 }
```

## Error Handling

The feature includes robust error handling:

1. **Account Creation Failure**: Transaction still imported without destination
2. **API Errors**: Logged with full context, transaction processing continues
3. **Cache Consistency**: Cache updated only after successful operations
4. **Duplicate Prevention**: Smart filtering ensures no duplicate updates

## Performance Considerations

### Caching Strategy

- **In-Memory Cache**: Stores merchant name → account ID mapping
- **Lifetime**: Cache persists for the duration of the import process
- **Benefits**: Reduces API calls for recurring merchants

### Batch Processing

- Updates processed sequentially to avoid overwhelming Firefly III API
- Progress logged every 50 transactions
- Graceful handling of rate limits and errors

## Testing

To test this feature:

1. **New Transactions**:
   ```bash
   # Run normal import
   israeli-bank-firefly-importer
   
   # Check Firefly III for new expense accounts
   # Verify transactions have proper destination accounts
   ```

2. **Updating Old Transactions**:
   ```bash
   # Dry run to preview updates
   israeli-bank-firefly-importer --dry-run
   
   # Check log output for "Would add destination accounts"
   # Run actual import
   israeli-bank-firefly-importer
   ```

## Future Enhancements

Potential improvements for future versions:

1. **Merchant Name Normalization**: Clean up merchant names (remove extra spaces, standardize format)
2. **Merchant Aliasing**: Map similar merchant names to same account (e.g., "SuperPharm Downtown" → "SuperPharm")
3. **Category Auto-Assignment**: Automatically assign categories based on merchant
4. **Merchant Rules**: User-defined rules for specific merchants
5. **Persistent Cache**: Store cache in Firefly III preferences for cross-run efficiency

## Related Files

- `src/firefly.ts`: Expense account creation and caching
- `src/importer/index.ts`: Transaction processing and updates
- `README.md`: User-facing documentation
- `CHANGELOG.md`: Feature changelog entry

## API Endpoints Used

- `GET /api/v1/accounts?type=expense`: Search for existing expense accounts
- `POST /api/v1/accounts`: Create new expense account
- `PUT /api/v1/transactions/{id}`: Update existing transaction with destination account

