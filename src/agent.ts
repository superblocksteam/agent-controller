import { readFileSync } from 'fs';
import { Retry, RetryableError } from '@superblocksteam/shared';
import { Fleet, Options } from '@superblocksteam/worker';
import compression from 'compression';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import expressPino from 'express-pino-logger';
import helmet from 'helmet';
import {
  default as envs,
  SUPERBLOCKS_AGENT_KEY,
  SUPERBLOCKS_AGENT_METRICS_FORWARD,
  SUPERBLOCKS_AGENT_STEP_RETRY_DURATION,
  SUPERBLOCKS_AGENT_STEP_RETRY_FACTOR,
  SUPERBLOCKS_AGENT_STEP_RETRY_JITTER,
  SUPERBLOCKS_AGENT_STEP_RETRY_LIMIT,
  SUPERBLOCKS_WORKER_ENABLE,
  SUPERBLOCKS_WORKER_PORT,
  SUPERBLOCKS_WORKER_STRICT_MATCHING,
  SUPERBLOCKS_WORKER_TLS_CA_FILE,
  SUPERBLOCKS_WORKER_TLS_CERT_FILE,
  SUPERBLOCKS_WORKER_TLS_INSECURE,
  SUPERBLOCKS_WORKER_TLS_KEY_FILE
} from './env';
import { errorHandler } from './middleware/error';
import { metrics as metricsMiddleware } from './middleware/metrics';
import { tracing as tracingMiddleware } from './middleware/tracing';
import healthRouter from './routes/meta/health';
import routerV1 from './routes/v1';
import logger from './utils/logger';
import { prom, sendMetrics, superblocksRegistry } from './utils/metrics';
import { SUPPORTED_PLUGIN_VERSIONS_MAP } from './utils/plugins';
import { registerWithSuperblocksCloud } from './utils/registration';
import { makeRequest, RequestMethod } from './utils/request';
import { metrics, ping, scheduledJobsRunner, startSchedules } from './utils/schedule';
import { default as tracer, getTracer } from './utils/tracer';
import { buildSuperblocksCloudUrl } from './utils/url';

dotenv.config();

if (SUPERBLOCKS_WORKER_ENABLE) {
  // worker
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const fleetOptions: Options = {
    port: Number(SUPERBLOCKS_WORKER_PORT),
    token: SUPERBLOCKS_AGENT_KEY,
    backoff: {
      duration: SUPERBLOCKS_AGENT_STEP_RETRY_DURATION,
      factor: SUPERBLOCKS_AGENT_STEP_RETRY_FACTOR,
      jitter: SUPERBLOCKS_AGENT_STEP_RETRY_JITTER,
      limit: SUPERBLOCKS_AGENT_STEP_RETRY_LIMIT
    },
    lazyMatching: !SUPERBLOCKS_WORKER_STRICT_MATCHING,
    promRegistry: superblocksRegistry,
    tracer: getTracer
  };

  if (!SUPERBLOCKS_WORKER_TLS_INSECURE) {
    try {
      fleetOptions.tls = {
        ca: readFileSync(SUPERBLOCKS_WORKER_TLS_CA_FILE).toString(),
        cert: readFileSync(SUPERBLOCKS_WORKER_TLS_CERT_FILE).toString(),
        key: readFileSync(SUPERBLOCKS_WORKER_TLS_KEY_FILE).toString()
      };
    } catch (err) {
      logger.error({ err }, 'error loading tls assets');
      process.exit(1);
    }
  } else {
    fleetOptions.tls = {
      insecure: true
    };
  }

  // Inititalize Fleet Singleton.
  Fleet.instance(logger, fleetOptions);
}

const app = express();
app.use(helmet());

app.use(tracingMiddleware(), metricsMiddleware(superblocksRegistry));

// Allow cross-origin requests to the agent with the Authorization header
// Ref: https://expressjs.com/en/resources/middleware/cors.html#configuration-options
app.use(
  cors({
    origin: true, // Setting origin to true reflects the request origin in allow origin response header
    optionsSuccessStatus: 200, // Some legacy browsers (IE11, various SmartTVs) choke on the default 204
    credentials: true, // Credentials are cookies, Authorization headers or TLS client certificates
    methods: ['GET', 'OPTIONS', 'POST', 'DELETE']
  })
);

