import { schedule } from 'node-cron';
import { JobScheduler } from '../controllers/scheduled_jobs';
import envs, { SUPERBLOCKS_AGENT_METRICS_FORWARD } from '../env';
import logger from './logger';
import { sendMetrics } from './metrics';
import { makeRequest, RequestMethod } from './request';
import { buildSuperblocksCloudUrl } from './url';

// send heartbeats to the server every minute
export const ping = schedule(
  '* * * * *',
  () =>
    makeRequest<Response>({
      method: RequestMethod.GET,
      url: buildSuperblocksCloudUrl('ping')
    }),
  { scheduled: false }
);

// send metrics to the server every minute
export const metrics = schedule('* * * * *', () => sendMetrics(), { scheduled: false });

export const scheduledJobsRunner = new JobScheduler({
  polling: {
    enabled: envs.get('SUPERBLOCKS_AGENT_ENABLE_SCHEDULE_POLLING'),
    frequency: envs.get('SUPERBLOCKS_AGENT_POLLING_FREQUENCY'),
    maxJitterMs: 5000
  },
  scheduled: false,
  logger
});

export const startSchedules = (): void => {
  ping.start();
  scheduledJobsRunner.start();

  if (SUPERBLOCKS_AGENT_METRICS_FORWARD) {
    metrics.start();
  }
};
