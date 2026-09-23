import * as Guest from "../models/guest.js";
import * as Setting from "../models/setting.js";
import * as Table from "../models/table.js";
import db from "../db.js";
import {
  sendNewGuestEmail,
  sendGuestConfirmationEmail,
  sendDeleteCodeEmail,
} from "../services/emailService.js";
import { sendNewGuestWhatsApp } from "../services/whatsappService.js";
import {
  validateFields,
  sanitizeObject,
  isValidEmail,
  FIELD_LIMITS,
} from "../utils/validation.js";

const dbAll = db.all;

// sistema simple de código de confirmación para borrado masivo
let pendingDeleteCode = null;
let pendingDeleteExpiry = null;

const generateDeleteCode = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

const assignRandomTable = async (neededSpace = 1, userId) => {
  try {
    const globalMaxStr = await Setting.getSetting(
      "max_guests_per_table",
      userId,
    );
    const globalMax = parseInt(globalMaxStr || "10", 10);

    const tableDefinitions = await dbAll(
      "SELECT id, name, capacity FROM tables WHERE userId = ?",
      [userId],
    );
    const tableInfo = {};
    tableDefinitions.forEach((t) => {
      tableInfo[t.id] = { name: t.name, capacity: t.capacity || globalMax };
    });

    const tableCounts = await dbAll(
      "SELECT tableId, COUNT(*) as count FROM guests WHERE userId = ? AND tableId IS NOT NULL GROUP BY tableId",
      [userId],
    );

    const currentOccupancy = {};
    tableCounts.forEach((t) => {
      currentOccupancy[t.tableId] = t.count;
    });

    const availableTableIds = [];

    Object.keys(tableInfo).forEach((id) => {
      const info = tableInfo[id];
      const occupied = currentOccupancy[id] || 0;
      if (info.capacity - occupied >= neededSpace) {
        availableTableIds.push(id);
      }
    });

    if (availableTableIds.length > 0) {
      const randomIndex = Math.floor(Math.random() * availableTableIds.length);
      return parseInt(availableTableIds[randomIndex], 10);
    } else {
      return tableDefinitions.length > 0 ? tableDefinitions[0].id : null;
    }
  } catch (error) {
    console.error("Error in assignRandomTable:", error);
    return null;
  }
};

const assignSeatsForTable = async (tableId, neededSeats = 1, userId) => {
  if (!tableId || neededSeats <= 0) return [];

  try {
    const globalMaxStr = await Setting.getSetting(
      "max_guests_per_table",
      userId,
    );
    const globalMax = parseInt(globalMaxStr || "10", 10);

    const tableRows = await dbAll(
      "SELECT capacity FROM tables WHERE id = ? AND userId = ?",
      [tableId, userId],
    );

    const tableCapacity =
      tableRows && tableRows.length > 0
        ? tableRows[0].capacity || globalMax
        : globalMax;

    const takenSeatRows = await dbAll(
      "SELECT seatNumber FROM guests WHERE tableId = ? AND userId = ? AND seatNumber IS NOT NULL",
      [tableId, userId],
    );

    const takenSeats = new Set(
      takenSeatRows
        .map((r) => r.seatNumber)
        .filter((n) => n !== null && n !== undefined),
    );

    const freeSeats = [];
    for (let i = 1; i <= tableCapacity; i++) {
      if (!takenSeats.has(i)) {
        freeSeats.push(i);
      }
    }

    if (freeSeats.length < neededSeats) {
      return [];
    }

    return freeSeats.slice(0, neededSeats);
  } catch (error) {
    console.error("Error in assignSeatsForTable:", error);
    return [];
  }
};

const validateTableCapacity = async (tableId, guestId, userId) => {
  try {
    if (!tableId) return { valid: true };

    const globalMaxStr = await Setting.getSetting(
      "max_guests_per_table",
      userId,
    );
    const globalMax = parseInt(globalMaxStr || "10", 10);

    const tableDef = await dbAll(
      "SELECT id, name, capacity FROM tables WHERE id = ? AND userId = ?",
      [tableId, userId],
    );

    if (!tableDef || tableDef.length === 0) {
      return { valid: false, error: `Table with ID ${tableId} not found` };
    }

    const table = tableDef[0];
    const capacity = table.capacity || globalMax;

    const occupancyResult = await dbAll(
      "SELECT COUNT(*) as count FROM guests WHERE tableId = ? AND userId = ? AND id != ?",
      [tableId, userId, guestId],
    );

    const currentCount = occupancyResult[0]?.count || 0;

    if (currentCount >= capacity) {
      return {
        valid: false,
        error: `Table "${table.name}" (ID ${tableId}) is full. Current: ${currentCount}/${capacity}`,
      };
    }

    return { valid: true };
  } catch (error) {
    console.error("Error validating table capacity:", error);
    return { valid: false, error: error.message };
  }
};

