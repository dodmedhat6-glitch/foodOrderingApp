export class MemberBranchEntity {
    memberId: number;
    branchId: number;
    createdAt: Date;

    constructor(data: Partial<MemberBranchEntity>) {
        this.memberId = data.memberId!;
        this.branchId = data.branchId!;
        this.createdAt = data.createdAt ?? new Date();
    }
}

// admin will create a member with email and another date
// an email will be sent to the member invite link and otp
// accept invite with otp and password