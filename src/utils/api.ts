import { ApiExecutionResponse } from '@superblocksteam/shared';

export const findFirstApiExecutionError = (apiResponse: ApiExecutionResponse): string | null => {
  const entries = Object.entries(apiResponse?.context?.outputs);
  for (const [stepName, stepResponse] of entries) {
    if (stepResponse.error) {
      return `Error in ${stepName}: ${stepResponse.error}`;
    }
  }
  return null;
};
