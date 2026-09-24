import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import {
  MEDIA_ROOT,
  MEDIA_KIND_COVER,
  MEDIA_KIND_GALLERY,
  MEDIA_KIND_HISTORY,
} from "../constants/media.js";

const MAX_PIXELS = 20_000_000;
const MAX_DIMENSION = 2560;
const ACCEPTED_FORMATS = new Set(["jpeg", "png", "webp"]);

// Mapeo kind → nombre de archivo de la portada. Solo `covery` tiene
// nombre fijo; las otras dos subcarpetas usan UUIDs.
const COVER_FILENAME = "cover.webp";

// URL pública servida por `app.use("/media/photos", express.static(...))`
// en `app.js`. Coincide con `MEDIA_KIND_*` arriba.
const mediaUrl = (slug, kind, name) =>
  `/media/photos/${encodeURIComponent(slug)}/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`;

/**
 * Devuelve la ruta absoluta del directorio del usuario para un "kind"
 * concreto (`covery/`, `gallery/` o `history/`).
 */
const userKindDirectory = (slug, kind) => join(MEDIA_ROOT, slug, kind);

const safeMediaName = (name) =>
  name === COVER_FILENAME || /^[0-9a-f-]{36}\.webp$/i.test(name);

const invalidImageError = () => {
  const error = new Error("Only valid JPEG, PNG and WebP images are allowed");
  error.status = 415;
  return error;
};

const saveAsWebp = async (file, targetPath) => {
  if (!file?.buffer?.length) {
    const error = new Error("Image file is required");
    error.status = 400;
    throw error;
  }

  const image = sharp(file.buffer, {
    limitInputPixels: MAX_PIXELS,
    failOn: "error",
  });
  let metadata;
  try {
    metadata = await image.metadata();
  } catch {
    throw invalidImageError();
  }
  if (!metadata.format || !ACCEPTED_FORMATS.has(metadata.format)) {
    throw invalidImageError();
  }

  const temporaryPath = `${targetPath}.${randomUUID()}.webp`;
  try {
    await image
      .rotate()
      .resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 88, effort: 4 })
      .toFile(temporaryPath);
    await rename(temporaryPath, targetPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
};

/**
 * Lista los archivos de una subcarpeta del usuario. Devuelve array
 * vacío si la carpeta no existe (caso normal en cuentas sin fotos).
 */
