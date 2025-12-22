// server.js (V22 - OnlineAppointmentRequests FIX + compat HTML)
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

// =============== 1. INICIALIZACIÓN ===============
if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawPrivateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !rawPrivateKey) {
    console.error("❌ ERROR: Faltan variables de Firebase.");
    process.exit(1);
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey: rawPrivateKey.replace(/\\n/g, "\n"),
    }),
  });
}

const db = admin.firestore();
const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

const PORT = process.env.PORT || 10000;

// =============== 2. SEGURIDAD (MEJORADA PARA ADMIN) ===============
const verifyFirebaseUser = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No autorizado. Falta token." });
  }

  const token = authHeader.split("Bearer ")[1];

  // --- SOPORTE PARA TOKEN ADMIN PROPIO ---
  if (token.startsWith("MARSALVA_ADMIN_")) {
    try {
      const encoded = token.replace("MARSALVA_ADMIN_", "");
      const decoded = Buffer.from(encoded, "base64").toString("utf-8");
      const [user, pass] = decoded.split(":");

      const doc = await db.collection("settings").doc("homeserve").get();
      const config = doc.data() || {};

      if (config.user === user && config.pass === pass) {
        req.user = { uid: "admin", email: "admin@marsalva.com" };
        return next();
      } else {
        return res.status(403).json({ error: "Credenciales de admin inválidas." });
      }
    } catch (e) {
      console.error("Error verificando admin token:", e);
      return res.status(403).json({ error: "Token de admin corrupto." });
    }
  }

  // --- Firebase normal ---
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error("Error verificando token:", error);
    return res.status(403).json({ error: "Token inválido o caducado." });
  }
};

// =============== 3. UTILS ===============
const MAX_DISTANCE_KM = 5;
const SCHEDULE = {
  morning: { startHour: 9, endHour: 14 },
  afternoon: { startHour: 16, endHour: 20 },
};

