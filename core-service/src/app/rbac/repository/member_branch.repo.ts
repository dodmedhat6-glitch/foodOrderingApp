import {MemberBranchEntity} from "../entity/member-branch.entity";
import {Knex} from "knex";
import {db} from "../../../lib/knex/kenx";

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


export async function findBranchesByMemberId(memberId: number): Promise<number[]> {
    const row = await db("member_branches")
        .select("branch_id")
        .where("member_id", memberId);
    return row.map(row => row.branch_id);
}


export async function countBranchesByIdsAndRestaurant(branchIds:number[], restaurantId:number): Promise<number>{

    const [{count}] = await db("restaurant_branches")
        .whereIn("id", branchIds)
        .andWhere("restaurant_id", restaurantId)
        .count("id as count");
    return Number(count);

}

