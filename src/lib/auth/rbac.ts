import { NextFunction, Request, Response } from 'express';
import { container } from '../di/containers';
import { tokens } from '../di/tokens';
import { NotAuthenticatedError, ForbiddenError } from './errors';
import { IPermissionChecker } from './permission-checker.interface';

export interface RbacOptions {
  resource: string;
  action: string;
}

export function rbac(options: RbacOptions) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        throw NotAuthenticatedError;
      }
      const checker = container.resolve<IPermissionChecker>(tokens.PermissionChecker);
      const allowed = await checker.hasPermission(req.user, options.resource, options.action);
      if (!allowed) {
        throw ForbiddenError;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
