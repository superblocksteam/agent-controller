import { constants } from 'http2';
import { SpanKind, Span } from '@opentelemetry/api';
import {
  apiTriggerToEntity,
  ApiDefinition,
  ApiExecutionResponse,
  AuthContext,
  DiagnosticMetadataTags,
  ExecutionContext,
  ExecutionParam,
  EventEntityType,
  HttpError,
  NotFoundError,
  RbacUnauthorizedError,
  UnauthorizedError,
  TooManyRequestsError,
  userAccessibleTokens,
  ForwardedCookies,
  FORWARDED_COOKIE_PREFIX,
  FORWARDED_COOKIE_DELIMITER,
  OBS_TAG_ENV,
  OBS_TAGS
} from '@superblocksteam/shared';
import { FetchAndExecuteProps, RelayDelegate, RequestFiles } from '@superblocksteam/shared-backend';
import ApiExecutor, { RecursionContext } from '../api/ApiExecutor';
import { ApiRequestRecord, PersistentAuditLogger } from '../utils/audit';
import { AgentCredentials } from '../utils/auth';
import { forwardAgentDiagnostics } from '../utils/diagnostics';
import { addDiagnosticTagsToError } from '../utils/error';
import logger from '../utils/logger';
import { makeRequest, RequestMethod } from '../utils/request';
import { getTracer } from '../utils/tracer';
import { buildSuperblocksCloudUrl } from '../utils/url';

interface FetchApiProps {
  apiId: string;
  isPublished: boolean;
  environment: string;
  agentCredentials: AgentCredentials;
  isWorkflow: boolean;
  relayDelegate?: RelayDelegate;
}

interface ExecuteApiProps {
  environment: string;
  eventType?: string;
  apiDef: ApiDefinition;
  isPublished: boolean;
  recursionContext: RecursionContext;
  auditLogger: PersistentAuditLogger;
  files?: RequestFiles;
  parentAuthContexts?: AuthContext;
  executionParams?: ExecutionParam[];
  forwardedCookies?: ForwardedCookies;
  relayDelegate?: RelayDelegate;
}

export const fetchApi = async ({
  apiId,
  isPublished,
  environment,
  agentCredentials,
  isWorkflow,
  relayDelegate
}: FetchApiProps): Promise<ApiDefinition> => {
  try {
    return await getTracer().startActiveSpan(
      'FETCH',
      {
        attributes: {
          [OBS_TAG_ENV]: environment,
          [OBS_TAGS.RESOURCE_ID]: apiId
        },
        kind: SpanKind.SERVER
      },
      async (span: Span): Promise<ApiDefinition> => {
        try {
          const response: ApiDefinition = await makeRequest<ApiDefinition>({
            agentCredentials: agentCredentials,
            method: RequestMethod.POST,
            url: buildSuperblocksCloudUrl(
              `${isWorkflow ? 'workflows' : 'api'}/${apiId}?isPublished=${isPublished}&environment=${environment}`
            ),
            relayDelegate
          });

          const { api, organizationId, metadata } = response;
          const entity: EventEntityType = apiTriggerToEntity(api.triggerType);

          span.setAttributes({
            [OBS_TAGS.ORG_ID]: organizationId,
            [OBS_TAGS.ORG_NAME]: metadata?.organizationName,
            [OBS_TAGS.RESOURCE_NAME]: api?.actions?.name,
            [OBS_TAGS.USER_EMAIL]: metadata?.requester,
            [OBS_TAGS.RESOURCE_TYPE]: entity
          });

          span.updateName(`FETCH ${entity}`);
          return response;
        } finally {
          span.end();
        }
      }
    );
  } catch (err) {
    addDiagnosticTagsToError(err, { apiId });
    throw err;
  }
};

/**
 * This methods guarantees all errors will be tagged properly.
 */
// TODO(pbardea): The recursion context here would likely benefit from
// a refactor that does the push and pop from the context here rather
// than at all of the call sites.
export const executeApiFunc = async ({
  environment,
  eventType,
  apiDef,
  executionParams = [],
  parentAuthContexts = {},
  files = undefined,
  isPublished,
  recursionContext,
  auditLogger,
  forwardedCookies,
  relayDelegate = null
}: ExecuteApiProps): Promise<{ apiResponse: ApiExecutionResponse; apiRecord: ApiRequestRecord }> => {
  const authContexts = Object.assign({}, parentAuthContexts, apiDef.authContext);
  const apiRecord = auditLogger.makeApiLogEvent(apiDef, isPublished);
  const tags: DiagnosticMetadataTags = { apiId: apiDef?.api?.id };
  try {
    validateApiDefinition(apiDef);
    const apiExecutor = new ApiExecutor();

    // The audit log creation creates a promise that gets awaited on
    // in the audit log finish/update event.
    apiRecord.start();
    const apiResponse = await apiExecutor.execute({
      environment,
      eventType,
      apiDef,
      executionParams,
      authContexts,
      files,
      auditLogger: auditLogger.localAuditLogger,
      recursionContext,
      forwardedCookies,
      relayDelegate
    });
    return { apiResponse, apiRecord };
  } catch (err) {
    auditLogger.localAuditLogger.error(`API Executor error, ${err}`);
    addDiagnosticTagsToError(err, tags);
    throw err;
  }
};

