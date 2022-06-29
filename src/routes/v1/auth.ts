import {
  ENVIRONMENT_PRODUCTION,
  ExchangeCodeResponse,
  getAuthIdFromConfig,
  IntegrationError,
  NotFoundError,
  ResponseWrapper,
  RestApiIntegrationAuthType,
  TokenType,
  TokenScope,
  RestApiIntegrationDatasourceConfiguration
} from '@superblocksteam/shared';
import { relayDelegateFromRequest } from '@superblocksteam/shared-backend';
import axios from 'axios';
import express, { CookieOptions, NextFunction, Request, Response } from 'express';
import JSON5 from 'json5';
import jwt_decode from 'jwt-decode';
import { get, isEmpty } from 'lodash';
import { defaultRefreshExpiry, defaultTokenExpiry, refreshOAuthPasswordToken } from '../../api/apiAuthentication';
import { exchangeAuthCode, refreshAuthCode } from '../../controllers/auth';
import { deleteCachedUserAuth, fetchDatasource, fetchPerUserToken, fetchUserToken } from '../../controllers/datasource';
import { forwardAgentDiagnostics } from '../../utils/diagnostics';
import { addDiagnosticTagsToError } from '../../utils/error';
import logger from '../../utils/logger';

import { agentCredsFromRequestJwt } from '../../utils/request';

const router = express.Router();
const HTTP_SECURE_COOKIE_OPTIONS: CookieOptions = { httpOnly: true, secure: true, sameSite: 'none' };

// Looks at the cookies included in the request and returns a response
// indicating if valid cookies are set. It is called before attempting to authenticate
// an api to look at the latest cookies and verify they are accurate.
router.post('/check-auth', async (req: Request, res: Response, next: NextFunction) => {
  const datasourceId = req.body.datasourceId;
  try {
    const agentCredentials = agentCredsFromRequestJwt(req);
    const relayDelegate = relayDelegateFromRequest(req);

    const integration = await fetchDatasource(datasourceId, agentCredentials, relayDelegate);
    const datasourceConfig: RestApiIntegrationDatasourceConfiguration | undefined =
      req.body.environment === ENVIRONMENT_PRODUCTION
        ? integration.datasource.configurationProd
        : integration.datasource.configurationStaging;
    const authKey = getAuthIdFromConfig(datasourceId, datasourceConfig);
    const authConfig = datasourceConfig?.authConfig;
    const hasToken = !isEmpty(req.cookies[authKey + '-token']);

    const authType = req.body.authType;
    switch (authType) {
      case RestApiIntegrationAuthType.BASIC:
        res.send(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          new ResponseWrapper<any>({ data: { authenticated: hasToken } })
        );
        return;
      case RestApiIntegrationAuthType.FIREBASE:
        if (!hasToken) {
          const refreshToken = req.cookies[authKey + '-refresh'];
          if (refreshToken) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let parsed: any;
            try {
              parsed = JSON5.parse(get(datasourceConfig, 'authConfig.apiKey', '') as string);
            } catch (err) {
              forwardAgentDiagnostics(new IntegrationError('Failed to parse the Firebase Authentication configuration.'), { datasourceId });
              return;
            }
            const params = new URLSearchParams();
            params.append('key', parsed?.apiKey ?? '');
            params.append('grant_type', 'refresh_token');
            params.append('refresh_token', refreshToken);
            const result = await axios.post(`https://securetoken.googleapis.com/v1/token`, params, {
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
              }
            });
            if (result.status === 200) {
              logger.info('token refreshed');
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const token = jwt_decode(result.data.id_token) as any;
              res.cookie(authKey + '-token', result.data.id_token, {
                ...HTTP_SECURE_COOKIE_OPTIONS,
                expires: new Date(token.exp * 1000)
              });
              res.cookie(authKey + '-refresh', result.data.refresh_token, HTTP_SECURE_COOKIE_OPTIONS);
              res.send(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                new ResponseWrapper<any>({ data: { authenticated: true } })
              );
              return;
            } else {
              logger.warn(`token refresh failed with code ${result.status} result ${result.data}`);
            }
          }
        }
        res.send(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          new ResponseWrapper<any>({ data: { authenticated: hasToken } })
        );
        return;
      case RestApiIntegrationAuthType.OAUTH2_PASSWORD:
        if (!hasToken) {
          const refreshToken = req.cookies[authKey + '-refresh'];
          if (refreshToken) {
            try {
              const newTokens = await refreshOAuthPasswordToken(authConfig, refreshToken);
              logger.info('token refreshed');
              res.cookie(authKey + '-token', newTokens.access.token, {
                ...HTTP_SECURE_COOKIE_OPTIONS,
                expires: newTokens.access.expiry
              });
              res.cookie(authKey + '-refresh', newTokens.refresh.token, HTTP_SECURE_COOKIE_OPTIONS);
              res.send(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                new ResponseWrapper<any>({ data: { authenticated: true } })
              );
            } catch (err) {
              logger.warn(`token refresh failed with code ${err}`);
            }
            return;
          }
        }
        res.send(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          new ResponseWrapper<any>({ data: { authenticated: hasToken } })
        );
        return;
      case RestApiIntegrationAuthType.OAUTH2_IMPLICIT:
        // The implicit flow "MUST NOT issue a refresh token". See
        // https://datatracker.ietf.org/doc/html/rfc6749#section-4.2.2
        res.send(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          new ResponseWrapper<any>({ data: { authenticated: hasToken } })
        );
        return;
      case RestApiIntegrationAuthType.OAUTH2_CODE: {
        if (authConfig.tokenScope === TokenScope.DATASOURCE) {
          const token = await fetchUserToken(agentCredentials, authType, authConfig, TokenType.ACCESS, datasourceId);
          let hasToken = Boolean(token);
          if (!hasToken) {
            hasToken = await refreshAuthCode(agentCredentials, authType, authConfig, datasourceId);
          }
          res.send(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            new ResponseWrapper<any>({ data: { authenticated: hasToken } })
          );
        } else {
          const token = await fetchPerUserToken(agentCredentials, authType, authConfig, TokenType.ACCESS);
          let hasToken = Boolean(token);
          if (!hasToken) {
            hasToken = await refreshAuthCode(agentCredentials, authType, authConfig);
          }
          res.send(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            new ResponseWrapper<any>({ data: { authenticated: hasToken } })
          );
        }
        res.send(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          new ResponseWrapper<any>({ data: { authenticated: hasToken } })
        );
      }
    }
  } catch (err) {
    addDiagnosticTagsToError(err, { datasourceId });
    next(err);
  }
});

