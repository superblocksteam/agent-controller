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
  Integration,
  IntegrationError,
  isPluginTestable,
  NotFoundError,
  Plugin,
  RestApiDatasourceConfiguration,
  RestApiIntegrationAuthType,
  TokenType
} from '@superblocksteam/shared';
import { RelayDelegate } from '@superblocksteam/shared-backend';
import { evaluateDatasource } from '../api/datasourceEvaluation';
import { APP_ENV_VAR_KEY, getAppEnvVars } from '../api/env';
import { AgentCredentials, getOrRefreshToken } from '../utils/auth';
import { forwardAgentDiagnostics } from '../utils/diagnostics';
import { addDiagnosticTagsToError } from '../utils/error';
import { loadPluginModule } from '../utils/executor';
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

  const loadedPlugin = await loadPluginModule(plugin.id, datasourceConfig.superblocksMetadata?.pluginVersion);
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
    const metadata = await loadedPlugin.metadata(datasourceConfig, actionConfiguration);
    return metadata;
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
    const loadedPlugin = await loadPluginModule(plugin.id, datasourceConfig.superblocksMetadata?.pluginVersion);
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
    await loadedPlugin.test(datasourceConfig);
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

export const cacheAuth = async (
  agentCredentials: AgentCredentials,
  authType: AuthType,
  authConfig: AuthConfig,
  tokenType: TokenType,
  tokenValue: string,
  expiresAt?: Date
): Promise<boolean | undefined> => {
  return await makeRequest<boolean | undefined>({
    agentCredentials: agentCredentials,
    method: RequestMethod.POST,
    url: buildSuperblocksCloudUrl(`userToken`),
    payload: {
      authType,
      authConfig,
      tokenType,
      tokenValue,
      expiresAt
    }
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
  return await makeRequest<boolean | undefined>({
    agentCredentials: agentCredentials,
    method: RequestMethod.POST,
    url: buildSuperblocksCloudUrl(`user/userToken`),
    payload: {
      authType,
      authConfig,
      tokenType,
      tokenValue,
      expiresAt
    }
  });
};

export const fetchPerUserToken = async (
  agentCredentials: AgentCredentials,
  authType: AuthType,
  authConfig: AuthConfig,
  tokenType: TokenType
): Promise<string | undefined> => {
  return await makeRequest<string | undefined>({
    agentCredentials: agentCredentials,
    method: RequestMethod.GET,
    url: buildSuperblocksCloudUrl(`user/userToken`),
    payload: {
      authType,
      authConfig,
      tokenType
    }
  });
};

export const fetchUserToken = async (
  agentCredentials: AgentCredentials,
  authType: AuthType,
  authConfig: AuthConfig,
  tokenType: TokenType,
  datasourceId?: string
): Promise<string | undefined> => {
  return await makeRequest<string | undefined>({
    agentCredentials: agentCredentials,
    method: RequestMethod.GET,
    url: buildSuperblocksCloudUrl(`userToken`),
    payload: {
      authType,
      authConfig,
      tokenType,
      datasourceId
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
    const token = await fetchUserToken(
      agentCredentials,
      RestApiIntegrationAuthType.OAUTH2_CODE,
      (datasourceConfig as RestApiDatasourceConfiguration).authConfig,
      TokenType.ACCESS,
      datasourceId
    );
    (datasourceConfig as RestApiDatasourceConfiguration).authConfig.authToken = token;
  }

  const loadedPlugin = await loadPluginModule(plugin.id, datasourceConfig.superblocksMetadata?.pluginVersion);
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
  if (loadedPlugin.preDelete) {
    await loadedPlugin.preDelete(datasourceConfig);
  }
  return { success: true };
};
