import { EnvStore } from '@superblocksteam/shared';
import tracer from 'dd-trace';
import dotenv from 'dotenv';
dotenv.config();

const datadogEnvs = new EnvStore(process.env);

datadogEnvs.addAll([
  {
    name: 'SUPERBLOCKS_AGENT_DATADOG_DISABLE_TRACER',
    defaultValue: 'true'
  },
  {
    name: 'SUPERBLOCKS_AGENT_DATADOG_DISABLE_LOG_INJECTION',
    defaultValue: 'true'
  }
]);

if (datadogEnvs.get('SUPERBLOCKS_AGENT_DATADOG_DISABLE_TRACER') !== 'true') {
  tracer.init({
    logInjection: datadogEnvs.get('SUPERBLOCKS_AGENT_DATADOG_DISABLE_LOG_INJECTION') !== 'true'
  });
}

export const addDdogTags = (tags: Record<string, string>): void => {
  const span = tracer.scope().active();
  if (span !== null) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spanContext = span.context() as any;
    // since ddog doesn't provide root span api :'(
    const rootSpan = spanContext._trace.started[0];
    for (const [key, value] of Object.entries(tags)) {
      rootSpan.setTag(key, value);
    }
  }
};

export default tracer;
