import { UnauthorizedError, AGENT_KEY_HEADER } from '@superblocksteam/shared';
import { NextFunction, Request, Response } from 'express';
import { extractAuthHeaderFromRequest } from '../utils/request';

/**
 * The middleware used by the agent endpoints.
 * @param allowAuthInQueryParams If the endpoint allows user to specify the authentication token
 *   in request query parameter, as an alternative of specifying the token in the request header.
 */
export const verifyAuth = (allowAuthInQueryParams = false) => (req: Request, res: Response, next: NextFunction): void => {
  try {
    const authHeader = extractAuthHeaderFromRequest(req, allowAuthInQueryParams);
    // Header format should be:
    // Authorization: Bearer <token>
    if (!authHeader || authHeader.split(' ').length != 2) {
      return next(new UnauthorizedError('Invalid authorization header provided'));
    }
  } catch (e) {
    return next(e);
  }

  return next();
};

export const verifyFile = () => (req: Request, res: Response, next: NextFunction): void => {
  const key: string = req.headers[AGENT_KEY_HEADER]?.toString();
  const location: string = req.query?.location?.toString();

  if (!location) {
    return next(new UnauthorizedError('No file provided.'));
  }

  // Ensure that the request file resides in a directory named
  // after the location header.
  if (!key || location.includes('..') || location.split('/').length < 2 || location.split('/').slice(-2)[0] != key) {
    return next(new UnauthorizedError('Unauthorized'));
  }

  return next();
};
