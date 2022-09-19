import { EnvStore, InvalidConfigurationError } from '@superblocksteam/shared';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const envs = new EnvStore(process.env);

// Env vars prefixed with this string will be made available in the app.
export const SUPERBLOCKS_ENV_VAR_PREFIX = 'SUPERBLOCKS_AGENT_APP_ENV_';

envs.addAll([
  // Private environment variables for use with Superblocks Cloud
  // or during development
  {
    name: '__SUPERBLOCKS_AGENT_DOMAIN',
    defaultValue: 'superblocks.com'
  },
  {
    name: '__SUPERBLOCKS_AGENT_SERVER_URL',
    defaultValue: 'https://app.superblocks.com'
  },
  {
    name: '__SUPERBLOCKS_AGENT_TYPE',
    defaultValue: '2'
  },
  {
    name: 'SUPERBLOCKS_AGENT_KEY'
  },
  {
    name: 'SUPERBLOCKS_AGENT_HOST_URL'
  },
  {
    name: 'SUPERBLOCKS_AGENT_JSON_PARSE_LIMIT',
    defaultValue: '50mb'
  },
  {
    name: 'SUPERBLOCKS_AGENT_PORT',
    defaultValue: '8020'
  },
  {
    name: 'SUPERBLOCKS_AGENT_COMPRESSION_DISABLE',
    defaultValue: 'false'
  },
  {
    name: 'SUPERBLOCKS_AGENT_ENV_SECRETS',
    defaultValue: '{}',
    regex: SUPERBLOCKS_ENV_VAR_PREFIX + '.*'
  },
  {
    name: 'SUPERBLOCKS_AGENT_ENV_VARS_JSON',
    defaultValue: '{}'
  },
  {
    name: 'SUPERBLOCKS_AGENT_EXECUTION_JS_TIMEOUT_MS',
    defaultValue: '1200000'
  },
  {
    name: 'SUPERBLOCKS_AGENT_EXECUTION_PYTHON_TIMEOUT_MS',
    defaultValue: '1200000'
  },
  // NOTE(bruce) This probably should be configurable as part of the rest
  // integration itself. We still need a wide system limit regardless.
  {
    name: 'SUPERBLOCKS_AGENT_EXECUTION_REST_API_TIMEOUT_MS',
    defaultValue: '300000'
  },
  {
    name: 'SUPERBLOCKS_AGENT_EAGER_REFRESH_THRESHOLD_MS',
    defaultValue: '300000'
  },
  {
    name: 'SUPERBLOCKS_AGENT_LOG_DISABLE_EXPRESS',
    defaultValue: 'true'
  },
  {
    name: 'SUPERBLOCKS_AGENT_DATADOG_CONNECT_TAGS',
    defaultValue: 'app:superblocks'
  },
  {
    name: 'SUPERBLOCKS_AGENT_ENABLE_SCHEDULE_POLLING',
    defaultValue: 'true'
  },
  {
    name: 'SUPERBLOCKS_AGENT_POLLING_FREQUENCY',
    defaultValue: '*/30 * * * * *'
  },
  {
    name: 'SUPERBLOCKS_INCLUDE_ERRORS_IN_AUDIT_LOGS',
    defaultValue: 'true'
  },
  // Agent version(s)
  // Represents the superblocksteam/superblocks (monorepo) semver
  {
    name: 'SUPERBLOCKS_AGENT_VERSION'
  },
  // Represents the superblocks/agent (OPA) semver
  {
    name: 'SUPERBLOCKS_AGENT_VERSION_EXTERNAL',
    defaultValue: 'v0.0.0'
  },
  {
    name: 'SUPERBLOCKS_AGENT_ENVIRONMENT',
    defaultValue: '*'
  },
  {
    name: 'SUPERBLOCKS_AGENT_REGISTRATION_RETRY_COUNT',
    defaultValue: '120'
  },
  // The actual keepidle NLB timeout seems to be 500s.
  // The actual keepidle timeout for global accelerator is 340s,
  // let's grant 5s of grace time by default.
  {
    name: '__SUPERBLOCKS_AGENT_KEEPALIVE_DELAY_MS',
    defaultValue: '335000'
  },
  // Maximum number of errors kept in memory, for the /health endpoint scraping.
  {
    name: 'SUPERBLOCKS_AGENT_ERROR_HISTORY_SIZE_MAX',
    defaultValue: '50'
  },
  // Worker environment variables.
  {
    name: 'SUPERBLOCKS_WORKER_PORT',
    defaultValue: '5001'
  },
  {
    name: 'SUPERBLOCKS_WORKER_TLS_CA_FILE',
    defaultValue: ''
  },
  {
    name: 'SUPERBLOCKS_WORKER_TLS_CERT_FILE',
    defaultValue: ''
  },
  {
    name: 'SUPERBLOCKS_WORKER_TLS_KEY_FILE',
    defaultValue: ''
  },
  {
    name: 'SUPERBLOCKS_WORKER_TLS_INSECURE',
    defaultValue: 'false'
  },
  {
    name: 'SUPERBLOCKS_WORKER_STRICT_MATCHING',
    defaultValue: 'false'
  },
  {
    name: 'SUPERBLOCKS_AGENT_STEP_RETRY_DURATION',
    defaultValue: '10'
  },
  {
    name: 'SUPERBLOCKS_AGENT_STEP_RETRY_FACTOR',
    defaultValue: '2'
  },
  {
    name: 'SUPERBLOCKS_AGENT_STEP_RETRY_JITTER',
    defaultValue: '0.5'
  },
  {
    name: 'SUPERBLOCKS_AGENT_STEP_RETRY_LIMIT',
    defaultValue: ''
  },
  {
    name: 'SUPERBLOCKS_AGENT_ERROR_HISTORY_DISABLE',
    defaultValue: 'false'
  },
  {
    name: 'SUPERBLOCKS_GOOGLE_SHEETS_CLIENT_ID',
    // default to production so that OPA doesn't require this to be set
    defaultValue: '473079805089-pg39s9chs160ve0us6t9c4pihboua4ne.apps.googleusercontent.com'
  },
  {
    name: 'SUPERBLOCKS_GOOGLE_SHEETS_REDIRECT_PATH',
    defaultValue: '/api/v1/oauth2/gsheets/callback'
  },
  // Worker
  {
    name: '__SUPERBLOCKS_WORKER_ENABLE',
    defaultValue: 'true'
  },
  {
    name: 'SUPERBLOCKS_AGENT_INTERNAL_HOST',
    defaultValue: 'localhost'
  },
  {
    name: '__SUPERBLOCKS_FILE_SERVER_URL',
    defaultValue: ''
  },
  {
    name: 'SUPERBLOCKS_AGENT_METRICS_DEFAULT',
    defaultValue: 'true'
  }
]);

