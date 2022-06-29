import { ExecutionParam } from '@superblocksteam/shared';
import { Request } from 'express';

export const getParamsFromRequest = (req: Request): ExecutionParam[] => {
  return [
    {
      key: 'params',
      value: req.query
    },
    {
      key: 'headers',
      value: req.headers
    },
    {
      key: 'body',
      value: req.body
    }
  ];
};
