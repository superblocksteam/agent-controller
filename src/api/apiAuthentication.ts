import {
  Action,
  AuthConfig,
  AuthType,
  GoogleSheetsAuthType,
  IntegrationError,
  RestApiIntegrationAuthType,
  RestApiIntegrationDatasourceConfiguration,
  TokenType
} from '@superblocksteam/shared';
import axios from 'axios';
import { get, isEmpty } from 'lodash';
import moment from 'moment';
import qs from 'qs';
import { cacheAuth, fetchUserToken } from '../controllers/datasource';
import { AgentCredentials, makeBasicAuthToken } from '../utils/auth';
import logger from '../utils/logger';

// Tokens usually provide an expiry time, but if not we should default to a
// value so they eventually expire.
export const defaultRefreshExpiry = moment().add(90, 'days').toDate();
export const defaultTokenExpiry = moment().add(30, 'days').toDate();

// Tokens SHOULD be returned with an "expires_in" parameters, but they are not
// always. If non is specified, we need to choose how long we should cache the
// tokens by default (in seconds).
export const DEFAULT_TOKEN_EXPIRES_IN = 3600 * 24;

export function expectsBindings(authType: AuthType, authConfig: AuthConfig): boolean {
  switch (authType) {
    case RestApiIntegrationAuthType.BASIC:
    case RestApiIntegrationAuthType.NONE:
      return false;
    case RestApiIntegrationAuthType.OAUTH2_PASSWORD:
      return !get(authConfig, 'useFixedPasswordCreds');
    case RestApiIntegrationAuthType.OAUTH2_CLIENT_CREDS:
    case RestApiIntegrationAuthType.OAUTH2_IMPLICIT:
    case RestApiIntegrationAuthType.OAUTH2_CODE:
    case RestApiIntegrationAuthType.FIREBASE:
    case GoogleSheetsAuthType.OAUTH2_CODE:
      return true;
  }
}

export function apiAuthBindings(authType: AuthType): string {
  switch (authType) {
    case RestApiIntegrationAuthType.NONE:
      return '';
    case RestApiIntegrationAuthType.BASIC:
      // Not intended to be used by end-users, but it's okay if it's accessible.
      return '_basic';
    case RestApiIntegrationAuthType.FIREBASE:
      return 'firebase';
    case RestApiIntegrationAuthType.OAUTH2_PASSWORD:
    case RestApiIntegrationAuthType.OAUTH2_CLIENT_CREDS:
    case RestApiIntegrationAuthType.OAUTH2_IMPLICIT:
    case RestApiIntegrationAuthType.OAUTH2_CODE:
    case GoogleSheetsAuthType.OAUTH2_CODE:
      return 'oauth';
  }
}

