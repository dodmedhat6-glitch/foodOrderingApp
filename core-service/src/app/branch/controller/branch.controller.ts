import {branchService, BranchService} from "../service/branch.service";
import {Request , Response , NextFunction} from "express"
import {validateBody} from "../../../common/validation/validate";
import {CreateBranchDto} from "../dto/branch.dto";
import {SystemRole} from "../../user/enums";
export class BranchController{
    constructor(private readonly branchService: BranchService) {
    }

    create = async (req: Request , res: Response , next: NextFunction) =>{
        try {
            const data = await validateBody(CreateBranchDto , req.body)
            const branch = await this.branchService.create(Number(req.params.restaurantId) ,req.user?.user_id! ,
                req.user?.role as SystemRole , data );
            res.status(201).json({message : "branch added", branch})

        }catch (err){
            next(err)
        }
    }


    findNearby = async (req: Request , res: Response , next: NextFunction) =>{
        try {
            const results = await this.branchService.findNearby(Number(req.query.lat),Number(req.query.lng))
            res.status(200).json({data : results})

        }catch (err){
            next(err)
        }
    }
}

export const branchController = new BranchController(branchService)