const readUserKindFiles = async (slug, kind) => {
  try {
    const files = await readdir(userKindDirectory(slug, kind));
    return files.filter(safeMediaName).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
};

/**
 * Devuelve la primera subcarpeta donde aparece `name` para ese usuario.
 * Se usa en `removeMine` para borrar sin tener que pasar el `kind`
 * en la query.
 */
const findKindForFile = async (slug, name) => {
  for (const kind of [
    MEDIA_KIND_COVER,
    MEDIA_KIND_GALLERY,
    MEDIA_KIND_HISTORY,
  ]) {
    const files = await readUserKindFiles(slug, kind);
    if (files.includes(name)) return kind;
  }
  return null;
};

/* ============================================================
 * Endpoints
 * ============================================================ */

export const listMine = async (req, res, next) => {
  try {
    const { slug } = req.userContext;

    const [coverFiles, galleryFiles, historyFiles] = await Promise.all([
      readUserKindFiles(slug, MEDIA_KIND_COVER),
      readUserKindFiles(slug, MEDIA_KIND_GALLERY),
      readUserKindFiles(slug, MEDIA_KIND_HISTORY),
    ]);

    res.json({
      success: true,
      data: {
        coverUrl: coverFiles.includes(COVER_FILENAME)
          ? mediaUrl(slug, MEDIA_KIND_COVER, COVER_FILENAME)
          : null,
        galleryUrls: galleryFiles.map((name) =>
          mediaUrl(slug, MEDIA_KIND_GALLERY, name),
        ),
        historyUrls: historyFiles.map((name) =>
          mediaUrl(slug, MEDIA_KIND_HISTORY, name),
        ),
      },
    });
  } catch (error) {
    next(error);
  }
};

export const uploadCover = async (req, res, next) => {
  try {
    const { slug } = req.userContext;
    const directory = userKindDirectory(slug, MEDIA_KIND_COVER);
    await mkdir(directory, { recursive: true });
    await saveAsWebp(req.file, join(directory, COVER_FILENAME));
    res.status(201).json({
      success: true,
      data: { url: mediaUrl(slug, MEDIA_KIND_COVER, COVER_FILENAME) },
    });
  } catch (error) {
    next(error);
  }
};

export const uploadGallery = async (req, res, next) => {
  try {
    const { slug } = req.userContext;
    const files = req.files ?? [];
    if (!files.length) {
      return res
        .status(400)
        .json({ success: false, message: "At least one image is required" });
    }

    const directory = userKindDirectory(slug, MEDIA_KIND_GALLERY);
    await mkdir(directory, { recursive: true });
    const existing = await readUserKindFiles(slug, MEDIA_KIND_GALLERY);
    if (existing.length + files.length > 12) {
      return res.status(400).json({
        success: false,
        message: "A maximum of 12 gallery photos is allowed",
      });
    }
    const urls = [];
    for (const file of files) {
      const name = `${randomUUID()}.webp`;
      await saveAsWebp(file, join(directory, name));
      urls.push(mediaUrl(slug, MEDIA_KIND_GALLERY, name));
    }
    res.status(201).json({ success: true, data: { urls } });
  } catch (error) {
    next(error);
  }
};

export const uploadHistory = async (req, res, next) => {
  try {
    const { slug } = req.userContext;
    const files = req.files ?? [];
    if (!files.length) {
      return res
        .status(400)
        .json({ success: false, message: "At least one image is required" });
    }

    const directory = userKindDirectory(slug, MEDIA_KIND_HISTORY);
    await mkdir(directory, { recursive: true });
    const existing = await readUserKindFiles(slug, MEDIA_KIND_HISTORY);
    if (existing.length + files.length > 12) {
      return res.status(400).json({
        success: false,
        message: "A maximum of 12 history photos is allowed",
      });
    }
    const urls = [];
    for (const file of files) {
      const name = `${randomUUID()}.webp`;
      await saveAsWebp(file, join(directory, name));
      urls.push(mediaUrl(slug, MEDIA_KIND_HISTORY, name));
    }
    res.status(201).json({ success: true, data: { urls } });
  } catch (error) {
    next(error);
  }
};

/**
 * Borrado de una foto propia del usuario. El frontend solo necesita
 * pasar el nombre del archivo (`cover.webp` o un UUID); el backend
 * localiza el archivo en cualquiera de las tres subcarpetas.
 *
 * Si en el futuro el frontend indica explícitamente el `kind`
 * (p.ej. `?kind=gallery`), podemos aceptarlo aquí; de momento buscar
 * mantiene el contrato simple y compatible hacia atrás.
 */
export const removeMine = async (req, res, next) => {
  try {
    const { name } = req.params;
    if (!safeMediaName(name)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid media name" });
    }
    const { slug } = req.userContext;
    const kind = await findKindForFile(slug, name);
    if (!kind) {
      // No devolvemos 404 para no filtrar existencia; respondemos 204
      // como si se hubiera borrado. El cliente simplemente verá que la
      // foto desaparece del siguiente `listMine`.
      return res.status(204).end();
    }
    await rm(join(userKindDirectory(slug, kind), name), { force: true });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
};

export const listPublic = async (req, res, next) => {
  try {
    const { slug } = req.userContext;

    const [coverFiles, galleryFiles, historyFiles] = await Promise.all([
      readUserKindFiles(slug, MEDIA_KIND_COVER),
      readUserKindFiles(slug, MEDIA_KIND_GALLERY),
      readUserKindFiles(slug, MEDIA_KIND_HISTORY),
    ]);

    res.json({
      success: true,
      data: {
        coverUrl: coverFiles.includes(COVER_FILENAME)
          ? mediaUrl(slug, MEDIA_KIND_COVER, COVER_FILENAME)
          : null,
        galleryUrls: galleryFiles.map((name) =>
          mediaUrl(slug, MEDIA_KIND_GALLERY, name),
        ),
        historyUrls: historyFiles.map((name) =>
          mediaUrl(slug, MEDIA_KIND_HISTORY, name),
        ),
      },
    });
  } catch (error) {
    next(error);
  }
};
