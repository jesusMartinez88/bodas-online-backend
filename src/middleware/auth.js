import jwt from "jsonwebtoken";
import { SESSION_COOKIE_NAME } from "../services/sessionCookie.js";

/**
 * Autenticación por JWT.
 *
 * El token se acepta desde dos sitios, en este orden:
 *   1. La cabecera `Authorization: Bearer <token>` (clientes no navegador:
 *      apps móviles, CLI, tests).
 *   2. La cookie de sesión `httpOnly` (el navegador web).
 *
 * La cookie es la vía principal del frontend: el token **no** se guarda en
 * `localStorage`, así que un XSS no puede leerlo.
 */
export const authenticateJWT = (req, res, next) => {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    console.error("FATAL: JWT_SECRET is not defined. Cannot authenticate.");
    return res.status(500).json({
      success: false,
      message: "Server configuration error",
    });
  }

  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : null;
  const cookieToken = req.cookies?.[SESSION_COOKIE_NAME] || null;

  const token = bearerToken || cookieToken;

  if (!token) {
    // Mismo mensaje para "sin cabecera" y "sin cookie": no revelamos cuál de
    // los dos mecanismos se esperaba.
    return res.status(401).json({
      success: false,
      message: "Authentication required",
    });
  }

  jwt.verify(token, secret, (err, user) => {
    if (err) {
      return res.status(403).json({
        success: false,
        message: "Invalid or expired token",
      });
    }

    req.user = user;
    next();
  });
};
