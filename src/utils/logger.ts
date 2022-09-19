import { context } from '@opentelemetry/api';
import { AuditLogMetadata, EnvStore, buildSuperblocksDomainURL } from '@superblocksteam/shared';
import { RemoteLogger, otelSpanContextToDataDog } from '@superblocksteam/shared-backend';
import dotenv from 'dotenv';
import { default as P, default as pino } from 'pino';
import pinoCaller from 'pino-caller';
import { createWriteStream } from 'pino-http-send';
import { SUPERBLOCKS_AGENT_DOMAIN } from '../env';
import { setAgentHeaders } from './headers';
dotenv.config();

const loggerEnvs = new EnvStore(process.env);

loggerEnvs.addAll([
  {
    name: '__SUPERBLOCKS_AGENT_INTAKE_LOGS_ENABLE',
    defaultValue: 'true'
  },
  {
    name: '__SUPERBLOCKS_AGENT_INTAKE_LOGS_SCHEME',
    defaultValue: 'https'
  },
  {
    name: '__SUPERBLOCKS_AGENT_INTAKE_LOGS_HOST',
    defaultValue: ''
  },
  {
    name: '__SUPERBLOCKS_AGENT_INTAKE_LOGS_PORT',
    defaultValue: '443'
  },
  {
    name: '__SUPERBLOCKS_AGENT_INTAKE_LOGS_PATH',
    defaultValue: ''
  },
  {
    name: 'SUPERBLOCKS_AGENT_LOG_LEVEL',
    defaultValue: 'info'
  },
  {
    name: 'SUPERBLOCKS_AGENT_LOG_DISABLE_PRETTY',
    defaultValue: 'true'
  },
  {
    name: '__SUPERBLOCKS_AGENT_LOG_BATCH_SIZE',
    defaultValue: '100'
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
    // https://docs.datadoghq.com/tracing/other_telemetry/connect_logs_and_traces/opentelemetry/?tab=nodejs
    return otelSpanContextToDataDog(context.active());
  },
  prettyPrint: loggerEnvs.get('SUPERBLOCKS_AGENT_LOG_DISABLE_PRETTY') === 'true' ? null : { colorize: true }
};

const logger = pinoCaller(pino(pinoConfig));

export const createLocalAuditLogger = (auditLogMetadata: AuditLogMetadata): P.Logger => {
  return logger.child(auditLogMetadata);
};

let stream;

if (loggerEnvs.get('__SUPERBLOCKS_AGENT_INTAKE_LOGS_ENABLE') === 'true') {
  const httpStreamConfig = {
    url: buildSuperblocksDomainURL({
      domain: SUPERBLOCKS_AGENT_DOMAIN,
      subdomain: 'logs.intake',
      scheme: loggerEnvs.get('__SUPERBLOCKS_AGENT_INTAKE_LOGS_SCHEME'),
      port: loggerEnvs.get('__SUPERBLOCKS_AGENT_INTAKE_LOGS_PORT'),
      path: loggerEnvs.get('__SUPERBLOCKS_AGENT_INTAKE_LOGS_PATH'),
      hostOverride: loggerEnvs.get('__SUPERBLOCKS_AGENT_INTAKE_LOGS_HOST')
    }),
    headers: setAgentHeaders(),
    batchSize: parseInt(loggerEnvs.get('__SUPERBLOCKS_AGENT_LOG_BATCH_SIZE')),
    retries: parseInt(loggerEnvs.get('__SUPERBLOCKS_AGENT_LOG_RETRIES')),
    interval: parseInt(loggerEnvs.get('__SUPERBLOCKS_AGENT_LOG_INTERVAL_MS')),
    timeout: parseInt(loggerEnvs.get('__SUPERBLOCKS_AGENT_LOG_TIMEOUT_MS'))
  };
  stream = createWriteStream(httpStreamConfig);
}

export const remoteLogger = new RemoteLogger({
  enabled: loggerEnvs.get('__SUPERBLOCKS_AGENT_INTAKE_LOGS_ENABLE') === 'true',
  stream: stream
});

export default logger;
