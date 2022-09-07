import { SUPERBLOCKS_CLOUD_BASE_URL } from '../env';

export const buildSuperblocksCloudUrl = (path = ''): string => {
  if (path.length > 0 && !path.startsWith('/')) {
    path = `/${path}`;
  }

  return `${SUPERBLOCKS_CLOUD_BASE_URL}/api/v1/agents${path}`;
};

export const buildSuperblocksUiUrl = (path: string): string => {
  return `${SUPERBLOCKS_CLOUD_BASE_URL}/${path}`;
};
