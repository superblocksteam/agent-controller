import { Metrics, AgentStatus } from '@superblocksteam/shared';
import { Response } from 'express';
import promBundle from 'express-prom-bundle';
import { Counter, Registry } from 'prom-client';
import * as si from 'systeminformation';
import { SUPERBLOCKS_AGENT_ID, SUPERBLOCKS_AGENT_VERSION, SUPERBLOCKS_AGENT_VERSION_EXTERNAL } from '../env';
import logger from './logger';
import { makeRequest, RequestMethod } from './request';
import { buildSuperblocksCloudUrl } from './url';

type ExecCounter = Counter<'status'>;

export enum ApiStatus {
  SUCCESS = 'success',
  FAILURE = 'failure'
}

enum RequestPath {
  EXECUTE_API = '/agent/v1/apis/execute',
  EXECUTE_WORKFLOW = '/agent/v1/workflows/#val'
}

const RequestDurationPercentile = {
  p50: 0.5,
  p75: 0.75,
  p90: 0.9,
  p95: 0.95,
  p99: 0.99
};

const durationPercentiles = Object.values(RequestDurationPercentile);

// Custom Metrics Registry
export const superblocksRegistry = new Registry();
superblocksRegistry.setDefaultLabels({
  // Treat version_external as the version tag for all metrics exposed
  // directly in the agent, as that is the version OPA users are
  // familiar with
  superblocks_agent_version: SUPERBLOCKS_AGENT_VERSION_EXTERNAL,
  superblocks_agent_id: SUPERBLOCKS_AGENT_ID
});

// Instrument Metrics
export const apiCount: ExecCounter = new Counter({
  name: 'superblocks_agent_api_executions_total',
  help: 'Count of Superblocks API/Workflow executions triggered from Superblocks UI.',
  labelNames: ['status'] as const,
  registers: [superblocksRegistry]
});

export const workflowCount: ExecCounter = new Counter({
  name: 'superblocks_agent_workflow_executions_total',
  help: 'Count of Superblocks Workflow executions triggered using the public endpoint.',
  labelNames: ['status'] as const,
  registers: [superblocksRegistry]
});

// Metrics helper functions
export const incrementCount = (counter: ExecCounter, status: ApiStatus): void => {
  counter.inc({ status: status });
};

const getCount = (counter: ExecCounter, status: ApiStatus): number => {
  return counter?.['hashMap']?.[`status:${status}`]?.['value'] ?? 0;
};

const getPercentileDuration = (path: RequestPath, percentile: number): number => {
  const requestDuration = superblocksRegistry.getSingleMetric('superblocks_agent_http_request_duration_seconds');
  return requestDuration?.['hashMap']?.[`path:${path}`]?.td?.ringBuffer?.[0]?.percentile(percentile) ?? 0;
};

const resetMetrics = (): void => {
  superblocksRegistry.resetMetrics();
};

// Metrics middleware
export const prom = promBundle({
  httpDurationMetricName: 'superblocks_agent_http_request_duration_seconds',
  metricType: 'summary',
  ageBuckets: 1, // Creates only one bucket that contains the active sliding window
  percentiles: durationPercentiles,
  includeMethod: false,
  includePath: true,
  includeStatusCode: false,
  metricsPath: '/metrics',
  promClient: {
    collectDefaultMetrics: {
      register: superblocksRegistry,
      prefix: 'superblocks_agent_'
    }
  },
  promRegistry: superblocksRegistry
});

const deployedAt = new Date();

export const sendMetrics = async (desiredState: AgentStatus): Promise<void> => {
  const _logger = logger.child({ who: 'heartbeat', desiredState });

  const reportedAt = new Date();
  try {
    const metrics: Metrics = {
      cpu: await si.currentLoad(),
      memory: await si.mem(),
      disk: await si.fsSize(),
      io: await si.networkStats(),
      uptime: process.uptime(),
      reported_at: reportedAt,
      deployed_at: deployedAt,
      version: SUPERBLOCKS_AGENT_VERSION,
      version_external: SUPERBLOCKS_AGENT_VERSION_EXTERNAL,
      apiSuccessCount: getCount(apiCount, ApiStatus.SUCCESS),
      apiFailureCount: getCount(apiCount, ApiStatus.FAILURE),
      workflowSuccessCount: getCount(workflowCount, ApiStatus.SUCCESS),
      workflowFailureCount: getCount(workflowCount, ApiStatus.FAILURE),
      apiP90DurationSeconds: getPercentileDuration(RequestPath.EXECUTE_API, RequestDurationPercentile.p90),
      workflowP90DurationSeconds: getPercentileDuration(RequestPath.EXECUTE_WORKFLOW, RequestDurationPercentile.p90),
      desiredState
    };

    // Reset the Prometheus metrics
    resetMetrics();

    _logger.trace(`Sending the following health metrics to Superblocks Cloud: ${JSON.stringify(metrics)}`);
    await makeRequest<Response>({
      method: RequestMethod.POST,
      url: buildSuperblocksCloudUrl(`healthcheck`),
      payload: metrics
    });
    _logger.debug(`Successfully sent health metrics to Superblocks Cloud at ${metrics.reported_at}.`);
  } catch (e) {
    _logger.error(`Failed to send health metrics to Superblocks Cloud at ${reportedAt}. ${e.stack}`);
  }
};
