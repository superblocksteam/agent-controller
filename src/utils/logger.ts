import { AuditLogMetadata, EnvStore } from '@superblocksteam/shared';
import { RemoteLogger } from '@superblocksteam/shared-backend';
import formats from 'dd-trace/ext/formats';
import dotenv from 'dotenv';
import { default as P, default as pino } from 'pino';
import pinoCaller from 'pino-caller';
import { createWriteStream } from 'pino-http-send';
import { SUPERBLOCKS_REMOTE_LOGGER_ENABLED } from '../env';
import { setAgentHeaders } from './headers';
import tracer from './tracer';
import { buildSuperblocksCloudUrl } from './url';
dotenv.config();

const loggerEnvs = new EnvStore(process.env);

loggerEnvs.addAll([
  {
    name: 'SUPERBLOCKS_AGENT_LOG_LEVEL',
    defaultValue: 'info'
  },
  {
    name: 'SUPERBLOCKS_AGENT_LOG_DISABLE_PRETTY',
    defaultValue: 'true'
  },
  {
    name: 'SUPERBLOCKS_AGENT_LOG_HTTP_DISABLE',
    defaultValue: 'false'
  },
  {
    name: '__SUPERBLOCKS_AGENT_LOG_BATCH_SIZE',
    defaultValue: '10'
  },
  {
    name: '__SUPERBLOCKS_AGENT_LOG_RETRIES',
    defaultValue: '5'
  },
  {
    name: '__SUPERBLOCKS_AGENT_LOG_INTERVAL_MS',
    defaultValue: '5000'
  },
  {
    name: '__SUPERBLOCKS_AGENT_LOG_TIMEOUT_MS',
    defaultValue: '5000'
  }
]);

const pinoConfig: P.LoggerOptions = {
  // We want to ensure that no logs created with this logger
  // are send to customers. To enable this, we're removing the
  // field that is used to determine this in our logging pipeline.
  redact: [RemoteLogger.EligibleField],
  level: loggerEnvs.get('SUPERBLOCKS_AGENT_LOG_LEVEL'),
  formatters: {
    level(level) {
      return { level };
    }
  },
  mixin() {
    const span = tracer.scope().active();
    const time = new Date().toISOString();
    if (!span) {
      return {};
    }
    const record = { time };
    tracer.inject(span.context(), formats.LOG, record);
    return record;
  },
  prettyPrint: loggerEnvs.get('SUPERBLOCKS_AGENT_LOG_DISABLE_PRETTY') === 'true' ? null : { colorize: true }
};

const logger = pinoCaller(pino(pinoConfig));

export const createLocalAuditLogger = (auditLogMetadata: AuditLogMetadata): P.Logger => {
  return logger.child(auditLogMetadata);
};

let stream;

if (loggerEnvs.get('SUPERBLOCKS_AGENT_LOG_HTTP_DISABLE') === 'false') {
  const httpStreamConfig = {
    url: buildSuperblocksCloudUrl('logs'),
    headers: setAgentHeaders(),
    batchSize: parseInt(loggerEnvs.get('__SUPERBLOCKS_AGENT_LOG_BATCH_SIZE')),
    retries: parseInt(loggerEnvs.get('__SUPERBLOCKS_AGENT_LOG_RETRIES')),
    interval: parseInt(loggerEnvs.get('__SUPERBLOCKS_AGENT_LOG_INTERVAL_MS')),
    timeout: parseInt(loggerEnvs.get('__SUPERBLOCKS_AGENT_LOG_TIMEOUT_MS'))
  };
  stream = createWriteStream(httpStreamConfig);
}

export const remoteLogger = new RemoteLogger({ enabled: SUPERBLOCKS_REMOTE_LOGGER_ENABLED, stream: stream });

export default logger;
