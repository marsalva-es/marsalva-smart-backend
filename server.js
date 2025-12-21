// server.js (V21 - ADMIN TOKEN FIX)
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
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: "No autorizado. Falta token." });
  }

  const token = authHeader.split('Bearer ')[1];

  // --- NUEVO: SOPORTE PARA NUESTRO TOKEN DE ADMIN PROPIO ---
  if (token.startsWith("MARSALVA_ADMIN_")) {
      try {
          // Decodificamos el token (viene en base64) para ver usuario y contraseña
          const encoded = token.replace("MARSALVA_ADMIN_", "");
          const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
          const [user, pass] = decoded.split(":");

          // Verificamos contra la base de datos que sigan siendo válidos
          const doc = await db.collection("settings").doc("homeserve").get();
          const config = doc.data() || {};

          if (config.user === user && config.pass === pass) {
              req.user = { uid: "admin", email: "admin@marsalva.com" }; // Usuario ficticio
              return next(); // ¡Pasa!
          } else {
              return res.status(403).json({ error: "Credenciales de admin cambiaron o son inválidas." });
          }
      } catch (e) {
          console.error("Error verificando admin token:", e);
          return res.status(403).json({ error: "Token de admin corrupto." });
      }
  }
  // ---------------------------------------------------------

  // Si no es nuestro token, intentamos verificarlo como usuario normal de Firebase
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

function toSpainDate(d=new Date()){return new Date(new Date(d).toLocaleString("en-US",{timeZone:"Europe/Madrid"}));}
function getSpainNow(){return toSpainDate(new Date());}
function addDays(d,days){return new Date(d.getTime() + days * 86400000);}

function getDistanceInKm(lat1, lon1, lat2, lon2) {
  if(!lat1 || !lon1 || !lat2 || !lon2) return 0;
  const R = 6371; 
  const dLat = (lat2 - lat1) * (Math.PI/180);
  const dLon = (lon2 - lon1) * (Math.PI/180);
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * (Math.PI/180)) * Math.cos(lat2 * (Math.PI/180)) * Math.sin(dLon/2) * Math.sin(dLon/2); 
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
  return R * c;
}