export async function getOauthClientCredsToken(
  agentCreds: AgentCredentials,
  datasourceConfiguration: RestApiIntegrationDatasourceConfiguration,
  action: Action
): Promise<string> {
  const tokenUrl = get(datasourceConfiguration.authConfig, 'tokenUrl');
  const scope = get(datasourceConfiguration.authConfig, 'scope');
  const clientToken = makeBasicAuthToken(
    get(datasourceConfiguration.authConfig, 'clientId'),
    get(datasourceConfiguration.authConfig, 'clientSecret')
  );
  const data = new URLSearchParams({ grant_type: 'client_credentials', scope: scope });

  try {
    const result = await axios.post(tokenUrl, data.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${clientToken}`
      }
    });
    const token = result.data.access_token;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + result.data.expires_in * 1000);

    const authType = datasourceConfiguration.authType;
    const authConfig = datasourceConfiguration.authConfig;
    cacheAuth(agentCreds, authType, authConfig, TokenType.ACCESS, token, expiresAt).catch((err) =>
      logger.debug(`error while caching token ${err}`)
    );
    return token;
  } catch (err) {
    throw new IntegrationError(`Failed to authenticate ${action.name}: ${err}`);
  }
}

export async function getOauthPasswordToken(
  agentCreds: AgentCredentials,
  authType: RestApiIntegrationAuthType,
  authConfig: AuthConfig,
  action: Action
): Promise<string> {
  try {
    const refreshToken = await fetchUserToken(agentCreds, authType, authConfig, TokenType.REFRESH);
    let tokens: OauthTokenResponse = undefined;
    let errMsg: string;
    if (!isEmpty(refreshToken)) {
      try {
        tokens = await refreshOAuthPasswordToken(authConfig, refreshToken);
      } catch (err) {
        errMsg = err;
      }
    }
    // If we failed to refresh the token, fetch a new set of tokens.
    if (!tokens) {
      try {
        tokens = await fetchNewOAuthPasswordToken(authConfig);
      } catch (err) {
        errMsg = err;
      }
    }
    // If fetching new tokens failed, then give up.
    if (!tokens) {
      throw new IntegrationError(`failed to fetch authenticate: ${errMsg}`);
    }
    cacheAuth(agentCreds, authType, authConfig, TokenType.ACCESS, tokens.access.token, tokens.access.expiry).catch((err) =>
      logger.debug(`error while caching token ${err}`)
    );
    cacheAuth(agentCreds, authType, authConfig, TokenType.REFRESH, tokens.refresh.token, tokens.refresh.expiry).catch((err) =>
      logger.debug(`error while caching token ${err}`)
    );
    return tokens.access.token;
  } catch (err) {
    throw new IntegrationError(`Failed to authenticate ${action.name}: ${err}`);
  }
}

export type ExpirableToken = {
  token: string;
  expiry: Date;
};

export type OauthTokenResponse = {
  access: ExpirableToken;
  refresh: ExpirableToken;
};

export async function fetchNewOAuthPasswordToken(authConfig: AuthConfig): Promise<OauthTokenResponse> {
  const tokenUrl = get(authConfig, 'tokenUrl');
  const username = get(authConfig, 'username');
  const password = get(authConfig, 'password');
  const clientId = get(authConfig, 'clientId');
  const clientSecret = get(authConfig, 'clientSecret');

  // experian has a few non-standard oauth password flow
  const isExperian = tokenUrl.includes('experian.com');

  const data = {
    username: username,
    password: password,
    client_id: clientId,
    client_secret: clientSecret
  };

  let result;
  if (isExperian) {
    result = await axios.post(tokenUrl, data, {
      // This entire format is not up to OAuth 2.0's spec. This is
      // specifically how it's implemented (incorrectly) in Experian's API.
      headers: {
        'Content-Type': 'application/json',
        Grant_type: 'password'
      }
    });
  } else {
    // This is the up to OAuth 2.0 spec
    result = await axios.post(tokenUrl, qs.stringify({ ...data, grant_type: 'password' }));
  }
  if (Math.floor(result.status / 100) !== 2) {
    throw new Error(`Failed to log in: ${result}`);
  }
  return {
    access: {
      token: result.data.access_token,
      expiry: new Date(parseInt(result.data.issued_at) + parseInt(result.data.expires_in) * 1000)
    },
    refresh: {
      token: result.data.refresh_token,
      expiry: defaultRefreshExpiry
    }
  };
}

export async function refreshOAuthPasswordToken(authConfig: AuthConfig, refreshToken: string): Promise<OauthTokenResponse> {
  const tokenUrl = get(authConfig, 'tokenUrl', '');
  const headers = {
    'Content-Type': 'application/json',
    grant_type: 'refresh_token',
    client_id: get(authConfig, 'clientId'),
    client_secret: get(authConfig, 'clientSecret'),
    refresh_token: refreshToken
  };
  const result = await axios.post(tokenUrl, {}, { headers });
  if (Math.floor(result.status / 100) !== 2) {
    throw new Error(`Failed to refresh token with result ${result.status}, err: ${JSON.stringify(result.data)}`);
  }
  return {
    access: {
      token: result.data.access_token,
      expiry: new Date(parseInt(result.data.issued_at) + parseInt(result.data.expires_in) * 1000)
    },
    refresh: {
      token: result.data.refresh_token,
      expiry: defaultRefreshExpiry
    }
  };
}
