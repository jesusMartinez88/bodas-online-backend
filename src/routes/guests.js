import express from "express";
import * as guestController from "../controllers/guestController.js";
import { authenticateJWT } from "../middleware/auth.js";
import { resolveUserContext } from "../middleware/resolveUserContext.js";

const router = express.Router();

// Rutas públicas con :userSlug
router.get("/public/:userSlug", resolveUserContext, guestController.getGuests);
router.get("/public/:userSlug/:id", resolveUserContext, guestController.getGuest);
router.post("/public/:userSlug", resolveUserContext, guestController.createGuest);

// Rutas protegidas (requieren login)
router.use(authenticateJWT);
router.use(resolveUserContext);

router.get("/", guestController.getGuests);
router.get("/:id", guestController.getGuest);
router.post("/", guestController.createGuest);
router.put("/:id", guestController.updateGuest);
router.patch("/:id", guestController.patchGuest);

// generar y enviar código de borrado masivo por email
router.post("/request-delete", guestController.requestDeleteCode);
// borrar todos los invitados (se requiere el código enviado por email).
// IMPORTANTE: estas rutas deben declararse ANTES que `/:id`, de lo contrario
// Express interpretaría "bulk" como un id de invitado.
router.delete("/bulk", guestController.deleteAllGuests);
router.delete("/", guestController.deleteAllGuests);
router.delete("/:id", guestController.deleteGuest);

export default router;
