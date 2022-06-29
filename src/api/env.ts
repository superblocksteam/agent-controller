import { safeJSONParse } from '@superblocksteam/shared-backend';
import P from 'pino';
import env, { SUPERBLOCKS_ENV_VAR_PREFIX } from '../env';

// TODO(taha) figure out why passing the logger here causes type mismatch
// issues with shared-backend, and readd it
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getAppEnvVars(logger: P.Logger): any {
  const envVarObj = safeJSONParse(env.get('SUPERBLOCKS_AGENT_ENV_VARS_JSON'));
  Object.entries(env.get('SUPERBLOCKS_AGENT_ENV_SECRETS')).forEach(([key, value]) => {
    const shortKey = key.replace(SUPERBLOCKS_ENV_VAR_PREFIX, '').toLowerCase();
    envVarObj[shortKey] = value;
  });

  return envVarObj;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getRedactedAppEnvVars(logger: P.Logger): any {
  const envVarObj = safeJSONParse(env.get('SUPERBLOCKS_AGENT_ENV_VARS_JSON'), logger);
  Object.entries(env.get('SUPERBLOCKS_AGENT_ENV_SECRETS')).forEach(([key]) => {
    const shortKey = key.replace(SUPERBLOCKS_ENV_VAR_PREFIX, '').toLowerCase();
    envVarObj[shortKey] = '<redacted>';
  });

  return envVarObj;
}

export const APP_ENV_VAR_KEY = 'Env';
