import {
  AGENT_ENVIRONMENT_HEADER,
  AGENT_HOST_URL_HEADER,
  AGENT_ID_HEADER,
  AGENT_INTERNAL_HOST_URL_HEADER,
  AGENT_KEY_HEADER,
  AGENT_VERSION_EXTERNAL_HEADER,
  AGENT_VERSION_HEADER,
  API_KEY_HEADER
} from '@superblocksteam/shared';
import { AgentCredentials } from '@superblocksteam/shared-backend';
import {
  SUPERBLOCKS_AGENT_ENVIRONMENT,
  SUPERBLOCKS_AGENT_ID,
  SUPERBLOCKS_AGENT_INTERNAL_HOST_URL,
  SUPERBLOCKS_AGENT_KEY,
  SUPERBLOCKS_AGENT_URL,
  SUPERBLOCKS_AGENT_VERSION,
  SUPERBLOCKS_AGENT_VERSION_EXTERNAL
} from '../env';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const setAgentHeaders = (headers: Record<any, any> = {}, agentCredentials: AgentCredentials = {}): Record<any, any> => {
  if (agentCredentials.apiKey) {
    headers[API_KEY_HEADER] = agentCredentials.apiKey;
  }
  if (agentCredentials.jwt) {
    headers.Authorization = agentCredentials.jwt;
  }

  headers[AGENT_ENVIRONMENT_HEADER] = SUPERBLOCKS_AGENT_ENVIRONMENT;
  headers[AGENT_HOST_URL_HEADER] = SUPERBLOCKS_AGENT_URL;
  headers[AGENT_INTERNAL_HOST_URL_HEADER] = SUPERBLOCKS_AGENT_INTERNAL_HOST_URL;
  headers[AGENT_ID_HEADER] = SUPERBLOCKS_AGENT_ID;

  headers[AGENT_KEY_HEADER] = SUPERBLOCKS_AGENT_KEY;
  headers[AGENT_VERSION_HEADER] = SUPERBLOCKS_AGENT_VERSION;
  headers[AGENT_VERSION_EXTERNAL_HEADER] = SUPERBLOCKS_AGENT_VERSION_EXTERNAL;
  return headers;
};