function toSpainDate(d = new Date()) {
  return new Date(new Date(d).toLocaleString("en-US", { timeZone: "Europe/Madrid" }));
}
function getSpainNow() {
  return toSpainDate(new Date());
}
function addDays(d, days) {
  return new Date(d.getTime() + days * 86400000);
}
function isOverlapping(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}
function getDistanceInKm(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return 0;
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
function getDayLabel(dateObj) {
  const days = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
  const months = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
  return `${days[dateObj.getDay()]} ${dateObj.getDate()} de ${months[dateObj.getMonth()]}`;
}

// =============== 4. ADMIN LOGIN ===============
app.post("/admin/login", async (req, res) => {
  const { user, pass } = req.body;
  try {
    const doc = await db.collection("settings").doc("homeserve").get();
    const config = doc.data() || {};

    if (config.user === user && config.pass === pass) {
      const payload = Buffer.from(`${user}:${pass}`).toString("base64");
      const customToken = `MARSALVA_ADMIN_${payload}`;
      return res.json({ token: customToken });
    } else {
      return res.status(401).json({ error: "Credenciales incorrectas" });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============== 5. ADMIN ENDPOINTS BLOQUEOS ===============
app.get("/admin/blocks", verifyFirebaseUser, async (req, res) => {
  try {
    const snap = await db.collection("calendarBlocks").get();
    const items = snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        ...data,
        start: data.start && data.start.toDate ? data.start.toDate().toISOString() : data.start,
        end: data.end && data.end.toDate ? data.end.toDate().toISOString() : data.end,
      };
    });
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/admin/blocks", verifyFirebaseUser, async (req, res) => {
  try {
    const { startISO, endISO, allDay, reason, city } = req.body;
    await db.collection("calendarBlocks").add({
      start: startISO,
      end: endISO,
      allDay: !!allDay,
      reason: reason || "Bloqueo manual",
      city: city || "",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/admin/blocks/:id", verifyFirebaseUser, async (req, res) => {
  try {
    await db.collection("calendarBlocks").doc(req.params.id).delete();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/admin/config/homeserve", verifyFirebaseUser, async (req, res) => {
  try {
    const doc = await db.collection("settings").doc("homeserve").get();
    if (!doc.exists) return res.json({ user: "", hasPass: false, lastChange: null });
    const data = doc.data();
    res.json({
      user: data.user,
      hasPass: !!data.pass,
      lastChange: data.lastChange ? data.lastChange.toDate().toISOString() : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============== 6. ENDPOINTS PÚBLICOS ===============
app.get("/version", (req, res) => {
  res.json({ version: "V22 - OnlineAppointmentRequests FIX", status: "online" });
});

/**
 * availability-smart
 * Acepta tanto:
 * - { lat, lng, durationMinutes, timePreference }
 * como:
 * - { token, block, rangeDays }
 */
app.post("/availability-smart", async (req, res) => {
  try {
    let {
      lat,
      lng,
      durationMinutes = 60,
      timePreference,
      timeSlot,
      token,
      block,
      rangeDays = 10,
    } = req.body;

    // Compat: si viene token, intentamos sacar coords/duración de la ficha
    if (token && (!lat || !lng)) {
      const tokenDoc = await db.collection("appointments").doc(token).get();
      if (tokenDoc.exists) {
        const t = tokenDoc.data() || {};
        if (t.location?.lat != null && t.location?.lng != null) {
          lat = t.location.lat;
          lng = t.location.lng;
        }
        if (typeof t.durationMinutes === "number") durationMinutes = t.durationMinutes;
        if (typeof t.duration === "number") durationMinutes = t.duration;
      }
    }

    // Compat: si viene block (morning/afternoon) lo tratamos como preferencia
    const requestedTimeRaw = String(timePreference || timeSlot || block || "").toLowerCase();

    const hasCoords = lat != null && lng != null && !isNaN(lat) && !isNaN(lng);
    const today = getSpainNow();
    const daysToCheck = Math.min(Math.max(parseInt(rangeDays, 10) || 10, 3), 21);

    const startRange = new Date(today);
    startRange.setHours(0, 0, 0, 0);
    const endRange = addDays(startRange, daysToCheck);

    // 1) CITAS (solo las que tienen campo date timestamp)
    const appSnap = await db
      .collection("appointments")
      .where("date", ">=", startRange)
      .where("date", "<=", endRange)
      .get();

    // 2) BLOQUEOS
    const blockSnap = await db.collection("calendarBlocks").get();

    const busyItems = [];

    appSnap.docs.forEach((doc) => {
      const data = doc.data() || {};
      if (!data.date || !data.date.toDate) return;

      const start = data.date.toDate();
      const dur = typeof data.duration === "number" ? data.duration : 60;
      const end = new Date(start.getTime() + dur * 60000);

      busyItems.push({
        start,
        end,
        lat: data.location?.lat,
        lng: data.location?.lng,
        type: "appointment",
      });
    });

    blockSnap.docs.forEach((doc) => {
      const data = doc.data() || {};

      const bStart = data.start && data.start.toDate ? data.start.toDate() : new Date(data.start);
      const bEnd = data.end && data.end.toDate ? data.end.toDate() : new Date(data.end);

      busyItems.push({
        start: bStart,
        end: bEnd,
        type: "block",
        allDay: !!data.allDay,
      });
    });

    // 3) GENERAR HUECOS (franjas de 1h)
    const availableSlots = [];

    for (let i = 0; i < daysToCheck; i++) {
      const currentDay = addDays(today, i);
      const dayNum = currentDay.getDay();
      if (dayNum === 0 || dayNum === 6) continue; // finde fuera

      const dayStart = new Date(currentDay);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(currentDay);
      dayEnd.setHours(23, 59, 59, 999);

      const dayBusyItems = busyItems.filter((item) => isOverlapping(item.start, item.end, dayStart, dayEnd));

      // bloque día completo
      const hasFullDayBlock = dayBusyItems.some((item) => item.type === "block" && item.allDay);
      if (hasFullDayBlock) continue;

      // filtro 5km por día (si ya tienes citas ese día lejos)
      const appointmentsToday = dayBusyItems.filter((x) => x.type === "appointment");
      if (hasCoords && appointmentsToday.length > 0) {
        let blockedByDistance = false;
        for (const a of appointmentsToday) {
          if (a.lat != null && a.lng != null) {
            const dist = getDistanceInKm(lat, lng, a.lat, a.lng);
            if (dist > MAX_DISTANCE_KM) {
              blockedByDistance = true;
              break;
            }
          }
        }
        if (blockedByDistance) continue;
      }

      // elegir turno(s)
      let blocksToUse = [];
      if (requestedTimeRaw.includes("morning") || requestedTimeRaw.includes("mañana") || requestedTimeRaw === "morning") {
        blocksToUse = [SCHEDULE.morning];
      } else if (requestedTimeRaw.includes("afternoon") || requestedTimeRaw.includes("tarde") || requestedTimeRaw === "afternoon") {
        blocksToUse = [SCHEDULE.afternoon];
      } else {
        blocksToUse = [SCHEDULE.morning, SCHEDULE.afternoon];
      }

      for (const blk of blocksToUse) {
        for (let hour = blk.startHour; hour < blk.endHour; hour++) {
          const slotStart = new Date(currentDay);
          slotStart.setHours(hour, 0, 0, 0);

          if (slotStart < new Date()) continue;

          const slotEndWindow = new Date(currentDay);
          slotEndWindow.setHours(hour + 1, 0, 0, 0);

          const workEnd = new Date(slotStart.getTime() + durationMinutes * 60000);

          // si el trabajo se sale del final del turno, descartamos
          const endOfShift = new Date(currentDay);
          endOfShift.setHours(blk.endHour, 0, 0, 0);
          if (workEnd > endOfShift) continue;

          let isOccupied = false;
          for (const item of dayBusyItems) {
            if (isOverlapping(slotStart, workEnd, item.start, item.end)) {
              isOccupied = true;
              break;
            }
          }

          if (!isOccupied) {
            const startStr = slotStart.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
            const endStr = slotEndWindow.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });

            availableSlots.push({
              date: slotStart.toISOString().split("T")[0],
              startTime: startStr,
              endTime: endStr,
              label: `${startStr} - ${endStr}`,
              message: `La visita se realizará entre las ${startStr} y las ${endStr}`,
              isoStart: slotStart.toISOString(),
            });
          }
        }
      }
    }

    // agrupar por día
    const grouped = availableSlots.reduce((acc, slot) => {
      if (!acc[slot.date]) acc[slot.date] = [];
      acc[slot.date].push(slot);
      return acc;
    }, {});

    const responseArray = Object.keys(grouped)
      .sort()
      .map((dateKey) => {
        const dateObj = new Date(dateKey);
        const labelDia = getDayLabel(dateObj);
        return {
          date: dateKey,
          dayLabel: labelDia,
          title: labelDia,
          slots: grouped[dateKey],
        };
      });

    res.json({ days: responseArray });
  } catch (error) {
    console.error("Error availability:", error);
    res.json({ days: [] });
  }
});

/**
 * appointment-request (FIX)
 * En vez de crear una cita "real", crea una solicitud en:
 *   onlineAppointmentRequests
 * que es lo que tu app lee.
 */
app.post("/appointment-request", async (req, res) => {
  try {
    const { token, slot, date, startTime, reason } = req.body;

    // 1) determinar requestedDate
    let requestedDate = null;

    if (slot?.isoStart) {
      requestedDate = new Date(slot.isoStart);
    } else if (date && startTime) {
      // date: "YYYY-MM-DD", startTime: "09:00"
      requestedDate = new Date(`${date}T${startTime}:00`);
    }

    if (!requestedDate || isNaN(requestedDate.getTime())) {
      return res.status(400).json({ error: "Fecha/hora inválida (requestedDate)" });
    }

    // 2) cargar datos del servicio desde el token (para rellenar client/address/phone/originalDate)
    let clientName = "Cliente";
    let address = "";
    let phone = "";
    let originalDate = null; // Timestamp o null
    let appointmentId = token || ""; // lo que tu app usa para abrir la cita

    if (token) {
      const d = await db.collection("appointments").doc(token).get();
      if (d.exists) {
        const data = d.data() || {};
        clientName = data.clientName || data.name || data.nombre || clientName;
        address = data.address || data.direccion || "";
        if (data.city) address = address ? `${address}, ${data.city}` : String(data.city);
        phone = data.phone || data.clientPhone || data.telefono || "";
        appointmentId = data.appointmentId || data.serviceNumber || token;

        // originalDate si existe en ese doc
        const od = data.originalDate || data.date;
        if (od && od.toDate) originalDate = od;
      }
    }

    // 3) crear solicitud en la colección que tu app lee
    const payload = {
      appointmentId: String(appointmentId || token || ""),
      clientName: String(clientName || "Cliente"),
      address: String(address || ""),
      phone: String(phone || ""),
      originalDate: originalDate || null,
      requestedDate: admin.firestore.Timestamp.fromDate(requestedDate),
      reason: String(reason || "Solicitud desde portal"),
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      // (extras opcionales, no molestan)
      token: token || null,
      source: "web_portal",
    };

    await db.collection("onlineAppointmentRequests").add(payload);

    res.json({ success: true });
  } catch (e) {
    console.error("❌ appointment-request error:", e);
    res.status(500).json({ error: e.message });
  }
});

// CLIENT INFO (para tu HTML)
app.post("/client-from-token", async (req, res) => {
  const d = await db.collection("appointments").doc(req.body.token).get();
  if (d.exists) res.json(d.data());
  else res.status(404).json({});
});

app.listen(PORT, () => console.log(`✅ Marsalva Server V22 Running`));
