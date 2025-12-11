// server.js
const express = require("express");
const cors = require("cors");

// node-fetch en modo CommonJS (para Node 18+)
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

// Firebase Admin
const admin = require("firebase-admin");

// =============== INICIALIZACIÓN FIREBASE ===============
if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawPrivateKey = process.env.FIREBASE_PRIVATE_KEY;

  console.log("🚀 Marsalva Smart Backend arrancando...");
  console.log("   Firebase Project:", projectId);
  console.log("   Tiene clientEmail:", !!clientEmail);
  console.log("   Tiene privateKey:", !!rawPrivateKey);

  if (!projectId || !clientEmail || !rawPrivateKey) {
    throw new Error(
      "Faltan variables de entorno de Firebase (PROJECT_ID / CLIENT_EMAIL / PRIVATE_KEY)"
    );
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

// =============== CONFIGURACIÓN BÁSICA ===============

// Coordenadas aproximadas de tu base (Algeciras)
const HOME_ALGECIRAS = { lat: 36.1408, lng: -5.4562 };

// Horarios
const MORNING_START = 9;   // 09:00
const MORNING_END = 14;    // 14:00
const AFTERNOON_START = 16;// 16:00
const AFTERNOON_END = 20;  // 20:00

// Duraciones (minutos)
const SLOT_MINUTES = 60;
const SERVICE_MINUTES_DEFAULT = 60; // mínimo 1h
const TRAVEL_MARGIN_MINUTES = 10;

// Google
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";

// Puerto
const PORT = process.env.PORT || 10000;

const app = express();
app.use(cors());
app.use(express.json());

console.log("   Google API Key presente:", !!GOOGLE_MAPS_API_KEY);

// Cache geocoding
const geocodeCache = new Map();

// =============== UTILIDADES GENERALES ===============

function normalizeBlock(block) {
  const b = (block || "").toString().toLowerCase();
  if (b.includes("mañ") || b.includes("man") || b.includes("morn")) {
    return "morning";
  }
  if (b.includes("tard") || b.includes("after")) {
    return "afternoon";
  }
  // por defecto, mañana
  return "morning";
}

function getDateOnly(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function buildDateWithHour(baseDate, hour) {
  const d = new Date(baseDate);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function formatTime(date) {
  const h = date.getHours().toString().padStart(2, "0");
  const m = date.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function getNextDays(rangeDays) {
  const days = [];
  const today = getDateOnly(new Date());
  for (let i = 0; i < rangeDays; i++) {
    const d = new Date(today.getTime() + i * 24 * 60 * 60000);
    days.push(d);
  }
  return days;
}

// =============== GOOGLE MAPS ===============

async function geocodeAddress(fullAddress) {
  if (!fullAddress) {
    throw new Error("Dirección vacía en geocodeAddress");
  }

  if (geocodeCache.has(fullAddress)) {
    return geocodeCache.get(fullAddress);
  }

  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error("No hay GOOGLE_MAPS_API_KEY configurada");
  }

  const url =
    "https://maps.googleapis.com/maps/api/geocode/json?address=" +
    encodeURIComponent(fullAddress) +
    "&key=" +
    GOOGLE_MAPS_API_KEY;

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error("Error al consultar Geocoding");
  }
  const data = await resp.json();
  if (data.status !== "OK" || !data.results.length) {
    throw new Error("No se pudo geolocalizar la dirección");
  }
  const loc = data.results[0].geometry.location;
  const result = { lat: loc.lat, lng: loc.lng };
  geocodeCache.set(fullAddress, result);
  return result;
}

async function getTravelTimeMinutes(origin, destination) {
  if (origin.lat === destination.lat && origin.lng === destination.lng) {
    return 0;
  }

  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error("No hay GOOGLE_MAPS_API_KEY configurada");
  }

  const origins = `${origin.lat},${origin.lng}`;
  const destinations = `${destination.lat},${destination.lng}`;
  const url =
    "https://maps.googleapis.com/maps/api/distancematrix/json?units=metric" +
    "&origins=" +
    origins +
    "&destinations=" +
    destinations +
    "&key=" +
    GOOGLE_MAPS_API_KEY;

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error("Error al consultar Distance Matrix");
  }
  const data = await resp.json();
  if (data.status !== "OK") {
    throw new Error("Error en respuesta Distance Matrix");
  }

  const element = data.rows[0].elements[0];
  if (element.status !== "OK") {
    throw new Error("No se pudo calcular el tiempo de viaje");
  }

  const seconds = element.duration.value;
  const minutes = Math.ceil(seconds / 60);
  return minutes;
}

