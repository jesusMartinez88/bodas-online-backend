import express from "express";
import * as guestController from "../controllers/guestController.js";
import * as adminController from "../controllers/adminController.js";
import { devOnly } from "../middleware/devOnly.js";
import { authenticateJWT } from "../middleware/auth.js";
import { resolveUserContext } from "../middleware/resolveUserContext.js";

const router = express.Router();

// Endpoint PÚBLICO (sin auth) para registrar clicks en CTAs "Registrar"
// de la landing. Lo montamos ANTES del middleware de autenticación porque
// lo dispara cualquier visitante anónimo desde el frontend.
router.post("/register-click", adminController.trackRegisterClick);

// Apply authentication to all the remaining stats routes
router.use(authenticateJWT);
router.use(resolveUserContext);

// Estadísticas generales
router.get("/", guestController.getStats);

// Estadísticas específicas
router.get("/attendance", guestController.getAttendanceStats);
router.get("/transportation", guestController.getTransportationStats);
router.get("/allergies", guestController.getAllergiesStats);
// Reset database (development only)
router.post("/reset", devOnly, guestController.resetDatabase);
export default router;
