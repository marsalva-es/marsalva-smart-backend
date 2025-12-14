// server.js (V7 - CON RUTA DE CITA CORREGIDA)
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const jwt = require("jsonwebtoken");

// =============== INICIALIZACIÓN ===============
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

// =============== CONFIGURACIÓN ===============
const HOME_ALGECIRAS = { lat: 36.1408, lng: -5.4562 };
const SCHEDULE = {
  morning: { startHour: 9, startMinute: 30, endHour: 14, endMinute: 0 },
  afternoon: { startHour: 17, startMinute: 0, endHour: 20, endMinute: 0 },
};
const SLOT_INTERVAL = 30;
const SERVICE_DEFAULT_MIN = 60;

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";
const ADMIN_USER = process.env.ADMIN_USER || "";
const ADMIN_PASS = process.env.ADMIN_PASS || "";
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || "";
const PORT = process.env.PORT || 10000;

const app = express();
app.use(cors({ origin: true }));
app.use(express.json()); // <--- IMPORTANTE: Esto permite leer el JSON que envía el frontend

const geocodeCache = new Map();
const distanceCache = new Map();

// =============== UTILIDADES ===============
function toSpainDate(dateInput = new Date()) {
  const d = new Date(dateInput);
  const spainString = d.toLocaleString("en-US", { timeZone: "Europe/Madrid" });
  return new Date(spainString);
}

function getSpainNow() { return toSpainDate(new Date()); }

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

function getMinutesFromMidnight(dateObj) {
  return dateObj.getHours() * 60 + dateObj.getMinutes();
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

// =============== LÓGICA DE CITAS ===============
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
    const y = curr.getFullYear();
    const m = String(curr.getMonth()+1).padStart(2,"0");
    const da = String(curr.getDate()).padStart(2,"0");
    keys.push(`${y}-${m}-${da}`);
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
      start: data.start?.toDate ? data.start.toDate() : null,
      end: data.end?.toDate ? data.end.toDate() : null,
      allDay: !!data.allDay,
      city: (data.city || "").trim().toLowerCase()
    };
  }).filter(b => {
    if (!b.city) return true; // global
    return b.city === cityNorm;
  });
}

// =============== ENDPOINTS ===============

