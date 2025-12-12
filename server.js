// server.js (V5 - COMPARACIÓN MATEMÁTICA SEGURA + LOGS DETALLADOS)
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const jwt = require("jsonwebtoken");

// =============== INICIALIZACIÓN FIREBASE ===============
if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawPrivateKey = process.env.FIREBASE_PRIVATE_KEY;

  console.log("🚀 Marsalva Backend V5 (Logic: Math Overlaps) arrancando...");

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

// =============== CONFIGURACIÓN ===============
const HOME_ALGECIRAS = { lat: 36.1408, lng: -5.4562 };
const SCHEDULE = {
  morning: { startHour: 9, startMinute: 30, endHour: 14, endMinute: 0 },
  afternoon: { startHour: 17, startMinute: 0, endHour: 20, endMinute: 0 }, // Ampliado a 20:00
};
const SLOT_INTERVAL = 30;
const SERVICE_DEFAULT_MIN = 60;
const TRAVEL_MARGIN_MINUTES = 15;
const MAX_TRAVEL_ALLOWED_BETWEEN_JOBS = 30;

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";
const ADMIN_USER = process.env.ADMIN_USER || "";
const ADMIN_PASS = process.env.ADMIN_PASS || "";
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || "";
const PORT = process.env.PORT || 10000;

