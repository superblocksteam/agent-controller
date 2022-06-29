import { Agent, PostRegistrationRequestBody, sleep } from '@superblocksteam/shared';
import { SUPERBLOCKS_AGENT_ID, SUPERBLOCKS_AGENT_REGISTRATION_RETRY_COUNT, SUPERBLOCKS_AGENT_TYPE } from '../env';
import { agentHealthManager } from '../global';
import logger from './logger';
import { SUPPORTED_PLUGIN_VERSIONS_MAP } from './plugins';
import { makeRequest, RequestMethod, shouldRetry } from './request';
import { buildSuperblocksCloudUrl } from './url';

export const registerWithSuperblocksCloud = async (): Promise<void> => {
  const retryCount = SUPERBLOCKS_AGENT_REGISTRATION_RETRY_COUNT;
  const retryIntervalSeconds = 5;
  for (let x = 0; x < retryCount; x++) {
    try {
      const payload: PostRegistrationRequestBody = {
        pluginVersions: SUPPORTED_PLUGIN_VERSIONS_MAP,
        type: SUPERBLOCKS_AGENT_TYPE
      };
      const me = await makeRequest<Agent>({
        method: RequestMethod.POST,
        url: buildSuperblocksCloudUrl('register'),
        payload
      });
      logger.info(`Agent ${me.id} has successfully registered with Superblocks Cloud, and will be accessed by the end-user at ${me.url}.`);
      agentHealthManager.recordRegistration();
      return;
    } catch (err) {
      if (shouldRetry(err)) {
        logger.warn(
          `Agent ${SUPERBLOCKS_AGENT_ID} failed to register with Superblocks Cloud due to a retryable error ${err}. Retrying in ${retryIntervalSeconds} seconds.`
        );
      } else {
        logger.error(
          `Agent ${SUPERBLOCKS_AGENT_ID} failed to register with Superblocks Cloud due to a non-retryable error ${err}. Shutting down gracefully.`
        );
        process.kill(process.pid, 'SIGTERM');
      }
    }
    await sleep(retryIntervalSeconds * 1000);
  }
  logger.error(`Agent failed to register with Superblocks Cloud after ${retryCount} retries. Please contact Superblocks Admin.`);
  process.kill(process.pid, 'SIGTERM');
};
