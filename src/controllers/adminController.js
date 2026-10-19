import db from "../db.js";
import * as User from "../models/user.js";
import * as Visit from "../models/visit.js";
import * as RegisterClick from "../models/registerClick.js";
import { logError } from "../utils/logger.js";

const PROTECTED_ADMIN_USERNAME = "admin";

/**
 * Devuelve la lista de usuarios con info agregada útil para el panel de admin:
 * contadores de tablas relacionadas + flags derivados.
 *
 * Se excluye al admin (role='admin'): el panel es para gestionar usuarios
 * "cliente", no al propio operador.
 *
 * hasInvitation se considera true si:
 *   - El admin marcó manualmente `invitationCompletedAt`, o
 *   - El usuario tiene contenido propio (guests/contacts/tables/finances).
 */
export const listUsersWithStats = async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT
        u.id, u.username, u.email, u.role, u.slug, u.paidAt,
        u.invitationCompletedAt, u.lastLoginAt, u.createdAt, u.notes,
        (SELECT COUNT(*) FROM guests g WHERE g.userId = u.id) AS guestCount,
        (SELECT COUNT(*) FROM contacts c WHERE c.userId = u.id) AS contactCount,
        (SELECT COUNT(*) FROM tables t WHERE t.userId = u.id) AS tableCount,
        (SELECT COUNT(*) FROM finances f WHERE f.userId = u.id) AS financeCount,
        (SELECT COUNT(*) FROM todos td WHERE td.userId = u.id) AS todoCount
      FROM users u
      WHERE u.role != 'admin'
      ORDER BY u.createdAt ASC
    `);

    const data = rows.map((row) => {
      const guestCount = Number(row.guestCount) || 0;
      const contactCount = Number(row.contactCount) || 0;
      const tableCount = Number(row.tableCount) || 0;
      const financeCount = Number(row.financeCount) || 0;
      const todoCount = Number(row.todoCount) || 0;
      const manuallyCompleted = !!row.invitationCompletedAt;
      const hasContent =
        guestCount > 0 || contactCount > 0 || tableCount > 0 || financeCount > 0;

      return {
        ...row,
        guestCount,
        contactCount,
        tableCount,
        financeCount,
        todoCount,
        paid: !!row.paidAt,
        hasInvitation: manuallyCompleted || hasContent,
        isProtected: row.username === PROTECTED_ADMIN_USERNAME,
      };
    });

    res.json({ success: true, data });
  } catch (error) {
    logError("Error listing admin users", error);
    res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

/**
 * Edita campos permitidos de un usuario. NO permite:
 *   - Editar el admin principal (username = "admin")
 *   - Editarse a sí mismo (cualquiera de los campos protegidos)
 *   - Cambiar username/role (eso tiene su propio endpoint)
 *   - Cambiar password (usar /api/auth/me/password)
 *
 * Campos permitidos: email, paidAt, invitationCompletedAt, notes.
 * Para "desmarcar" un campo basta con enviar `null` o string vacío.
 */
const ALLOWED_PATCH_FIELDS = new Set([
  "email",
  "paidAt",
  "invitationCompletedAt",
  "notes",
]);

const normalizeDateOrNull = (value) => {
  if (value === null || value === "" || value === undefined) {
    return null;
  }
  // Aceptamos ISO strings o timestamps; si es inválido, devolvemos null.
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const target = await User.findById(id);
    if (!target) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }
    if (target.username === PROTECTED_ADMIN_USERNAME) {
      return res.status(403).json({
        success: false,
        message: "Cannot edit the main admin account",
      });
    }
    if (Number(req.user.id) === Number(id)) {
      return res.status(403).json({
        success: false,
        message: "Cannot edit your own account from this endpoint",
      });
    }

    const patch = {};
    for (const [key, value] of Object.entries(req.body || {})) {
      if (!ALLOWED_PATCH_FIELDS.has(key)) continue;
      patch[key] = value;
    }

    if ("email" in patch) {
      const email = patch.email;
      if (email !== null && email !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid email format" });
      }
    }

    if ("paidAt" in patch) patch.paidAt = normalizeDateOrNull(patch.paidAt);
    if ("invitationCompletedAt" in patch)
      patch.invitationCompletedAt = normalizeDateOrNull(patch.invitationCompletedAt);

    const updated = await User.updateUser(id, patch);
    res.json({
      success: true,
      data: {
        ...updated,
        paid: !!updated.paidAt,
        hasInvitation: !!updated.invitationCompletedAt,
      },
      message: "User updated successfully",
    });
  } catch (error) {
    logError("Error updating admin user", error);
    res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

/**
 * Elimina un usuario. Mismas reglas que el userController.deleteUser
 * original, pero expuesto bajo /api/admin/users/:id.
 */
export const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    const target = await User.findById(id);
    if (!target) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }
    if (target.username === PROTECTED_ADMIN_USERNAME) {
      return res.status(403).json({
        success: false,
        message: "Cannot delete the main admin account",
      });
    }
    if (Number(req.user.id) === Number(id)) {
      return res
        .status(403)
        .json({ success: false, message: "Cannot delete yourself" });
    }
    await User.deleteUser(id);
    res.json({ success: true, message: "User deleted successfully" });
  } catch (error) {
    logError("Error deleting admin user", error);
    res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

/**
 * GET /api/admin/stats/visits
 * Estadísticas globales de visitas únicas a la app (por IP).
 */
export const getVisitStats = async (req, res) => {
  try {
    const stats = await Visit.getStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    logError("Error fetching visit stats", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

/**
 * POST /api/stats/register-click
 *
 * Endpoint PÚBLICO (sin auth) que registra un click en un CTA de "Registrar".
 * Fire-and-forget desde el frontend: responde 200 OK sin esperar al INSERT
 * para no penalizar la navegación.
 *
 * Body opcional: `{ source?: 'header' | 'hero' | 'pricing' | 'final' | 'footer' }`.
 * Sirve solo para análisis futuro; la deduplicación se hace por IP en 24 h.
 */
export const trackRegisterClick = async (req, res) => {
  // Respondemos primero para que la latencia del INSERT no bloquee al cliente.
  res.json({ success: true });

  const ip = req.ip ?? "unknown";
  const ua = req.headers["user-agent"] ?? null;
  const source = typeof req.body?.source === "string" ? req.body.source.slice(0, 32) : null;

  RegisterClick.track(ip, ua, source).catch((err) => {
    logError("Error tracking register click", err);
  });
};

/**
 * GET /api/admin/stats/register-clicks
 * Estadísticas globales de clicks únicos en CTAs "Registrar" (por IP).
 */
export const getRegisterClickStats = async (req, res) => {
  try {
    const stats = await RegisterClick.getStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    logError("Error fetching register-click stats", error);
    res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};
