import { AuthConfig, AuthType, DatasourceDto, TokenType } from '@superblocksteam/shared';
import { refreshUserTokenOnAgent, refreshUserTokenOnServer } from '../controllers/auth';
import { fetchUserToken } from '../controllers/datasource';

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
  datasource: DatasourceDto
): Promise<string> {
  let token = await fetchUserToken(agentCredentials, authType, authConfig, TokenType.ACCESS, datasource.id);
  if (!token) {
    if (authConfig.refreshTokenFromServer) {
      const newUserToken = refreshUserTokenOnServer(agentCredentials, authType, authConfig, datasource);
      if (!newUserToken) {
        throw new Error(`Failed to refresh a token on server`);
      }
      return newUserToken;
    } else {
      if (!refreshUserTokenOnAgent(agentCredentials, authType, authConfig, token)) {
        throw new Error(`Failed to refresh a token on agent`);
      }
    }
    token = await fetchUserToken(agentCredentials, authType, authConfig, TokenType.ACCESS, datasource.id);
  }
  return token;
}
