import {
  AuthContext,
  DatasourceConfiguration,
  ExecutionContext,
  getAuthIdFromConfig,
  IntegrationError,
  PUBLISHED_VIEW_MODE,
  RedactableExecutionParam,
  RestApiIntegrationAuthType,
  RestApiIntegrationDatasourceConfiguration
} from '@superblocksteam/shared';
import { formatExecutionOutput, RelayDelegate, RequestFiles, resolveConfigurationRecursive } from '@superblocksteam/shared-backend';
import { isEmpty } from 'lodash';
import { executeApiFunc, fetchApi } from '../controllers/api';
import { PersistentAuditLogger } from '../utils/audit';
import { AgentCredentials } from '../utils/auth';
import { addDiagnosticTagsToError } from '../utils/error';
import { RecursionContext } from './ApiExecutor';
import { apiAuthBindings } from './apiAuthentication';

export async function evaluateDatasource(
  datasourceConfiguration: DatasourceConfiguration,
  environment: string,
  agentCredentials: AgentCredentials,
  datasourceContext: ExecutionContext,
  isWorkFlow: boolean,
  files: RequestFiles,
  recursionContext: RecursionContext,
  relayDelegate: RelayDelegate
): Promise<void> {
  try {
    if (datasourceConfiguration.dynamicWorkflowConfiguration?.workflowId) {
      await evaluateDynamicDatasource(
        datasourceContext,
        datasourceConfiguration,
        environment,
        agentCredentials,
        isWorkFlow,
        files,
        recursionContext,
        relayDelegate
      );
      return;
    }
    // If there is no selected dependent workflow for this datasource but, it may
    // have dynamic bindings (e.g. REST API datasource). Try to resolve bindings
    // in the datasource config in any case since there might be non dynamic
    // workflow related lookups
    await resolveConfigurationRecursive(datasourceContext, files, datasourceConfiguration as Record<string, unknown>);
  } catch (err) {
    addDiagnosticTagsToError(err, { environment });
    throw err;
  }
}

/**
 * This method guarantees all thrown errors are classified and tagged properly.
 */
async function evaluateDynamicDatasource(
  initialContext: ExecutionContext,
  datasourceConfiguration: DatasourceConfiguration,
  environment: string,
  agentCredentials: AgentCredentials,
  isWorkflow: boolean,
  files: RequestFiles,
  recursionContext: RecursionContext,
  relayDelegate: RelayDelegate
): Promise<void> {
  try {
    if (recursionContext.isEvaluatingDatasource) {
      throw new IntegrationError('Cannot reference a workflow that uses an integration that fetches credentials dynamically');
    }
    const datasourceContext = new ExecutionContext(initialContext);
    const workflowId = datasourceConfiguration.dynamicWorkflowConfiguration.workflowId;
    // Note that we run the deployed workflow when executing the workflows that
    // the dynamic datasources rely on, but may be running them against any
    // environment.
    const apiRequest = { apiId: workflowId, params: [], viewMode: PUBLISHED_VIEW_MODE };

    const fetchStart = Date.now();
    const apiDef = await fetchApi({
      apiId: apiRequest.apiId,
      isPublished: apiRequest.viewMode,
      environment,
      agentCredentials,
      isWorkflow,
      relayDelegate
    });
    const fetchEnd = Date.now();

    const pLogger = new PersistentAuditLogger('todo');

    const executeStart = Date.now();
    const { apiResponse, apiRecord } = await executeApiFunc({
      environment,
      apiDef,
      files: undefined,
      isPublished: apiRequest.viewMode,
      recursionContext: {
        executedWorkflowsPath: recursionContext.executedWorkflowsPath,
        isEvaluatingDatasource: true
      },
      auditLogger: pLogger,
      relayDelegate
    });
    const executeEnd = Date.now();
    apiResponse.timing = {
      ...(apiResponse.timing ?? {}),
      fetchStart,
      fetchEnd,
      fetchDurationMs: fetchEnd - fetchStart,
      executeStart,
      executeEnd,
      executeDurationMs: executeEnd - executeStart
    };
    apiRecord.finish(apiResponse);

    try {
      Object.values(apiResponse.context.outputs).forEach((output) => {
        if (output.error) throw new IntegrationError(output.error);
      });

      datasourceContext.addGlobalVariableOverride(apiDef?.api?.actions?.name ?? 'error_workflow', {
        response: formatExecutionOutput(apiResponse)
      });
    } catch (err) {
      throw new IntegrationError(`Error running dependent workflow: ${err.message}`);
    }

    // First, if we have a dynamic datasource we need to evaluate the
    // bindings.
    await resolveConfigurationRecursive(datasourceContext, files, datasourceConfiguration as Record<string, unknown>);
  } catch (err) {
    addDiagnosticTagsToError(err, { environment });
    throw err;
  }
}

export function makeAuthBindings(
  authContexts: AuthContext,
  datasourceConfig: RestApiIntegrationDatasourceConfiguration,
  datasourceId: string
): Record<string, RedactableExecutionParam[]> {
  const datasourceAuthId = getAuthIdFromConfig(datasourceId, datasourceConfig);
  const datasourceContextParams = authContexts[datasourceAuthId];
  if (!datasourceContextParams) {
    return {};
  }

  const authBindings = {};
  const authType = datasourceConfig?.authType as RestApiIntegrationAuthType;
  const authKey = apiAuthBindings(authType);
  if (!isEmpty(authKey)) {
    authBindings[authKey] = datasourceContextParams;
  }

  return authBindings;
}