// ─── RUTAS PÚBLICAS (por slug) ────────────────────────────────────────────────

export const getGuests = async (req, res) => {
  try {
    // El middleware resolveUserContext ya montó req.userContext
    const userId = req.userContext.userId;

    const { attending, needsTransport, search } = req.query;
    const filters = {};

    if (attending !== undefined) {
      filters.attending = attending === "true";
    }
    if (needsTransport !== undefined) {
      filters.needsTransport = needsTransport === "true";
    }
    if (search) {
      filters.search = search;
    }

    const guests = await Guest.getAllGuests(filters, userId);
    res.json({
      success: true,
      data: guests,
      count: guests.length,
    });
  } catch (error) {
    console.error("Error fetching guests:", error);
    res.status(500).json({
      success: false,
      error: "Error fetching guests",
      message: error.message,
    });
  }
};

export const getGuest = async (req, res) => {
  try {
    const userId = req.userContext.userId;
    const { id } = req.params;
    const guest = await Guest.getGuestById(id, userId);

    if (!guest) {
      return res.status(404).json({
        success: false,
        error: "Guest not found",
      });
    }

    res.json({
      success: true,
      data: guest,
    });
  } catch (error) {
    console.error("Error fetching guest:", error);
    res.status(500).json({
      success: false,
      error: "Error fetching guest",
      message: error.message,
    });
  }
};

export const createGuest = async (req, res) => {
  try {
    const userId = req.userContext.userId;
    const {
      name,
      email,
      phone,
      adults,
      children,
      attendance,
      mealType,
      needsTransport,
      allergies,
      notes,
      sendEmail,
      isAdult = true,
    } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        error: "Name is required",
      });
    }

    const lengthValidation = validateFields(req.body, {
      name: FIELD_LIMITS.GUEST_NAME,
      email: FIELD_LIMITS.GUEST_EMAIL,
      phone: FIELD_LIMITS.GUEST_PHONE,
      allergies: FIELD_LIMITS.GUEST_ALLERGIES,
      notes: FIELD_LIMITS.GUEST_NOTES,
    });

    if (!lengthValidation.valid) {
      return res.status(400).json({
        success: false,
        error: lengthValidation.errors.join(", "),
      });
    }

    if (email && !isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        error: "Email inválido",
      });
    }

    const sanitizedBody = sanitizeObject(
      req.body,
      ["name", "email", "phone", "allergies"],
      ["notes"],
    );
    Object.assign(req.body, sanitizedBody);

    const finalChildren =
      req.body.childrens !== undefined ? req.body.childrens : children;
    const numAdults = parseInt(adults || "1", 10);
    const numChildren = parseInt(finalChildren || "0", 10);
    const totalAttendees = numAdults + numChildren;
    const isAttending =
      attendance !== false &&
      attendance !== "false" &&
      attendance !== 0 &&
      attendance !== "0";

    const autoAssignStr = await Setting.getSetting(
      "auto_assign_tables",
      userId,
    );
    const autoAssign =
      autoAssignStr === "true" ||
      autoAssignStr === "1" ||
      autoAssignStr === true;
    const createdGuests = [];

    let tableId =
      autoAssign && isAttending
        ? await assignRandomTable(totalAttendees, userId)
        : null;
    let seatNumbers = [];

    if (tableId && isAttending && totalAttendees > 0) {
      seatNumbers = await assignSeatsForTable(tableId, totalAttendees, userId);
    }
    if (!seatNumbers.length) {
      tableId = null;
    }

    const getSeatNumberForIndex = (index) => {
      if (!seatNumbers || seatNumbers.length === 0) return null;
      return seatNumbers[index] !== undefined ? seatNumbers[index] : null;
    };

    const mainGuest = await Guest.createGuest({
      userId,
      name: isAdult ? name : `${name} - Niño`,
      email,
      phone,
      attending: isAttending,
      mealType: mealType || "normal",
      needsTransport: needsTransport || false,
      allergies,
      notes,
      tableId,
      seatNumber: getSeatNumberForIndex(0),
      isAdult: isAdult,
    });
    createdGuests.push(mainGuest);

    if (numAdults > 1) {
      for (let i = 1; i < numAdults; i++) {
        const adultGuest = await Guest.createGuest({
          userId,
          name: `${name} - Acompañante ${i}`,
          email: null,
          phone: null,
          attending: isAttending,
          mealType: "normal",
          needsTransport: needsTransport || false,
          allergies: null,
          notes: `Acompañante de ${name}`,
          tableId,
          seatNumber: getSeatNumberForIndex(i),
          isAdult: true,
        });
        createdGuests.push(adultGuest);
      }
    }

    if (isAdult) {
      for (let i = 0; i < numChildren; i++) {
        const childGuest = await Guest.createGuest({
          userId,
          name: `${name} - Niño ${i + 1}`,
          email: null,
          phone: null,
          attending: isAttending,
          mealType: "normal",
          needsTransport: needsTransport || false,
          allergies: null,
          notes: `Niño/a de ${name}`,
          tableId,
          seatNumber: getSeatNumberForIndex(numAdults + i),
          isAdult: false,
        });
        createdGuests.push(childGuest);
      }
    }

    if (sendEmail !== false) {
      await sendNewGuestEmail(mainGuest, numAdults, numChildren, userId);
    }

    if (sendEmail !== false) {
      sendNewGuestWhatsApp(mainGuest, numAdults, numChildren).catch((err) =>
        console.error("WhatsApp notification error:", err),
      );
    }

    if (process.env.SEND_CONFIRMATION_EMAIL === "true" && mainGuest.email) {
      await sendGuestConfirmationEmail(mainGuest);
    }

    let message = `${totalAttendees} invitado(s) creados (${numAdults} adultos, ${numChildren} niños) - Estado: ${isAttending ? "Confirmado" : "No confirma"})`;
    if (isAttending) {
      if (tableId) {
        message += ` asignados a mesa ID ${tableId}`;
      } else {
        message += ` (sin mesa asignada, quedan en "por asignar")`;
      }
    }

    res.status(201).json({
      success: true,
      data: mainGuest,
      allGuests: createdGuests,
      message,
    });
  } catch (error) {
    console.error("Error creating guest(s):", error);
    res.status(500).json({
      success: false,
      error: "Error creating guest(s)",
      message: error.message,
    });
  }
};