// 1. Availability Smart
app.post("/availability-smart", async (req, res) => {
  try {
    const { token, block, rangeDays } = req.body;
    const service = await db.collection("appointments").doc(token).get();
    if(!service.exists) return res.status(404).json({error:"Token"});
    
    const sData = service.data();
    const duration = parseDurationMinutes(sData.duration);
    
    const nowES = getSpainNow();
    const resultDays = [];

    for(let i=0; i<(rangeDays||14); i++) {
      const day = addDays(nowES, i);
      const dayBase = setTime(day, 0, 0); // 00:00 del día
      
      if(isWeekendES(dayBase)) continue;

      const dayKey = toDayKeyES(dayBase);
      const blocks = await getBlocksForDay(dayKey, sData.city);

      if(blocks.some(b => b.allDay)) continue;

      const possibleSlots = generateSlotsForDayAndBlock(dayBase, block);
      const valid = [];

      const dayStart = new Date(dayBase);
      const dayEnd = addDays(dayStart, 1);
      const apptsSnap = await db.collection("appointments")
        .where("date", ">=", admin.firestore.Timestamp.fromDate(dayStart))
        .where("date", "<", admin.firestore.Timestamp.fromDate(dayEnd))
        .get();
        
      const existing = apptsSnap.docs.map(doc => {
        const d = doc.data();
        const realStart = toSpainDate(d.date.toDate());
        return {
           start: realStart,
           end: addMinutes(realStart, parseDurationMinutes(d.duration)),
        };
      });

      for(const sStart of possibleSlots) {
        if(sStart < nowES) continue;

        const sEnd = addMinutes(sStart, duration);
        const sMinStart = getMinutesFromMidnight(sStart);
        const sMinEnd = getMinutesFromMidnight(sEnd);

        const isBlocked = blocks.some(b => {
           if(!b.start || !b.end) return false;
           const bMinStart = getMinutesFromMidnight(b.start);
           const bMinEnd = getMinutesFromMidnight(b.end);
           return sMinStart < bMinEnd && sMinEnd > bMinStart;
        });

        if(isBlocked) continue;

        const isOverlap = existing.some(ex => sStart < ex.end && sEnd > ex.start);
        if(isOverlap) continue;

        valid.push({ startTime: formatTime(sStart), endTime: formatTime(sEnd) });
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
    res.status(500).json({error: "Error"});
  }
});

// 2. ADMIN: BLOQUEOS (GET)
app.get("/admin/blocks", async (req, res) => {
  try {
    const snap = await db.collection("calendarBlocks").orderBy("createdAt", "desc").limit(1000).get();
    const items = snap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        start: data.start?.toDate().toISOString(), 
        end: data.end?.toDate().toISOString(),
        allDay: data.allDay,
        reason: data.reason,
        city: data.city
      };
    });
    res.json({ ok: true, items });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// 3. ADMIN: BLOQUEOS (POST)
app.post("/admin/blocks", async (req, res) => {
  try {
    const { startISO, endISO, allDay, reason, city } = req.body;
    const s = new Date(startISO);
    const e = new Date(endISO);
    
    if (allDay) {
       s.setHours(0,0,0,0);
       e.setHours(23,59,59,999);
    }

    const dayKeys = buildDayKeysBetween(s, e);
    
    await db.collection("calendarBlocks").add({
      start: admin.firestore.Timestamp.fromDate(s),
      end: admin.firestore.Timestamp.fromDate(e),
      allDay: !!allDay,
      reason: reason || "Bloqueo",
      city: city || "",
      dayKeys,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// 4. ADMIN: DELETE
app.delete("/admin/blocks/:id", async (req, res) => {
  await db.collection("calendarBlocks").doc(req.params.id).delete();
  res.json({ ok: true });
});

// 5. LOGIN
app.post("/admin/login", (req, res) => {
  const { user, pass } = req.body;
  if(user === ADMIN_USER && pass === ADMIN_PASS) {
     const token = jwt.sign({role:"admin"}, ADMIN_JWT_SECRET);
     res.json({ok:true, token});
  } else {
     res.status(401).json({error:"Error credenciales"});
  }
});

// 6. CLIENT INFO
app.post("/client-from-token", async(req,res)=>{
  const d = await db.collection("appointments").doc(req.body.token).get();
  if(d.exists) res.json(d.data());
  else res.status(404).json({});
});

// =========================================================
// 7. 🔥 ESTA ES LA RUTA QUE FALTABA (SOLICITUD DE CITA) 🔥
// =========================================================
app.post("/appointment-request", async (req, res) => {
  try {
    console.log("📩 Solicitud recibida:", req.body);
    const { token, date, startTime, endTime } = req.body;

    if (!token || !date || !startTime) {
      return res.status(400).json({ error: "Datos incompletos" });
    }

    // Actualizamos la cita en Firebase con el horario seleccionado
    // Cambiamos el estado a 'pending_approval' (o el que uses)
    await db.collection("appointments").doc(token).update({
      dateStr: date,              // Fecha en texto (ej: 2025-05-10)
      startTime: startTime,       // Hora inicio (ej: 09:30)
      endTime: endTime,           // Hora fin (ej: 10:30)
      status: "pending_approval", // Para que sepa el admin que hay que revisar
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`✅ Cita actualizada para token ${token}: ${date} ${startTime}`);
    res.json({ success: true, message: "Cita guardada correctamente" });

  } catch (error) {
    console.error("❌ Error guardando cita:", error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => console.log("✅ Marsalva V7 Running"));
