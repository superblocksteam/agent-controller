import {
  checkEnvironment,
  unmaskSecrets,
  DatasourceMetadataDto,
  DatasourceTestRequest,
  DatasourceTestResult,
  ENVIRONMENT_PRODUCTION,
  Integration,
  ResponseWrapper,
  ENVIRONMENT_STAGING,
  DeleteDatasourceOnAgentResult,
  validateDatasourceConfigurationSchema,
  ActionConfiguration
} from '@superblocksteam/shared';
import { relayDelegateFromRequest } from '@superblocksteam/shared-backend';
import express, { NextFunction, Request, Response } from 'express';
import { fetchApi } from '../../controllers/api';
import { fetchDatasource, getMetadata, preDelete, testConnection } from '../../controllers/datasource';
import { addDiagnosticTagsToError } from '../../utils/error';
import logger from '../../utils/logger';
import { agentCredsFromRequestJwt, extractAuthHeaderFromRequest } from '../../utils/request';

const router = express.Router();

router.post('/:datasourceId/metadata', async (req: Request, res: Response, next: NextFunction) => {
  const datasourceId = req.params.datasourceId;
  const environment = req.query.environment as string;
  const actionId = req.query.actionId;
  const apiId = req.query.apiId;
  try {
    let integration: Integration;
    const agentCredentials = agentCredsFromRequestJwt(req);
    const relayDelegate = relayDelegateFromRequest(req);
    try {
      integration = await fetchDatasource(datasourceId, agentCredentials, relayDelegate);
    } catch (e) {
      return next(e);
    }
    let actionConfiguration: ActionConfiguration;
    if (actionId) {
      const apiDefinition = await fetchApi({
        apiId: apiId as string,
        isPublished: false, //query metadata for unpublished apis
        environment: environment,
        agentCredentials: agentCredentials,
        isWorkflow: false
      });
      const filtered = Object.entries(apiDefinition.api.actions.actions).filter((action) => {
        return action && action.length > 1 && action[1].id === actionId;
      });
      if (filtered && filtered.length > 0 && filtered[0].length > 1) {
        actionConfiguration = filtered[0][1].configuration;
      }
    }
    const structure = await getMetadata(
      environment,
      environment === ENVIRONMENT_PRODUCTION ? integration.datasource?.configurationProd : integration.datasource?.configurationStaging,
      integration.plugin,
      agentCredentials,
      datasourceId,
      relayDelegate,
      actionConfiguration
    );
    const response = new ResponseWrapper<DatasourceMetadataDto>({ data: structure });
    res.send(response);
  } catch (err) {
    addDiagnosticTagsToError(err, { datasourceId, environment });
    next(err);
  }
});

// Deprecated. We make a POST endpoint for metadata because GET request doesn't support request body well.
router.get('/:datasourceId/metadata', async (req: Request, res: Response, next: NextFunction) => {
  const datasourceId = req.params.datasourceId;
  const environment = req.query.environment as string;
  const actionId = req.query.actionId;
  const apiId = req.query.apiId;
  try {
    const agentCredentials = agentCredsFromRequestJwt(req);

    const integration = await fetchDatasource(datasourceId, agentCredentials);

    let actionConfiguration: ActionConfiguration;
    if (actionId) {
      const apiDefinition = await fetchApi({
        apiId: apiId as string,
        isPublished: false, //query metadata for unpublished apis
        environment: environment,
        agentCredentials: agentCredentials,
        isWorkflow: false
      });
      const filtered = Object.entries(apiDefinition.api.actions.actions).filter((action) => {
        return action && action.length > 1 && action[1].id === actionId;
      });
      if (filtered && filtered.length > 0 && filtered[0].length > 1) {
        actionConfiguration = filtered[0][1].configuration;
      }
    }

    const structure = await getMetadata(
      environment,
      environment === ENVIRONMENT_PRODUCTION ? integration.datasource?.configurationProd : integration.datasource?.configurationStaging,
      integration.plugin,
      agentCredentials,
      datasourceId,
      null /* relayDelegate*/,
      actionConfiguration /* actionConfiguration */
    );
    const response = new ResponseWrapper<DatasourceMetadataDto>({ data: structure });
    res.send(response);
  } catch (err) {
    addDiagnosticTagsToError(err, { datasourceId, environment });
    next(err);
  }
});

router.post('/test', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const testReq = req.body as DatasourceTestRequest;
    const datasourceId = req.query.datasourceId as string;
    if (datasourceId) {
      // maybe existing datasource, maybe pass another query parameter, something like persisted=false
      try {
        // existing datasource
        const agentCredentials = agentCredsFromRequestJwt(req);
        const integration = await fetchDatasource(datasourceId, agentCredentials);
        if (integration.datasource.demoIntegrationId) {
          if (req.query.environment === ENVIRONMENT_PRODUCTION) {
            unmaskSecrets(testReq.datasourceConfig, integration.plugin, integration.datasource.configurationProd);
          } else if (req.query.environment === ENVIRONMENT_STAGING) {
            unmaskSecrets(testReq.datasourceConfig, integration.plugin, integration.datasource.configurationStaging);
          }
        }
      } catch {
        logger.warn(`Could not fetch datasource '${datasourceId}' from the server. Testing with available configuration.`);
      }
    }

    validateDatasourceConfigurationSchema(testReq.datasourceConfig);
    const environment = checkEnvironment(req.query.environment as string);
    const relayDelegate = relayDelegateFromRequest(req);
    const connection = await testConnection(
      environment,
      testReq.datasourceConfig,
      testReq.plugin,
      extractAuthHeaderFromRequest(req),
      relayDelegate,
      datasourceId
    );
    const response = new ResponseWrapper<DatasourceTestResult>({ data: connection });
    res.send(response);
  } catch (err) {
    next(err);
  }
});

router.delete('/:datasourceId', async (req: Request, res: Response, next: NextFunction) => {
  const datasourceId = req.params.datasourceId;
  const environment = req.query.environment as string;
  try {
    const agentCredentials = agentCredsFromRequestJwt(req);
    const integration = await fetchDatasource(datasourceId, agentCredentials);
    const deleteResult = await preDelete(
      environment,
      environment === ENVIRONMENT_PRODUCTION ? integration.datasource?.configurationProd : integration.datasource?.configurationStaging,
      integration.plugin,
      agentCredentials,
      datasourceId
    );
    const response = new ResponseWrapper<DeleteDatasourceOnAgentResult>({ data: deleteResult });
    res.send(response);
  } catch (err) {
    addDiagnosticTagsToError(err, { datasourceId, environment });
    next(err);
  }
});

export default router;
