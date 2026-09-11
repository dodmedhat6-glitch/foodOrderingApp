import {hours} from "../../../common/times";
import {getPermissionByRoleName} from "../repository/permission.repo";

class PermissionsCashService{
    private cache:Map<string , {permissions: string[] , cachedAt:number}> = new Map();
    private readonly TTL = hours(1)

    async getPermissions(roleName : string): Promise<string[]> {
        // check cache , if it is in the cache , fetch it , if not fetch from db
        const cached = this.cache.get(roleName);
        if (cached && Date.now() - cached.cachedAt < this.TTL){
            return cached.permissions
        }
        // after calling db , insert it into cache
        const permissions = await getPermissionByRoleName(roleName);
        this.cache.set(roleName,{permissions , cachedAt : Date.now()});

        return permissions;

    }
    hasPermissions(permissions: string[] , resource : string , action : string): boolean{
        return permissions.includes(`${resource}:${action}`);
    }
}


export const permissionCashService = new PermissionsCashService()