// =============== SLOTS ===============

function generateSlotsForDayAndBlock(dayDate, rawBlock) {
  const block = normalizeBlock(rawBlock);
  const slots = [];
  let startHour, endHour;
  if (block === "morning") {
    startHour = MORNING_START;
    endHour = MORNING_END;
  } else {
    startHour = AFTERNOON_START;
    endHour = AFTERNOON_END;
  }

  let current = buildDateWithHour(dayDate, startHour);
  const endBlock = buildDateWithHour(dayDate, endHour);

  while (current < endBlock) {
    const endSlot = addMinutes(current, SLOT_MINUTES);
    if (endSlot <= endBlock) {
      slots.push({
        start: new Date(current),
        end: new Date(endSlot),
      });
    }
    current = endSlot;
  }
  return slots;
}

// =============== LÓGICA DE RUTA (BLOQUEA SOLAPES + VIAJES) ===============

async function isSlotFeasible(
  slot,
  newLocation,
  rawBlock,
  existingAppointmentsForBlock
) {
  const block = normalizeBlock(rawBlock);

  // 0) BLOQUEO DURO: si el hueco pisa una cita existente → fuera
  for (const appt of existingAppointmentsForBlock) {
    const overlap =
      slot.start < appt.end && // empieza antes de que termine la otra
      slot.end > appt.start;   // y termina después de que empiece la otra

    if (overlap) {
      return false;
    }
  }

  const day = getDateOnly(slot.start);
  const today = getDateOnly(new Date());

  const blockStartHour =
    block === "morning" ? MORNING_START : AFTERNOON_START;
  const blockEndHour =
    block === "morning" ? MORNING_END : AFTERNOON_END;

  const blockStartDate = buildDateWithHour(day, blockStartHour);
  const blockEndDate = buildDateWithHour(day, blockEndHour);

  let currentTime = new Date(blockStartDate);
  let currentLocation = HOME_ALGECIRAS;

  if (day.getTime() === today.getTime()) {
    const now = new Date();
    if (now > currentTime) currentTime = now;
  }

  const newAppointment = {
    id: "NEW",
    start: new Date(slot.start),
    durationMinutes: SERVICE_MINUTES_DEFAULT,
    location: newLocation,
    block,
    status: "pending",
  };
  newAppointment.end = addMinutes(
    newAppointment.start,
    newAppointment.durationMinutes
  );

  const allAppointments = [...existingAppointmentsForBlock, newAppointment];
  allAppointments.sort((a, b) => a.start.getTime() - b.start.getTime());

  for (const appt of allAppointments) {
    const duration = appt.durationMinutes || SERVICE_MINUTES_DEFAULT;

    const travelMinutes = await getTravelTimeMinutes(
      currentLocation,
      appt.location || HOME_ALGECIRAS
    );
    const arrival = addMinutes(
      currentTime,
      travelMinutes + TRAVEL_MARGIN_MINUTES
    );

    if (arrival > appt.start) {
      return false;
    }

    const serviceEnd = addMinutes(appt.start, duration);

    currentTime = serviceEnd;
    currentLocation = appt.location || HOME_ALGECIRAS;

    if (currentTime > blockEndDate) {
      return false;
    }
  }

  const travelBackMinutes = await getTravelTimeMinutes(
    currentLocation,
    HOME_ALGECIRAS
  );
  const arrivalHome = addMinutes(
    currentTime,
    travelBackMinutes + TRAVEL_MARGIN_MINUTES
  );

  if (arrivalHome > blockEndDate) {
    return false;
  }

  return true;
}

