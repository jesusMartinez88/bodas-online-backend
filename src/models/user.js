import db from "../db.js";
import bcrypt from "bcryptjs";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { MEDIA_ROOT } from "../constants/media.js";

// Columnas "seguras" que devolvemos al frontend (nunca password, etc.)
const PUBLIC_USER_COLUMNS =
  "id, username, email, role, slug, paidAt, invitationCompletedAt, lastLoginAt, createdAt, notes";

export const findByUsername = async (username) => {
  return await db.get("SELECT * FROM users WHERE username = ?", [username]);
};

export const findById = async (id) => {
  return await db.get(`SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = ?`, [
    id,
  ]);
};

export const findBySlug = async (slug) => {
  return await db.get(
    `SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE slug = ?`,
    [slug],
  );
};

export const comparePassword = async (password, hashedPassword) => {
  return await bcrypt.compare(password, hashedPassword);
};

export const createUser = async ({
  username,
  email,
  password,
  role = "user",
  slug,
}) => {
  const hashedPassword = await bcrypt.hash(password, 10);
  const result = await db.run(
    "INSERT INTO users (username, email, password, role, slug) VALUES (?, ?, ?, ?, ?)",
    [username, email || null, hashedPassword, role, slug],
  );
  return { id: result.lastID, username, email, role, slug };
};

export const updatePassword = async (id, newPassword) => {
  const hashed = await bcrypt.hash(newPassword, 10);
  await db.run("UPDATE users SET password = ? WHERE id = ?", [hashed, id]);
};

export const listUsers = async () => {
  return await db.all(
    `SELECT ${PUBLIC_USER_COLUMNS} FROM users ORDER BY createdAt ASC`,
  );
};

/**
 * Borra la carpeta `assets/<slug>/` de un usuario.
 *
 * Se llama automáticamente desde `DeleteUser` para que no queden
 * archivos huérfanos en disco cuando un usuario se elimina. La
 * validación con `resolve()` + comparación con `MEDIA_ROOT` es una
 * defensa en profundidad: aunque el slug lo genera el backend, nunca
 * concatenamos input del usuario directamente a un path sin chequear
 * que el resultado sigue dentro del directorio permitido.
 */
const removeUserAssets = async (slug) => {
  if (!slug || typeof slug !== "string") return;
  const target = resolve(join(MEDIA_ROOT, slug));
  // Solo borramos si el path resuelto sigue colgando de MEDIA_ROOT
  // (evita traversal si por lo que sea el slug viene con "../").
  const rootWithSep = MEDIA_ROOT.endsWith(sep) ? MEDIA_ROOT : MEDIA_ROOT + sep;
  if (!target.startsWith(rootWithSep) && target !== MEDIA_ROOT) return;
  if (!existsSync(target)) return;
  await rm(target, { recursive: true, force: true });
};

export const deleteUser = async (id) => {
  // 1. Leemos el slug ANTES de borrar la fila, porque después no
  //    podríamos recuperar a qué carpeta de assets pertenecía.
  const user = await db.get("SELECT slug FROM users WHERE id = ?", [id]);

  // 2. Defensa: en Turso el PRAGMA foreign_keys puede resetearse por
  //    request. Lo reactivamos justo antes del DELETE para garantizar
  //    que el CASCADE barra guests, settings, tables, finances, contacts,
  //    todos, music_playlist y landing_questionnaire asociados.
  await db.run("PRAGMA foreign_keys = ON");
  const result = await db.run("DELETE FROM users WHERE id = ?", [id]);

  // 3. Limpiamos los assets (fotos de invitación) del usuario. Lo
  //    hacemos DESPUÉS del borrado en BD y fuera del `try` que rodea
  //    la transacción: si falla el rm (p.ej. permisos), la fila de BD
  //    ya está eliminada y el siguiente intento de borrado no la
  //    encontrará, dejando archivos huérfanos. Loggeamos el warning
  //    pero no abortamos.
  if (user?.slug) {
    try {
      await removeUserAssets(user.slug);
    } catch (err) {
      console.warn(
        `Could not remove assets folder for deleted user (slug=${user.slug}):`,
        err.message,
      );
    }
  }

  return { deletedId: id, changes: result.changes };
};

export const updateRole = async (id, role) => {
  await db.run("UPDATE users SET role = ? WHERE id = ?", [role, id]);
};

export const updateLastLogin = async (id) => {
  await db.run(
    "UPDATE users SET lastLoginAt = CURRENT_TIMESTAMP WHERE id = ?",
    [id],
  );
};

/**
 * Actualiza campos editables de un usuario. Solo permite los campos
 * explícitamente listados en `ALLOWED_FIELDS`; cualquier otra clave del
 * payload se ignora silenciosamente para evitar mass-assignment.
 */
const ALLOWED_FIELDS = new Set([
  "email",
  "paidAt",
  "invitationCompletedAt",
  "role",
  "notes",
]);

export const updateUser = async (id, fields) => {
  const entries = Object.entries(fields || {}).filter(
    ([key, value]) => ALLOWED_FIELDS.has(key) && value !== undefined,
  );
  if (entries.length === 0) {
    return await findById(id);
  }

  const setClause = entries.map(([key]) => `${key} = ?`).join(", ");
  const values = entries.map(([, value]) => {
    if (value === null || value === "") {
      return null;
    }
    return value;
  });

  await db.run(`UPDATE users SET ${setClause} WHERE id = ?`, [...values, id]);
  return await findById(id);
};
