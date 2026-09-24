import express from "express";
import multer from "multer";
import { authenticateJWT } from "../middleware/auth.js";
import { resolveUserContext } from "../middleware/resolveUserContext.js";
import * as controller from "../controllers/invitationMediaController.js";

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 12 },
});

router.get("/public/:userSlug", resolveUserContext, controller.listPublic);
router.use(authenticateJWT);
router.use(resolveUserContext);
router.get("/", controller.listMine);
router.post("/cover", upload.single("image"), controller.uploadCover);
router.post("/gallery", upload.array("images", 12), controller.uploadGallery);
router.post("/history", upload.array("images", 12), controller.uploadHistory);
router.delete("/:name", controller.removeMine);

router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res
      .status(status)
      .json({ success: false, message: "Invalid image upload" });
  }
  next(error);
});

export default router;
