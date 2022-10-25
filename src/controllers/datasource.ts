import { validatePostUserTokenRequest } from '@superblocksteam/schemas';
import {
  ActionConfiguration,
  AuthConfig,
  AuthType,
  BadRequestError,
  DatasourceConfiguration,
  DatasourceMetadataDto,
  DatasourceTestResult,
  DeleteDatasourceOnAgentResult,
  ExecutionContext,
  getBasePluginId,
  Integration,
  IntegrationError,
  isPluginTestable,
  NotFoundError,
  Plugin,
  PostUserTokenRequestDto,
  RestApiDatasourceConfiguration,
  RestApiIntegrationAuthType,
  TokenType
} from '@superblocksteam/shared';
import { RelayDelegate } from '@superblocksteam/shared-backend';
import { Fleet, Selector } from '@superblocksteam/worker';
import { get, isDate } from 'lodash';
import { evaluateDatasource } from '../api/datasourceEvaluation';
import { APP_ENV_VAR_KEY, getAppEnvVars } from '../api/env';
import { SUPERBLOCKS_AGENT_EAGER_REFRESH_THRESHOLD_MS } from '../env';
import { AgentCredentials, getOrRefreshToken } from '../utils/auth';
import { forwardAgentDiagnostics } from '../utils/diagnostics';
import { addDiagnosticTagsToError } from '../utils/error';
import logger from '../utils/logger';
import { makeRequest, RequestMethod } from '../utils/request';
import { buildSuperblocksCloudUrl } from '../utils/url';

export const getMetadata = async (
  environment: string,
  datasourceConfig: DatasourceConfiguration,
  plugin: Plugin,
  agentCredentials: AgentCredentials,
  datasourceId: string,
  relayDelegate: RelayDelegate = null,
  actionConfiguration: ActionConfiguration = null
): Promise<DatasourceMetadataDto> => {
  if (!datasourceConfig) {
    throw new NotFoundError('Datasource configuration is missing');
  }

  if (!plugin) {
    throw new NotFoundError('Plugin is missing');
  }

  const initialContext = new ExecutionContext();
  initialContext.addGlobalVariableOverride(APP_ENV_VAR_KEY, getAppEnvVars(logger));
  if ((datasourceConfig as RestApiDatasourceConfiguration).authType === RestApiIntegrationAuthType.OAUTH2_CODE) {
    const datasource = await fetchDatasource(datasourceId, agentCredentials);
    const token = await getOrRefreshToken(
      agentCredentials,
      (datasourceConfig as RestApiDatasourceConfiguration).authType,
      (datasourceConfig as RestApiDatasourceConfiguration).authConfig,
      datasource.datasource
    );
    (datasourceConfig as RestApiDatasourceConfiguration).authConfig.authToken = token;
  }

  await evaluateDatasource(
    datasourceConfig,
    environment,
    agentCredentials,
    initialContext,
    false /* isWorkflow */,
    [] /* files */,
    {
      executedWorkflowsPath: [],
      isEvaluatingDatasource: false
    },
    relayDelegate
  );

  try {
    const pluginName = getBasePluginId(plugin.id);
    const pluginVersion = datasourceConfig.superblocksMetadata?.pluginVersion;
    const labels = { environment };
    const selector = Selector.Exact({ pluginName, pluginVersion, labels });
    return await Fleet.instance().metadata(selector, {}, datasourceConfig, actionConfiguration);
  } catch (e) {
    const err = new IntegrationError(`Failed to load the plugin metadata. Cause: ${e}`);
    addDiagnosticTagsToError(err, { pluginId: plugin.id, datasourceId: datasourceId });
    throw err;
  }
};

