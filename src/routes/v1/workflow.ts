import {
  checkEnvironment,
  ENVIRONMENT_PRODUCTION,
  ResponseWrapper,
  CORRELATION_ID,
  SUPERBLOCKS_REQUEST_ID_HEADER
} from '@superblocksteam/shared';
import { AgentCredentials, formatExecutionOutput, relayDelegateFromRequest } from '@superblocksteam/shared-backend';
import express, { NextFunction, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { executeApiFunc, fetchApi } from '../../controllers/api';
import { findFirstApiExecutionError } from '../../utils/api';
import { PersistentAuditLogger } from '../../utils/audit';
import { ApiStatus, incrementCount, workflowCount } from '../../utils/metrics';
import { extractAuthHeaderFromRequest } from '../../utils/request';
import { activateKeepAliveProbes } from '../../utils/socket';
import { getParamsFromRequest } from '../../utils/workflow';

const router = express.Router();

// Fetch the specified Workflow definition from Superblocks Cloud, and execute it
router.post('/:apiId', (req: Request, res: Response, next: NextFunction) => {
  (async () => {
    const requestStart = Date.now();
    // TODO: EG-1034, remove this defaulting after we upgrade all the customers
    let isSuccessful = false;
    try {
      activateKeepAliveProbes(res);
      const environment = checkEnvironment((req.query.environment as string) ?? ENVIRONMENT_PRODUCTION);
      const isTesting = req.query.test ? req.query.test === 'true' : false;
      const params = getParamsFromRequest(req);
      const apiRequest = { apiId: req.params.apiId, params, viewMode: !isTesting };

      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
      const source = ip.toString();
      const pLogger = new PersistentAuditLogger(source);

      const apiKey = extractAuthHeaderFromRequest(req, true);
      const agentCredentials = new AgentCredentials({ apiKey: apiKey });
      const relayDelegate = relayDelegateFromRequest(req);
      const fetchStart = Date.now();
      const apiDef = await fetchApi({
        apiId: apiRequest.apiId,
        isPublished: apiRequest.viewMode,
        environment,
        agentCredentials,
        isWorkflow: true,
        relayDelegate
      });
      const fetchEnd = Date.now();

      // This is set so we can add the proper metrics label.
      // In the future, we'll have this value in a JWT.
      res.locals.org_id = apiDef.organizationId;
      res.locals.org_name = apiDef.metadata?.organizationName;

      const props = {
        metadata: {
          correlationId: req.header(SUPERBLOCKS_REQUEST_ID_HEADER) || uuidv4()
        },
        environment,
        apiDef,
        executionParams: params,
        files: undefined,
        isPublished: apiRequest.viewMode,
        recursionContext: {
          isEvaluatingDatasource: false,
          executedWorkflowsPath: [{ name: apiDef.api.actions.name, id: apiDef.api.id }]
        },
        auditLogger: pLogger,
        relayDelegate
      };

      const executeStart = Date.now();
      const { apiResponse, apiRecord } = await executeApiFunc(props);
      const executeEnd = Date.now();

      res.header(CORRELATION_ID, props.metadata.correlationId);

      const response = new ResponseWrapper({ data: formatExecutionOutput(apiResponse) });
      const err = findFirstApiExecutionError(apiResponse);
      if (err === null) {
        // used by metrics reporting
        isSuccessful = true;
      } else {
        response.responseMeta.success = false;
        response.responseMeta.status = 500;
        response.responseMeta.message = err;
      }

      const requestEnd = Date.now();
      // Create or add to the timing metadata
      apiResponse.timing = {
        ...(apiResponse.timing ?? {}),
        fetchStart,
        fetchEnd,
        fetchDurationMs: fetchEnd - fetchStart,
        executeStart,
        executeEnd,
        executeDurationMs: executeEnd - executeStart,
        requestStart,
        requestEnd,
        requestDurationMs: requestEnd - requestStart
      };
      apiRecord.finish(apiResponse).catch(() => {
        // TODO: No error handling?
      });

      response.responseMeta.timing = apiResponse.timing;
      res.send(response);
    } catch (err) {
      next(err);
    } finally {
      if (isSuccessful) {
        incrementCount(workflowCount, ApiStatus.SUCCESS);
      } else {
        incrementCount(workflowCount, ApiStatus.FAILURE);
      }
    }
  })();
});

export default router;