const parseAgentUrl = (rawUrl: string): URL => {
  try {
    const parsedUrl = addProtocolToURL(rawUrl);
    let agentUrl;
    if (parsedUrl.endsWith('/agent')) {
      agentUrl = parsedUrl;
    } else if (parsedUrl.endsWith('/agent/')) {
      agentUrl = parsedUrl.slice(0, -1);
    } else if (parsedUrl.endsWith('/')) {
      agentUrl = parsedUrl + 'agent';
    } else {
      agentUrl = parsedUrl + '/agent';
    }
    return new URL(agentUrl);
  } catch (e) {
    throw new InvalidConfigurationError(`The specified value for 'SUPERBLOCKS_AGENT_HOST_URL' - '${rawUrl}' - is invalid. ${e.message}`);
  }
};

const addProtocolToURL = (rawUrl: string): string => {
  if (!(rawUrl.startsWith('http://') || rawUrl.startsWith('https://'))) {
    const paths = rawUrl.split('/');
    const base = paths[0].split(':');
    if (base[0] === 'localhost' || base[0] === '127.0.0.1') {
      return 'http://' + rawUrl;
    }
    return 'https://' + rawUrl;
  }
  return rawUrl;
};

const generateAgentId = (): string => {
  return uuidv4();
};

export const SUPERBLOCKS_AGENT_KEY = envs.get('SUPERBLOCKS_AGENT_KEY');
export const SUPERBLOCKS_AGENT_ID = generateAgentId();
export const SUPERBLOCKS_AGENT_REGISTRATION_RETRY_COUNT = envs.get('SUPERBLOCKS_AGENT_REGISTRATION_RETRY_COUNT');
export const SUPERBLOCKS_AGENT_ENVIRONMENT = envs.get('SUPERBLOCKS_AGENT_ENVIRONMENT');
export const SUPERBLOCKS_AGENT_VERSION = envs.get('SUPERBLOCKS_AGENT_VERSION');
export const SUPERBLOCKS_AGENT_VERSION_EXTERNAL = envs.get('SUPERBLOCKS_AGENT_VERSION_EXTERNAL');
export const SUPERBLOCKS_AGENT_URL = parseAgentUrl(envs.get('SUPERBLOCKS_AGENT_HOST_URL')).toString();
export const SUPERBLOCKS_AGENT_TYPE = Number(envs.get('__SUPERBLOCKS_AGENT_TYPE'));