export const fetchAndExecute = async ({
  apiId,
  isPublished,
  environment,
  eventType,
  agentCredentials,
  files,
  cookies,
  executionParams,
  recursionContext,
  isWorkflow,
  relayDelegate
}: FetchAndExecuteProps): Promise<{ apiResponse: ApiExecutionResponse; apiRecord?: ApiRequestRecord; orgID?: string }> => {
  let apiDef: ApiDefinition | undefined;
  const fetchStart = Date.now();
  try {
    apiDef = await fetchApi({
      apiId,
      isPublished,
      environment,
      agentCredentials,
      isWorkflow,
      relayDelegate
    });
  } catch (err) {
    if (err instanceof HttpError && err.status === constants.HTTP_STATUS_UNAUTHORIZED) {
      if (err instanceof RbacUnauthorizedError) {
        throw err;
      }
      logger.error(`Encountered Rbac error while fetching and executing API '${apiId}': ${err}`);
      throw new UnauthorizedError(`The execution is not authorized: ${err.message}`);
    }
    if (err instanceof HttpError && err.status === constants.HTTP_STATUS_TOO_MANY_REQUESTS) {
      throw new TooManyRequestsError(`Too many requests: ${err.message}`);
    }
    logger.error(`Encountered error while fetching and executing API '${apiId}': ${err}`);
    forwardAgentDiagnostics(err, {
      apiId
    });
    const errorCtx = new ExecutionContext();
    errorCtx.error = err.message;
    return {
      apiResponse: {
        apiId,
        context: errorCtx
      }
    };
  }
  const fetchEnd = Date.now();

  let source = apiDef.metadata?.requester ?? 'Unknown';
  // TODO: We can also store the full call stack in the audit log record for
  // future usage. Deferring this for now though. We currently just show the
  // last caller as a quick win without needing to update the UI too much. It
  // also keeps the source as a simple string, but it could be extended in the
  // future to be a more complex object.
  if (recursionContext.executedWorkflowsPath.length > 0) {
    source = 'Nested call from ' + recursionContext.executedWorkflowsPath[recursionContext.executedWorkflowsPath.length - 1].name;
  }
  recursionContext.executedWorkflowsPath.push({ id: apiDef.api.id, name: apiDef.api.actions.name });
  const pLogger = new PersistentAuditLogger(source);

  // TODO(taha) skip if no rest api steps

  // find all cookies that end with superblocks suffixes and create a context
  // object out of them. this is then used for the execution context of auth'ed
  // rest api integration steps
  // This map looks like {"-token": "token", "-userId": "userId"} which indicates
  // that a cookie with the suffix "-token" will be mapped to the "token" property
  // on the created auth object (ie firebase.token).
  const knownSuffixes = userAccessibleTokens().reduce((map, tokenType) => {
    map['-' + tokenType] = tokenType;
    return map;
  }, {} as Record<string, string>);
  const parentAuthContexts = {};

  const forwardedCookies: ForwardedCookies = {};

  Object.entries(cookies ?? {}).forEach(([cookieKey, tokenValue]) => {
    if (cookieKey.startsWith(FORWARDED_COOKIE_PREFIX)) {
      const keyToSplit = cookieKey.replace(FORWARDED_COOKIE_PREFIX, '');
      const parts = keyToSplit.split(FORWARDED_COOKIE_DELIMITER);
      if (parts.length !== 2) return;
      forwardedCookies[parts[1]] = { domain: parts[0], value: tokenValue };
      return;
    }

    // The cookie key is formatted as the auth ID suffixed with one of the known
    // suffixes.
    Object.entries(knownSuffixes).forEach(([knownSuffix, variableKey]) => {
      if (cookieKey.endsWith(knownSuffix)) {
        const authId = cookieKey.replace(knownSuffix, '');
        if (!parentAuthContexts[authId]) {
          parentAuthContexts[authId] = [];
        }
        parentAuthContexts[authId].push({
          key: variableKey,
          value: tokenValue
        });
      }
    });
  });

  if (cookies) {
    logger.debug('cookies: ' + JSON.stringify(Object.keys(cookies)));
  }

  const executeStart = Date.now();
  const { apiResponse, apiRecord } = await executeApiFunc({
    environment,
    eventType,
    apiDef,
    executionParams,
    parentAuthContexts,
    files,
    isPublished,
    recursionContext,
    auditLogger: pLogger,
    forwardedCookies,
    relayDelegate
  });
  const executeEnd = Date.now();
  if (apiResponse) {
    apiResponse.apiName = apiDef?.api?.actions?.name;
    apiResponse.notificationConfig = apiDef?.api?.actions?.notificationConfig;
    apiResponse.timing = {
      ...(apiResponse.timing ?? {}),
      fetchStart,
      fetchEnd,
      fetchDurationMs: fetchEnd - fetchStart,
      executeStart,
      executeEnd,
      executeDurationMs: executeEnd - executeStart
    };
  }

  const idx = recursionContext.executedWorkflowsPath.findIndex((workflow) => workflow.id === apiDef.api.id);
  if (idx !== recursionContext.executedWorkflowsPath.length - 1) {
    logger.error('Bad state removing self from workflows path');
  }
  recursionContext.executedWorkflowsPath.splice(idx);
  return { apiResponse, apiRecord, orgID: apiDef.organizationId };
};

const validateApiDefinition = (apiDef: ApiDefinition) => {
  if (!apiDef || !apiDef.api) {
    throw new NotFoundError('API not found');
  }
  if (!apiDef.api.actions) {
    throw new NotFoundError('API action is empty');
  }
};
