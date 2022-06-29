import { Health } from '@superblocksteam/shared';
import { Request, Response } from 'express';
import {
  SUPERBLOCKS_AGENT_ENVIRONMENT,
  SUPERBLOCKS_AGENT_ERROR_HISTORY_DISABLE,
  SUPERBLOCKS_AGENT_ID,
  SUPERBLOCKS_AGENT_URL,
  SUPERBLOCKS_AGENT_VERSION,
  SUPERBLOCKS_AGENT_VERSION_EXTERNAL
} from '../env';
import { agentHealthManager } from '../global';

export const getHealth = (_: Request, res: Response): void => {
  const data: Health = {
    uptime: process.uptime(),
    message: 'Ok',
    date: new Date(),
    id: SUPERBLOCKS_AGENT_ID,
    url: SUPERBLOCKS_AGENT_URL,
    environment: SUPERBLOCKS_AGENT_ENVIRONMENT,
    version: SUPERBLOCKS_AGENT_VERSION,
    version_external: SUPERBLOCKS_AGENT_VERSION_EXTERNAL,
    registered: agentHealthManager.isRegistered()
  };

  // Conditionally add server errors to the health response object.
  // We don't always want to do this because there might be sensitive information
  // logged that we do not want to expose to the world in the case of agents that
  // are not network-protected.
  if (SUPERBLOCKS_AGENT_ERROR_HISTORY_DISABLE !== 'true') {
    data.server_errors = agentHealthManager.getServerErrors();
  }

  res.status(200).send(data);
};
