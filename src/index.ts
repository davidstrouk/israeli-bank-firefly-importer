#!/usr/bin/env node

import { readFile } from 'fs/promises';
import config from 'nconf';
import { schedule } from 'node-cron';
import loadConfig from './load-config.js';
import doImport from './importer/index.js';
import logger, { init as loggerInit } from './logger.js';
import { init as fireFlyInit } from './firefly.js';

interface PackageJson {
  version: string;
  [key: string]: unknown;
}

interface CliOptions {
  dryRun?: boolean;
  since?: string;
  backfill?: boolean;
  dateTolerance?: number;
  cleanup?: boolean;
  removeDuplicates?: boolean;
  listTransactions?: boolean;
  onlyAccounts?: string[];
  skipEdit?: boolean;
}

const packageJsonContent = await readFile(
  new URL('../package.json', import.meta.url),
);
const pkg: PackageJson = JSON.parse(packageJsonContent.toString());

/**
 * Parse command line arguments
 */
function parseCliArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    skipEdit: true,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    switch (arg) {
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--since':
        options.since = args[i + 1];
        i += 1;
        break;
      case '--backfill':
        options.backfill = true;
        break;
      case '--date-tolerance':
        options.dateTolerance = parseInt(args[i + 1] || '2', 10);
        i += 1;
        break;
      case '--cleanup':
        options.cleanup = true;
        break;
      case '--remove-duplicates':
        options.removeDuplicates = true;
        break;
      case '--list-transactions':
        options.listTransactions = true;
        break;
      case '--only-accounts':
        options.onlyAccounts = args[i + 1]?.split(',');
        i += 1;
        break;
      case '--skip-edit':
        options.skipEdit = false;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        if (arg && arg.startsWith('--')) {
          logger().warn({ arg }, 'Unknown argument, ignoring');
        }
        break;
    }
  }

  return options;
}

/**
 * Print help message
 */
function printHelp(): void {
  /* eslint-disable no-console */
  console.log(`
Israeli Bank Firefly III Importer v${pkg.version}

Usage: israeli-bank-firefly-importer [options]

Options:
  --help, -h              Show this help message
  --dry-run               Run without making changes (preview mode)
  --since YYYY-MM-DD      Process transactions since this date
  --backfill              Backfill existing transactions (convert to transfers)
  --date-tolerance N      Days tolerance for matching transfers (default: 2)
  --cleanup               Drop all state and clean up
  --remove-duplicates     Remove duplicate transactions
  --list-transactions     List all transactions
  --only-accounts A,B,C   Process only specific accounts (comma-separated)
  --skip-edit             Skip editing existing transactions

Examples:
  # Normal import (production)
  israeli-bank-firefly-importer

  # Dry run to preview what would be imported
  israeli-bank-firefly-importer --dry-run

  # Import transactions since a specific date
  israeli-bank-firefly-importer --since 2024-01-01

  # Backfill existing transactions and convert to transfers (dry run)
  israeli-bank-firefly-importer --backfill --dry-run

  # Backfill with custom date tolerance
  israeli-bank-firefly-importer --backfill --date-tolerance 3

  # Backfill since a specific date
  israeli-bank-firefly-importer --backfill --since 2024-01-01

  # Remove duplicate transactions
  israeli-bank-firefly-importer --remove-duplicates

  # List all transactions
  israeli-bank-firefly-importer --list-transactions

Environment Variables:
  CONFIG_FILE            Path to config file (default: ./config.yaml)

For more information, visit: https://github.com/itairaz1/israeli-bank-firefly-importer
  `);
  /* eslint-enable no-console */
}

async function run(options: CliOptions): Promise<void> {
  try {
    await doImport({
      skipEdit: options.skipEdit ?? true,
      onlyAccounts: options.onlyAccounts,
      cleanup: options.cleanup ?? false,
      since: options.since,
      removeDuplicates: options.removeDuplicates ?? false,
      listTransactions: options.listTransactions ?? false,
      dryRun: options.dryRun ?? false,
      backfill: options.backfill ?? false,
      dateTolerance: options.dateTolerance ?? 2,
    });
  } catch (err: unknown) {
    const error = err as { response?: { data?: { message?: string } } };
    logger().error(
      {
        error: err,
        message: error?.response?.data?.message,
      },
      'Fatal error',
    );
    process.exit(1);
  }
}

async function init(): Promise<void> {
  const configFile = process.env.CONFIG_FILE || './config.yaml';
  await loadConfig(configFile);
  loggerInit();
  logger().debug(`Config file '${configFile}' loaded.`);

  fireFlyInit();
}

try {
  const cliOptions = parseCliArgs();
  await init();

  logger().info(
    {
      version: pkg.version,
      ...cliOptions,
    },
    'Starting Israeli Bank Firefly iii Importer',
  );

  if (cliOptions.dryRun) {
    logger().info('🔍 DRY RUN MODE - No changes will be made to Firefly');
  }

  await run(cliOptions);

  const cron: string | undefined = config.get('cron');
  if (
    cron
    && !cliOptions.dryRun
    && !cliOptions.backfill
    && !cliOptions.cleanup
    && !cliOptions.removeDuplicates
    && !cliOptions.listTransactions
  ) {
    logger().info({ cron }, 'Running with cron');
    schedule(cron, () => run(cliOptions));
  }
} catch (err: unknown) {
  logger().error(err, 'Critical error');
  process.exit(1);
}
