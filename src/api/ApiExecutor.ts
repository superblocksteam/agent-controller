import {
  Action,
  ActionType,
  ApiDefinition,
  ApiDetails,
  ApiExecutionResponse,
  apiTriggerToEntity,
  ApiTriggerType,
  AuthContext,
  BasicAuthConfig,
  DatasourceConfiguration,
  DatasourceDto,
  DiagnosticMetadataTags,
  ENVIRONMENT_PRODUCTION,
  EventAction,
  EventEntityType,
  ExecutionContext,
  ExecutionOutput,
  ExecutionParam,
  ForwardedCookies,
  getBasePluginId,
  getChildActionIds,
  Global,
  GoogleSheetsAuthType,
  GOOGLE_SHEETS_PLUGIN_ID,
  IntegrationError,
  InternalServerError,
  LogFields,
  NotFoundError,
  RestApiIntegrationAuthType,
  RestApiIntegrationDatasourceConfiguration
} from '@superblocksteam/shared';
import {
  buildContextFromBindings,
  ExecutionMeta,
  PluginProps,
  RelayDelegate,
  RequestFiles,
  resolveConfigurationRecursive
} from '@superblocksteam/shared-backend';
import { Fleet, VersionedPluginDefinition } from '@superblocksteam/worker';
import { cloneDeep, get, isEmpty } from 'lodash';
import P from 'pino';
import { SUPERBLOCKS_AGENT_ID, SUPERBLOCKS_FILE_SERVER_URL, SUPERBLOCKS_WORKER_ENABLE } from '../env';
import { AgentCredentials, getOrRefreshToken, makeBasicAuthToken } from '../utils/auth';
import { forwardAgentDiagnostics } from '../utils/diagnostics';
import { addDiagnosticTagsToError } from '../utils/error';
import { getChildActionNames, loadPluginModule } from '../utils/executor';
import logger, { remoteLogger } from '../utils/logger';
import tracer from '../utils/tracer';
import { apiAuthBindings, expectsBindings, getOauthClientCredsToken, getOauthPasswordToken } from './apiAuthentication';
import { evaluateDatasource, makeAuthBindings } from './datasourceEvaluation';
import { APP_ENV_VAR_KEY, getAppEnvVars, getRedactedAppEnvVars } from './env';

export type RecursionContext = {
  executedWorkflowsPath: Array<{ name: string; id: string }>;
  isEvaluatingDatasource: boolean;
};

type EvaluatedDatasource = {
  config: DatasourceConfiguration;
  redactedConfig: DatasourceConfiguration;
};

type ExecutionProps = {
  metadata?: ExecutionMeta;
  apiDef: ApiDefinition;
  executionParams: ExecutionParam[];
  environment: string;
  authContexts: AuthContext;
  files: RequestFiles;
  auditLogger: P.Logger;
  recursionContext: RecursionContext;
  relayDelegate: RelayDelegate;
  forwardedCookies?: ForwardedCookies;
};

export default class ApiExecutor {
  status: ExecuteStatus;

  constructor() {
    this.status = ExecuteStatus.IDLE;
  }

