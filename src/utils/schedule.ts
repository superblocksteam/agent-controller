import { AgentStatus } from '@superblocksteam/shared';
import { schedule } from 'node-cron';
import { JobScheduler } from '../controllers/scheduled_jobs';
import envs from '../env';
import logger from './logger';
import { sendMetrics } from './metrics';

// Send agent metrics to Superblocks Cloud every minute
export const heartbeatSender = schedule(
  '* * * * *',
  () => {
    sendMetrics(AgentStatus.ACTIVE);
  },
  { scheduled: false }
);

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
  heartbeatSender.start();
  scheduledJobsRunner.start();
};
