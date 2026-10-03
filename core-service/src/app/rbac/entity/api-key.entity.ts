export class ApiKeyEntity {
    id: number;
    name: string;
    keyHash: string;
    roleId: number;
    roleName: string;
    status: "active" | "revoked";
    lastUsedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;

    constructor(data: Partial<ApiKeyEntity>) {
        this.id = data.id!;
        this.name = data.name!;
        this.keyHash = data.keyHash!;
        this.roleId = data.roleId!;
        this.roleName = data.roleName!;
        this.status = data.status ?? "active";
        this.lastUsedAt = data.lastUsedAt ?? null;
        this.createdAt = data.createdAt ?? new Date();
        this.updatedAt = data.updatedAt ?? new Date();
    }
}
