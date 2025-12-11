// server.js
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

// NOTA: En Node 18+ (Render) 'fetch' es nativo. No hace falta importar node-fetch.

// =============== INICIALIZACIÓN FIREBASE ===============
if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawPrivateKey = process.env.FIREBASE_PRIVATE_KEY;

  console.log("🚀 Marsalva Smart Backend V3 (Logic: Anti-Zigzag) arrancando...");

  if (!projectId || !clientEmail || !rawPrivateKey) {
    console.error("❌ ERROR CRÍTICO: Faltan variables de entorno de Firebase.");
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

// =============== CONFIGURACIÓN DEL NEGOCIO (TUS REGLAS) ===============

// Tu Base: Algeciras
const HOME_ALGECIRAS = { lat: 36.1408, lng: -5.4562 };

// ⏰ HORARIOS EXACTOS
const SCHEDULE = {
  morning:   { startHour: 9,  startMinute: 30, endHour: 14, endMinute: 0 },
  afternoon: { startHour: 17, startMinute: 0,  endHour: 19, endMinute: 0 }
};

// ⏱️ TIEMPOS Y REGLAS DE VIAJE
const SLOT_INTERVAL = 30;         // Ofrecer huecos cada 30 min (9:30, 10:00, 10:30...)
const SERVICE_DEFAULT_MIN = 60;   // Duración mínima si no se especifica
const TRAVEL_MARGIN_MINUTES = 15; // Colchón: Aparcar, subir herramientas, saludar.

// 🚫 REGLA ANTI-ZIGZAG (IMPORTANTE)
// Si el viaje entre cita A y cita B tarda más de X minutos, el sistema dice "NO".
// Esto evita ir de Algeciras a La Línea y volver. Te obliga a quedarte por la zona.
const MAX_TRAVEL_ALLOWED_BETWEEN_JOBS = 30; 

// Google API
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";
const PORT = process.env.PORT || 10000;

const app = express();
app.use(cors());
app.use(express.json());

// Cachés para ahorrar dinero en Google Maps
const geocodeCache = new Map();
const distanceCache = new Map();

// =============== UTILIDADES DE FECHA (ZONA ESPAÑA) ===============

// Truco para asegurar que siempre calculamos con hora de España
function getSpainDate(dateInput = new Date()) {
  const d = new Date(dateInput);
  const spainString = d.toLocaleString("en-US", { timeZone: "Europe/Madrid" });
  return new Date(spainString);
}

function getDateOnly(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Crea una fecha base con hora específica
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
  if (b.includes("tard") || b.includes("after")) return "afternoon";
  return "morning";
}

// =============== GOOGLE MAPS INTELIGENTE ===============

async function geocodeAddress(fullAddress) {
  if (!fullAddress) throw new Error("Dirección vacía");
  if (geocodeCache.has(fullAddress)) return geocodeCache.get(fullAddress);
  
  // Fallback si no hay API Key
  if (!GOOGLE_MAPS_API_KEY) return HOME_ALGECIRAS;

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(fullAddress)}&key=${GOOGLE_MAPS_API_KEY}`;
  
  try {
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.status !== "OK" || !data.results.length) return HOME_ALGECIRAS; // Fallback seguro
    
    const loc = data.results[0].geometry.location;
    const result = { lat: loc.lat, lng: loc.lng };
    geocodeCache.set(fullAddress, result);
    return result;
  } catch (e) {
    console.error("Error Geocoding:", e.message);
    return HOME_ALGECIRAS;
  }
}

async function getTravelTimeMinutes(origin, destination) {
  // Si es la misma ubicación (o muy cerca)
  if (Math.abs(origin.lat - destination.lat) < 0.001 && Math.abs(origin.lng - destination.lng) < 0.001) {
    return 0;
  }

  const cacheKey = `${origin.lat},${origin.lng}_${destination.lat},${destination.lng}`;
  if (distanceCache.has(cacheKey)) return distanceCache.get(cacheKey);

  if (!GOOGLE_MAPS_API_KEY) return 20; // Estimación por defecto si no hay API

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
    console.error("Error Matrix:", e.message);
  }
  return 20; // Fallback seguro
}

// =============== GENERADOR DE HUECOS ===============

function generateSlotsForDayAndBlock(dayDate, rawBlock) {
  const block = normalizeBlock(rawBlock);
  const config = SCHEDULE[block];

  const slots = [];
  let current = setTime(dayDate, config.startHour, config.startMinute);
  const endLimit = setTime(dayDate, config.endHour, config.endMinute);

  while (current < endLimit) {
    // Probamos huecos cada 30 minutos
    slots.push(new Date(current));
    current = addMinutes(current, SLOT_INTERVAL);
  }
  return slots;
}

// =============== 🧠 EL CEREBRO: VALIDADOR DE RUTAS ===============

async function isSlotFeasible(slotStart, newLocation, newDuration, rawBlock, existingAppointments) {
  const block = normalizeBlock(rawBlock);
  const config = SCHEDULE[block];
  const day = getDateOnly(slotStart);
  
  // Limites del bloque
  const blockStartTime = setTime(day, config.startHour, config.startMinute);
  const blockEndTime = setTime(day, config.endHour, config.endMinute);

  // 1. Crear candidato
  const newAppt = {
    id: "NEW",
    start: new Date(slotStart),
    end: addMinutes(slotStart, newDuration),
    location: newLocation,
    duration: newDuration
  };

  // Validación básica: ¿Termina antes de cerrar el turno?
  if (newAppt.end > blockEndTime) return false;

  // 2. Mezclar con ruta actual y ordenar
  const dailyRoute = [...existingAppointments, newAppt].sort((a, b) => a.start - b.start);

  // 3. Validar superposiciones (Overlap)
  for (let i = 0; i < dailyRoute.length - 1; i++) {
    const current = dailyRoute[i];
    const next = dailyRoute[i+1];
    // Si la actual termina DESPUÉS de que empiece la siguiente -> MAL
    if (current.end > next.start) return false; 
  }

  // 4. SIMULACIÓN DE VIAJE (TSP simplificado)
  // Empezamos simulando desde Casa o desde donde estemos a las 8:00
  let currentLocation = HOME_ALGECIRAS;
  
  // Hora de "salida" de casa. Tú dices que sales a las 8:00.
  // Pero la primera cita es a las 9:30.
  // Verificaremos que el viaje Casa -> Primera Cita sea posible saliendo a las 8:00.
  let simulatedTime = setTime(day, 8, 0); 

  for (let i = 0; i < dailyRoute.length; i++) {
    const appt = dailyRoute[i];
    
    // Calcular viaje desde la ubicación anterior (o casa)
    const travelMinutes = await getTravelTimeMinutes(currentLocation, appt.location);
    
    // REGLA DE ORO: No desplazamientos locos entre clientes
    // Si NO es el primer viaje desde casa (ese puede ser largo si vas a Tarifa),
    // y el viaje entre clientes supera el máximo permitido... BLOQUEAR.
    if (i > 0 && travelMinutes > MAX_TRAVEL_ALLOWED_BETWEEN_JOBS) {
      // Ejemplo: De La Línea (appt anterior) a Algeciras (nueva) son > 30 min? -> FUERA.
      return false; 
    }

    // Hora a la que llegaríamos
    const arrivalTime = addMinutes(simulatedTime, travelMinutes + TRAVEL_MARGIN_MINUTES);

    // ¿Llegamos tarde al inicio de la cita?
    if (arrivalTime > appt.start) {
      return false; // Imposible llegar
    }

    // Actualizamos simulación: Hacemos el trabajo
    // La hora actual pasa a ser cuando termina este trabajo
    simulatedTime = appt.end;
    currentLocation = appt.location;
  }

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
    city: d.city || "", 
    zip: d.zip || "",
    name: d.clientName || "Cliente",
    // Si la cita de origen tiene una duración estimada, la usamos
    // Si no, por defecto 60 min.
    duration: d.estimatedDuration || SERVICE_DEFAULT_MIN 
  };
}

async function getAppointmentsForDay(dateObj, block) {
  const startD = getDateOnly(dateObj);
  const endD = addMinutes(startD, 24 * 60);

  // Convertimos a Timestamp de Firestore
  const startTs = admin.firestore.Timestamp.fromDate(startD);
  const endTs = admin.firestore.Timestamp.fromDate(endD);

  const snap = await db.collection("appointments")
    .where("date", ">=", startTs)
    .where("date", "<", endTs)
    .get();

  const appts = [];
  for (const doc of snap.docs) {
    const data = doc.data();
    const apptDate = data.date.toDate(); // Firestore Timestamp -> JS Date
    
    // Filtramos por bloque horario
    const hour = apptDate.getHours();
    const isMorning = hour < 15;
    
    if (normalizeBlock(block) === "morning" && !isMorning) continue;
    if (normalizeBlock(block) === "afternoon" && isMorning) continue;

    let loc = HOME_ALGECIRAS;
    // Intentamos geolocalizar la cita existente
    if (data.address) {
       try { 
         const full = data.address + (data.city ? ", " + data.city : "");
         loc = await geocodeAddress(full); 
       } catch(e){}
    }

    // IMPORTANTE: Leemos la duración real de la cita existente
    const realDuration = data.duration || SERVICE_DEFAULT_MIN;

    appts.push({
      id: doc.id,
      start: apptDate,
      end: addMinutes(apptDate, realDuration),
      location: loc,
      duration: realDuration
    });
  }
  return appts;
}

// =============== ENDPOINTS ===============

app.post("/availability-smart", async (req, res) => {
  try {
    const { token, block, rangeDays } = req.body;
    const range = rangeDays || 14; 
    
    const service = await getServiceByToken(token);
    if (!service) return res.status(404).json({ error: "Token inválido" });

    // Geolocalizamos al NUEVO cliente
    const fullAddr = `${service.address}, ${service.city}, ${service.zip}`;
    const clientLoc = await geocodeAddress(fullAddr);
    
    // Duración de ESTE nuevo servicio (si no está definida, 60 min)
    const newServiceDuration = service.duration || SERVICE_DEFAULT_MIN;

    const resultDays = [];
    const today = getSpainDate();
    
    // Iteramos los próximos días
    for (let i = 0; i < range; i++) {
      const day = addMinutes(today, i * 24 * 60);
      const dayNum = day.getDay();
      if (dayNum === 0 || dayNum === 6) continue; // Fin de semana libre

      const existingAppts = await getAppointmentsForDay(day, block);
      const possibleStartTimes = generateSlotsForDayAndBlock(day, block);
      
      const validSlots = [];

      for (const slotStart of possibleStartTimes) {
        // No mostrar horas pasadas hoy
        if (slotStart < today) continue;

        const feasible = await isSlotFeasible(
          slotStart, 
          clientLoc, 
          newServiceDuration,
          block, 
          existingAppts
        );

        if (feasible) {
          validSlots.push({
            startTime: formatTime(slotStart),
            endTime: formatTime(addMinutes(slotStart, newServiceDuration))
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
  const { token, date, startTime, endTime } = req.body;
  
  if (!token || !date || !startTime) return res.status(400).json({error: "Datos faltantes"});

  // Construir fecha completa
  const [h, m] = startTime.split(":");
  const finalDate = new Date(date);
  finalDate.setHours(parseInt(h), parseInt(m), 0, 0);
  
  // Calcular duración basada en start/end o default
  // Esto es solo para guardar el registro
  
  const service = await getServiceByToken(token);

  const docRef = await db.collection("onlineAppointmentRequests").add({
    token,
    serviceId: service ? service.serviceId : null,
    clientName: service ? service.name : "Desconocido",
    date: admin.firestore.Timestamp.fromDate(finalDate),
    requestedTime: startTime,
    status: "pending",
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  res.json({ ok: true, id: docRef.id });
});

// Endpoint auxiliar para ver datos del cliente
app.post("/client-from-token", async (req, res) => {
  const { token } = req.body;
  const s = await getServiceByToken(token);
  if(!s) return res.status(404).json({error:"No encontrado"});
  res.json(s);
});

app.listen(PORT, () => console.log(`🚀 Marsalva Smart Backend V3 corriendo en puerto ${PORT}`));
