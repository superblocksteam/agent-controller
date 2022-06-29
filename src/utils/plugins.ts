import path from 'path';
import { RegisteredPlugins, SemVer } from '@superblocksteam/shared';
import { SUPERBLOCKS_GOOGLE_SHEETS_CLIENT_ID, SUPERBLOCKS_GOOGLE_SHEETS_REDIRECT_PATH } from '../env';

const SUPERBLOCKS_PLUGIN_PACKAGE_PREFIX = 'sb-';

const getSupportedPluginVersionsMap = (): Record<string, string[]> => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const depedencies: Record<string, string> = require(path.resolve(__dirname, '..', '..', 'package.json')).dependencies;
  const pluginVersionsMap: Record<string, string[]> = {};
  const pluginIDs = RegisteredPlugins(SUPERBLOCKS_GOOGLE_SHEETS_CLIENT_ID, SUPERBLOCKS_GOOGLE_SHEETS_REDIRECT_PATH).getIDs();
  for (const dep in depedencies) {
    if (dep.startsWith(SUPERBLOCKS_PLUGIN_PACKAGE_PREFIX)) {
      // Parse the aliased dependency name assuming the format of
      // the Superblocks package dependency is sb-${plugin.id}-${plugin.version}
      const parsedPlugin = dep.split('-');
      const pluginID = parsedPlugin[1];
      const pluginVersion = parsedPlugin[2];
      if (pluginIDs.has(pluginID)) {
        (pluginVersionsMap[pluginID] ||= []).push(pluginVersion);
      }
    }
  }

  Object.entries(pluginVersionsMap).forEach(([name, versions]) => (pluginVersionsMap[name] = versions.sort()));
  return pluginVersionsMap;
};

export const getAliasedPackageName = (pluginName: string, pluginVersion: string): string => {
  return `${SUPERBLOCKS_PLUGIN_PACKAGE_PREFIX}${pluginName}-${pluginVersion}`;
};

export const SUPPORTED_PLUGIN_VERSIONS_MAP = getSupportedPluginVersionsMap();

export const agentSupportsPlugin = (pluginId: string): boolean => {
  // Check if the agent supports at least one version of the specified plugin
  return (SUPPORTED_PLUGIN_VERSIONS_MAP[pluginId] ?? []).length > 0;
};

export const agentSupportsPluginVersion = (pluginId: string, pluginVersion: SemVer): boolean => {
  return (SUPPORTED_PLUGIN_VERSIONS_MAP[pluginId] ?? []).includes(pluginVersion);
};