// ─── RUTAS PROTEGIDAS ─────────────────────────────────────────────────────────

export const updateGuest = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.userContext.userId;
    const {
      name,
      email,
      phone,
      attending,
      mealType,
      needsTransport,
      allergies,
      notes,
      tableId,
      seatNumber,
    } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        error: "Name is required",
      });
    }

    const existingGuest = await Guest.getGuestById(id);
    if (!existingGuest) {
      return res.status(404).json({
        success: false,
        error: "Guest not found",
      });
    }

    // Ownership validation
    if (existingGuest.userId !== userId) {
      return res.status(403).json({
        success: false,
        error: "Forbidden",
      });
    }

    if (tableId !== undefined && tableId !== null) {
      const capacityCheck = await validateTableCapacity(tableId, id, userId);
      if (!capacityCheck.valid) {
        return res.status(400).json({
          success: false,
          error: "Invalid table assignment",
          message: capacityCheck.error,
        });
      }
    }

    const updatedGuest = await Guest.updateGuest(
      id,
      {
        name,
        email,
        phone,
        attending:
          attending !== undefined ? attending : existingGuest.attending,
        mealType: mealType || "normal",
        needsTransport:
          needsTransport !== undefined
            ? needsTransport
            : existingGuest.needsTransport,
        allergies,
        notes,
        tableId: tableId !== undefined ? tableId : null,
        seatNumber: seatNumber !== undefined ? seatNumber : null,
      },
      userId,
    );

    res.json({
      success: true,
      data: updatedGuest,
      message: "Guest updated successfully",
    });
  } catch (error) {
    console.error("Error updating guest:", error);
    res.status(500).json({
      success: false,
      error: "Error updating guest",
      message: error.message,
    });
  }
};

