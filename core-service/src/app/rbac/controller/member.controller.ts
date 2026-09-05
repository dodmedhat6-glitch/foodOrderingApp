import {Request , Response , NextFunction} from "express"
import {validateBody} from "../../../common/validation/validate";
import {CreateMemberDto} from "../dto/member.dto";
import {memberService} from "../service/member.service";

export class MemberController{
    createMember = async (req : Request , res: Response , next: NextFunction) =>{
        try {
            const data = await validateBody(CreateMemberDto , req.body);
            const result = await memberService.createMember(Number(req.params.restaurantId) , data );
            res.status(200).send(result)
        }catch (err){
            next(err)
        }
    }

    //TODO : PUT RESTAURANT MEMBER BRANCHES CONTROLLER

}


export const memberController = new MemberController()