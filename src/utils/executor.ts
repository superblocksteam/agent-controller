import { Action, ApiDetails, getAction, InternalServerError, NotFoundError, SemVer } from '@superblocksteam/shared';
import { BasePlugin, PluginConfiguration } from '@superblocksteam/shared-backend';
import { fetchAndExecute } from '../controllers/api';
import {
  SUPERBLOCKS_AGENT_EXECUTION_JS_TIMEOUT_MS,
  SUPERBLOCKS_AGENT_EXECUTION_PYTHON_TIMEOUT_MS,
  SUPERBLOCKS_AGENT_EXECUTION_REST_API_TIMEOUT_MS
} from '../env';
import logger from './logger';
import { getAliasedPackageName, SUPPORTED_PLUGIN_VERSIONS_MAP, agentSupportsPlugin, agentSupportsPluginVersion } from './plugins';

export const getChildActionNames = (action: Action, apiDef: ApiDetails): string[] => {
  try {
    return Object.entries(action.children ?? {}).map(([_, childId]) => getAction(childId, apiDef).name);
  } catch (err) {
    throw new NotFoundError(`Failed to get child action names for action ${action.id} in API ${apiDef.name}`);
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadPluginModule<T extends BasePlugin>(pluginId: string, pluginVersion?: SemVer): Promise<T | any> {
  try {
    logger.debug(`Loading plugin ID '${pluginId}' with version '${pluginVersion}'.`);
    if (!agentSupportsPlugin(pluginId)) {
      // Error out if the plugin is completely unsupported; ideally, this should never
      // occur but it pays to be defensive
      throw new InternalServerError(`Specified plugin ID '${pluginId}' is not supported`);
    } else if (!pluginVersion || !agentSupportsPluginVersion(pluginId, pluginVersion)) {
      // Use the highest supported plugin version if a plugin version is not passed or supported
      const latestVersion = SUPPORTED_PLUGIN_VERSIONS_MAP[pluginId].slice(-1)[0];
      logger.warn(
        `Specified plugin ID '${pluginId}' with version '${pluginVersion}' is not valid. Loading latest version '${latestVersion}' instead.`
      );
      pluginVersion = latestVersion;
    }

    const module = await import(getAliasedPackageName(pluginId, pluginVersion));
    const plugin = new module.default();
    plugin.attachLogger(logger.child({ plugin_name: pluginId, plugin_version: pluginVersion }));

    const pluginConfiguration: PluginConfiguration = {
      javascriptExecutionTimeoutMs: SUPERBLOCKS_AGENT_EXECUTION_JS_TIMEOUT_MS,
      pythonExecutionTimeoutMs: SUPERBLOCKS_AGENT_EXECUTION_PYTHON_TIMEOUT_MS,
      restApiExecutionTimeoutMs: SUPERBLOCKS_AGENT_EXECUTION_REST_API_TIMEOUT_MS,
      workflowFetchAndExecuteFunc: fetchAndExecute
    };
    plugin.configure(pluginConfiguration);

    return plugin;
  } catch (err) {
    logger.error(err);
    throw err;
  }
}