export const patchGuest = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.userContext.userId;
    const partialData = req.body;

    const existingGuest = await Guest.getGuestById(id);
    if (!existingGuest) {
      return res.status(404).json({
        success: false,
        error: "Guest not found",
      });
    }

    // Ownership validation
    if (existingGuest.userId !== userId) {
      return res.status(403).json({
        success: false,
        error: "Forbidden",
      });
    }

    if (partialData.tableId !== undefined && partialData.tableId !== null) {
      const capacityCheck = await validateTableCapacity(
        partialData.tableId,
        id,
        userId,
      );
      if (!capacityCheck.valid) {
        return res.status(400).json({
          success: false,
          error: "Invalid table assignment",
          message: capacityCheck.error,
        });
      }
    }

    let updatedOldTable = null;
    let updatedNewTable = null;
    if (partialData.tableId !== undefined) {
      const oldTableId = existingGuest.tableId;
      const newTableId = partialData.tableId;
      if (
        oldTableId !== null &&
        oldTableId !== undefined &&
        String(oldTableId) !== String(newTableId)
      ) {
        await Guest.removeCaptainFromTable(oldTableId, id);
        updatedOldTable = await Table.getTableById(oldTableId, userId);
        updatedNewTable = await Table.getTableById(newTableId, userId);
      }
    }

    const updatedGuest = await Guest.patchGuest(id, partialData, userId);

    const response = {
      success: true,
      data: updatedGuest,
      message: "Guest partially updated successfully",
    };

    if (updatedOldTable || updatedNewTable) {
      response.updatedTables = {};
      if (updatedOldTable)
        response.updatedTables[updatedOldTable.id] = updatedOldTable;
      if (updatedNewTable)
        response.updatedTables[updatedNewTable.id] = updatedNewTable;
    }

    res.json(response);
  } catch (error) {
    console.error("Error patching guest:", error);
    res.status(500).json({
      success: false,
      error: "Error patching guest",
      message: error.message,
    });
  }
};

export const deleteGuest = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.userContext.userId;

    const guest = await Guest.getGuestById(id);
    if (!guest) {
      return res.status(404).json({
        success: false,
        error: "Guest not found",
      });
    }

    // Ownership validation
    if (guest.userId !== userId) {
      return res.status(403).json({
        success: false,
        error: "Forbidden",
      });
    }

    const result = await Guest.deleteGuest(id, userId);

    res.json({
      success: true,
      data: result,
      message: "Guest deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting guest:", error);
    res.status(500).json({
      success: false,
      error: "Error deleting guest",
      message: error.message,
    });
  }
};

export const requestDeleteCode = async (req, res) => {
  try {
    const userId = req.userContext.userId;
    pendingDeleteCode = generateDeleteCode();
    pendingDeleteExpiry = Date.now() + 15 * 60 * 1000;

    console.log("🔐 Código de borrado generado:", pendingDeleteCode);

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

export const deleteAllGuests = async (req, res) => {
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

    const result = await Guest.deleteAllGuests(userId);
    res.json({
      success: true,
      data: result,
      message: "All guests deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting all guests:", error);
    res.status(500).json({
      success: false,
      error: "Error deleting all guests",
      message: error.message,
    });
  }
};

export const getStats = async (req, res) => {
  try {
    const userId = req.userContext.userId;
    const stats = await Guest.getGuestStats(userId);

    res.json({
      success: true,
      data: {
        total: stats.totalGuests,
        confirmed: stats.confirmados,
        pending: stats.pendientes,
        needTransport: stats.needTransport,
        totalAdults: stats.totalAdults || 0,
        totalChildren: stats.totalChildren || 0,
      },
    });
  } catch (error) {
    console.error("Error fetching stats:", error);
    res.status(500).json({
      success: false,
      error: "Error fetching stats",
      message: error.message,
    });
  }
};

export const getAttendanceStats = async (req, res) => {
  try {
    const userId = req.userContext.userId;
    const stats = await Guest.getAttendanceStats(userId);

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error("Error fetching attendance stats:", error);
    res.status(500).json({
      success: false,
      error: "Error fetching attendance stats",
      message: error.message,
    });
  }
};

export const getTransportationStats = async (req, res) => {
  try {
    const userId = req.userContext.userId;
    const stats = await Guest.getTransportationStats(userId);

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error("Error fetching transportation stats:", error);
    res.status(500).json({
      success: false,
      error: "Error fetching transportation stats",
      message: error.message,
    });
  }
};

export const getAllergiesStats = async (req, res) => {
  try {
    const userId = req.userContext.userId;
    const stats = await Guest.getAllergiesStats(userId);

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error("Error fetching allergies stats:", error);
    res.status(500).json({
      success: false,
      error: "Error fetching allergies stats",
      message: error.message,
    });
  }
};

export const resetDatabase = async (req, res) => {
  try {
    const userId = req.userContext.userId;
    await db.run("DELETE FROM guests WHERE userId = ?", [userId]);

    res.json({
      success: true,
      message: "Database reset successfully",
      data: {
        tables_cleared: ["guests"],
      },
    });
  } catch (error) {
    console.error("Error resetting database:", error);
    res.status(500).json({
      success: false,
      error: "Error resetting database",
      message: error.message,
    });
  }
};
