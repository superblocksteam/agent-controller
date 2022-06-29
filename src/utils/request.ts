import { constants } from 'http2';
import {
  ApiReservedQueryParams,
  AuditLogDto,
  DiagnosticMetadata,
  HttpError,
  SuperblocksError,
  RbacUnauthorizedError
} from '@superblocksteam/shared';
import { RelayDelegate } from '@superblocksteam/shared-backend';
import axios, { AxiosRequestConfig } from 'axios';
import { Request } from 'express';
import { SUPERBLOCKS_AGENT_ERROR_HISTORY_DISABLE } from '../env';
import { agentHealthManager } from '../global';
import logger from '../utils/logger';
import { AgentCredentials } from './auth';
import { setAgentHeaders } from './headers';
import { buildSuperblocksCloudUrl } from './url';

export enum RequestMethod {
  GET = 'get',
  POST = 'post',
  PUT = 'put',
  DELETE = 'delete'
}

export const getUserEmail = (req: Request): string => {
  return req.body?.params?.[0]?.value?.user?.email ?? 'unknown';
};

/**
 * Parse the authorization token from the header or the query parameter if applicable.
 * Agent are eventually relying on the server to finalize the authorization.
 * @param request
 * @param allowAuthInQueryParams If we allow read the authorization token from the query parameter.
 *
 * @return Authorization token if any.
 */
export const extractAuthHeaderFromRequest = (request: Request, allowAuthInQueryParams = false): string | null => {
  const authHeader = request?.headers?.authorization;
  if (authHeader) {
    return authHeader;
  }

  if (request.query[ApiReservedQueryParams.AUTH]) {
    return 'Bearer ' + (request.query[ApiReservedQueryParams.AUTH] as string);
  }

  return null;
};

export const agentCredsFromRequestJwt = (request: Request): AgentCredentials => {
  const jwt = extractAuthHeaderFromRequest(request);
  return new AgentCredentials({ jwt: jwt });
};

interface RequestProps {
  agentCredentials?: AgentCredentials;
  method: RequestMethod;
  url: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  headers?: Record<any, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: Record<any, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: Record<any, any>;
  relayDelegate?: RelayDelegate;
}

export async function makeRequest<R>({
  agentCredentials = {},
  method,
  url,
  payload,
  headers = {},
  params = {},
  relayDelegate
}: RequestProps): Promise<R> {
  const startTime = Date.now();
  let requestConfigs: AxiosRequestConfig;
  const headersWithCredentials = setAgentHeaders(headers, agentCredentials);
  if (relayDelegate) {
    requestConfigs = {
      method: method,
      url: url,
      data: relayDelegate.relayBody(payload),
      headers: relayDelegate.relayHeaders(headersWithCredentials),
      params: relayDelegate.relayQuery(params)
    };
  } else {
    requestConfigs = {
      method: method,
      url: url,
      data: payload,
      headers: headersWithCredentials,
      params: params
    };
  }

  logger.debug(`Initializing request ${JSON.stringify(requestConfigs)}`);
  try {
    const res = await axios(requestConfigs);
    logger.debug(`Request to ${url} returned ${res.status} with headers ${JSON.stringify(res.headers)}`);
    return res.data?.data;
  } catch (e) {
    const { errorCode, errorMessage } = parseAndRecordError(e);
    // TODO Handle internal errors vs user errors better
    if (e.response?.data?.responseMeta?.error?.superblocksError === SuperblocksError.RbacUnauthorized) {
      throw new RbacUnauthorizedError(e.response?.data?.responseMeta?.error?.message ?? 'Action is not permitted.');
    }
    throw new HttpError(errorCode ?? 500, errorMessage);
  } finally {
    logger.info(`Request to ${url} finished in ${Date.now() - startTime}ms`);
  }
}

// Audit log requests don't throw errors and also return just the data, rather
// than res.data.data.
export async function makeAuditLogRequest<R>(method: RequestMethod, url: string, payload: AuditLogDto): Promise<R> {
  const startTime = Date.now();
  try {
    const req: AxiosRequestConfig = {
      method: method,
      url: url,
      data: payload,
      headers: setAgentHeaders()
    };
    const res = await axios(req);
    return res.data;
  } catch (e) {
    logger.error(`Audit log request failed: ${e.message}`);
    parseAndRecordError(e);
  } finally {
    logger.info(`Audit logging request to ${url} finished in ${Date.now() - startTime}ms`);
  }
}

// Diagnostic log requests don't throw errors
export async function makeDiagnosticLogRequest(payload: DiagnosticMetadata): Promise<void> {
  const startTime = Date.now();
  const url = buildSuperblocksCloudUrl('diagnostics');
  try {
    const req: AxiosRequestConfig = {
      method: RequestMethod.POST,
      url,
      data: payload,
      headers: setAgentHeaders()
    };
    await axios(req);
  } catch (e) {
    logger.error(`Diagnostic logging request failed: ${e.message}`);
    parseAndRecordError(e);
  } finally {
    logger.info(`Diagnostic logging request to ${url} finished in ${Date.now() - startTime}ms`);
  }
}

const nonRetryableHttpError = new Set([
  constants.HTTP_STATUS_NOT_FOUND,
  constants.HTTP_STATUS_UNAUTHORIZED,
  constants.HTTP_STATUS_BAD_REQUEST,
  constants.HTTP_STATUS_CONFLICT
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parseAndRecordError = (e: any) => {
  const errorCode = e?.response?.status;
  const errorMessage = e?.response?.data?.responseMeta?.error?.message ?? e.message;
  // Conditionally record agent errors for display in the health response
  if (SUPERBLOCKS_AGENT_ERROR_HISTORY_DISABLE !== 'true') {
    agentHealthManager.recordServerError({ code: errorCode, msg: errorMessage, ts: Date.now() });
  }
  return { errorCode, errorMessage };
};

export const shouldRetry = (err: Error): boolean => {
  if (!(err instanceof HttpError)) {
    return false;
  }
  return !nonRetryableHttpError.has(err.status);
};
