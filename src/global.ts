import { AgentError } from '@superblocksteam/shared';
import { SUPERBLOCKS_AGENT_ERROR_HISTORY_SIZE_MAX } from './env';

class AgentHealthManager {
  private readonly errorHistorySize: number;
  private cur = 0;
  // Keep the agent -> server errors.
  private serverErrors: AgentError[] = [];
  private registered = false;

  constructor(errorHistorySize: number) {
    this.errorHistorySize = errorHistorySize;
  }

  recordServerError(agentServerError: AgentError): void {
    if (this.serverErrors.length < this.errorHistorySize) {
      this.serverErrors.push(agentServerError);
    } else {
      this.serverErrors[this.cur] = agentServerError;
    }
    this.cur = (this.cur + 1) % this.errorHistorySize;
  }

  recordRegistration() {
    this.registered = true;
  }

  getServerErrors(): AgentError[] {
    return this.serverErrors;
  }

  isRegistered(): boolean {
    return this.registered;
  }
}

export const agentHealthManager = new AgentHealthManager(SUPERBLOCKS_AGENT_ERROR_HISTORY_SIZE_MAX);
