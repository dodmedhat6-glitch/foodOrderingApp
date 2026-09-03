import {MemberBranchEntity} from "../entity/member-branch.entity";
import {Knex} from "knex";
import {db} from "../../../common/knex/kenx";

function toEntity(row:any):MemberBranchEntity{
    return new MemberBranchEntity({
        memberId : row.member_id,
        branchId: row.branch_id,
        createdAt: row.created_at,
    });
}

export async function setMemberBranch(memberId :number , rows: MemberBranchEntity[] , trx?: Knex.Transaction): Promise<void>{
    const query = trx || db ;
    await query('member_branches').where('member_id' , memberId).delete();

    if(rows.length > 0) {
        await query('member_branches').insert(
            rows.map(row =>({
                member_id: row.memberId,
                branch_id: row.branchId,
                created_at: row.createdAt
        }))
        );
    }


}