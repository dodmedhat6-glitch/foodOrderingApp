export interface IPermissionChecker {
  hasPermission(
    user: Express.Request['user'],
    resource: string,
    action: string,
  ): boolean | Promise<boolean>;
}