  async execute({
    metadata,
    apiDef,
    executionParams,
    environment,
    authContexts,
    files,
    auditLogger,
    recursionContext,
    forwardedCookies,
    relayDelegate
  }: ExecutionProps): Promise<ApiExecutionResponse> {
    this.status = ExecuteStatus.EXECUTING;
    const api = apiDef.api;
    const actions = apiDef.api.actions;
    const tags: DiagnosticMetadataTags = { apiId: api.id, environment };

    const logFields: LogFields = {
      resourceType: apiTriggerToEntity(apiDef.api.triggerType),
      resourceId: apiDef.api.id,
      resourceName: actions.name,
      organizationId: apiDef.organizationId,
      userEmail: apiDef.metadata?.requester || undefined,
      controllerId: SUPERBLOCKS_AGENT_ID,
      correlationId: metadata?.correlationId,
      environment
    };

    if (apiDef.api.triggerType === ApiTriggerType.UI) {
      logFields.parentId = apiDef.api.applicationId;
      logFields.parentType = EventEntityType.APPLICATION;
    }

    try {
      // build context
      // TODO: Build an object that manages the redaction automatically. This
      // will also need a redactable version of a datasource config and actions.
      const initialContext = new ExecutionContext();
      const redactedContext = new ExecutionContext();

      const bindingPathToValue = {};
      executionParams?.forEach((param) => {
        bindingPathToValue[param.key] = param.value;
      });
      buildContextFromBindings(bindingPathToValue).forEach(([variableName, variable]) => {
        initialContext.addGlobalVariable(variableName, variable);
        redactedContext.addGlobalVariable(variableName, variable);
      });

      initialContext.addGlobalVariableOverride(APP_ENV_VAR_KEY, getAppEnvVars(auditLogger));
      redactedContext.addGlobalVariableOverride(APP_ENV_VAR_KEY, getRedactedAppEnvVars(auditLogger));

      const global = Global.from(apiDef.global);
      initialContext.addGlobalsOverride(global);
      redactedContext.addGlobalsOverride(global);

      const agentCredentials = new AgentCredentials({ apiKey: `Bearer ${apiDef.orgApiKey}` });

      const execContext = await this.executeAction({
        triggerActionId: actions.triggerActionId,
        agentCredentials: agentCredentials,
        actions,
        context: initialContext,
        redactedContext: redactedContext,
        authContexts: authContexts,
        datasources: apiDef.datasources,
        applicationId: api.applicationId,
        auditLogger,
        files,
        environment: environment,
        recursionContext: recursionContext,
        apiId: apiDef.api.id,
        relayDelegate,
        logFields,
        forwardedCookies
      });

      return {
        apiId: api.id,
        context: execContext
      };
    } catch (err) {
      addDiagnosticTagsToError(err, tags);
      throw err;
    } finally {
      this.status = ExecuteStatus.IDLE;
    }
  }

