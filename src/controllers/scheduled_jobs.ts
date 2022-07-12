import { ApiDefinition, ApiExecutionResponse, ENVIRONMENT_PRODUCTION } from '@superblocksteam/shared';
import { schedule, ScheduledTask } from 'node-cron';
import { PersistentAuditLogger } from '../utils/audit';
import { forwardAgentDiagnostics } from '../utils/diagnostics';
import { setAgentHeaders } from '../utils/headers';
import logger from '../utils/logger';
import { makeRequest, RequestMethod } from '../utils/request';
import { buildSuperblocksCloudUrl } from '../utils/url';
import { executeApiFunc } from './api';

export class JobScheduler {
  private _task: ScheduledTask;
  private _alive: boolean;
  private _numRunning: number;

  constructor(options: {
    polling: {
      enabled: string;
      frequency: string;
      maxJitterMs: number;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: any;
    scheduled: boolean;
  }) {
    if (options.polling.enabled !== 'true') {
      return;
    }

    if (options.scheduled) {
      this._alive = true;
    }
    this._numRunning = 0;

    this._task = schedule(
      options.polling.frequency,
      async () => {
        try {
          this._numRunning++;
          const jitter = Math.floor(Math.random() * options.polling.maxJitterMs);
          await new Promise((r) => setTimeout(r, jitter));
          await pollScheduledJobs();
        } catch (err) {
          options.logger.error(`Failed to poll schedules: ${err}`);
        } finally {
          this._numRunning--;
        }
      },
      { scheduled: options.scheduled }
    );
  }

  start(): void {
    this._alive = true;
    this._task?.start();
  }

  stop(): void {
    this._alive = false;
    this._task?.stop();
  }

  // NOTE(Frank): I haven't figured out how to do this in Node.js
  //              But if these were Java, Go, C, etc. I would have
  //              used a conditional variable. This function would
  //              simply wait for a single which would be released
  //              by the scheduler when the last job is done. This
  //              busy loop is generally a bad practice. I try to
  //              mitigate it by only checking every second and
  //              only starting it when .join() is called.
  //
  // UPDATE(FRANK): Use the new Retry paradigm here.
  join(): Promise<void> {
    return new Promise((resolve) => {
      // every second...
      schedule('* * * * * *', () => {
        if (!this._alive && this._numRunning == 0) {
          resolve();
        }
      });
    });
  }
}

export const pollScheduledJobs = async (): Promise<ApiExecutionResponse[]> => {
  // TODO(pbardea): Return API IDs.
  // TODO(pbardea): Paginate.
  const apiDefs: ApiDefinition[] = await makeRequest<ApiDefinition[]>({
    method: RequestMethod.POST,
    url: buildSuperblocksCloudUrl(`pending-jobs`),
    headers: setAgentHeaders()
  });

  logger.info(`Successfully fetched ${apiDefs.length} scheduled jobs. ${apiDefs.map((apiDef) => apiDef.api?.id)}`);

  if (!apiDefs.length) {
    return [];
  }

  const source = 'Schedule';
  const pLogger = new PersistentAuditLogger(source);
  try {
    const startTime = Date.now();
    let success = 0;
    let failure = 0;
    const allJobs = await Promise.all(
      apiDefs.map(async (apiDef) => {
        try {
          const result = await executeApiFunc({
            environment: ENVIRONMENT_PRODUCTION,
            apiDef,
            isPublished: true,
            recursionContext: { isEvaluatingDatasource: false, executedWorkflowsPath: [] },
            auditLogger: pLogger
          });
          success++;
          return result;
        } catch (e) {
          failure++;
          logger.error(`Failed to execute scheduled job ${apiDef.api?.id}. ${e}\n${e.stack}`);
        }
      })
    );
    logger.info(
      `Processed ${apiDefs.length} scheduled jobs in ${
        Date.now() - startTime
      } ms. ${success} scheduled jobs succeeded. ${failure} scheduled jobs failed.`
    );
    return allJobs;
  } catch (e) {
    pLogger.localAuditLogger.error(`Error while executing schedule: ${e.message}`);
    forwardAgentDiagnostics(e);
  }
};
