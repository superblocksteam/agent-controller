import { Action, ApiDetails, getAction, NotFoundError } from '@superblocksteam/shared';
import { FetchAndExecuteProps } from '@superblocksteam/shared-backend';
import { BasePlugin } from '@superblocksteam/shared-backend';
import { VersionedPluginDefinition } from '@superblocksteam/worker';
import { fetchAndExecute } from '../controllers/api';
import dependencies from '../dependencies';
import {
  SUPERBLOCKS_AGENT_EXECUTION_JS_TIMEOUT_MS,
  SUPERBLOCKS_AGENT_EXECUTION_PYTHON_TIMEOUT_MS,
  SUPERBLOCKS_AGENT_EXECUTION_REST_API_MAX_CONTENT_LENGTH_BYTES,
  SUPERBLOCKS_AGENT_EXECUTION_REST_API_TIMEOUT_MS
} from '../env';
import { getTracer } from '../utils/tracer';
import logger from './logger';
import { agentSupportsPluginVersion, SUPPORTED_PLUGIN_VERSIONS_MAP } from './plugins';

export const getChildActionNames = (action: Action, apiDef: ApiDetails): string[] => {
  try {
    return Object.entries(action.children ?? {}).map(([_, childId]) => getAction(childId, apiDef).name);
  } catch (err) {
    throw new NotFoundError(`Failed to get child action names for action ${action.id} in API ${apiDef.name}`);
  }
};

export async function loadPluginModule(vpd: VersionedPluginDefinition): Promise<BasePlugin> {
  let version: string;
  {
    try {
      if (!vpd.version || !agentSupportsPluginVersion(vpd.name, vpd.version)) {
        version = SUPPORTED_PLUGIN_VERSIONS_MAP[vpd.name].slice(-1)[0];
        logger.warn(
          `Specified plugin ID '${vpd.name}' with version '${vpd.version}' is not valid. Loading latest version '${version}' instead.`
        );
      } else {
        version = vpd.version;
      }
    } catch (err) {
      logger.error({ err }, 'could not determine plugin version');
      throw err;
    }
  }

  const key = `sb-${vpd.name}-${version}`;

  if (!(key in dependencies)) {
    throw new Error(`plugin ${key} not found`);
  }

  const plugin: BasePlugin = dependencies[key] as BasePlugin;

  // Frank: We shouldn't be doing this at runtime.
  //        We should be doing it once when the controller starts.
  //        This is what the worker does. However, this code is temporary
  //        and it's the current behavior anyways.
  plugin.attachLogger(logger.child({ plugin_name: vpd.name, plugin_version: version }));
  plugin.attachTracer(getTracer());
  plugin.configure({
    // no connection pooling happens in the agent, so this value is not used anywhere
    connectionPoolIdleTimeoutMs: 0,
    javascriptExecutionTimeoutMs: SUPERBLOCKS_AGENT_EXECUTION_JS_TIMEOUT_MS,
    pythonExecutionTimeoutMs: SUPERBLOCKS_AGENT_EXECUTION_PYTHON_TIMEOUT_MS,
    restApiExecutionTimeoutMs: SUPERBLOCKS_AGENT_EXECUTION_REST_API_TIMEOUT_MS,
    restApiMaxContentLengthBytes: SUPERBLOCKS_AGENT_EXECUTION_REST_API_MAX_CONTENT_LENGTH_BYTES,
    workflowFetchAndExecuteFunc: async (props: FetchAndExecuteProps) => {
      const { apiResponse, apiRecord } = await fetchAndExecute(props);
      if (apiRecord) {
        apiRecord.finish(apiResponse).catch(() => {
          // TODO: No error handling?
        });
      }
      return apiResponse;
    }
  });
  plugin.init();

  return plugin;
}
