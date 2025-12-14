// server.js (V10 - VERSIÓN FINAL INTEGRADA)
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const jwt = require("jsonwebtoken");

// =============== 1. INICIALIZACIÓN FIREBASE ===============
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

// =============== 2. CONFIGURACIÓN GLOBAL ===============
const HOME_ALGECIRAS = { lat: 36.1408, lng: -5.4562 };
const SCHEDULE = {
  morning: { startHour: 9, startMinute: 30, endHour: 14, endMinute: 0 },
  afternoon: { startHour: 17, startMinute: 0, endHour: 20, endMinute: 0 },
};
const SLOT_INTERVAL = 30;
const SERVICE_DEFAULT_MIN = 60;

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || "secreto_super_seguro"; // Cambiar en prod
const PORT = process.env.PORT || 10000;

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

const geocodeCache = new Map();

// =============== 3. MIDDLEWARE DE SEGURIDAD ===============
const verifyAdmin = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "No token provided" });

  const token = authHeader.split(" ")[1];
  try {
    jwt.verify(token, ADMIN_JWT_SECRET);
    next();
  } catch (err) {
    return res.status(403).json({ error: "Token inválido o expirado" });
  }
};

// =============== 4. UTILIDADES (FECHAS Y MAPAS) ===============
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
    if (!b.city) return true; 
    return b.city === cityNorm;
  });
}


// =============== 5. ENDPOINTS DE AUTENTICACIÓN ===============

// A) LOGIN INTELIGENTE (Firebase > Env Vars)
app.post("/admin/login", async (req, res) => {
  const { user, pass } = req.body;
  try {
    // 1. Buscamos credenciales personalizadas en DB
    const doc = await db.collection("settings").doc("admin_access").get();
    
    // Valores por defecto (del sistema)
    let validUser = process.env.ADMIN_USER || "admin";
    let validPass = process.env.ADMIN_PASS || "admin";

    // Si existen en DB, sobrescriben a las del sistema
    if (doc.exists) {
        const data = doc.data();
        if (data.user && data.pass) {
            validUser = data.user;
            validPass = data.pass;
        }
    }

    if(user === validUser && pass === validPass) {
       // Token válido por 30 días
       const token = jwt.sign({role:"admin"}, ADMIN_JWT_SECRET, { expiresIn: '30d' });
       res.json({ok:true, token});
    } else {
       res.status(401).json({error:"Credenciales incorrectas"});
    }
  } catch(e) {
    console.error(e);
    res.status(500).json({error: "Error interno verificando credenciales"});
  }
});

