import leumi from './leumi.js';

interface AccountDetails {
  type: string;
  kind: string;
}

interface EnrichedResult {
  accountNumber: string;
  accountDetails: AccountDetails;
  [key: string]: unknown;
}

type ManipulatorFunction = (
  enrichedResult: EnrichedResult
) => EnrichedResult | null;

interface ManipulatorMap {
  [key: string]: ManipulatorFunction;
}

const map: ManipulatorMap = {
  leumi,
};

export default function manipulateScrapResult(
  enrichedResult: EnrichedResult,
): EnrichedResult | null {
  const manipulator = map[enrichedResult.accountDetails.type];
  return manipulator ? manipulator(enrichedResult) : enrichedResult;
}
