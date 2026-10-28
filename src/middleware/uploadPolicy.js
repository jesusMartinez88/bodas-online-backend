import multer from "multer";

/**
 * Política de subida de archivos.
 *
 * Defensa en profundidad: el `fileFilter` de multer rechaza los MIME
 * declarados que no corresponden a lo que la ruta espera, de modo que un
 * `.html` o un `.exe` no llega ni a cargarse en memoria.
 *
 * OJO: el MIME que envía el cliente **no es una garantía**. La validación
 * que decide de verdad es la del contenido, y se hace después:
 *   - Imágenes → `sharp` lee la cabecera real del archivo y exige que el
 *     formato sea JPEG/PNG/WebP (`invitationMediaController.saveAsWebp`).
 *   - Audio    → se comprueban los bytes mágicos MP3 (cabecera `ID3` o frame
 *     header MPEG) (`invitationMediaController.isMp3`).
 *
 * Los dos filtros juntos son los que importan: el `fileFilter` es la primera
 * puerta (rápida y barata) y la validación de contenido, la definitiva.
 */

/** Tamaño máximo por imagen (10 MB). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Tamaño máximo del audio de fondo (20 MB). */
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

/** Número máximo de imágenes por petición de galería/historia. */
export const MAX_IMAGE_FILES = 12;

/** MIME declarados admitidos para imágenes (el contenido se valida aparte). */
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** MIME declarados admitidos para audio MP3 (el contenido se valida aparte). */
const AUDIO_MIME_TYPES = new Set(["audio/mpeg", "audio/mp3", "audio/x-mpeg"]);

const buildFileFilter = (allowed, message) => (_req, file, cb) => {
  const mime = typeof file?.mimetype === "string" ? file.mimetype.toLowerCase() : "";
  if (allowed.has(mime)) {
    cb(null, true);
    return;
  }
  const error = new Error(message);
  error.status = 415;
  cb(error);
};

/** Multer para las imágenes de portada, galería e historia. */
export const createImageUpload = () =>
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGE_FILES },
    fileFilter: buildFileFilter(
      IMAGE_MIME_TYPES,
      "Only valid JPEG, PNG and WebP images are allowed",
    ),
  });

/** Multer para el audio de fondo (MP3). */
export const createAudioUpload = () =>
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_AUDIO_BYTES, files: 1 },
    fileFilter: buildFileFilter(AUDIO_MIME_TYPES, "Only valid MP3 audio is allowed"),
  });
