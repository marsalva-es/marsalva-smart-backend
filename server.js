// server.js (V13 - STRICT TIME WINDOWS & GEO CLUSTERING)
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

// =============== 2. SEGURIDAD (MIDDLEWARE) ===============
const verifyFirebaseUser = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: "No autorizado. Falta token." });
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error("Error verificando token:", error);
    return res.status(403).json({ error: "Token inválido o caducado." });
  }
};

// =============== 3. CONFIGURACIÓN y UTILS ===============
// Regla: No desplazarse más de 5km de una visita a otra en el mismo día
const MAX_DISTANCE_KM = 5; 

// Horario: Franjas enteras
const SCHEDULE = {
  morning: { startHour: 9, endHour: 14 },    // Genera: 9-10, 10-11, ... 13-14
  afternoon: { startHour: 16, endHour: 20 }, // Genera: 16-17, ... 19-20
};

function toSpainDate(d=new Date()){return new Date(new Date(d).toLocaleString("en-US",{timeZone:"Europe/Madrid"}));}
function getSpainNow(){return toSpainDate(new Date());}
function addDays(d,days){return new Date(d.getTime() + days * 86400000);}

// Fórmula Haversine (Cálculo preciso de distancia en KM)
function getDistanceInKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radio Tierra km
  const dLat = (lat2 - lat1) * (Math.PI/180);
  const dLon = (lon2 - lon1) * (Math.PI/180);
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * (Math.PI/180)) * Math.cos(lat2 * (Math.PI/180)) * Math.sin(dLon/2) * Math.sin(dLon/2); 
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
  return R * c;
}

