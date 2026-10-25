import {NextFunction, Request, Response} from "express";
import {inject, injectable} from "tsyringe";
import {MediaCaller, MediaService, UploadedFile} from "../service/media.service";
import {tokens} from "../../../lib/di/tokens";
import {sendSuccess} from "../../../lib/http/response";
import {validateBody} from "../../../lib/validation/validate";
import {CreateMediaUploadUrlDTO} from "../dto/media.dto";
import {parseFilters, parseQuery} from "../../../lib/http/pagination/parse.query";
import {SystemRole} from "../../user/enums";

@injectable()
export class MediaController {
    constructor(@inject(tokens.MediaService) private readonly mediaService: MediaService) {
    }

    upload = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const file = (req as Request & {file?: UploadedFile}).file;
            const result = await this.mediaService.upload(
                Number(req.params.restaurantId),
                this.caller(req),
                file
            );
            sendSuccess(res, {message: "Media uploaded", media: result}, 201);
        } catch (err) {
            next(err);
        }
    }

    createUploadUrl = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const data = await validateBody(CreateMediaUploadUrlDTO, req.body);
            const result = await this.mediaService.createUploadUrl(
                Number(req.params.restaurantId),
                this.caller(req),
                data
            );
            sendSuccess(res, {
                message: "Upload url created",
                media: result.media,
                uploadUrl: result.uploadUrl
            }, 201);
        } catch (err) {
            next(err);
        }
    }

    confirmUpload = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const result = await this.mediaService.confirmUpload(Number(req.params.id), this.caller(req));
            sendSuccess(res, {message: "Media confirmed", media: result});
        } catch (err) {
            next(err);
        }
    }

    findById = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const result = await this.mediaService.findById(Number(req.params.id), this.caller(req));
            sendSuccess(res, {media: result});
        } catch (err) {
            next(err);
        }
    }

    findByRestaurant = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const params = parseQuery(req.query);
            // Column names, not entity fields: applyFilters puts these straight
            // into the where clause (see lib/http/pagination/cursor.pagination).
            const filters = parseFilters(req.query, ['id', 'status', 'uploaded_by', 'content_type']);
            const result = await this.mediaService.findByRestaurant(
                Number(req.params.restaurantId),
                params,
                filters
            );
            sendSuccess(res, result.data, 200, result.meta);
        } catch (err) {
            next(err);
        }
    }

    remove = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const result = await this.mediaService.remove(Number(req.params.id), this.caller(req));
            sendSuccess(res, {message: "Media deleted", media: {id: result.id, status: result.status}});
        } catch (err) {
            next(err);
        }
    }

    private caller = (req: Request): MediaCaller => ({
        userId: req.user?.user_id!,
        role: req.user?.role! as SystemRole,
        restaurantId: req.user?.restaurantId
    })
}