export const SUPERBLOCKS_CLOUD_BASE_URL = envs.get('__SUPERBLOCKS_AGENT_SERVER_URL');
export const SUPERBLOCKS_AGENT_EXECUTION_JS_TIMEOUT_MS = envs.get('SUPERBLOCKS_AGENT_EXECUTION_JS_TIMEOUT_MS');
export const SUPERBLOCKS_AGENT_EXECUTION_PYTHON_TIMEOUT_MS = envs.get('SUPERBLOCKS_AGENT_EXECUTION_PYTHON_TIMEOUT_MS');
export const SUPERBLOCKS_AGENT_EXECUTION_REST_API_TIMEOUT_MS = parseInt(envs.get('SUPERBLOCKS_AGENT_EXECUTION_REST_API_TIMEOUT_MS'));
export const SUPERBLOCKS_AGENT_KEEPALIVE_DELAY_MS = parseInt(envs.get('__SUPERBLOCKS_AGENT_KEEPALIVE_DELAY_MS'));
export const SUPERBLOCKS_AGENT_EAGER_REFRESH_THRESHOLD_MS = parseInt(envs.get('SUPERBLOCKS_AGENT_EAGER_REFRESH_THRESHOLD_MS'));

export const SUPERBLOCKS_AGENT_ERROR_HISTORY_DISABLE = envs.get('SUPERBLOCKS_AGENT_ERROR_HISTORY_DISABLE');
export const SUPERBLOCKS_AGENT_ERROR_HISTORY_SIZE_MAX = parseInt(envs.get('SUPERBLOCKS_AGENT_ERROR_HISTORY_SIZE_MAX'));
export const SUPERBLOCKS_WORKER_ENABLE: boolean = envs.get('__SUPERBLOCKS_WORKER_ENABLE') == 'true';
export const SUPERBLOCKS_WORKER_STRICT_MATCHING: boolean = envs.get('SUPERBLOCKS_WORKER_STRICT_MATCHING') == 'true';
export const SUPERBLOCKS_WORKER_PORT = Number(envs.get('SUPERBLOCKS_WORKER_PORT'));
export const SUPERBLOCKS_WORKER_TLS_INSECURE: boolean = envs.get('SUPERBLOCKS_WORKER_TLS_INSECURE') == 'true';
export const SUPERBLOCKS_AGENT_INTERNAL_HOST_URL = `${SUPERBLOCKS_WORKER_TLS_INSECURE ? 'http' : 'https'}://${envs.get(
  'SUPERBLOCKS_AGENT_INTERNAL_HOST'
)}:${SUPERBLOCKS_WORKER_PORT}`;
export const SUPERBLOCKS_WORKER_TLS_CA_FILE: string = envs.get('SUPERBLOCKS_WORKER_TLS_CA_FILE');
export const SUPERBLOCKS_WORKER_TLS_CERT_FILE: string = envs.get('SUPERBLOCKS_WORKER_TLS_CERT_FILE');
export const SUPERBLOCKS_WORKER_TLS_KEY_FILE: string = envs.get('SUPERBLOCKS_WORKER_TLS_KEY_FILE');
export const SUPERBLOCKS_AGENT_STEP_RETRY_DURATION = Number(envs.get('SUPERBLOCKS_AGENT_STEP_RETRY_DURATION'));
export const SUPERBLOCKS_AGENT_STEP_RETRY_FACTOR = Number(envs.get('SUPERBLOCKS_AGENT_STEP_RETRY_FACTOR'));
export const SUPERBLOCKS_AGENT_STEP_RETRY_JITTER = Number(envs.get('SUPERBLOCKS_AGENT_STEP_RETRY_JITTER'));
export const SUPERBLOCKS_AGENT_STEP_RETRY_LIMIT: number =
  envs.get('SUPERBLOCKS_AGENT_STEP_RETRY_LIMIT') == '' ? Infinity : envs.get('SUPERBLOCKS_AGENT_STEP_RETRY_LIMIT');
export const SUPERBLOCKS_FILE_SERVER_URL: string =
  envs.get('__SUPERBLOCKS_FILE_SERVER_URL') != ''
    ? envs.get('__SUPERBLOCKS_FILE_SERVER_URL')
    : `http://${envs.get('SUPERBLOCKS_AGENT_INTERNAL_HOST')}:${envs.get('SUPERBLOCKS_AGENT_PORT')}/agent/v1/files`;
export const SUPERBLOCKS_GOOGLE_SHEETS_CLIENT_ID = envs.get('SUPERBLOCKS_GOOGLE_SHEETS_CLIENT_ID');
export const SUPERBLOCKS_GOOGLE_SHEETS_REDIRECT_PATH = envs.get('SUPERBLOCKS_GOOGLE_SHEETS_REDIRECT_PATH');
export const SUPERBLOCKS_AGENT_METRICS_FORWARD: boolean = SUPERBLOCKS_AGENT_TYPE !== 0;
export const SUPERBLOCKS_AGENT_METRICS_DEFAULT: boolean = envs.get('SUPERBLOCKS_AGENT_METRICS_DEFAULT') == 'true';
export const SUPERBLOCKS_AGENT_DOMAIN: string = envs.get('__SUPERBLOCKS_AGENT_DOMAIN');

export default envs;