// B) CAMBIAR CREDENCIALES ROOT (Protegido)
app.post("/admin/update-root-access", verifyAdmin, async (req, res) => {
    try {
        const { newUser, newPass } = req.body;
        if (!newUser || !newPass) return res.status(400).json({error: "Faltan datos"});

        await db.collection("settings").doc("admin_access").set({
            user: newUser,
            pass: newPass,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ success: true, message: "Credenciales actualizadas." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// =============== 6. ENDPOINTS CONFIGURACIÓN HOMESERVE ===============

// GET CONFIG
app.get("/admin/config/homeserve", verifyAdmin, async (req, res) => {
  try {
    const doc = await db.collection("settings").doc("homeserve").get();
    if (!doc.exists) return res.json({ user: "", hasPass: false, lastChange: null });
    
    const data = doc.data();
    res.json({
      user: data.user,
      hasPass: !!data.pass, // Solo decimos si existe, no la devolvemos
      lastChange: data.lastChange ? data.lastChange.toDate().toISOString() : null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SAVE CONFIG
app.post("/admin/config/homeserve", verifyAdmin, async (req, res) => {
  try {
    const { user, pass } = req.body;
    await db.collection("settings").doc("homeserve").set({
      user,
      pass,
      lastChange: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET SERVICES
app.get("/admin/services/homeserve", verifyAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection("externalServices").where("provider", "==", "homeserve").get();
    
    // Si está vacío, creamos dummy data para que no se vea feo al principio
    if (snapshot.empty) {
        const dummies = [
            { provider: 'homeserve', client: 'Cliente Ejemplo 1', address: 'Calle Prueba, 1', status: 'pending' }
        ];
        for(const d of dummies) await db.collection("externalServices").add(d);
        const snap2 = await db.collection("externalServices").where("provider", "==", "homeserve").get();
        return res.json(snap2.docs.map(d => ({ id: d.id, ...d.data() })));
    }

    const services = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(services);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// EDIT SERVICE
app.put("/admin/services/homeserve/:id", verifyAdmin, async (req, res) => {
  try {
    const { client, address } = req.body;
    await db.collection("externalServices").doc(req.params.id).update({ client, address });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE SERVICES
app.post("/admin/services/homeserve/delete", verifyAdmin, async (req, res) => {
  try {
    const { ids } = req.body; 
    if(!ids || !ids.length) return res.status(400).json({error: "No IDs"});

    const batch = db.batch();
    ids.forEach(id => {
        const ref = db.collection("externalServices").doc(id);
        batch.delete(ref);
    });
    await batch.commit();
    
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// =============== 7. ENDPOINTS LÓGICA DE NEGOCIO (CITAS) ===============

// AVAILABILITY SMART
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
      const dayBase = setTime(day, 0, 0); 
      
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

// SOLICITUD DE CITA (Guarda en Pendientes)
app.post("/appointment-request", async (req, res) => {
  try {
    console.log("📩 Nueva solicitud pendiente:", req.body);
    const { token, date, startTime, endTime, block } = req.body;

    if (!token || !date || !startTime) {
      return res.status(400).json({ error: "Datos incompletos" });
    }

    // 1. Buscamos cita original
    const originalRef = db.collection("appointments").doc(token);
    const originalSnap = await originalRef.get();

    if (!originalSnap.exists) {
      return res.status(404).json({ error: "Cita original no encontrada" });
    }
    const originalData = originalSnap.data();

    // 2. Construir el Timestamp solicitado
    const [year, month, day] = date.split('-').map(Number);
    const [hour, minute] = startTime.split(':').map(Number);
    const reqDateObj = new Date(year, month - 1, day, hour, minute);

    // 3. Crear el documento CON LA ESTRUCTURA EXACTA QUE PIDE TU APP
    const requestData = {
      address: originalData.address || "",
      appointmentId: token,
      city: originalData.city || "",
      clientName: originalData.clientName || originalData.name || "Cliente",
      clientPhone: originalData.phone || originalData.clientPhone || "",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      
      originalDate: originalData.date || null,
      
      requestedBlock: block || "unknown",
      requestedDate: admin.firestore.Timestamp.fromDate(reqDateObj),
      requestedDateString: date,
      requestedEndTime: endTime,
      requestedStartTime: startTime,
      
      source: "smartBooking",
      status: "pending",
      token: token,
      zip: originalData.zip || originalData.cp || ""
    };

    await db.collection("onlineAppointmentRequests").add(requestData);

    console.log(`✅ Solicitud guardada para ${requestData.clientName}`);
    res.json({ success: true, message: "Solicitud enviada a revisión correctamente" });

  } catch (error) {
    console.error("❌ Error guardando solicitud:", error);
    res.status(500).json({ error: error.message });
  }
});

// ADMIN: BLOQUEOS (GET)
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

// ADMIN: BLOQUEOS (POST)
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

// ADMIN: DELETE BLOCK
app.delete("/admin/blocks/:id", async (req, res) => {
  await db.collection("calendarBlocks").doc(req.params.id).delete();
  res.json({ ok: true });
});

// CLIENT INFO
app.post("/client-from-token", async(req,res)=>{
  const d = await db.collection("appointments").doc(req.body.token).get();
  if(d.exists) res.json(d.data());
  else res.status(404).json({});
});

app.listen(PORT, () => console.log(`✅ Marsalva Server V10 Running on Port ${PORT}`));
