interface EnrichedResult {
  accountNumber: string;
  accountDetails: {
    type: string;
    kind: string;
  };
  [key: string]: unknown;
}

export default function manipulate(
  enrichedResult: EnrichedResult,
): EnrichedResult | null {
  const accountNumberSplits = enrichedResult.accountNumber.split('_');
  if (
    accountNumberSplits.length === 2
    && !/^[0-9]{2}$/.test(accountNumberSplits[1] || '')
  ) {
    return null;
  }
  return enrichedResult;
}
