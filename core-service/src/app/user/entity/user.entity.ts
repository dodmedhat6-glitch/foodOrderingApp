import { SystemRole } from "../enums.js";

export class User {
    id: number;
    email: string;
    phone: string;
    name: string;
    systemRole: SystemRole;
    passwordHash: string;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;

    constructor(data: Partial<User>) {
        this.id = data.id!;
        this.email = data.email!;
        this.phone = data.phone!;
        this.name = data.name!;
        this.systemRole = data.systemRole!;
        this.passwordHash = data.passwordHash!;
        this.createdAt = data.createdAt!;
        this.updatedAt = data.updatedAt!;
        this.deletedAt = data.deletedAt!;
    }
}
