import {Router} from "express";
import {container} from "../../lib/di/containers";
import {tokens} from "../../lib/di/tokens";
import {MediaController} from "./controller/media.controller";
import {authenticate} from "../../lib/auth/guard";
import {rbac, requireRestaurantMember} from "../../lib/auth/rbac";
import {uploadSingleMedia} from "./upload.middleware";

export const mediaRouter = Router();
const mediaController = container.resolve<MediaController>(tokens.MediaController);

// Restaurant-scoped: membership of :restaurantId is checked in the path,
// the same shape the catalogue routes use (app/product/routes.ts).

// multipart/form-data, field name `file`
mediaRouter.post('/restaurants/:restaurantId/media',
    authenticate,
    requireRestaurantMember('restaurantId'),
    rbac({resource: "core:media", action: 'create'}),
    uploadSingleMedia('file'),
    mediaController.upload
);

// Browser-direct alternative: hands back a presigned PUT url, no bytes through us.
mediaRouter.post('/restaurants/:restaurantId/media/upload-url',
    authenticate,
    requireRestaurantMember('restaurantId'),
    rbac({resource: "core:media", action: 'create'}),
    mediaController.createUploadUrl
);

mediaRouter.get('/restaurants/:restaurantId/media',
    authenticate,
    requireRestaurantMember('restaurantId'),
    rbac({resource: "core:media", action: 'read'}),
    mediaController.findByRestaurant
);

// Media-level routes carry no restaurantId, so requireRestaurantMember cannot
// run here - MediaService checks the row's restaurant against the caller.
mediaRouter.post('/media/:id/confirm',
    authenticate,
    rbac({resource: "core:media", action: 'create'}),
    mediaController.confirmUpload
);

mediaRouter.get('/media/:id',
    authenticate,
    rbac({resource: "core:media", action: 'read'}),
    mediaController.findById
);

mediaRouter.delete('/media/:id',
    authenticate,
    rbac({resource: "core:media", action: 'delete'}),
    mediaController.remove
);
