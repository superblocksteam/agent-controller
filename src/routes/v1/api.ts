import os from 'os';
import {
  ApiExecutionRequest,
  ApiExecutionResponse,
  checkEnvironment,
  ResponseWrapper,
  CORRELATION_ID,
  SUPERBLOCKS_REQUEST_ID_HEADER
} from '@superblocksteam/shared';
import { relayDelegateFromRequest, sanitizeAgentKey } from '@superblocksteam/shared-backend';
import express, { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import autoReap from 'multer-autoreap';
import { v4 as uuidv4 } from 'uuid';
import { fetchAndExecute } from '../../controllers/api';
import { SUPERBLOCKS_AGENT_KEY } from '../../env';
import { findFirstApiExecutionError } from '../../utils/api';
import { apiCount, ApiStatus, incrementCount } from '../../utils/metrics';
import { agentCredsFromRequestJwt } from '../../utils/request';
import { activateKeepAliveProbes } from '../../utils/socket';

const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: `${os.tmpdir()}/${sanitizeAgentKey(SUPERBLOCKS_AGENT_KEY)}`,
    filename: (req, file, cb) => {
      cb(null, `${file.originalname}_${sanitizeAgentKey(SUPERBLOCKS_AGENT_KEY)}`);
    }
  })
});

// Fetch the given API definition from Superblocks Cloud and execute it
router.post('/execute', upload.array('files'), autoReap, async (req: Request, res: Response, next: NextFunction) => {
  const requestStart = Date.now();
  activateKeepAliveProbes(res);
  let isSuccessful = false;
  try {
    const environment = checkEnvironment(req.query.environment as string);
    const body = req.files ? JSON.parse(req.body.body) : req.body;
    const apiRequest = body as ApiExecutionRequest;
    apiRequest.cookies = req.cookies;

    const agentCredentials = agentCredsFromRequestJwt(req);
    const relayDelegate = relayDelegateFromRequest(req);
    const recursionContext = {
      isEvaluatingDatasource: false,
      executedWorkflowsPath: []
    };

    const props = {
      metadata: {
        correlationId: req.header(SUPERBLOCKS_REQUEST_ID_HEADER) || uuidv4()
      },
      apiId: apiRequest.apiId,
      isPublished: apiRequest.viewMode,
      environment,
      executionParams: apiRequest.params,
      agentCredentials,
      files: req.files,
      cookies: apiRequest.cookies,
      recursionContext,
      isWorkflow: false,
      relayDelegate
    };

    const fetchAndExecuteStart = Date.now();
    const { apiResponse, apiRecord, orgID } = await fetchAndExecute(props);
    const fetchAndExecuteEnd = Date.now();

    // This is set so we can add the proper metrics label.
    // In the future, we'll have this value in a JWT.
    res.locals.org_id = orgID;

    res.header(CORRELATION_ID, props.metadata.correlationId);

    const response = new ResponseWrapper<ApiExecutionResponse>({ data: apiResponse });
    const err = findFirstApiExecutionError(apiResponse);

    if (err === null) {
      isSuccessful = true; // used to send metrics
    } else {
      response.responseMeta.success = false;
      response.responseMeta.status = 500;
      response.responseMeta.message = err;
    }

    const requestEnd = Date.now();
    // Create or add to the timing metadata
    apiResponse.timing = {
      ...(apiResponse.timing ?? {}),
      fetchAndExecuteStart,
      fetchAndExecuteEnd,
      fetchAndExecuteDurationMs: fetchAndExecuteEnd - fetchAndExecuteStart,
      requestStart,
      requestEnd,
      requestDurationMs: requestEnd - requestStart
    };
    if (apiRecord) apiRecord.finish(apiResponse);

    res.send(response);
  } catch (err) {
    next(err);
  } finally {
    if (isSuccessful) {
      incrementCount(apiCount, ApiStatus.SUCCESS);
    } else {
      incrementCount(apiCount, ApiStatus.FAILURE);
    }
  }
});

export default router;
