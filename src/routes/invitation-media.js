import express from "express";
import { authenticateJWT } from "../middleware/auth.js";
import { resolveUserContext } from "../middleware/resolveUserContext.js";
import { createImageUpload } from "../middleware/uploadPolicy.js";
import * as controller from "../controllers/invitationMediaController.js";

const router = express.Router();

const upload = createImageUpload();

router.get("/public/:userSlug", resolveUserContext, controller.listPublic);
router.use(authenticateJWT);
router.use(resolveUserContext);
router.get("/", controller.listMine);
router.post("/cover", upload.single("image"), controller.uploadCover);
router.post("/gallery", upload.array("images", 12), controller.uploadGallery);
router.post("/history", upload.array("images", 12), controller.uploadHistory);
router.delete("/:name", controller.removeMine);

// Los errores de multer (tamaño máximo, número de archivos, MIME no
// admitido) y los de validación de contenido los maneja el manejador global
// de `src/app.js`, que devuelve 413/415 con el mensaje real.

export default router;
