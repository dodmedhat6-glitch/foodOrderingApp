import {RestaurantStatus} from "../enums";


export class RestaurantEntity{
    id :number;
    owner_id: number;
    name: string;
    logoUrl:string;
    status: RestaurantStatus;
    primaryCountry:string;
    createdAt: Date;
    updateAt: Date;
    statusUpdatedAt: Date;

    constructor(data : Partial<RestaurantEntity>) {
        this.id = data.id!;
        this.owner_id = data.owner_id!;
        this.name = data.name!;
        this.logoUrl = data.logoUrl ?? '';
        this.status = data.status!;
        this.primaryCountry= data.primaryCountry!;
        this.createdAt= data.createdAt ?? new Date();
        this.updateAt= data.updateAt?? new Date();
        this.statusUpdatedAt = data.statusUpdatedAt?? new Date();

    }
}