export class RolePermissionEntity {
    roleId: number;
    permissionId: number;
    createdAt: Date;

    constructor(data: Partial<RolePermissionEntity>) {
        this.roleId = data.roleId!;
        this.permissionId = data.permissionId!;
        this.createdAt = data.createdAt ?? new Date();
    }
}
