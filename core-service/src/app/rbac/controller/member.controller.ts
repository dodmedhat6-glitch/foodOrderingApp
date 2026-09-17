import {Request , Response , NextFunction} from "express"
import {validateBody} from "../../../lib/validation/validate";
import {CreateMemberDto, UpdateMemberBranchesDTO, UpdateMemberDto} from "../dto/member.dto";
import {MemberService} from "../service/member.service";
import {inject, injectable} from "tsyringe";
import {tokens} from "../../../lib/di/tokens";

@injectable()
export class MemberController{
    constructor(@inject(tokens.MemberService) private readonly memberService: MemberService) {}

    createMember = async (req : Request , res: Response , next: NextFunction) =>{
        try {
            const data = await validateBody(CreateMemberDto , req.body);
            const result = await this.memberService.createMember(Number(req.params.restaurantId) , data );
            res.status(200).send(result)
        }catch (err){
            next(err)
        }
    }

    listMembers = async (req:  Request , res: Response , next : NextFunction) =>{
        try {
            const data = await this.memberService.listMember(Number(req.params.restaurantId));
            res.status(200).send(data)
        }
        catch (err)
        {
            next(err)
        }
    }


    updateMember = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const data = await validateBody(UpdateMemberDto, req.body);
            const result = await this.memberService.updateMember(
                Number(req.params.restaurantId),
                Number(req.params.memberId),
                data
            );
            res.status(200).send(result);
        }
        catch (error) {
            next(error);
        }
    }

    deleteMember = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const result = await this.memberService.deleteMember(
                Number(req.params.restaurantId),
                Number(req.params.memberId)
            );
            res.status(200).send(result);
        }
        catch (error) {
            next(error);
        }
    }

    updateMemberBranches = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const data = await validateBody(UpdateMemberBranchesDTO, req.body);
            const result = await this.memberService.updateMemberBranches(
                Number(req.params.restaurantId),
                Number(req.params.memberId),
                data
            );
            res.status(200).send(result);
        }
        catch (error) {
            next(error);
        }
    }

    getRolePermissions = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const result = await this.memberService.getRolePermissions(req.params.role as string);
            res.status(200).send(result);
        }
        catch (error) {
            next(error);
        }
    }

}