import {RestaurantStatus} from "../enums";


export class RestaurantEntity{
    id :number;
    ownerId: number;
    name: string;
    logoURL:string;
    status: RestaurantStatus;
    primaryCountry:string;
    createdAt: Date;
    updateAt: Date;
    statusUpdatedAt: Date;

    constructor(data : Partial<RestaurantEntity>) {
        this.id = data.id!;
        this.ownerId = data.ownerId!;
        this.name = data.name!;
        this.logoURL = data.logoURL ?? '';
        this.status = data.status!;
        this.primaryCountry= data.primaryCountry!;
        this.createdAt= data.createdAt ?? new Date();
        this.updateAt= data.updateAt?? new Date();
        this.statusUpdatedAt = data.statusUpdatedAt?? new Date();

    }
}