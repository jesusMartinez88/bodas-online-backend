import { resolve } from "node:path";

/**
 * Raíz del sistema de archivos donde se guardan las fotos de invitación
 * de cada usuario.
 *
 * Cada usuario tiene su propia carpeta `MEDIA_ROOT/<slug>/` con tres
 * subcarpetas (ver `MEDIA_KINDS`):
 *   - covery/   → portada (`cover.webp`)
 *   - gallery/  → fotos de la galería (`<uuid>.webp`)
 *   - history/  → fotos de "Nuestra historia" (`<uuid>.webp`)
 *
 * Centralizada aquí para que tanto `invitationMediaController.js`
 * (que escribe/lee las fotos) como `models/user.js` (que borra la
 * carpeta al eliminar un usuario) apunten al mismo path. Si se cambia
 * `INVITATION_MEDIA_DIR` en producción, ambos lo ven a la vez.
 */
export const MEDIA_ROOT = resolve(process.env.INVITATION_MEDIA_DIR || "assets");

/**
 * "Kind" de cada carpeta dentro de `MEDIA_ROOT/<slug>/`. La clave
 * (`gallery`, `covery`, `history`) es lo que aparece en la URL pública
 * `/media/photos/<slug>/<kind>/<file>`. Se exporta también `MEDIA_KINDS`
 * para iterar sobre los tres tipos al listar/borrar.
 */
export const MEDIA_KIND_COVER = "covery";
export const MEDIA_KIND_GALLERY = "gallery";
export const MEDIA_KIND_HISTORY = "history";
export const MEDIA_KIND_MUSIC = "music";

export const MEDIA_KINDS = [
  MEDIA_KIND_COVER,
  MEDIA_KIND_GALLERY,
  MEDIA_KIND_HISTORY,
  MEDIA_KIND_MUSIC,
];
