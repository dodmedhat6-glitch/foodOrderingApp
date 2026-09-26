import { NextFunction, Response, Request } from 'express';
import { NotAuthenticatedError } from './errors';
import { verifyAccessToken } from './jwt';

export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length)
    : undefined;
  const token = req.cookies?.access_token ?? bearerToken;

  if (!token) {
    throw NotAuthenticatedError;
  }
  req.user = verifyAccessToken(token);
  next();
}
