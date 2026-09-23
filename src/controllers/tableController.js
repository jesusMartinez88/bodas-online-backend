import * as Table from "../models/table.js";
import * as Guest from "../models/guest.js";
import * as Setting from "../models/setting.js";
import { sendDeleteCodeEmail } from "../services/emailService.js";

const mapTableResponse = (table) => {
  if (!table) return null;
  return table;
};

// sistema simple de código de confirmación para borrado masivo de mesas
let pendingDeleteCode = null;
let pendingDeleteExpiry = null;

const generateDeleteCode = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

export const getTables = async (req, res) => {
  try {
    const userId = req.userContext.userId;
    const allTables = await Table.getAllTables(userId);

    res.json({
      success: true,
      data: allTables.map(mapTableResponse),
    });
  } catch (error) {
    console.error("Error fetching tables:", error);
    res.status(500).json({
      success: false,
      error: "Error fetching tables",
      message: error.message,
    });
  }
};

export const getTable = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.userContext.userId;
    const table = await Table.getTableById(id, userId);
    if (!table) {
      return res.status(404).json({
        success: false,
        error: "Table not found",
      });
    }
    res.json({
      success: true,
      data: mapTableResponse(table),
    });
  } catch (error) {
    console.error("Error fetching table:", error);
    res.status(500).json({
      success: false,
      error: "Error fetching table",
      message: error.message,
    });
  }
};

export const createTable = async (req, res) => {
  try {
    const { name, capacity, shape, posX, posY } = req.body;
    const userId = req.userContext.userId;

    let tableName = name;
    if (!tableName) {
      tableName = await Table.getNextTableName(userId);
    }

    const tableToCreate = {
      userId,
      name: tableName,
      capacity: capacity || 10,
      shape: shape || "round",
      posX: posX || 0,
      posY: posY || 0,
    };

    const result = await Table.createTable(tableToCreate);
    res.status(201).json({
      success: true,
      data: mapTableResponse(result),
      message: `Table created as ${tableName}`,
    });
  } catch (error) {
    console.error("Error creating table:", error);

    if (error.message && error.message.includes("UNIQUE constraint failed")) {
      return res.status(409).json({
        success: false,
        error: "Duplicate table name",
        message: "A table with this name already exists.",
      });
    }

    res.status(500).json({
      success: false,
      error: "Error creating table",
      message: error.message,
    });
  }
};

export const updateTable = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.userContext.userId;
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const source =
      payload.table && typeof payload.table === "object"
        ? payload.table
        : payload.data && typeof payload.data === "object"
          ? payload.data
          : payload;
    const {
      name,
      capacity,
      shape,
      posX,
      posY,
      captainIds,
      rotation,
      highchairs,
    } = source;

    const existingTable = await Table.getTableById(id, userId);
    if (!existingTable) {
      return res.status(404).json({
        success: false,
        error: "Table not found",
      });
    }

    // Ownership validation
    if (existingTable.userId !== userId) {
      return res.status(403).json({
        success: false,
        error: "Forbidden",
      });
    }

    if (captainIds && Array.isArray(captainIds)) {
      for (const cid of captainIds) {
        const captain = await Guest.getGuestById(cid, userId);
        if (!captain) {
          return res.status(404).json({
            success: false,
            error: "Captain not found",
            message: `No existe un invitado con id ${cid}.`,
          });
        }
        if (Number(captain.tableId) !== Number(id)) {
          return res.status(422).json({
            success: false,
            error: "Invalid captain",
            message: `El capitán con id ${cid} debe estar sentado en esta mesa.`,
          });
        }
      }
    }

    const updateData = { name, capacity, shape, posX, posY };

    if (rotation !== undefined) {
      updateData.rotation = rotation;
    }

    if (highchairs !== undefined) {
      updateData.highchairs = Number.isNaN(parseInt(highchairs, 10))
        ? highchairs
        : parseInt(highchairs, 10);
    }

    if ("captainIds" in req.body) {
      updateData.captainIds = captainIds ?? null;
    }

    const result = await Table.updateTableById(id, updateData, userId);
    if (result.skipped) {
      return res.status(400).json({
        success: false,
        error: "No fields to update",
      });
    }

    const updatedTable = await Table.getTableById(id, userId);
    res.json({
      success: true,
      data: mapTableResponse(updatedTable),
    });
  } catch (error) {
    console.error("Error updating table:", error);

    if (error.message && error.message.includes("UNIQUE constraint failed")) {
      return res.status(409).json({
        success: false,
        error: "Duplicate table name",
        message: "A table with this name already exists.",
      });
    }

    res.status(500).json({
      success: false,
      error: "Error updating table",
      message: error.message,
    });
  }
};

export const deleteTable = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.userContext.userId;

    const table = await Table.getTableById(id, userId);
    if (!table) {
      return res.status(404).json({
        success: false,
        error: "Table not found",
      });
    }

    // Ownership validation
    if (table.userId !== userId) {
      return res.status(403).json({
        success: false,
        error: "Forbidden",
      });
    }

    const tableName = table.name;

    const unassignResult = await Guest.unassignGuestsFromTable(id, userId);
    const configResult = await Table.deleteTableById(id, userId);

    res.json({
      success: true,
      data: {
        id: parseInt(id, 10),
        name: tableName,
        unassignedGuests: unassignResult.changes,
        configDeleted: configResult.changes > 0,
      },
      message: `Table "${tableName}" (ID ${id}) deleted and ${unassignResult.changes} guest(s) unassigned.`,
    });
  } catch (error) {
    console.error("[TableController] Error deleting table:", error);
    res.status(500).json({
      success: false,
      error: "Error deleting table",
      message: error.message,
    });
  }
};

export const requestDeleteCode = async (req, res) => {
  try {
    const userId = req.userContext.userId;
    pendingDeleteCode = generateDeleteCode();
    pendingDeleteExpiry = Date.now() + 15 * 60 * 1000;

    console.log("🔐 Código de borrado de mesas generado:", pendingDeleteCode);

    await sendDeleteCodeEmail(pendingDeleteCode, userId);

    const responsePayload = {
      success: true,
      message: "Confirmation code sent via email",
    };
    if (process.env.NODE_ENV !== "production") {
      responsePayload.code = pendingDeleteCode;
    }
    res.json(responsePayload);
  } catch (error) {
    console.error("Error requesting delete code:", error);
    res.status(500).json({
      success: false,
      error: "Error generating confirmation code",
      message: error.message,
    });
  }
};

export const deleteAllTables = async (req, res) => {
  try {
    const { code } = req.query;
    const userId = req.userContext.userId;

    if (!code) {
      return res.status(400).json({
        success: false,
        error: "Confirmation code missing",
      });
    }
    if (code !== pendingDeleteCode) {
      return res.status(400).json({
        success: false,
        error: "Invalid confirmation code",
      });
    }
    if (Date.now() > pendingDeleteExpiry) {
      pendingDeleteCode = null;
      pendingDeleteExpiry = null;
      return res.status(400).json({
        success: false,
        error: "Confirmation code expired",
      });
    }

    pendingDeleteCode = null;
    pendingDeleteExpiry = null;

    await Guest.unassignAllGuestsFromTables(userId);

    const result = await Table.deleteAllTables(userId);
    res.json({
      success: true,
      data: result,
      message: "All tables deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting all tables:", error);
    res.status(500).json({
      success: false,
      error: "Error deleting all tables",
      message: error.message,
    });
  }
};