// Verifica superposición de rangos de tiempo
function isOverlapping(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

// =============== 4. ENDPOINTS PROTEGIDOS (ADMIN) ===============
// (Sin cambios, manteniendo tu lógica funcional)

app.get("/admin/config/homeserve", verifyFirebaseUser, async (req, res) => {
  try {
    const doc = await db.collection("settings").doc("homeserve").get();
    if (!doc.exists) return res.json({ user: "", hasPass: false, lastChange: null });
    const data = doc.data();
    res.json({
      user: data.user,
      hasPass: !!data.pass,
      lastChange: data.lastChange ? data.lastChange.toDate().toISOString() : null
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/config/homeserve", verifyFirebaseUser, async (req, res) => {
  try {
    const { user, pass } = req.body;
    await db.collection("settings").doc("homeserve").set({
      user,
      pass,
      lastChange: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/services/homeserve", verifyFirebaseUser, async (req, res) => {
    const snap = await db.collection("externalServices").where("provider", "==", "homeserve").get();
    const services = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(services);
});

// =============== 5. LÓGICA DE CITAS INTELIGENTE (OPTIMIZADA V13) ===============

app.post("/availability-smart", async (req, res) => {
  try {
    // Recibimos lat/lng y la DURACIÓN real del servicio (default 60 min)
    const { lat, lng, durationMinutes = 60 } = req.body;

    if (!lat || !lng) return res.status(400).json({ error: "Faltan coordenadas" });

    const today = getSpainNow();
    const daysToCheck = 10; // Miramos los próximos 10 días
    let availableSlots = [];

    // 1. Obtener rango de fechas
    const startRange = new Date(today);
    startRange.setHours(0,0,0,0);
    const endRange = addDays(startRange, daysToCheck);
    
    // 2. Cargar TODAS las citas existentes en ese rango
    const snapshot = await db.collection("appointments")
      .where("date", ">=", startRange)
      .where("date", "<=", endRange)
      .get();

    const existingApps = snapshot.docs.map(doc => {
      const data = doc.data();
      // Calculamos el fin de la cita existente basándonos en SU duración
      const appDuration = data.duration || 60;
      return {
        start: data.date.toDate(),
        end: new Date(data.date.toDate().getTime() + appDuration * 60000),
        lat: data.location?.lat,
        lng: data.location?.lng
      };
    });

    // 3. Procesar día a día
    for (let i = 0; i < daysToCheck; i++) {
      const currentDay = addDays(today, i);
      
      // Excluir fines de semana (Sáb y Dom)
      const dayNum = currentDay.getDay();
      if (dayNum === 0 || dayNum === 6) continue; 

      // === REGLA 1: CLUSTERING (Agrupación por Localidad) ===
      // Filtramos citas que ya existen en ESTE día
      const dayApps = existingApps.filter(app => 
        app.start.getDate() === currentDay.getDate() &&
        app.start.getMonth() === currentDay.getMonth()
      );

      let dayIsBlockedByDistance = false;

      // Si hoy ya hay trabajo, verificamos que NO esté lejos (> 5km)
      if (dayApps.length > 0) {
        for (const bookedApp of dayApps) {
          if (bookedApp.lat && bookedApp.lng) {
            const dist = getDistanceInKm(lat, lng, bookedApp.lat, bookedApp.lng);
            if (dist > MAX_DISTANCE_KM) {
              // Si hay AL MENOS UNA cita lejos, este día queda descartado.
              // Esto fuerza a buscar un día vacío o un día con citas cerca.
              dayIsBlockedByDistance = true;
              break; 
            }
          }
        }
      }

      if (dayIsBlockedByDistance) continue; // Día descartado, siguiente.

      // === REGLA 2: FRANJAS HORARIAS & DURACIÓN ===
      const blocks = [SCHEDULE.morning, SCHEDULE.afternoon];

      for (const block of blocks) {
        // Bucle hora a hora: 9, 10, 11...
        for (let hour = block.startHour; hour < block.endHour; hour++) {
          
          // Definimos el inicio de la franja (ej: 09:00)
          const slotStart = new Date(currentDay);
          slotStart.setHours(hour, 0, 0, 0);
          
          // Definimos el FINAL de la franja VISUAL (ej: 10:00) para mostrar al cliente
          const windowEnd = new Date(currentDay);
          windowEnd.setHours(hour + 1, 0, 0, 0);

          // Definimos el FINAL REAL DE TRABAJO para comprobar hueco (Inicio + Duración Servicio)
          // Esto es clave: si el servicio dura 2h, comprobamos si hay hueco de 9 a 11.
          const workEnd = new Date(slotStart.getTime() + durationMinutes * 60000);

          // Validación básica: no ofrecer horas pasadas
          if (slotStart < new Date()) continue;

          // Validación de colisión estricta
          let isOccupied = false;
          for (const booked of dayApps) {
            // Comprobamos si el TRABAJO propuesto choca con citas existentes
            if (isOverlapping(slotStart, workEnd, booked.start, booked.end)) {
              isOccupied = true;
              break;
            }
          }

          if (!isOccupied) {
            const startStr = slotStart.toLocaleTimeString("es-ES", { hour: '2-digit', minute: '2-digit' });
            const endStr = windowEnd.toLocaleTimeString("es-ES", { hour: '2-digit', minute: '2-digit' });
            
            // Textos amigables
            const label = `${startStr} - ${endStr}`;
            const message = `La visita se realizará entre las ${startStr} y las ${endStr}`;

            availableSlots.push({
              date: slotStart.toISOString().split('T')[0],
              startTime: startStr,
              endTime: endStr,
              label: label,
              message: message,
              isoStart: slotStart.toISOString() 
            });
          }
        }
      }
    }

    // Agrupar respuesta
    const grouped = availableSlots.reduce((acc, slot) => {
      if (!acc[slot.date]) acc[slot.date] = [];
      acc[slot.date].push(slot);
      return acc;
    }, {});

    const responseArray = Object.keys(grouped).map(dateKey => ({
      date: dateKey,
      slots: grouped[dateKey]
    }));

    res.json({ days: responseArray });

  } catch (error) {
    console.error("Error availability:", error);
    res.status(500).json({ error: error.message });
  }
});

// Guardado de Cita (Actualizado para guardar Duración y Ubicación)
app.post("/appointment-request", async (req, res) => {
    try {
        const { slot, clientData, location, durationMinutes = 60 } = req.body; 
        
        await db.collection("appointments").add({
            date: admin.firestore.Timestamp.fromDate(new Date(slot.isoStart)),
            duration: durationMinutes, // Guardamos la duración real para futuros cálculos
            client: clientData,
            location: location, // { lat, lng } ESENCIAL para el clustering
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/client-from-token", async(req,res)=>{
  const d = await db.collection("appointments").doc(req.body.token).get();
  if(d.exists) res.json(d.data()); else res.status(404).json({});
});

app.listen(PORT, () => console.log(`✅ Marsalva Server V13 (Strict Duration) Running`));