// Logging
if (envs.get('SUPERBLOCKS_AGENT_LOG_DISABLE_EXPRESS') !== 'true') {
  app.use(expressPino({ logger }));
}
logger.debug('Debug logging enabled');

// Request
// sending large params for api/execute endpoint may result in
// parse errors if json size > 50mb. Default limit is 10mb
app.use(express.json({ limit: envs.get('SUPERBLOCKS_AGENT_JSON_PARSE_LIMIT') }));
// Parse URL-encoded bodies using qs library
app.use(express.urlencoded({ extended: true }));

// Compression (disable if gzip is enabled in reverse proxy already)
if (envs.get('SUPERBLOCKS_AGENT_COMPRESSION_DISABLE') !== 'true') {
  app.use(compression());
}

// Configure prometheus metrics middleware
app.use(prom);

// Routes
// Health check routes for platform use (for eg, docker or k8s healthcheck)
app.use('/', healthRouter);
// Routes for Superblocks application use
app.use('/agent/v1', routerV1);

const port = envs.get('SUPERBLOCKS_AGENT_PORT');
const server = app.listen(Number(port), '0.0.0.0', async () => {
  logger.info(`Your Superblocks agent is live and listening on port ${port}.`);

  logger.debug(`This agent supports the following Superblocks plugins: ${JSON.stringify(SUPPORTED_PLUGIN_VERSIONS_MAP)}`);

  // Agent self-registration
  await registerWithSuperblocksCloud();
  startSchedules();
});

const signalHandler = async (signal: string): Promise<void> => {
  const _logger = logger.child({ who: 'signal handler', signal });
  _logger.info('received signal');

  if (SUPERBLOCKS_AGENT_METRICS_FORWARD) {
    // stop sending metrics to the server
    metrics.stop();
    // send final batch of metrics to the server
    await sendMetrics();
  }

  _logger.info(
    {
      component: 'job scheduler'
    },
    'initiating shutdown'
  );
  const jobShutdown = scheduledJobsRunner.join();
  scheduledJobsRunner.stop();

  _logger.info(
    {
      component: 'http server'
    },
    'initiating shutdown'
  );
  const serverShutdown = new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));

  try {
    const logger = _logger.child({ component: 'http server' });
    await serverShutdown;
    logger.info('shutdown successful');
  } catch (err) {
    logger.error({ err }, 'shutdown failed');
  }

  await jobShutdown;
  _logger.info(
    {
      component: 'job scheduler'
    },
    'shutdown successful'
  );

  // Stop sending heartbeats to the server after the job scheduler
  // and http server have been shutdown. If we do it before, and the
  // inflight APIs/jobs take more than a certain amount of time to finish,
  // the server will mark the controller as deactivated which is
  // undesirable.
  ping.stop();

  // deregister this agent after all scheduled jobs have finished and the http server connections
  // have been closed.
  try {
    await new Retry<void>({
      backoff: {
        duration: 1000,
        factor: 2,
        jitter: 0.5,
        limit: 5
      },
      logger: logger.child({ who: 'deregister' }),
      func: async (): Promise<void> => {
        try {
          await makeRequest<Response>({
            method: RequestMethod.DELETE,
            url: buildSuperblocksCloudUrl()
          });
        } catch (err) {
          // TODO(frank): fail fast on certain errors (i.e. could not authorize agent)
          throw new RetryableError(err.message);
        }
      }
    }).do();
  } catch (err) {
    logger.error({ err }, 'could not deregister controller');
  }

  try {
    const logger = _logger.child({ component: 'tracer' });
    await await tracer.shutdown();
    logger.info('shutdown successful');
  } catch (err) {
    logger.error({ err }, 'shutdown failed');
  }

  process.exit(0);
};

// The error handler must be before any other error middleware and after all controllers
app.use(errorHandler);

// This signal will be a local workstation when ctrl^C is pressed.
// kill -2 <pid>
process.on('SIGINT', signalHandler);

// This signal will be sent by Kubernetes when the pod is deleted.
// kill -15 <pid>
process.on('SIGTERM', signalHandler);

// This signal will be sent by Nodemon when it restarts the process.
// kill -31 <pid>
process.on('SIGUSR2', signalHandler);

process.on('uncaughtException', (err, next) => {
  logger.error(`Uncaught error found. ${err}\n${err.stack}`);
  return;
});

export default app;
