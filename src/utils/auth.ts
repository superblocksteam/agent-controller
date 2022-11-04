import { AuthConfig, AuthType, DatasourceDto, IntegrationError, TokenScope, TokenType } from '@superblocksteam/shared';
import { refreshUserTokenOnAgent, refreshUserTokenOnServer } from '../controllers/auth';
import { fetchPerUserToken, fetchUserToken } from '../controllers/datasource';
import { SUPERBLOCKS_AGENT_EAGER_REFRESH_THRESHOLD_MS } from '../env';

export class AgentCredentials {
  jwt?: string;
  apiKey?: string;

  constructor({ jwt = '', apiKey = '' }: { jwt?: string; apiKey?: string }) {
    this.jwt = jwt;
    this.apiKey = apiKey;
  }
}

export function makeBasicAuthToken(username: string, password: string): string {
  return Buffer.from(username + ':' + password).toString('base64');
}

export async function getOrRefreshToken(
  agentCredentials: AgentCredentials,
  authType: AuthType,
  authConfig: AuthConfig,
  datasource: DatasourceDto,
  eagerRefreshThresholdMs = SUPERBLOCKS_AGENT_EAGER_REFRESH_THRESHOLD_MS
): Promise<string> {
  let token;
  if (authConfig.tokenScope === TokenScope.DATASOURCE) {
    token = await fetchUserToken({
      agentCredentials: agentCredentials,
      authType: authType,
      authConfig: authConfig,
      tokenType: TokenType.ACCESS,
      datasourceId: datasource.id,
      eagerRefreshThresholdMs
    });
  } else {
    token = await fetchPerUserToken(agentCredentials, authType, authConfig, TokenType.ACCESS, eagerRefreshThresholdMs);
  }
  if (!token) {
    if (authConfig.refreshTokenFromServer) {
      const newUserToken = await refreshUserTokenOnServer(agentCredentials, authType, authConfig, datasource);
      if (!newUserToken) {
        throw new IntegrationError(`Failed to refresh a token on server`);
      }
      return newUserToken;
    } else {
      if (!(await refreshUserTokenOnAgent(agentCredentials, authType, authConfig, token))) {
        throw new IntegrationError(`Failed to refresh a token on agent`);
      }
    }
    token = await fetchUserToken({
      agentCredentials: agentCredentials,
      authType: authType,
      authConfig: authConfig,
      tokenType: TokenType.ACCESS,
      datasourceId: datasource.id
    });
  }
  return token;
}
