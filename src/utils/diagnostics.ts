import {
  AgentMessageType,
  BadRequestError,
  DiagnosticMetadataTags,
  DiagnosticType,
  HttpError,
  IntegrationError,
  InternalServerError,
  NotFoundError,
  UnauthorizedError
} from '@superblocksteam/shared';
import { makeDiagnosticLogRequest } from './request';

export const forwardAgentDiagnostics = (err: Error, tags: DiagnosticMetadataTags = {}): void => {
  const type = DiagnosticType.AGENT;
  if (err instanceof IntegrationError || err instanceof BadRequestError) {
    makeDiagnosticLogRequest({ ...tags, type, messageType: AgentMessageType.INTEGRATION_ERROR, message: err.message });
  } else if (err instanceof InternalServerError || err instanceof NotFoundError || err instanceof HttpError) {
    makeDiagnosticLogRequest({ ...tags, type, messageType: AgentMessageType.INTERNAL_ERROR, message: err.message });
  } else if (err instanceof UnauthorizedError) {
    makeDiagnosticLogRequest({ ...tags, type, messageType: AgentMessageType.UNAUTHORIZED_ERROR, message: err.message });
  } else {
    makeDiagnosticLogRequest({
      ...tags,
      type,
      messageType: AgentMessageType.INTERNAL_ERROR,
      message: err.message ?? JSON.stringify(err)
    });
  }
};