// =============== FIRESTORE: SERVICIO POR TOKEN ===============

async function getServiceByToken(token) {
  console.log("Buscando cita en Firestore (appointments) para token:", token);

  const docRef = db.collection("appointments").doc(token);
  const docSnap = await docRef.get();

  if (!docSnap.exists) {
    console.warn("No se ha encontrado cita (appointments) para token:", token);
    return null;
  }

  const data = docSnap.data();

  return {
    token,
    serviceId: data.id || docSnap.id,
    name: data.clientName || data.name || "",
    phone: data.phone || data.phoneNumber || "",
    address: data.address || "",
    city: data.city || "",
    zip: data.zip || data.postalCode || "",
  };
}

// =============== FIRESTORE: CITAS DE ESE DÍA/BLOQUE ===============

async function getAppointmentsForDayBlock(dayDate, rawBlock) {
  const block = normalizeBlock(rawBlock);

  const dayStart = getDateOnly(dayDate);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60000);

  const startTs = admin.firestore.Timestamp.fromDate(dayStart);
  const endTs = admin.firestore.Timestamp.fromDate(dayEnd);

  const blockStartHour =
    block === "morning" ? MORNING_START : AFTERNOON_START;
  const blockEndHour =
    block === "morning" ? MORNING_END : AFTERNOON_END;

  const snap = await db
    .collection("appointments")
    .where("date", ">=", startTs)
    .where("date", "<", endTs)
    .get();

  const appointments = [];

  for (const doc of snap.docs) {
    const data = doc.data();
    if (!data.date) continue;

    let start;
    if (data.date.toDate) {
      start = data.date.toDate();
    } else {
      start = new Date(data.date);
      if (isNaN(start.getTime())) continue;
    }

    const hour = start.getHours();

    // Log para debug
    console.log(
      `   Cita ${doc.id} → hora ${hour}, block ${block}, rango ${blockStartHour}-${blockEndHour}`
    );

    if (hour < blockStartHour || hour >= blockEndHour) continue;

    const rawDuration =
      typeof data.duration === "number"
        ? data.duration
        : SERVICE_MINUTES_DEFAULT;
    const duration = Math.max(rawDuration, SERVICE_MINUTES_DEFAULT);
    const end = addMinutes(start, duration);

    const fullAddress = data.address;
    let location = HOME_ALGECIRAS;
    try {
      location = await geocodeAddress(fullAddress);
    } catch (e) {
      console.warn(
        "No se pudo geocodificar dirección de cita, usando HOME_ALGECIRAS:",
        fullAddress,
        e.message
      );
    }

    appointments.push({
      id: doc.id,
      start,
      end,
      durationMinutes: duration,
      location,
      block,
      status: data.status || "unknown",
    });
  }

  console.log(
    `Encontradas ${appointments.length} citas para ${dayStart
      .toISOString()
      .slice(0, 10)} bloque normalizado=${block}`
  );

  return appointments;
}

// =============== FIRESTORE: GUARDAR SOLICITUD ONLINE ===============

async function createAppointmentRequest(payload) {
  const now = new Date();

  const docToSave = {
    ...payload,
    createdAt: now.toISOString(),
    createdAtTimestamp: admin.firestore.Timestamp.fromDate(now),
  };

  const docRef = await db
    .collection("onlineAppointmentRequests")
    .add(docToSave);

  console.log(
    "Solicitud de cita guardada en Firestore con id:",
    docRef.id
  );

  return { requestId: docRef.id };
}

// =============== ENDPOINTS ===============

app.post("/client-from-token", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: "Falta token" });
    }

    const service = await getServiceByToken(token);
    if (!service) {
      return res
        .status(404)
        .json({ error: "Servicio no encontrado para ese token" });
    }

    return res.json({
      name: service.name,
      phone: service.phone,
      address: service.address,
      city: service.city,
      zip: service.zip,
      serviceId: service.serviceId,
    });
  } catch (err) {
    console.error("Error en /client-from-token:", err);
    res.status(500).json({ error: "Error interno" });
  }
});

