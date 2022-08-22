import {
  AuditLogEventType,
  AuditLogEntityType,
  ApiDefinition,
  ApiExecutionResponse,
  ApiRunStatus,
  ApiTriggerType,
  isApiRunDetails,
  AuditLogDto,
  Action
} from '@superblocksteam/shared';
import P from 'pino';
import envs, { SUPERBLOCKS_AGENT_ID } from '../env';
import logger, { createLocalAuditLogger } from './logger';
import { makeAuditLogRequest, RequestMethod } from './request';
import { buildSuperblocksCloudUrl } from './url';

export class ApiRequestRecord {
  entry: AuditLogDto;
  localLogger: P.Logger;
  nameToAction: Record<string, Action>;

  async start(): Promise<void> {
    // TODO(taha) Do we need to construct the steps preemptively?
    // This doesn't mean anything and gets populated by the audit finish event later.
    // There are server-side events that rely on this being populated, in the absence
    // of which we do not sent start events for analytics but maybe that is okay
    const steps = [];
    for (const action of Object.values(this.nameToAction)) {
      steps.push({
        name: action.name,
        id: action.id,
        pluginId: action.pluginId,
        datasourceId: action.datasourceId,
        startTimeUtc: new Date()
      });
    }
    this.entry.steps = steps;
    this.entry = await makeAuditLogRequest<AuditLogDto>(RequestMethod.POST, buildSuperblocksCloudUrl(`audit`), this.entry);
  }

  async finish(res: ApiExecutionResponse): Promise<AuditLogDto> {
    try {
      return await this.constructAndSendFinishRequest(res);
    } catch (e) {
      logger.error(`Failed to send completion audit log: ${e.message}`);
    }
  }

  private constructAndSendFinishRequest(res: ApiExecutionResponse): Promise<AuditLogDto> {
    if (!this.entry) {
      logger.error(`No entry created`);
      return null;
    }
    if (!isApiRunDetails(this.entry.details)) {
      logger.error(`Start log details does not match the expected schema for an API_RUN. [details=${JSON.stringify(this.entry.details)}]`);
      return null;
    }
    let err = this.getError(res);

    const steps = [];
    for (const [stepName, executionOutput] of Object.entries(res.context.outputs)) {
      steps.push({
        name: stepName,
        id: this.nameToAction[stepName].id,
        pluginId: this.nameToAction[stepName].pluginId,
        datasourceId: this.nameToAction[stepName].datasourceId,
        error: executionOutput.error,
        startTimeUtc: executionOutput.startTimeUtc,
        executionTimeMs: executionOutput.executionTime
      });
    }
    this.entry.steps = steps;
    this.entry.details.timing = res.timing;

    if (envs.get('SUPERBLOCKS_INCLUDE_ERRORS_IN_AUDIT_LOGS') !== 'true') {
      err = '<error message redacted>';
    }
    if (err) {
      this.entry.details.status = ApiRunStatus.FAIL;
      this.entry.details.error = err;
    } else {
      this.entry.details.status = ApiRunStatus.SUCCESS;
    }
    const endTime = new Date();
    this.entry.details.endTime = endTime;
    this.entry.endTime = endTime;
    return makeAuditLogRequest<AuditLogDto>(RequestMethod.PUT, buildSuperblocksCloudUrl(`audit/${this.entry.id}`), this.entry);
  }

  private getError(res: ApiExecutionResponse): string | null {
    for (const stepName in res?.context?.outputs) {
      const step = res.context.outputs[stepName];
      if (step.error) {
        return `Error in step "${stepName}": ${step.error}`;
      }
    }

    return null;
  }

  constructor(entry: AuditLogDto, localLogger: P.Logger, apiDef: ApiDefinition) {
    this.nameToAction = {};
    for (const action of Object.values(apiDef.api.actions.actions)) {
      this.nameToAction[action.name] = action;
    }

    this.localLogger = localLogger;
    this.entry = entry;
  }
}

export class PersistentAuditLogger {
  source: string;
  localAuditLogger: P.Logger;

  makeApiLogEvent(apiDef: ApiDefinition, isDeployed: boolean): ApiRequestRecord {
    let entityType: AuditLogEntityType;
    let entityId: string;
    switch (apiDef.api.triggerType) {
      case ApiTriggerType.UI:
        entityType = AuditLogEntityType.APPLICATION;
        entityId = apiDef.api.applicationId;
        break;
      case ApiTriggerType.WORKFLOW:
        entityType = AuditLogEntityType.WORKFLOW;
        entityId = apiDef.api.id;
        break;
      case ApiTriggerType.SCHEDULE:
        entityType = AuditLogEntityType.SCHEDULED_JOB;
        entityId = apiDef.api.id;
        break;
    }
    const log: AuditLogDto = {
      entityId: entityId,
      entityType: entityType,
      organizationId: apiDef.organizationId,
      deployed: isDeployed,
      startTime: new Date(),
      endTime: null,
      source: this.source,
      type: AuditLogEventType.API_RUN,
      agentId: SUPERBLOCKS_AGENT_ID
    };
    const apiRunDetails = {
      type: AuditLogEventType.API_RUN,
      target: apiDef.api.id,
      locationContext: apiDef.locationContext
    };
    log.details = apiRunDetails;

    return new ApiRequestRecord(log, this.localAuditLogger, apiDef);
  }

  constructor(source: string) {
    this.source = source;
    this.localAuditLogger = createLocalAuditLogger({ user_email: this.source });
  }
}