// Returns a response that sets cookies on successful authentication for a rest api integration
router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    let success = false;
    const tokens = req.body;
    const authId = tokens.authId;

    switch (req.body.authType) {
      case RestApiIntegrationAuthType.BASIC: {
        if (tokens.token) {
          res.cookie(`${authId}-token`, tokens.token, { ...HTTP_SECURE_COOKIE_OPTIONS, expires: defaultTokenExpiry });
          success = true;
        }
        break;
      }
      case RestApiIntegrationAuthType.FIREBASE:
        if (jwt_decode(tokens.idToken)) {
          const token = jwt_decode(tokens.idToken);
          const exp: number = token['exp'] ?? 0;
          const userId: string = token['user_id'] ?? '';
          res.cookie(`${authId}-token`, tokens.idToken, { ...HTTP_SECURE_COOKIE_OPTIONS, expires: new Date(exp * 1000) });
          res.cookie(`${authId}-userId`, userId, HTTP_SECURE_COOKIE_OPTIONS);
          res.cookie(`${authId}-refresh`, tokens.refreshToken, HTTP_SECURE_COOKIE_OPTIONS);
          success = true;
        }
        break;
      case RestApiIntegrationAuthType.OAUTH2_IMPLICIT:
      case RestApiIntegrationAuthType.OAUTH2_PASSWORD:
        if (tokens.refreshToken) {
          res.cookie(`${authId}-refresh`, tokens.refreshToken, { ...HTTP_SECURE_COOKIE_OPTIONS, expires: defaultRefreshExpiry });
        }
        if (tokens.token) {
          res.cookie(`${authId}-token`, tokens.token, {
            ...HTTP_SECURE_COOKIE_OPTIONS,
            expires: tokens.expiryTimestamp ? new Date(parseInt(tokens.expiryTimestamp)) : defaultTokenExpiry
          });
          success = true;
        }
        break;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = new ResponseWrapper<any>({ data: success });
    res.send(response);
  } catch (err) {
    next(err);
  }
});

router.post('/logout', async (req: Request, res: Response, next: NextFunction) => {
  // Cached token keys are suffixed depending on their token type (e.g.
  // "-refresh").
  const tokenSuffixes = Object.values(TokenType).map((tokenType) => '-' + tokenType);
  const hasKnownSuffix = (s: string): boolean => {
    for (const suffix of tokenSuffixes) {
      if (s.endsWith(suffix)) {
        return true;
      }
    }
    return false;
  };
  try {
    Object.keys(req.cookies)
      .filter(hasKnownSuffix)
      .forEach((key) => {
        res.cookie(key, '', { expires: new Date() });
      });

    // Clear backend tokens.
    const agentCredentials = agentCredsFromRequestJwt(req);
    await deleteCachedUserAuth(agentCredentials);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = new ResponseWrapper<any>({ data: true });
    res.send(response);
  } catch (err) {
    next(err);
  }
});

// Exchanges an authentication code for an authentication token that's stored in
// the server.
router.post('/exchange-code', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const accessCode = req.body.accessCode;

    const agentCredentials = agentCredsFromRequestJwt(req);

    let authType = req.body.authType;
    let authConfig = req.body.authConfig;
    if (req.body.datasourceId) {
      // Fetch the full datasource ID from server.
      const integration = await fetchDatasource(req.body.datasourceId, agentCredentials);
      const config =
        req.body.environment === ENVIRONMENT_PRODUCTION
          ? integration?.datasource?.configurationProd
          : integration?.datasource?.configurationStaging;
      authType = get(config, 'authType');
      authConfig = get(config, 'authConfig');
    }

    if (!authConfig) {
      throw new NotFoundError('Auth Configuration expected but not found');
    }

    let error = '';
    let successful = true;
    try {
      await exchangeAuthCode(agentCredentials, authType, accessCode, authConfig);
    } catch (err) {
      successful = false;
      error = err.message;
      if (err.response?.data) {
        // If we have a detailed error message, include it on a new line.
        // The final error message would look like:
        //    Failed with code 400:
        //    {"reason": "Invalid redirect URI"}
        error += `:\n${JSON.stringify(err.response.data)}`;
      }
    }

    const response = new ResponseWrapper<ExchangeCodeResponse>({
      data: {
        successful,
        error
      }
    });
    res.send(response);
  } catch (err) {
    next(err);
  }
});

export default router;