  /**
   * This method does not throw execution errors, but returns the error in the
   * {@link ExecutionContext} to the caller.
   *
   * TODO(pbardea): These arguments needs to be cleaned up. Files and context
   *  should be wrapped into a common struct.
   */
  private async executeAction({
    triggerActionId,
    agentCredentials,
    actions,
    context,
    redactedContext,
    authContexts,
    datasources,
    applicationId,
    files,
    auditLogger,
    environment,
    recursionContext,
    apiId,
    relayDelegate,
    logFields,
    forwardedCookies
  }: {
    triggerActionId: string;
    agentCredentials: AgentCredentials;
    actions: ApiDetails;
    context: ExecutionContext;
    redactedContext: ExecutionContext;
    authContexts: AuthContext;
    datasources: Record<string, DatasourceDto>;
    applicationId: string;
    files: RequestFiles;
    auditLogger: P.Logger;
    environment: string;
    recursionContext: RecursionContext;
    apiId: string;
    relayDelegate: RelayDelegate;
    logFields: LogFields;
    forwardedCookies?: ForwardedCookies;
  }): Promise<ExecutionContext> {
    remoteLogger.info(
      { ...logFields, resourceAction: EventAction.STARTED },
      `The ${logFields.resourceType} "${logFields.resourceName}" has been ${EventAction.STARTED}.`
    );
    const initialContext = new ExecutionContext(context);
    const redactedInitialContext = new ExecutionContext(redactedContext);
    // TODO Optimization, we don't have to create a new VM for every action
    // const vm = new NodeVMWithContext(context);
    let action;
    try {
      action = validateAndGetAction(triggerActionId, actions);
    } catch (err) {
      addDiagnosticTagsToError(err, { apiId });
      // We throw here because we don't even get an action running.
      throw err;
    }

    const actionFlow: Action[] = [];
    const evaluatedDatasourceConfigs: Record<string, EvaluatedDatasource> = {};

    while (action) {
      const tags: DiagnosticMetadataTags = {
        actionName: action.name,
        actionId: action.id,
        apiId,
        applicationId,
        datasourceId: action.datasourceId,
        pluginId: action.pluginId
      };
      let datasource;
      try {
        switch (action.type) {
          case ActionType.Integration: {
            datasource = validateAndGetDatasourceForAction({ action, datasources });
            if (evaluatedDatasourceConfigs[action.datasourceId] === undefined) {
              const datasourceEvaluationResult = await redactAndEvaluateDatasourceConfiguration({
                initialContext,
                redactedInitialContext,
                environment,
                agentCredentials,
                files,
                action,
                recursionContext,
                authContexts,
                datasource,
                auditLogger,
                relayDelegate
              });
              evaluatedDatasourceConfigs[action.datasourceId] = {
                config: datasourceEvaluationResult.datasourceConfiguration,
                redactedConfig: datasourceEvaluationResult.redactedDatasourceConfiguration
              };
            }

            actionFlow.push(action);

            // TODO do proper BFS when we support branching with children
            // for now we only support a single child for Integration actions
            const childActionId = getChildActionIds(action)[0];
            if (!childActionId) {
              action = null;
            } else {
              action = validateAndGetAction(childActionId, actions);
            }
            break;
          }
          // TODO Implement
          case ActionType.Loop:
          case ActionType.Conditional:
          case ActionType.Assignment:
          default:
        }
      } catch (error) {
        const message = '';
        return executeActionErrorContext({ error, message, action, auditLogger, tags });
      }
    }

    const newContext = new ExecutionContext(context);
    const newRedactedContext = new ExecutionContext(redactedContext);
    for (const action of actionFlow) {
      const stepLogFields: LogFields = {
        ...logFields,
        parentId: logFields.resourceId,
        parentName: logFields.resourceName,
        parentType: logFields.resourceType,
        resourceType: EventEntityType.STEP,
        resourceId: action.id,
        resourceName: action.name,
        plugin: action.pluginId,
        integragionId: action.datasourceId,
        userEmail: action.pluginId === 'workflow' ? undefined : logFields.userEmail // We'll need to properly pass the request to the headless workflow so it's logged properly.
      };
      remoteLogger.info(
        { ...stepLogFields, resourceAction: EventAction.STARTED },
        `The ${stepLogFields.resourceType} "${stepLogFields.resourceName}" has been ${EventAction.STARTED}.`
      );
      const tags: DiagnosticMetadataTags = {
        actionName: action.name,
        actionId: action.id,
        apiId,
        applicationId,
        datasourceId: action.datasourceId,
        pluginId: action.pluginId,
        organizationId: logFields.organizationId // TODO(frank): I think it makes sense to refactor our tags so that we simply pass in 'logFields'.
      };
      try {
        const evaluatedDatasource = evaluatedDatasourceConfigs[action.datasourceId];
        const datasourceConfiguration = evaluatedDatasource.config;
        const redactedDatasourceConfig = evaluatedDatasource.redactedConfig;

        if (action.type !== ActionType.Integration) {
          const errorMessage = `unexpected action type ${action.type} for action ${action.id}`;
          forwardAgentDiagnostics(new InternalServerError(errorMessage), tags);
          logger.error(errorMessage);
          continue;
        }

        newContext.addGlobalVariable('$fileServerUrl', SUPERBLOCKS_FILE_SERVER_URL);
        newContext.addGlobalVariable('$flagWorker', SUPERBLOCKS_WORKER_ENABLE);

        newRedactedContext.addGlobalVariable('$fileServerUrl', SUPERBLOCKS_FILE_SERVER_URL);
        newRedactedContext.addGlobalVariable('$flagWorker', SUPERBLOCKS_WORKER_ENABLE);

        auditLogger.info('Executing action ' + action.name);

        const props: PluginProps = {
          environment,
          context: newContext,
          redactedContext: newRedactedContext,
          agentCredentials,
          redactedDatasourceConfiguration: redactedDatasourceConfig,
          datasourceConfiguration,
          actionConfiguration: action.configuration,
          files,
          recursionContext,
          relayDelegate,
          forwardedCookies
        };

        const vpd: VersionedPluginDefinition = {
          name: getBasePluginId(action.pluginId),
          version: action.configuration?.superblocksMetadata?.pluginVersion
        };

        // execute action and wrap function in a trace for ddog observability
        const output = await tracer.trace(
          action.pluginId,
          { tags },
          async (): Promise<ExecutionOutput> => {
            if (!SUPERBLOCKS_WORKER_ENABLE || action.pluginId == 'workflow') {
              return await (await loadPluginModule(vpd)).setupAndExecute(props);
            }

            return await Fleet.instance().execute(
              {
                vpd,
                labels: { environment: props.environment }
              },
              props
            );
          }
        );

        output.children = getChildActionNames(action, actions);

        // TODO If we use action names as key, we need to make sure action.name
        //  is unique across Canvas, API and internal names
        newContext.addOutput(action.name, output);
        newRedactedContext.addOutput(action.name, output);
        if (output.error) {
          remoteLogger.error(
            { ...stepLogFields, error: output.error },
            `The ${stepLogFields.resourceType} "${stepLogFields.resourceName}" has failed.`
          );
          forwardAgentDiagnostics(new IntegrationError(output.error), tags);
          newContext.errorContext = {
            actionId: action.id,
            actionName: action.name
          };
          newContext.error = output.error;
          newRedactedContext.errorContext = {
            actionId: action.id,
            actionName: action.name
          };
          newRedactedContext.error = output.error;
          break;
        }

        output.log
          // We only want to log INFO messages. The whole system could use
          // some refactoring but until then, this is how we find that out.
          .filter((log) => !log.startsWith('[WARN]') && !log.startsWith('[ERROR]'))
          // Log each log message.
          .forEach((log) => {
            try {
              // javascript is stringified
              remoteLogger.info(stepLogFields, JSON.parse(log));
            } catch {
              // python is not
              remoteLogger.info(stepLogFields, log);
            }
          });
        remoteLogger.info(
          { ...stepLogFields, resourceAction: EventAction.FINISHED },
          `The ${stepLogFields.resourceType} "${stepLogFields.resourceName}" has ${EventAction.FINISHED}.`
        );
      } catch (error) {
        const message = `Fatal error: failed to execute action ${action.name}`;
        return executeActionErrorContext({ error, message, action, auditLogger, tags });
      }
    }

    // Resolve notification bindings. We are not throwing errors here, and we keep the execution running.
    try {
      await resolveConfigurationRecursive(newContext, files, actions.notificationConfig);
    } catch (err) {
      // Notification configuration resolution is best effort.
      // TODO(pbardea): improve the error handling of the custom error message binding evaluation error
      forwardAgentDiagnostics(err, { apiId });
    }

    if (!newRedactedContext.error) {
      remoteLogger.info(
        { ...logFields, resourceAction: EventAction.FINISHED },
        `The ${logFields.resourceType} "${logFields.resourceName}" has ${EventAction.FINISHED}.`
      );
    } else {
      remoteLogger.error(
        { ...logFields, error: newRedactedContext.error },
        `The ${logFields.resourceType} "${logFields.resourceName}" has failed.`
      );
    }

    return newRedactedContext;
  }
}

