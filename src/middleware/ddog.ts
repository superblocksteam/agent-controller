import { RequestHandler } from 'express';
import { addDdogTags } from '../utils/tracer';

export const addReqParamsToDdog: RequestHandler = async (req, res, next) => {
  addDdogTags(req.params);
  return next();
};
