// server.js
const express = require("express");
const cors = require("cors");

// node-fetch en modo CommonJS
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

// =============== CONFIGURACIÓN BÁSICA ===============

// Coordenadas aproximadas de tu base (Algeciras)
const HOME_ALGECIRAS = {
  lat: 36.1408,
  lng: -5.4562,
};

// Horarios
const MORNING_START = 9;   // 09:00
const MORNING_END = 14;    // 14:00
const AFTERNOON_START = 16; // 16:00
const AFTERNOON_END = 20;   // 20:00;

// Duraciones (minutos)
const SLOT_MINUTES = 60;
const SERVICE_MINUTES_DEFAULT = 60;
const TRAVEL_MARGIN_MINUTES = 10;

// Clave de Google (en Render → Environment → variable GOOGLE_MAPS_API_KEY)
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";

// Puerto
const PORT = process.env.PORT || 10000;

const app = express();
app.use(cors());
app.use(express.json());

// =============== UTILIDADES GENERALES ===============

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

// =============== GOOGLE MAPS: GEOCODING + DISTANCIA ===============

async function geocodeAddress(fullAddress) {
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
  return { lat: loc.lat, lng: loc.lng };
}

async function getTravelTimeMinutes(origin, destination) {
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

// =============== GENERAR SLOTS POR DÍA Y BLOQUE ===============

function generateSlotsForDayAndBlock(dayDate, block) {
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

// =============== LÓGICA DE RUTA ===============

async function isSlotFeasible(slot, newLocation, block, existingAppointmentsForBlock) {
  const day = getDateOnly(slot.start);
  const blockStartHour = block === "morning" ? MORNING_START : AFTERNOON_START;
  const blockEndHour = block === "morning" ? MORNING_END : AFTERNOON_END;

  const newAppointment = {
    id: "NEW",
    start: new Date(slot.start),
    end: addMinutes(slot.start, SERVICE_MINUTES_DEFAULT),
    location: newLocation,
    block,
    status: "pending",
  };

  const allAppointments = [...existingAppointmentsForBlock, newAppointment];
  allAppointments.sort((a, b) => a.start.getTime() - b.start.getTime());

  let currentTime = buildDateWithHour(day, blockStartHour);
  let currentLocation = HOME_ALGECIRAS;
  const blockEndDate = buildDateWithHour(day, blockEndHour);

  for (const appt of allAppointments) {
    const travelMinutes = await getTravelTimeMinutes(currentLocation, appt.location);
    const arrival = addMinutes(currentTime, travelMinutes + TRAVEL_MARGIN_MINUTES);

    if (arrival > appt.end) {
      return false;
    }

    const startService = arrival > appt.start ? arrival : appt.start;
    const endService = addMinutes(startService, SERVICE_MINUTES_DEFAULT);

    currentTime = endService;
    currentLocation = appt.location;

    if (currentTime > blockEndDate) {
      return false;
    }
  }

  const travelBackMinutes = await getTravelTimeMinutes(currentLocation, HOME_ALGECIRAS);
  const arrivalHome = addMinutes(currentTime, travelBackMinutes + TRAVEL_MARGIN_MINUTES);

  if (arrivalHome > blockEndDate) {
    return false;
  }

  return true;
}

// =============== "BASE DE DATOS" SIMULADA ===============

// TODO: cambia estas funciones para conectar con tu BD real

async function getServiceByToken(token) {
  // Aquí deberías buscar en tu BD usando el token.
  // De momento: datos simulados para probar.
  return {
    token,
    serviceId: "SV-" + token.slice(0, 6),
    name: "Cliente de prueba",
    phone: "600000000",
    address: "Calle Ejemplo 1",
    city: "Algeciras",
    zip: "11201",
  };
}

async function getAppointmentsForDayBlock(dayDate, block) {
  // Aquí deberías devolver las citas reales de ese día y bloque.
  // De momento, ninguna: array vacío.
  return [];
}

async function createAppointmentRequest(payload) {
  // Aquí deberías guardar en tu BD (colección de "solicitudes online").
  console.log("Creando solicitud de cita pendiente:", payload);
  return {
    requestId: "REQ-" + Date.now(),
  };
}

// =============== ENDPOINTS ===============

// 1) Sacar datos del cliente a partir del token
app.post("/client-from-token", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: "Falta token" });
    }

    const service = await getServiceByToken(token);
    if (!service) {
      return res.status(404).json({ error: "Servicio no encontrado para ese token" });
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

// 2) Devolver huecos inteligentes (mañana/tarde) para los próximos días
app.post("/availability-smart", async (req, res) => {
  try {
    const { token, block, rangeDays } = req.body;

    if (!token || !block) {
      return res.status(400).json({ error: "Faltan parámetros (token o block)" });
    }

    const range = typeof rangeDays === "number" ? rangeDays : 14;

    const service = await getServiceByToken(token);
    if (!service) {
      return res.status(404).json({ error: "Servicio no encontrado para ese token" });
    }

    const fullAddress =
      service.address +
      ", " +
      (service.zip ? service.zip + ", " : "") +
      service.city;

    const clientLocation = await geocodeAddress(fullAddress);
    const days = getNextDays(range);
    const resultDays = [];

    for (const day of days) {
      const existingAppointments = await getAppointmentsForDayBlock(day, block);
      const slots = generateSlotsForDayAndBlock(day, block);
      const validSlots = [];

      for (const slot of slots) {
        const feasible = await isSlotFeasible(
          slot,
          clientLocation,
          block,
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
        const label = buildPrettyDayLabel(day, block);
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

// 3) Crear solicitud de cita pendiente
app.post("/appointment-request", async (req, res) => {
  try {
    const { token, block, date, startTime, endTime } = req.body;

    if (!token || !block || !date || !startTime || !endTime) {
      return res.status(400).json({ error: "Faltan parámetros" });
    }

    const service = await getServiceByToken(token);
    if (!service) {
      return res.status(404).json({ error: "Servicio no encontrado para ese token" });
    }

    const payload = {
      token,
      block,
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
      createdAt: new Date().toISOString(),
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

// Etiqueta bonita de día
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
  const bloqueTexto = block === "morning" ? "mañana" : "tarde";

  return `${diaSemana} ${d} de ${mes} (${bloqueTexto})`;
}

// Salud
app.get("/", (req, res) => {
  res.send("Marsalva Smart Backend en marcha ✅");
});

app.listen(PORT, () => {
  console.log("Servidor escuchando en puerto", PORT);
});
