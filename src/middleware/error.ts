import { ErrorDto, HttpError, IntegrationError, RbacUnauthorizedError, ResponseMeta, SuperblocksError } from '@superblocksteam/shared';
import { NextFunction, Request, Response } from 'express';
import { forwardAgentDiagnostics } from '../utils/diagnostics';
import { getDiagnosticTagsFromError } from '../utils/error';
import logger from '../utils/logger';

function getResponseMetaByError(error: Error): ResponseMeta {
  let responseMeta: ResponseMeta;
  let superblocksErrorType: SuperblocksError | undefined = undefined;
  if (error instanceof HttpError) {
    logger.warn(error);
    responseMeta = new ResponseMeta({
      status: error.status,
      message: error.message,
      success: false
    });
    if (error instanceof RbacUnauthorizedError) {
      superblocksErrorType = SuperblocksError.RbacUnauthorized;
    }
  } else if (error instanceof IntegrationError) {
    logger.info(`Integration Error: ${error}`);
    responseMeta = new ResponseMeta({
      status: 200,
      message: error.message,
      success: false
    });
  } else if (error instanceof SyntaxError) {
    logger.info(`Request body was not parseable: ${error}`);
    responseMeta = new ResponseMeta({
      status: 400,
      message: `Request body was not JSON parseable: ${error.message}`,
      success: false
    });
  } else {
    logger.error(error);
    responseMeta = new ResponseMeta({
      status: 500,
      message: 'Internal Error',
      success: false
    });
  }

  responseMeta.error = new ErrorDto({
    code: responseMeta.status,
    message: responseMeta.message,
    ...(superblocksErrorType ? { type: superblocksErrorType } : {})
  });
  return responseMeta;
}

export const errorHandler = (error: Error, request: Request, response: Response, next: NextFunction): void => {
  const responseMeta = getResponseMetaByError(error);
  response.status(responseMeta.status);
  response.send({ responseMeta });

  forwardAgentDiagnostics(error, getDiagnosticTagsFromError(error));
};
