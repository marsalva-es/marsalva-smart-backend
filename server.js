// server.js
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

// NOTA: En Node 18+ 'fetch' es nativo. Si usas Node anterior, descomenta la siguiente línea:
// const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

// =============== INICIALIZACIÓN FIREBASE ===============
if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  // Truco: maneja tanto saltos de línea literales como escapados
  const rawPrivateKey = process.env.FIREBASE_PRIVATE_KEY;

  console.log("🚀 Marsalva Smart Backend V2 arrancando...");
  
  if (!projectId || !clientEmail || !rawPrivateKey) {
    console.error("❌ ERROR: Faltan variables de entorno de Firebase.");
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

// =============== CONFIGURACIÓN DEL NEGOCIO ===============

// Tu Base (Algeciras)
const HOME_ALGECIRAS = { lat: 36.1408, lng: -5.4562 };

// Horarios (Formato 24h)
const SCHEDULE = {
  morning:   { startHour: 9,  startMinute: 30, endHour: 14, endMinute: 0 },
  afternoon: { startHour: 17, startMinute: 0,  endHour: 19, endMinute: 0 }
};

// Duraciones y Reglas
const SLOT_MINUTES = 60;          // Huecos de 1 hora
const SERVICE_DEFAULT = 60;       // Duración servicio estándar
const TRAVEL_MARGIN_MINUTES = 10; // Tiempo extra para aparcar/llegar
const MAX_TRAVEL_MINUTES = 40;    // "NO VIAJES LOCOS": Máximo tiempo conduciendo entre citas

// Google API
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";

const app = express();
app.use(cors());
app.use(express.json());

// Cache simple en memoria para no pagar de más a Google
const geocodeCache = new Map();
const distanceCache = new Map(); // Clave: "lat1,lng1_lat2,lng2"

// =============== UTILIDADES DE TIEMPO (ZONA ESPAÑA) ===============

// Fuerza la fecha a hora peninsular para evitar líos de servidores en UTC
function getSpainDate(dateInput = new Date()) {
  const d = new Date(dateInput);
  // Convertimos a string en zona horaria de Madrid y volvemos a crear objeto Date
  // Esto es un "truco" para operaciones locales. Lo ideal es usar librerías como Luxon.
  const spainString = d.toLocaleString("en-US", { timeZone: "Europe/Madrid" });
  return new Date(spainString);
}

function getDateOnly(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function setTime(baseDate, hour, minute) {
  const d = new Date(baseDate);
  d.setHours(hour, minute, 0, 0);
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

function normalizeBlock(block) {
  const b = (block || "").toString().toLowerCase();
  if (b.includes("tard") || b.includes("after") || b.includes("pm")) return "afternoon";
  return "morning";
}

// =============== GOOGLE MAPS (CON CACHÉ) ===============

async function geocodeAddress(fullAddress) {
  if (!fullAddress) throw new Error("Dirección vacía");
  if (geocodeCache.has(fullAddress)) return geocodeCache.get(fullAddress);
  if (!GOOGLE_MAPS_API_KEY) throw new Error("Falta API KEY de Google");

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(fullAddress)}&key=${GOOGLE_MAPS_API_KEY}`;
  
  try {
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.status !== "OK" || !data.results.length) throw new Error("Dirección no encontrada");
    
    const loc = data.results[0].geometry.location;
    const result = { lat: loc.lat, lng: loc.lng };
    geocodeCache.set(fullAddress, result);
    return result;
  } catch (e) {
    console.error("Error Geocoding:", e.message);
    // Fallback: Devolvemos Algeciras si falla para no romper la app (OJO: esto es temporal)
    return HOME_ALGECIRAS;
  }
}

async function getTravelTimeMinutes(origin, destination) {
  // Si son casi iguales, 0 minutos
  if (Math.abs(origin.lat - destination.lat) < 0.0001 && Math.abs(origin.lng - destination.lng) < 0.0001) {
    return 0;
  }

  const cacheKey = `${origin.lat},${origin.lng}_${destination.lat},${destination.lng}`;
  if (distanceCache.has(cacheKey)) return distanceCache.get(cacheKey);

  if (!GOOGLE_MAPS_API_KEY) return 20; // Fallback sin API Key

  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?units=metric&origins=${origin.lat},${origin.lng}&destinations=${destination.lat},${destination.lng}&key=${GOOGLE_MAPS_API_KEY}`;

  try {
    const resp = await fetch(url);
    const data = await resp.json();
    
    if (data.status === "OK" && data.rows[0].elements[0].status === "OK") {
      const seconds = data.rows[0].elements[0].duration.value;
      const minutes = Math.ceil(seconds / 60);
      distanceCache.set(cacheKey, minutes);
      return minutes;
    }
  } catch (e) {
    console.error("Error Distance Matrix:", e.message);
  }
  
  // Si falla Google, calculamos "a ojo" (seguridad)
  return 20; 
}

// =============== GENERADOR DE HUECOS ===============

function generateSlotsForDayAndBlock(dayDate, rawBlock) {
  const block = normalizeBlock(rawBlock);
  const config = SCHEDULE[block];

  const slots = [];
  
  // Configurar hora inicio y fin exactas (ej. 09:30 y 14:00)
  let current = setTime(dayDate, config.startHour, config.startMinute);
  const endLimit = setTime(dayDate, config.endHour, config.endMinute);

  while (current < endLimit) {
    const endSlot = addMinutes(current, SLOT_MINUTES);
    
    // Solo añadimos si el servicio termina antes o a la misma hora del cierre
    if (endSlot <= endLimit) {
      slots.push({
        start: new Date(current),
        end: new Date(endSlot),
      });
    }
    // Avanzamos en intervalos de 30 mins para dar flexibilidad al usuario? 
    // O de hora en hora? Aquí lo dejo de hora en hora según SLOT_MINUTES
    current = addMinutes(current, 30); // <--- CAMBIO: Saltos de 30 min para más opciones (9:30, 10:00, 10:30...)
  }
  return slots;
}

// =============== EL CEREBRO DE LA RUTA ===============

async function isSlotFeasible(slot, newLocation, rawBlock, existingAppointments) {
  const block = normalizeBlock(rawBlock);
  const config = SCHEDULE[block];
  const day = getDateOnly(slot.start);
  
  const blockEndTime = setTime(day, config.endHour, config.endMinute);

  // 1. Crear el objeto de la nueva cita propuesta
  const newAppt = {
    id: "NEW_CANDIDATE",
    start: new Date(slot.start),
    end: addMinutes(slot.start, SERVICE_DEFAULT),
    location: newLocation,
    duration: SERVICE_DEFAULT
  };

  // 2. Fusionar con las citas existentes y ORDENAR por hora
  const dailyRoute = [...existingAppointments, newAppt].sort((a, b) => a.start - b.start);

  // 3. Validar superposición directa (PISADA)
  for (let i = 0; i < dailyRoute.length - 1; i++) {
    const current = dailyRoute[i];
    const next = dailyRoute[i+1];
    // Si una empieza antes de que acabe la otra
    if (current.end > next.start) {
      return false; // Se pisan
    }
  }

  // 4. Simular la ruta completa: Casa -> Cita1 -> Cita2 ... -> Casa
  let currentLocation = HOME_ALGECIRAS;
  let currentTime = setTime(day, config.startHour, config.startMinute); 
  
  // Si es hoy, no podemos viajar en el pasado
  const now = getSpainDate();
  if (day.getTime() === getDateOnly(now).getTime()) {
    if (currentTime < now) currentTime = now;
  }

  for (const appt of dailyRoute) {
    // A. Viaje hacia la cita
    const travelTo = await getTravelTimeMinutes(currentLocation, appt.location);
    
    // REGLA: No desplazamientos locos
    if (travelTo > MAX_TRAVEL_MINUTES) {
      // Si el viaje es de más de X min, descartamos este hueco porque rompe la logística
      return false; 
    }

    const arrivalTime = addMinutes(currentTime, travelTo + TRAVEL_MARGIN_MINUTES);

    // B. ¿Llegamos a tiempo para empezar la cita?
    if (arrivalTime > appt.start) {
      return false; // Llegamos tarde
    }

    // C. Realizamos el servicio
    // Actualizamos tiempo y ubicación al salir de la cita
    currentTime = appt.end;
    currentLocation = appt.location;
  }

  // 5. Vuelta a casa (opcional validar si quieres volver a comer/cenar a hora)
  const travelHome = await getTravelTimeMinutes(currentLocation, HOME_ALGECIRAS);
  const arrivalHome = addMinutes(currentTime, travelHome);

  // Si quieres ser estricto con volver a casa antes del cierre del bloque:
  // if (arrivalHome > blockEndTime) return false; 
  
  // Si solo te importa que el servicio termine dentro del horario:
  if (newAppt.end > blockEndTime) return false;

  return true;
}

// =============== FIRESTORE FETCH ===============

async function getServiceByToken(token) {
  const doc = await db.collection("appointments").doc(token).get();
  if (!doc.exists) return null;
  const d = doc.data();
  return { 
    token, 
    address: d.address || "", 
    city: d.city || "Algeciras", 
    zip: d.zip || "",
    name: d.clientName || "Cliente"
  };
}

async function getAppointmentsForDay(dateObj, block) {
  const startD = getDateOnly(dateObj);
  const endD = addMinutes(startD, 24 * 60);

  const snap = await db.collection("appointments")
    .where("date", ">=", startD)
    .where("date", "<", endD)
    .get();

  const appts = [];
  for (const doc of snap.docs) {
    const data = doc.data();
    const apptDate = data.date.toDate(); // Asumiendo Timestamp de Firestore
    
    // Filtrar si pertenece al bloque (mañana o tarde)
    const hour = apptDate.getHours();
    const isMorning = hour < 15; // Corte simple a las 15:00
    
    if (normalizeBlock(block) === "morning" && !isMorning) continue;
    if (normalizeBlock(block) === "afternoon" && isMorning) continue;

    let loc = HOME_ALGECIRAS;
    if (data.address) {
       try { loc = await geocodeAddress(data.address + ", " + (data.city || "Algeciras")); } catch(e){}
    }

    appts.push({
      id: doc.id,
      start: apptDate,
      end: addMinutes(apptDate, data.duration || SERVICE_DEFAULT),
      location: loc
    });
  }
  return appts;
}

// =============== API ENDPOINTS ===============

app.post("/availability-smart", async (req, res) => {
  try {
    const { token, block, rangeDays } = req.body;
    const range = rangeDays || 14; 
    
    const service = await getServiceByToken(token);
    if (!service) return res.status(404).json({ error: "Token inválido" });

    // Geolocalizamos al cliente UNA VEZ
    const fullAddr = `${service.address}, ${service.city}, ${service.zip}`;
    const clientLoc = await geocodeAddress(fullAddr);

    const resultDays = [];
    const today = getSpainDate();
    
    // Generar días
    for (let i = 0; i < range; i++) {
      const day = addMinutes(today, i * 24 * 60);
      if (day.getDay() === 0 || day.getDay() === 6) continue; // Saltar Sábado/Domingo

      const existingAppts = await getAppointmentsForDay(day, block);
      const possibleSlots = generateSlotsForDayAndBlock(day, block);
      
      const validSlots = [];

      for (const slot of possibleSlots) {
        // Filtrar pasado
        if (slot.start < today) continue;

        const feasible = await isSlotFeasible(slot, clientLoc, block, existingAppts);
        if (feasible) {
          validSlots.push({
            startTime: formatTime(slot.start),
            endTime: formatTime(slot.end)
          });
        }
      }

      if (validSlots.length > 0) {
        resultDays.push({
          date: day.toISOString().slice(0, 10),
          label: day.toLocaleDateString("es-ES", { weekday: 'long', day: 'numeric', month: 'long' }),
          slots: validSlots
        });
      }
    }

    res.json({ days: resultDays });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error interno" });
  }
});

app.post("/appointment-request", async (req, res) => {
  // ... (Misma lógica de guardado que tenías, solo asegúrate de guardar 'date' como Timestamp)
  const { token, date, startTime } = req.body;
  
  // Reconstruir fecha completa
  const [h, m] = startTime.split(":");
  const finalDate = new Date(date);
  finalDate.setHours(parseInt(h), parseInt(m), 0, 0);

  const docRef = await db.collection("onlineAppointmentRequests").add({
    token,
    date: admin.firestore.Timestamp.fromDate(finalDate),
    status: "pending",
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  res.json({ ok: true, id: docRef.id });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Servidor Marsalva escuchando en ${PORT}`));
