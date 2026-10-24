import db from "../db.js";

const BASE_SELECT = `
  SELECT
    id,
    userId,
    title,
    artist,
    youtube_url,
    youtube_id,
    note,
    order_index,
    created_at,
    updated_at
  FROM music_playlist
`;

export const listSongs = async (userId) => {
  return db.all(`${BASE_SELECT} WHERE userId = ? ORDER BY order_index ASC, id ASC`, [userId]);
};

export const getSongById = async (id, userId) => {
  if (userId !== undefined) {
    return db.get(`${BASE_SELECT} WHERE id = ? AND userId = ?`, [id, userId]);
  }
  return db.get(`${BASE_SELECT} WHERE id = ?`, [id]);
};

export const getNextOrderIndex = async (userId) => {
  const row = await db.get("SELECT COALESCE(MAX(order_index), -1) + 1 AS next_order FROM music_playlist WHERE userId = ?", [userId]);
  return Number(row?.next_order ?? 0);
};

export const createSong = async (song) => {
  const result = await db.run(
    `INSERT INTO music_playlist (userId, title, artist, youtube_url, youtube_id, note, order_index)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [song.userId || null, song.title, song.artist, song.youtube_url, song.youtube_id, song.note, song.order_index],
  );

  return getSongById(result.lastID, song.userId);
};

const ALLOWED_UPDATE_FIELDS = new Set([
  "title",
  "artist",
  "youtube_url",
  "youtube_id",
  "note",
  "order_index",
]);

export const updateSongPartial = async (id, partialData, userId) => {
  const entries = Object.entries(partialData).filter(
    ([field, value]) =>
      ALLOWED_UPDATE_FIELDS.has(field) &&
      value !== undefined &&
      value !== null,
  );
  if (entries.length === 0) {
    return getSongById(id, userId);
  }

  const setClause = entries.map(([field]) => `${field} = ?`).join(", ");
  const params = entries.map(([, value]) => value);
  
  if (userId !== undefined) {
    params.push(id, userId);
    await db.run(
      `UPDATE music_playlist
       SET ${setClause}, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND userId = ?`,
      params,
    );
  } else {
    params.push(id);
    await db.run(
      `UPDATE music_playlist
       SET ${setClause}, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      params,
    );
  }

  return getSongById(id, userId);
};

export const deleteSong = async (id, userId) => {
  if (userId !== undefined) {
    return db.run("DELETE FROM music_playlist WHERE id = ? AND userId = ?", [id, userId]);
  }
  return db.run("DELETE FROM music_playlist WHERE id = ?", [id]);
};

export const reorderSongsTransaction = async (songs, userId) => {
  await db.transaction(async (transaction) => {
    for (const song of songs) {
      const result = await transaction.execute(
        "UPDATE music_playlist SET order_index = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND userId = ?",
        [song.order, song.id, userId],
      );

      if (result.rowsAffected === 0) {
        const notFoundError = new Error(`Song with id ${song.id} not found or belongs to another user`);
        notFoundError.code = "NOT_FOUND";
        throw notFoundError;
      }
    }
  });
};