app.post("/availability-smart", async (req, res) => {
  try {
    const { token, block, rangeDays } = req.body;

    if (!token || !block) {
      return res
        .status(400)
        .json({ error: "Faltan parámetros (token o block)" });
    }

    const normBlock = normalizeBlock(block);
    console.log("🕒 availability-smart → block recibido:", block, "normalizado:", normBlock);

    const range = typeof rangeDays === "number" ? rangeDays : 14;

    const service = await getServiceByToken(token);
    if (!service) {
      return res
        .status(404)
        .json({ error: "Servicio no encontrado para ese token" });
    }

    const fullAddress =
      service.address +
      (service.city ? ", " + service.city : "") +
      (service.zip ? ", " + service.zip : "");

    const clientLocation = await geocodeAddress(fullAddress);

    const allDays = getNextDays(range);
    const resultDays = [];
    const now = new Date();
    const todayDateOnly = getDateOnly(now);

    for (const day of allDays) {
      const dayOfWeek = day.getDay(); // 0 = domingo, 6 = sábado
      if (dayOfWeek === 0 || dayOfWeek === 6) continue; // sin findes

      const isToday = getDateOnly(day).getTime() === todayDateOnly.getTime();

      const existingAppointments = await getAppointmentsForDayBlock(
        day,
        normBlock
      );
      const slots = generateSlotsForDayAndBlock(day, normBlock);
      const validSlots = [];

      for (const slot of slots) {
        if (isToday && slot.start <= now) {
          continue; // no horas pasadas hoy
        }

        const feasible = await isSlotFeasible(
          slot,
          clientLocation,
          normBlock,
          existingAppointments
        );
        if (feasible) {
          validSlots.push({
            startTime: formatTime(slot.start),
            endTime: formatTime(slot.end),
          });
        }
      }

      if (validSlots.length) {
        const dateStr = day.toISOString().slice(0, 10); // YYYY-MM-DD
        const label = buildPrettyDayLabel(day, normBlock);
        resultDays.push({
          date: dateStr,
          label,
          slots: validSlots,
        });
      }
    }

    return res.json({ days: resultDays });
  } catch (err) {
    console.error("Error en /availability-smart:", err);
    res.status(500).json({ error: "Error interno" });
  }
});

app.post("/appointment-request", async (req, res) => {
  try {
    const { token, block, date, startTime, endTime } = req.body;

    if (!token || !block || !date || !startTime || !endTime) {
      return res.status(400).json({ error: "Faltan parámetros" });
    }

    const service = await getServiceByToken(token);
    if (!service) {
      return res
        .status(404)
        .json({ error: "Servicio no encontrado para ese token" });
    }

    const payload = {
      token,
      block: normalizeBlock(block),
      date,
      startTime,
      endTime,
      serviceId: service.serviceId,
      clientName: service.name,
      clientPhone: service.phone,
      address: service.address,
      city: service.city,
      zip: service.zip,
      status: "pending",
    };

    const result = await createAppointmentRequest(payload);

    return res.json({
      ok: true,
      requestId: result.requestId,
    });
  } catch (err) {
    console.error("Error en /appointment-request:", err);
    res.status(500).json({ error: "Error interno" });
  }
});

// =============== TEXTO BONITO PARA EL DÍA ===============

function buildPrettyDayLabel(date, block) {
  const dias = [
    "Domingo",
    "Lunes",
    "Martes",
    "Miércoles",
    "Jueves",
    "Viernes",
    "Sábado",
  ];
  const meses = [
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre",
  ];

  const d = date.getDate();
  const diaSemana = dias[date.getDay()];
  const mes = meses[date.getMonth()];
  const bloqueTexto =
    normalizeBlock(block) === "morning" ? "mañana" : "tarde";

  return `${diaSemana} ${d} de ${mes} (${bloqueTexto})`;
}

// =============== RUTA DE PRUEBA ===============

app.get("/", (req, res) => {
  res.send("Marsalva Smart Backend en marcha ✅");
});

// =============== ARRANCAR SERVIDOR ===============

app.listen(PORT, () => {
  console.log("✅ Servidor escuchando en puerto", PORT);
});
