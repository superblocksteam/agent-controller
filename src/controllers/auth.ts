import {
  AuthConfig,
  AuthType,
  DatasourceDto,
  IntegrationError,
  OAUTH_CALLBACK_PATH,
  RestApiIntegrationAuthType,
  TokenType
} from '@superblocksteam/shared';
import axios from 'axios';
import { isEmpty } from 'lodash';
import { get } from 'lodash';
import { DEFAULT_TOKEN_EXPIRES_IN } from '../api/apiAuthentication';
import { AgentCredentials } from '../utils/auth';
import logger from '../utils/logger';
import { makeRequest, RequestMethod } from '../utils/request';
import { buildSuperblocksUiUrl } from '../utils/url';
import { cacheUserAuth, fetchPerUserToken, fetchUserToken } from './datasource';

export async function exchangeAuthCode(
  agentCreds: AgentCredentials,
  authType: RestApiIntegrationAuthType,
  accessCode: string,
  authConfig: AuthConfig,
  origin: string
): Promise<void> {
  const clientId = get(authConfig, 'clientId', '');
  const clientSecret = get(authConfig, 'clientSecret', '');
  const tokenUrl = get(authConfig, 'tokenUrl', '');
  const params = new URLSearchParams();
  params.append('code', accessCode ?? '');
  params.append('client_id', clientId);
  params.append('client_secret', clientSecret);
  params.append('redirect_uri', `${origin}/${OAUTH_CALLBACK_PATH}`);
  params.append('grant_type', 'authorization_code');
  const result = await axios.post(tokenUrl, params, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    }
  });
  try {
    const accessToken = result.data.access_token;
    if (!accessToken) {
      throw new Error('failed to parse access token');
    }
    const expiresIn = result.data.expires_in ?? DEFAULT_TOKEN_EXPIRES_IN;
    const now = new Date();
    await cacheUserAuth(
      agentCreds,
      authType,
      authConfig,
      TokenType.ACCESS,
      result.data.access_token,
      new Date(now.getTime() + 1000 * expiresIn)
    );
    if (result.data.refresh_token) {
      await cacheUserAuth(agentCreds, authType, authConfig, TokenType.REFRESH, result.data.refresh_token);
    }
  } catch (err) {
    throw new Error(`Failed to process response and cache token: ${err.message}`);
  }
}

export async function refreshAuthCode(
  agentCredentials: AgentCredentials,
  authType: RestApiIntegrationAuthType,
  authConfig: AuthConfig,
  datasource?: DatasourceDto
): Promise<boolean> {
  const refreshToken = datasource?.id
    ? await fetchUserToken({
        agentCredentials: agentCredentials,
        authType: authType,
        authConfig: authConfig,
        tokenType: TokenType.REFRESH,
        datasourceId: datasource?.id
      })
    : await fetchPerUserToken(agentCredentials, authType, authConfig, TokenType.REFRESH);
  if (!refreshToken) {
    return false;
  }

  if (authConfig.refreshTokenFromServer) {
    return !isEmpty(refreshUserTokenOnServer(agentCredentials, authType, authConfig, datasource));
  } else {
    return refreshUserTokenOnAgent(agentCredentials, authType, authConfig, refreshToken);
  }
}

export const refreshUserTokenOnAgent = async (
  agentCredentials: AgentCredentials,
  authType: AuthType,
  authConfig: AuthConfig,
  refreshToken: string
): Promise<boolean> => {
  const tokenUrl = get(authConfig, 'tokenUrl', '');
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded'
  };
  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('client_id', get(authConfig, 'clientId'));
  params.append('client_secret', get(authConfig, 'clientSecret'));
  params.append('refresh_token', refreshToken);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let result: any;
  try {
    result = await axios.post(tokenUrl, params, { headers });
  } catch (err) {
    logger.debug(`failed to refresh token ${err}`);
    return false;
  }
  if (Math.floor(result.status / 100) !== 2) {
    logger.warn(`token refresh failed with code ${result.status} result ${result.data}`);
    return false;
  }
  const now = new Date();
  await cacheUserAuth(
    agentCredentials,
    authType,
    authConfig,
    TokenType.ACCESS,
    result.data.access_token,
    new Date(now.getTime() + 1000 * result.data.expires_in)
  );
  if (result.data.refresh_token) {
    await cacheUserAuth(agentCredentials, authType, authConfig, TokenType.REFRESH, result.data.refresh_token);
  }
  return true;
};

export const refreshUserTokenOnServer = async (
  agentCredentials: AgentCredentials,
  authType: AuthType,
  authConfig: AuthConfig,
  datasource: DatasourceDto
): Promise<string> => {
  try {
    const newUserToken = await makeRequest<string | undefined>({
      agentCredentials: agentCredentials,
      method: RequestMethod.POST,
      url: buildSuperblocksUiUrl(`api/v1/oauth2/${datasource.pluginId}/refresh`), // TODO: extract to constant?
      payload: {
        authType,
        authConfig,
        datasourceId: datasource.id
      }
    });
    return newUserToken;
  } catch (error) {
    switch (error.status) {
      case 400:
      case 404: {
        logger.warn(`Failed to refresh user token on server: ${error.message}`);
        throw new IntegrationError(`Failed to refresh user token on server, most likely the access has been revoked`);
      }
      default: {
        throw new Error(`Failed to refresh user token on server: ${error}`);
      }
    }
  }
};
