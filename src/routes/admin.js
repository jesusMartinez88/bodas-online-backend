import express from "express";
import multer from "multer";
import * as adminController from "../controllers/adminController.js";
import * as invitationMediaController from "../controllers/invitationMediaController.js";
import * as questionnaireController from "../controllers/landingQuestionnaireController.js";
import { authenticateJWT } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";

const router = express.Router();
const uploadMusic = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
});

router.use(authenticateJWT);
router.use(requireRole("admin"));

router.get("/users", adminController.listUsersWithStats);
router.patch("/users/:id", adminController.updateUser);
router.delete("/users/:id", adminController.deleteUser);
router.post(
  "/users/:id/music",
  uploadMusic.single("audio"),
  invitationMediaController.uploadMusicForUser,
);

// Estadísticas de visitas únicas por IP agrupadas por slug.
router.get("/stats/visits", adminController.getVisitStats);

// Cuestionario inicial de la landing de un usuario concreto. Lo expone el
// admin para diseñar la landing en base a las respuestas del cliente.
router.get(
  "/users/:id/landing-questionnaire",
  questionnaireController.getForUser,
);

// Permite al admin guardar o sobreescribir el cuestionario de cualquier
// usuario (útil cuando el cliente no lo pudo enviar durante el registro).
router.put(
  "/users/:id/landing-questionnaire",
  questionnaireController.saveForUser,
);

export default router;