export const testConnection = async (
  environment: string,
  datasourceConfig: DatasourceConfiguration,
  plugin: Plugin,
  authHeader: string,
  relayDelegate: RelayDelegate,
  datasourceId: string
): Promise<DatasourceTestResult> => {
  try {
    if (!datasourceConfig) {
      throw new NotFoundError('Datasource configuration is missing');
    }

    if (!plugin) {
      throw new NotFoundError('Plugin is missing');
    }

    const agentCredentials = new AgentCredentials({ jwt: authHeader });
    const initialContext = new ExecutionContext();
    initialContext.addGlobalVariableOverride(APP_ENV_VAR_KEY, getAppEnvVars(logger));
    if (!isPluginTestable(plugin)) {
      return { success: true, message: 'Test successful' };
    } else if ((datasourceConfig as RestApiDatasourceConfiguration).authType === RestApiIntegrationAuthType.OAUTH2_CODE) {
      const datasource = await fetchDatasource(datasourceId, agentCredentials);
      const token = await getOrRefreshToken(
        agentCredentials,
        (datasourceConfig as RestApiDatasourceConfiguration).authType,
        (datasourceConfig as RestApiDatasourceConfiguration).authConfig,
        datasource.datasource
      );
      (datasourceConfig as RestApiDatasourceConfiguration).authConfig.authToken = token;
    }
    await evaluateDatasource(
      datasourceConfig,
      environment,
      agentCredentials,
      initialContext,
      false /* isWorkflow */,
      [] /* files */,
      {
        executedWorkflowsPath: [],
        isEvaluatingDatasource: false
      },
      relayDelegate
    );

    const pluginName = getBasePluginId(plugin.id);
    const pluginVersion = datasourceConfig.superblocksMetadata?.pluginVersion;
    const labels = { environment };
    const selector = Selector.Exact({ pluginName, pluginVersion, labels });

    await Fleet.instance().test(selector, {}, datasourceConfig);

    return { success: true, message: 'Test successful' };
  } catch (e) {
    forwardAgentDiagnostics(e, { environment, pluginId: plugin.id });
    return { success: false, message: e.message };
  }
};

export const fetchDatasource = async (
  datasourceId: string,
  agentCredentials: AgentCredentials,
  relayDelegate: RelayDelegate = null
): Promise<Integration> => {
  try {
    if (!datasourceId) {
      throw new BadRequestError('Datasource ID is empty.');
    }
    return makeRequest<Integration>({
      agentCredentials: agentCredentials,
      method: RequestMethod.POST,
      relayDelegate,
      url: buildSuperblocksCloudUrl(`datasource/${datasourceId}`)
    });
  } catch (err) {
    addDiagnosticTagsToError(err, { datasourceId });
    throw err;
  }
};

const verifyUserTokenRequestPayload = (payload: PostUserTokenRequestDto): boolean => {
  try {
    validatePostUserTokenRequest(payload);
  } catch (err) {
    const tokenUrl = get(payload.authConfig, 'tokenUrl', '');
    logger.warn(
      `${err}. Dropping the caching attempt. tokenUrl: ${tokenUrl}, authType: ${payload.authType}, tokenType: ${payload.tokenType}, expiresAt: ${payload.expiresAt}`
    );
    return false;
  }
  return true;
};

export const cacheAuth = async (
  agentCredentials: AgentCredentials,
  authType: AuthType,
  authConfig: AuthConfig,
  tokenType: TokenType,
  tokenValue: string,
  expiresAt?: Date
): Promise<boolean | undefined> => {
  const userTokenPayload: PostUserTokenRequestDto = {
    authType: authType,
    authConfig: authConfig,
    tokenType: tokenType,
    tokenValue: tokenValue
  };

  if (isDate(expiresAt)) {
    userTokenPayload.expiresAt = expiresAt;
  }

  if (!verifyUserTokenRequestPayload(userTokenPayload)) {
    return;
  }

  return await makeRequest<boolean | undefined>({
    agentCredentials: agentCredentials,
    method: RequestMethod.POST,
    url: buildSuperblocksCloudUrl(`userToken`),
    payload: userTokenPayload
  });
};

export const deleteCachedUserAuth = async (agentCredentials: AgentCredentials): Promise<boolean | undefined> => {
  return await makeRequest<boolean | undefined>({
    agentCredentials: agentCredentials,
    method: RequestMethod.DELETE,
    url: buildSuperblocksCloudUrl(`user/userToken`)
  });
};