const validateAndGetAction = (actionId: string, actions: ApiDetails): Action | null => {
  if (!actions || !actions.actions) {
    // We always expect these payloads on an API.
    throw new NotFoundError('Actions not found.');
  }
  if (isEmpty(actions.actions)) {
    // If an API has no actions (e.g. empty workflow or job) there is nothing to
    // execute.
    return null;
  }
  if (!actions.actions[actionId]) {
    throw new NotFoundError(`Action ${actionId} not found`);
  }
  return actions.actions[actionId];
};

const redactAndEvaluateDatasourceConfiguration = async ({
  initialContext,
  redactedInitialContext,
  environment,
  agentCredentials,
  action,
  files,
  recursionContext,
  authContexts,
  datasource,
  auditLogger,
  relayDelegate
}: {
  initialContext: ExecutionContext;
  redactedInitialContext: ExecutionContext;
  environment: string;
  agentCredentials: AgentCredentials;
  action: Action;
  files: RequestFiles;
  recursionContext: RecursionContext;
  authContexts: AuthContext;
  datasource: DatasourceDto;
  auditLogger: P.Logger;
  relayDelegate: RelayDelegate;
}): Promise<{ datasourceConfiguration: DatasourceConfiguration; redactedDatasourceConfiguration: DatasourceConfiguration }> => {
  try {
    // Make 2 copies of the initial context. So that can use each to:
    // 1) don't modify the original and leak built up context to other
    // datasources
    // 2) build in parallel as the redacted context
    const datasourceContext = new ExecutionContext(initialContext);
    const redactedDatasourceContext = new ExecutionContext(redactedInitialContext);
    const datasourceConfiguration: RestApiIntegrationDatasourceConfiguration =
      environment === ENVIRONMENT_PRODUCTION ? datasource.configurationProd : datasource.configurationStaging;
    const authBindings = makeAuthBindings(authContexts, datasourceConfiguration, datasource.id);
    Object.entries(authBindings).forEach(([authTypeKey, variables]) => {
      const authObj = {};
      const redactedAuthObj = {};
      variables.forEach((variable) => {
        authObj[variable.key] = variable.value;
        redactedAuthObj[variable.key] = variable.redactedValue ?? variable.value;
      });
      datasourceContext.addGlobalVariable(authTypeKey, authObj);
      redactedDatasourceContext.addGlobalVariable(authTypeKey, redactedAuthObj);
    });

    // This redaction is currently a bit ad-hoc, but want to avoid
    // premature optimization and is waiting to see what other
    // information we'd potentially redacted from the raw request.
    const redactedDatasourceConfiguration: RestApiIntegrationDatasourceConfiguration = cloneDeep(datasourceConfiguration);
    const authType = datasourceConfiguration.authType as RestApiIntegrationAuthType;
    const authConfig = datasourceConfiguration.authConfig;
    switch (authType) {
      case RestApiIntegrationAuthType.OAUTH2_CLIENT_CREDS: {
        const binding = apiAuthBindings(redactedDatasourceConfiguration.authType as RestApiIntegrationAuthType);
        const existingContext = datasourceContext.globals[binding];
        if (!(existingContext && existingContext['token'])) {
          // If the token is not already cached.
          const token = await getOauthClientCredsToken(agentCredentials, datasourceConfiguration, action);
          datasourceContext.addGlobalVariable(binding, { token });
          redactedDatasourceContext.addGlobalVariable(binding, { token: '<redacted>' });
        }
        break;
      }
      case RestApiIntegrationAuthType.OAUTH2_PASSWORD: {
        if (!get(authConfig, 'useFixedPasswordCreds')) {
          break;
        }
        const binding = apiAuthBindings(authType);
        const existingContext = datasourceContext.globals[binding];
        if (!(existingContext && existingContext['token'])) {
          // If the token is not already cached.
          const token = await getOauthPasswordToken(agentCredentials, authType, authConfig, action);
          datasourceContext.addGlobalVariable(binding, { token });
          redactedDatasourceContext.addGlobalVariable(binding, { token: '<redacted>' });
        }
        break;
      }
      case RestApiIntegrationAuthType.BASIC: {
        let token = '';
        if (get(authConfig, 'shareBasicAuthCreds')) {
          const username = (datasourceConfiguration.authConfig as BasicAuthConfig).username ?? '';
          const password = (datasourceConfiguration.authConfig as BasicAuthConfig).password ?? '';
          token = makeBasicAuthToken(username, password);
        } else {
          const binding = apiAuthBindings(authType);
          const existingContext = datasourceContext.globals[binding];
          if (existingContext && existingContext['token']) {
            token = existingContext['token'];
          }
        }

        const authHeader = { key: 'Authorization', value: `Basic ${token}` };
        const redactedAuthHeader = { key: 'Authorization', value: `Basic <redacted>` };
        // Append the headers to both configs.
        (datasourceConfiguration.headers = datasourceConfiguration.headers ?? []).push(authHeader);
        (redactedDatasourceConfiguration.headers = redactedDatasourceConfiguration.headers ?? []).push(redactedAuthHeader);
        break;
      }
    }

    // For Google Sheets (OAuth2), ignore the binding eval flow and simply
    // inject the token into the datasourceConfig
    if (action.pluginId === GOOGLE_SHEETS_PLUGIN_ID) {
      if (datasourceConfiguration.authType === GoogleSheetsAuthType.OAUTH2_CODE) {
        const token: string = await getOrRefreshToken(
          agentCredentials,
          datasourceConfiguration.authType,
          datasourceConfiguration.authConfig,
          datasource
        );
        if (!token) {
          throw new IntegrationError(`Authentication failed - token not found`);
        }
        datasourceConfiguration.authConfig.authToken = token;
      }
    } else if (authType) {
      const authBinding = apiAuthBindings(authType);
      const hasBindings = datasourceContext.globals[authBinding];
      if (expectsBindings(authType, authConfig) && !hasBindings) {
        // We would have errored later on, but give a nicer error here if we
        // know auth is missing.
        throw new IntegrationError(`Authentication failed - token not found`);
      }
    }

    for (const { config, context } of [
      { config: datasourceConfiguration, context: datasourceContext },
      { config: redactedDatasourceConfiguration, context: redactedDatasourceContext }
    ]) {
      await evaluateDatasource(
        config,
        environment,
        agentCredentials,
        context,
        true /* isWorkFlow */,
        files,
        recursionContext,
        relayDelegate
      );
    }

    return { datasourceConfiguration, redactedDatasourceConfiguration };
  } catch (err) {
    throw new IntegrationError(`Evaluating datasource step "${datasource.name}" failed: ${err.message}`);
  }
};

const validateAndGetDatasourceForAction = ({
  action,
  datasources
}: {
  action: Action;
  datasources: Record<string, DatasourceDto>;
}): DatasourceDto => {
  if (!action.datasourceId) {
    throw new NotFoundError(`Datasource ID not specified for action ${action.id}.`);
  }
  const datasource = datasources[action.datasourceId];
  if (!datasource) {
    throw new NotFoundError(`Datasource ${action.datasourceId} not found for action ${action.id}`);
  }
  return datasource;
};

export function executeActionErrorContext({
  error,
  message,
  tags,
  auditLogger,
  action
}: {
  error: Error;
  message: string;
  tags: DiagnosticMetadataTags;
  auditLogger: P.Logger;
  action: Action;
}): ExecutionContext {
  forwardAgentDiagnostics(error, tags);
  const output = new ExecutionOutput();
  const errorMsg = isEmpty(message) ? error.message : `${message}: ${error.message}`;
  output.logError(errorMsg);
  auditLogger.info(errorMsg);
  const context = new ExecutionContext();
  context.addOutput(action.name, output);
  return context;
}

export enum ExecuteStatus {
  EXECUTING = 'EXECUTING',
  IDLE = 'IDLE',
  PAUSED = 'PAUSED'
}
