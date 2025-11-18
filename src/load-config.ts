import { createRequire } from 'node:module';
import config from 'nconf';
// @ts-expect-error - no types available for nconf-yaml
import nconfYaml from 'nconf-yaml';

const require = createRequire(import.meta.url);

interface EnvMap {
  [key: string]: string;
}

const envMap: EnvMap = {
  FIREFLY_BASE_URL: 'firefly:baseUrl',
  FIREFLY_TOKEN_API: 'firefly:tokenApi',
  CRON: 'cron',
  SCRAPER_PARALLEL: 'scraper:parallel',
  SCRAPER_TIMEOUT: 'scraper:timeout',
  LOG_LEVEL: 'log:level',
};

config
  .defaults(require('../config/default.json'));

export default async function loadConfig(path: string): Promise<void> {
  config.remove('defaults');
  config.env({
    transform: (obj: { key: string; value: string }) => {
      const mappedKey = envMap[obj.key];
      if (!mappedKey) {
        return null;
      }
      // eslint-disable-next-line no-param-reassign
      obj.key = mappedKey;
      return obj;
    },
  });
  config.file({
    file: path,
    format: nconfYaml as never,
  });
  config.defaults(require('../config/default.json'));
  config.required(['firefly', 'firefly:baseUrl', 'firefly:tokenApi', 'banks']);
}