export const cacheUserAuth = async (
  agentCredentials: AgentCredentials,
  authType: AuthType,
  authConfig: AuthConfig,
  tokenType: TokenType,
  tokenValue: string,
  expiresAt?: Date
): Promise<boolean | undefined> => {
  const userTokenPayload: PostUserTokenRequestDto = {
    authType: authType,
    authConfig: authConfig,
    tokenType: tokenType,
    tokenValue: tokenValue
  };

  if (isDate(expiresAt)) {
    userTokenPayload.expiresAt = expiresAt;
  }

  return await makeRequest<boolean | undefined>({
    agentCredentials: agentCredentials,
    method: RequestMethod.POST,
    url: buildSuperblocksCloudUrl(`user/userToken`),
    payload: userTokenPayload
  });
};

export const fetchPerUserToken = async (
  agentCredentials: AgentCredentials,
  authType: AuthType,
  authConfig: AuthConfig,
  tokenType: TokenType,
  eagerRefreshThresholdMs = SUPERBLOCKS_AGENT_EAGER_REFRESH_THRESHOLD_MS
): Promise<string | undefined> => {
  return await makeRequest<string | undefined>({
    agentCredentials: agentCredentials,
    method: RequestMethod.GET,
    url: buildSuperblocksCloudUrl(`user/userToken`),
    payload: {
      authType,
      authConfig,
      tokenType,
      eagerRefreshThresholdMs: eagerRefreshThresholdMs
    }
  });
};

type FetchUserTokenRequest = {
  agentCredentials: AgentCredentials;
  authType: AuthType;
  authConfig: AuthConfig;
  tokenType: TokenType;
  datasourceId?: string;
  eagerRefreshThresholdMs?: number;
};

export const fetchUserToken = async ({
  agentCredentials,
  authType,
  authConfig,
  tokenType,
  datasourceId,
  eagerRefreshThresholdMs = SUPERBLOCKS_AGENT_EAGER_REFRESH_THRESHOLD_MS
}: FetchUserTokenRequest): Promise<string | undefined> => {
  return await makeRequest<string | undefined>({
    agentCredentials: agentCredentials,
    method: RequestMethod.GET,
    url: buildSuperblocksCloudUrl(`userToken`),
    payload: {
      authType: authType,
      authConfig: authConfig,
      tokenType: tokenType,
      datasourceId: datasourceId,
      eagerRefreshThresholdMs: eagerRefreshThresholdMs
    }
  });
};

export const preDelete = async (
  environment: string,
  datasourceConfig: DatasourceConfiguration,
  plugin: Plugin,
  agentCredentials: AgentCredentials,
  datasourceId: string,
  relayDelegate: RelayDelegate = null
): Promise<DeleteDatasourceOnAgentResult> => {
  if (!datasourceConfig) {
    throw new NotFoundError('Datasource configuration is missing');
  }

  if (!plugin) {
    throw new NotFoundError('Plugin is missing');
  }

  const initialContext = new ExecutionContext();
  initialContext.addGlobalVariableOverride(APP_ENV_VAR_KEY, getAppEnvVars(logger));
  if ((datasourceConfig as RestApiDatasourceConfiguration).authType === RestApiIntegrationAuthType.OAUTH2_CODE) {
    const token = await fetchUserToken({
      agentCredentials: agentCredentials,
      authType: RestApiIntegrationAuthType.OAUTH2_CODE,
      authConfig: (datasourceConfig as RestApiDatasourceConfiguration).authConfig,
      tokenType: TokenType.ACCESS,
      datasourceId: datasourceId
    });
    (datasourceConfig as RestApiDatasourceConfiguration).authConfig.authToken = token;
  }

  await evaluateDatasource(
    datasourceConfig,
    environment,
    agentCredentials,
    initialContext,
    false /* isWorkflow */,
    [] /* files */,
    {
      executedWorkflowsPath: [],
      isEvaluatingDatasource: false
    },
    relayDelegate
  );

  const pluginName = getBasePluginId(plugin.id);
  const pluginVersion = datasourceConfig.superblocksMetadata?.pluginVersion;
  const labels = { environment };
  const selector = Selector.Exact({ pluginName, pluginVersion, labels });

  await Fleet.instance().preDelete(selector, {}, datasourceConfig);

  return { success: true };
};
