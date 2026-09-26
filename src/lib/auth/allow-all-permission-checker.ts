import { IPermissionChecker } from './permission-checker.interface';

/**
 * Default IPermissionChecker until a module needs real RBAC — see AGENTS.md §2.1
 * (rbac.ts must depend on this interface, never on a concrete app/ module).
 */
export class AllowAllPermissionChecker implements IPermissionChecker {
  async hasPermission(): Promise<boolean> {
    return true;
  }
}
