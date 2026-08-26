import {AddressNotFoundError} from "../errors";
import {
    findAddressesByUserId,
    findAddressById,
    createAddress,
    updateAddress,
    deleteAddress,
    clearDefaultByUserId,
} from "../repository/customer-address.repo";
import {CreateAddressDTO, UpdateAddressDTO} from "../dto/customer-address.dto";

function toResponse(address: any) {
    return {
        id: address.id,
        label: address.label,
        country: address.country,
        city: address.city,
        street: address.street,
        building: address.building,
        apartmentNumber: address.apartmentNumber,
        type: address.type,
        lat: address.lat,
        lng: address.lng,
        isDefault: address.isDefault,
    };
}

export class CustomerAddressService {

    getByUserId = async (userId: number) => {
        const addresses = await findAddressesByUserId(userId);
        return addresses.map(toResponse);
    }

    create = async (userId: number, data: CreateAddressDTO) => {
        if (data.isDefault) {
            await clearDefaultByUserId(userId);
        }
        const address = await createAddress({userId, ...data});
        return toResponse(address);
    }

    update = async (userId: number, addressId: number, data: UpdateAddressDTO) => {
        const existing = await findAddressById(addressId);
        if (!existing || existing.userId !== userId) {
            throw AddressNotFoundError;
        }
        if (data.isDefault) {
            await clearDefaultByUserId(userId);
        }
        const updated = await updateAddress(addressId, data);
        return toResponse(updated);
    }

    remove = async (userId: number, addressId: number) => {
        const existing = await findAddressById(addressId);
        if (!existing || existing.userId !== userId) {
            throw AddressNotFoundError;
        }
        await deleteAddress(addressId);
    }
}

export const customerAddressService = new CustomerAddressService();