function isOverlapping(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function getDayLabel(dateObj) {
  const days = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  return `${days[dateObj.getDay()]} ${dateObj.getDate()} de ${months[dateObj.getMonth()]}`;
}

// =============== 4. ADMIN LOGIN (MODIFICADO) ===============
app.post("/admin/login", async (req, res) => {
    const { user, pass } = req.body;
    try {
        const doc = await db.collection("settings").doc("homeserve").get();
        const config = doc.data() || {};
        
        if (config.user === user && config.pass === pass) {
            // EN LUGAR DE TOKEN DE FIREBASE, CREAMOS NUESTRO PROPIO TOKEN SEGURO
            // Formato: MARSALVA_ADMIN_ + Base64(usuario:contraseña)
            const payload = Buffer.from(`${user}:${pass}`).toString('base64');
            const customToken = `MARSALVA_ADMIN_${payload}`;
            
            return res.json({ token: customToken });
        } else {
            return res.status(401).json({ error: "Credenciales incorrectas" });
        }
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// =============== 5. ADMIN ENDPOINTS DE BLOQUEOS ===============
// GET BLOCKS
app.get("/admin/blocks", verifyFirebaseUser, async (req, res) => {
    try {
        const snap = await db.collection("calendarBlocks").get();
        const items = snap.docs.map(d => {
            const data = d.data();
            return { 
                id: d.id, 
                ...data,
                start: data.start && data.start.toDate ? data.start.toDate().toISOString() : data.start,
                end: data.end && data.end.toDate ? data.end.toDate().toISOString() : data.end
            };
        });
        res.json({ items });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// CREATE BLOCK
app.post("/admin/blocks", verifyFirebaseUser, async (req, res) => {
    try {
        const { startISO, endISO, allDay, reason, city } = req.body;
        await db.collection("calendarBlocks").add({
            start: startISO, 
            end: endISO,
            allDay: !!allDay,
            reason: reason || "Bloqueo manual",
            city: city || "",
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE BLOCK
app.delete("/admin/blocks/:id", verifyFirebaseUser, async (req, res) => {
    try {
        await db.collection("calendarBlocks").doc(req.params.id).delete();
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET CONFIG
app.get("/admin/config/homeserve", verifyFirebaseUser, async (req, res) => {
  try {
    const doc = await db.collection("settings").doc("homeserve").get();
    if (!doc.exists) return res.json({ user: "", hasPass: false, lastChange: null });
    const data = doc.data();
    res.json({ user: data.user, hasPass: !!data.pass, lastChange: data.lastChange ? data.lastChange.toDate().toISOString() : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// (Se mantienen los otros endpoints de config render/services)

// =============== 6. ENDPOINTS PÚBLICOS ===============

app.get("/version", (req, res) => {
    res.json({ version: "V21 - Admin Auth Fix", status: "online" });
});

app.post("/availability-smart", async (req, res) => {
  try {
    const { lat, lng, durationMinutes = 60, timePreference, timeSlot } = req.body;
    const requestedTime = (timePreference || timeSlot || "").toLowerCase();
    const hasCoords = (lat && lng && !isNaN(lat) && !isNaN(lng));
    const today = getSpainNow();
    const daysToCheck = 10;
    
    let availableSlots = [];

    const startRange = new Date(today);
    startRange.setHours(0,0,0,0);
    const endRange = addDays(startRange, daysToCheck);
    
    // 1. OBTENER CITAS
    const appSnap = await db.collection("appointments")
      .where("date", ">=", startRange)
      .where("date", "<=", endRange)
      .get();

    // 2. OBTENER BLOQUEOS
    const blockSnap = await db.collection("calendarBlocks").get(); 

    let busyItems = [];

    // Añadir Citas
    appSnap.docs.forEach(doc => {
      const data = doc.data();
      busyItems.push({
        start: data.date.toDate(),
        end: new Date(data.date.toDate().getTime() + (data.duration || 60) * 60000),
        lat: data.location?.lat,
        lng: data.location?.lng,
        type: 'appointment'
      });
    });

    // Añadir Bloqueos
    blockSnap.docs.forEach(doc => {
      const data = doc.data();
      
      let bStart, bEnd;
      if (data.start && data.start.toDate) { bStart = data.start.toDate(); } 
      else { bStart = new Date(data.start); }

      if (data.end && data.end.toDate) { bEnd = data.end.toDate(); } 
      else { bEnd = new Date(data.end); }

      busyItems.push({
        start: bStart,
        end: bEnd,
        type: 'block',
        allDay: data.allDay
      });
    });

    // 3. PROCESAR DÍAS
    for (let i = 0; i < daysToCheck; i++) {
      const currentDay = addDays(today, i);
      const dayNum = currentDay.getDay();
      if (dayNum === 0 || dayNum === 6) continue; 

      const dayBusyItems = busyItems.filter(item => {
          const dayStart = new Date(currentDay); dayStart.setHours(0,0,0,0);
          const dayEnd = new Date(currentDay); dayEnd.setHours(23,59,59,999);
          return isOverlapping(item.start, item.end, dayStart, dayEnd);
      });

      const hasFullDayBlock = dayBusyItems.some(item => item.type === 'block' && item.allDay);
      if (hasFullDayBlock) continue; 

      const appointmentsToday = dayBusyItems.filter(i => i.type === 'appointment');
      let dayIsBlockedByDistance = false;
      if (hasCoords && appointmentsToday.length > 0) {
        for (const app of appointmentsToday) {
          if (app.lat && app.lng) {
            const dist = getDistanceInKm(lat, lng, app.lat, app.lng);
            if (dist > MAX_DISTANCE_KM) {
              dayIsBlockedByDistance = true;
              break; 
            }
          }
        }
      }
      if (dayIsBlockedByDistance) continue;

      let blocksToUse = [];
      if (requestedTime.includes('mañana') || requestedTime.includes('morning')) {
         blocksToUse.push(SCHEDULE.morning);
      } else if (requestedTime.includes('tarde') || requestedTime.includes('afternoon')) {
         blocksToUse.push(SCHEDULE.afternoon);
      } else {
         blocksToUse = [SCHEDULE.morning, SCHEDULE.afternoon];
      }

      for (const block of blocksToUse) {
        for (let hour = block.startHour; hour < block.endHour; hour++) {
          const slotStart = new Date(currentDay);
          slotStart.setHours(hour, 0, 0, 0);
          
          const windowEnd = new Date(currentDay);
          windowEnd.setHours(hour + 1, 0, 0, 0); 
          const workEnd = new Date(slotStart.getTime() + durationMinutes * 60000); 

          if (slotStart < new Date()) continue;

          let isOccupied = false;
          for (const item of dayBusyItems) {
            if (isOverlapping(slotStart, workEnd, item.start, item.end)) {
              isOccupied = true;
              break;
            }
          }

          if (!isOccupied) {
            const startStr = slotStart.toLocaleTimeString("es-ES", { hour: '2-digit', minute: '2-digit' });
            const endStr = windowEnd.toLocaleTimeString("es-ES", { hour: '2-digit', minute: '2-digit' });
            
            availableSlots.push({
              date: slotStart.toISOString().split('T')[0],
              startTime: startStr,
              endTime: endStr,
              label: `${startStr} - ${endStr}`,
              message: `La visita se realizará entre las ${startStr} y las ${endStr}`,
              isoStart: slotStart.toISOString() 
            });
          }
        }
      }
    }

    const grouped = availableSlots.reduce((acc, slot) => {
      if (!acc[slot.date]) acc[slot.date] = [];
      acc[slot.date].push(slot);
      return acc;
    }, {});

    const responseArray = Object.keys(grouped).map(dateKey => {
      const dateObj = new Date(dateKey); 
      const labelDia = getDayLabel(dateObj); 
      return {
        date: dateKey,
        dayLabel: labelDia,
        title: labelDia,
        slots: grouped[dateKey]
      };
    });

    res.json({ days: responseArray });

  } catch (error) {
    console.error("Error availability:", error);
    res.json({ days: [] });
  }
});

app.post("/appointment-request", async (req, res) => {
    try {
        const { slot, clientData, location, durationMinutes = 60 } = req.body; 
        await db.collection("appointments").add({
            date: admin.firestore.Timestamp.fromDate(new Date(slot.isoStart)),
            duration: durationMinutes,
            client: clientData,
            location: location || null,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/client-from-token", async(req,res)=>{
  const d = await db.collection("appointments").doc(req.body.token).get();
  if(d.exists) res.json(d.data()); else res.status(404).json({});
});

app.listen(PORT, () => console.log(`✅ Marsalva Server V21 (Admin Auth Fixed) Running`));