const app = express();
app.use(cors({ origin: true, methods: ["GET", "POST", "DELETE", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.use(express.json());

const geocodeCache = new Map();
const distanceCache = new Map();

// =============== UTILIDADES TIEMPO ===============
function toSpainDate(dateInput = new Date()) {
  const d = new Date(dateInput);
  const spainString = d.toLocaleString("en-US", { timeZone: "Europe/Madrid" });
  return new Date(spainString);
}

function getSpainNow() { return toSpainDate(new Date()); }

function spainDayStart(dateInput) {
  const d = toSpainDate(dateInput);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function addDays(date, days) {
  return addMinutes(date, days * 24 * 60);
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

// === NUEVO: COMPARACIÓN SEGURA POR MINUTOS (0-1440) ===
function getMinutesFromMidnight(dateObj) {
  return dateObj.getHours() * 60 + dateObj.getMinutes();
}

function overlapsMath(startA, endA, startB, endB) {
  // A = Slot, B = Bloqueo
  return startA < endB && endA > startB;
}

function normalizeBlock(block) {
  const b = (block || "").toString().toLowerCase();
  if (b.includes("tard") || b.includes("after")) return "afternoon";
  return "morning";
}

function isWeekendES(dateInput) {
  const d = toSpainDate(dateInput);
  const n = d.getDay();
  return n === 0 || n === 6;
}

function parseDurationMinutes(value) {
  if (!value) return SERVICE_DEFAULT_MIN;
  if (typeof value === "number") return value > 1000 ? Math.round(value/60) : Math.round(value);
  const s = String(value).trim();
  if(s.includes(":")) {
    const [h, m] = s.split(":");
    return parseInt(h)*60 + parseInt(m);
  }
  return parseInt(s) || SERVICE_DEFAULT_MIN;
}

// =============== GOOGLE MAPS ===============
async function geocodeAddress(fullAddress) {
  if (!fullAddress) throw new Error("Dir vacía");
  if (geocodeCache.has(fullAddress)) return geocodeCache.get(fullAddress);
  if (!GOOGLE_MAPS_API_KEY) return HOME_ALGECIRAS;
  
  try {
    const resp = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(fullAddress)}&key=${GOOGLE_MAPS_API_KEY}`);
    const data = await resp.json();
    if (data.status !== "OK" || !data.results.length) return HOME_ALGECIRAS;
    const res = data.results[0].geometry.location;
    geocodeCache.set(fullAddress, res);
    return res;
  } catch (e) { return HOME_ALGECIRAS; }
}

async function getTravelTimeMinutes(origin, destination) {
  if (Math.abs(origin.lat - destination.lat) < 0.001 && Math.abs(origin.lng - destination.lng) < 0.001) return 0;
  const k = `${origin.lat},${origin.lng}_${destination.lat},${destination.lng}`;
  if (distanceCache.has(k)) return distanceCache.get(k);
  if (!GOOGLE_MAPS_API_KEY) return 20;

  try {
    const r = await fetch(`https://maps.googleapis.com/maps/api/distancematrix/json?units=metric&origins=${origin.lat},${origin.lng}&destinations=${destination.lat},${destination.lng}&key=${GOOGLE_MAPS_API_KEY}`);
    const d = await r.json();
    if (d.status === "OK" && d.rows[0].elements[0].status === "OK") {
      const min = Math.ceil(d.rows[0].elements[0].duration.value / 60);
      distanceCache.set(k, min);
      return min;
    }
  } catch (e) {}
  return 20;
}

// =============== GENERADOR HUECOS ===============
function generateSlotsForDayAndBlock(dayBaseES, rawBlock) {
  const block = normalizeBlock(rawBlock);
  const config = SCHEDULE[block];
  const slots = [];
  let current = setTime(dayBaseES, config.startHour, config.startMinute);
  const limit = setTime(dayBaseES, config.endHour, config.endMinute);
  while (current < limit) {
    slots.push(new Date(current));
    current = addMinutes(current, SLOT_INTERVAL);
  }
  return slots;
}

// =============== BLOQUEOS ===============
function toDayKeyES(dateInput) {
  const d = toSpainDate(dateInput);
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const da = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${da}`;
}

function buildDayKeysBetween(startDate, endDate) {
  const keys = [];
  let curr = new Date(startDate); curr.setHours(0,0,0,0);
  const last = new Date(endDate); last.setHours(0,0,0,0);
  while(curr <= last) {
    keys.push(toDayKeyES(curr));
    curr.setDate(curr.getDate()+1);
  }
  return [...new Set(keys)];
}

async function getBlocksForDay(dayKey, clientCity="") {
  const snap = await db.collection("calendarBlocks").where("dayKeys", "array-contains", dayKey).get();
  const cityNorm = (clientCity || "").trim().toLowerCase();
  
  return snap.docs.map(d => {
    const data = d.data();
    return {
      id: d.id,
      start: data.start?.toDate ? toSpainDate(data.start.toDate()) : null, // IMPORTANTE: Convertimos a ES aquí
      end: data.end?.toDate ? toSpainDate(data.end.toDate()) : null,       // IMPORTANTE: Convertimos a ES aquí
      allDay: !!data.allDay,
      city: (data.city || "").trim().toLowerCase()
    };
  }).filter(b => {
    if (!b.city) return true; // global
    return b.city === cityNorm;
  });
}

// =============== VALIDACIÓN RUTA ===============
async function isSlotFeasible(slotStart, newLocation, newDuration, rawBlock, existingAppointments) {
  const block = normalizeBlock(rawBlock);
  const config = SCHEDULE[block];
  const dayBase = spainDayStart(slotStart);
  const blockEnd = setTime(dayBase, config.endHour, config.endMinute);

  const newAppt = {
    start: new Date(slotStart),
    end: addMinutes(slotStart, newDuration),
    location: newLocation
  };

  if (newAppt.end > blockEnd) return false;

  const route = [...existingAppointments, newAppt].sort((a,b) => a.start - b.start);
  
  // Solapes citas existentes
  for(let i=0; i<route.length-1; i++) {
    if (route[i].end > route[i+1].start) return false;
  }

  // Ruta
  let currLoc = HOME_ALGECIRAS;
  let currTime = setTime(dayBase, 8, 0);

  for(let i=0; i<route.length; i++) {
    const appt = route[i];
    const travel = await getTravelTimeMinutes(currLoc, appt.location);
    if(i>0 && travel > MAX_TRAVEL_ALLOWED_BETWEEN_JOBS) return false;

    const arrival = addMinutes(currTime, travel + TRAVEL_MARGIN_MINUTES);
    if (arrival > appt.start) return false;

    currTime = appt.end;
    currLoc = appt.location;
  }
  return true;
}

async function getAppointmentsForDay(dayBaseES, block) {
  const s = spainDayStart(dayBaseES);
  const e = addDays(s, 1);
  const snap = await db.collection("appointments")
    .where("date", ">=", admin.firestore.Timestamp.fromDate(s))
    .where("date", "<", admin.firestore.Timestamp.fromDate(e))
    .get();

  const res = [];
  const normBlock = normalizeBlock(block);

  for(const doc of snap.docs) {
    const d = doc.data();
    if(!d.date) continue;
    const realDate = toSpainDate(d.date.toDate());
    const h = realDate.getHours();
    if (normBlock === "morning" && h >= 15) continue;
    if (normBlock === "afternoon" && h < 15) continue;

    const dur = parseDurationMinutes(d.duration||d.estimatedDuration);
    let loc = HOME_ALGECIRAS;
    if(d.address) try { loc = await geocodeAddress(d.address + (d.city ? ", "+d.city : "")); } catch(_){}

    res.push({ start: realDate, end: addMinutes(realDate, dur), location: loc, duration: dur });
  }
  return res;
}

// =============== ENDPOINTS ===============
app.post("/availability-smart", async (req, res) => {
  try {
    const { token, block, rangeDays } = req.body;
    const service = await getServiceByToken(token);
    if(!service) return res.status(404).json({error:"Token"});

    const clientLoc = await geocodeAddress(`${service.address}, ${service.city}`);
    const duration = parseDurationMinutes(service.duration);
    const nowES = getSpainNow();
    const resultDays = [];

    for(let i=0; i<(rangeDays||14); i++) {
      const day = addDays(nowES, i);
      const dayBase = spainDayStart(day);
      if(isWeekendES(dayBase)) continue;

      const dayKey = toDayKeyES(dayBase);
      const blocks = await getBlocksForDay(dayKey, service.city);

      if(blocks.some(b => b.allDay)) {
        console.log(`[BLOCK] Día completo bloqueado: ${dayKey}`);
        continue; 
      }

      const existing = await getAppointmentsForDay(dayBase, block);
      const slots = generateSlotsForDayAndBlock(dayBase, block);
      const valid = [];

      for(const sStart of slots) {
        if(sStart < nowES) continue; // Pasado

        const sEnd = addMinutes(sStart, duration);
        
        // --- 🛡️ COMPROBACIÓN SEGURA MATEMÁTICA ---
        const slotMinStart = getMinutesFromMidnight(sStart);
        const slotMinEnd = getMinutesFromMidnight(sEnd);

        const isBlocked = blocks.some(b => {
          if(!b.start || !b.end) return false;
          // Convertimos el bloqueo a minutos del día
          const bMinStart = getMinutesFromMidnight(b.start);
          const bMinEnd = getMinutesFromMidnight(b.end);
          
          const overlap = overlapsMath(slotMinStart, slotMinEnd, bMinStart, bMinEnd);
          if(overlap) {
            console.log(`[BLOCK] Solape detectado ${dayKey}: Slot(${formatTime(sStart)}-${formatTime(sEnd)}) vs Block(${formatTime(b.start)}-${formatTime(b.end)})`);
          }
          return overlap;
        });

        if(isBlocked) continue;

        if(await isSlotFeasible(sStart, clientLoc, duration, block, existing)) {
          valid.push({ startTime: formatTime(sStart), endTime: formatTime(sEnd) });
        }
      }

      if(valid.length) {
        resultDays.push({ 
          date: dayKey, 
          label: dayBase.toLocaleDateString("es-ES", { weekday:'long', day:'numeric', month:'long' }), 
          slots: valid 
        });
      }
    }
    res.json({ days: resultDays });
  } catch(e) {
    console.error(e);
    res.status(500).json({error: "Error server"});
  }
});

// ... (Resto de endpoints admin login/blocks se mantienen igual que V4, copia aquí abajo)

// AUTH & ADMIN ENDPOINTS
function getBearerToken(req) {
  const h = req.headers.authorization || "";
  const parts = h.split(" ");
  return (parts.length === 2 && parts[0] === "Bearer") ? parts[1] : null;
}
function requireAdmin(req, res, next) {
  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ error: "No auth" });
  try {
    const p = jwt.verify(token, ADMIN_JWT_SECRET);
    if (!p || p.role !== "admin") throw new Error();
    req.admin = p; next();
  } catch (_) { res.status(401).json({ error: "Token inválido" }); }
}

app.post("/admin/login", (req, res) => {
  const { user, pass } = req.body;
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    res.json({ ok: true, token: jwt.sign({ role: "admin" }, ADMIN_JWT_SECRET, { expiresIn: "12h" }) });
  } else res.status(401).json({ error: "Bad creds" });
});

app.get("/admin/blocks", requireAdmin, async (req, res) => {
  const snap = await db.collection("calendarBlocks").orderBy("createdAt", "desc").limit(1000).get();
  res.json({ ok: true, items: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
});

app.post("/admin/blocks", requireAdmin, async (req, res) => {
  const { startISO, endISO, allDay, reason, city } = req.body;
  const s = toSpainDate(new Date(startISO));
  const e = toSpainDate(new Date(endISO));
  
  if (allDay) { s.setHours(0,0,0,0); e.setHours(23,59,59,999); }
  
  await db.collection("calendarBlocks").add({
    start: admin.firestore.Timestamp.fromDate(s),
    end: admin.firestore.Timestamp.fromDate(e),
    allDay: !!allDay,
    reason: reason||"", city: (city||"").trim(),
    dayKeys: buildDayKeysBetween(s, e),
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  res.json({ ok: true });
});

app.delete("/admin/blocks/:id", requireAdmin, async (req, res) => {
  await db.collection("calendarBlocks").doc(req.params.id).delete();
  res.json({ ok: true });
});

async function getServiceByToken(token) {
  const d = await db.collection("appointments").doc(token).get();
  if(!d.exists) return null;
  const data = d.data();
  return { token, serviceId: d.id, ...data, duration: parseDurationMinutes(data.duration) };
}

app.post("/client-from-token", async (req,res) => {
  const s = await getServiceByToken(req.body.token);
  res.json(s || {error:"Not found"});
});

app.post("/appointment-request", async (req,res) => {
  // Lógica simplificada para guardar solicitud
  const {token,date,startTime} = req.body;
  const s = await getServiceByToken(token);
  const [h,m] = startTime.split(":");
  const d = new Date(date); d.setHours(h,m,0,0);
  
  const doc = { 
    token, clientName: s.name, requestedDate: admin.firestore.Timestamp.fromDate(d),
    requestedTime: startTime, status: "pending", createdAt: admin.firestore.FieldValue.serverTimestamp()
  };
  await db.collection("appointmentChangeRequests").add(doc);
  res.json({ok:true});
});

app.listen(PORT, () => console.log(`✅ Marsalva V5 running port ${PORT}`));
