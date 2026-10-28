import express from "express";
import * as authController from "../controllers/authController.js";
import { authenticateJWT } from "../middleware/auth.js";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { validateBody } from "../middleware/validation.js";
import {
  checkUsernameLimiter,
  withConstantLatency,
} from "../middleware/checkUsername.js";

const router = express.Router();

// Limitador estricto para login + register: 10 req / hora.
// NO se aplica a check-username, que tiene su propio limitador más permisivo
// (checkUsernameLimiter) y se ejecuta solo al submit del form.
const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  // `ipKeyGenerator` espera un string (la IP), no el Request.
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: {
    success: false,
    message: "Too many login attempts, please try again in an hour.",
  },
});

// Limitador para solicitud de códigos de restablecimiento: 5 req / 15 min
const resetCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: {
    success: false,
    message:
      "Demasiadas solicitudes de código. Por favor, intenta de nuevo en unos minutos.",
  },
});

// Esquemas de validación de entrada. Sin ellos, un body ausente o con tipos
// inesperados llegaba al controlador y reventaba con 500 en vez de 400.
const loginSchema = {
  username: {
    type: "string",
    required: true,
    minLength: 1,
    maxLength: 100,
    message: "username: es obligatorio (1-100 caracteres)",
  },
  password: {
    type: "string",
    required: true,
    minLength: 1,
    maxLength: 200,
    message: "password: es obligatorio (1-200 caracteres)",
  },
};

const registerSchema = {
  username: {
    type: "string",
    required: true,
    minLength: 3,
    maxLength: 50,
    message: "username: debe tener entre 3 y 50 caracteres",
  },
  email: {
    // Opcional (la columna `users.email` admite NULL), pero si viene debe
    // ser un email válido. El formulario de registro del front siempre lo
    // envía; esto solo evita que un cliente externo meta basura.
    type: "email",
    required: false,
    maxLength: 255,
    message: "email: debe ser un email válido",
  },
  password: {
    type: "string",
    required: true,
    minLength: 8,
    maxLength: 200,
    message: "password: debe tener al menos 8 caracteres",
  },
};

router.post("/login", authLimiter, validateBody(loginSchema), authController.login);
router.post(
  "/register",
  authLimiter,
  validateBody(registerSchema),
  authController.register,
);
router.get(
  "/check-username",
  checkUsernameLimiter,
  withConstantLatency(authController.checkUsername),
);

// Rutas protegidas
router.get("/me", authenticateJWT, authController.me);
router.post("/logout", authController.logout);
router.patch("/me/password", authenticateJWT, authController.changePassword);
router.patch(
  "/me",
  authenticateJWT,
  resetCodeLimiter,
  authController.updateMe,
);
router.post(
  "/me/request-reset-code",
  authenticateJWT,
  resetCodeLimiter,
  authController.requestResetCode,
);
router.post(
  "/me/reset-password-with-code",
  authenticateJWT,
  authController.resetPasswordWithCode,
);

export default router;
