import { Response } from 'express';
import { SUPERBLOCKS_AGENT_KEEPALIVE_DELAY_MS } from '../env';

export const activateKeepAliveProbes = (res: Response): void => {
  // By default, the probes run 10 times with intervals of 1 second.
  // We can't configure this but we can set the timeout delay
  // of when the probes are initiated.
  // Set keepalive probes to run right before the keepidle timeout
  // to refresh the timeout.
  res.socket.setKeepAlive(true, SUPERBLOCKS_AGENT_KEEPALIVE_DELAY_MS);
};
