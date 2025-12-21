// server.js (V12 - SMART CLUSTERING & TIME WINDOWS)
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

// =============== 1. INICIALIZACIÓN (IGUAL) ===============
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

// =============== 2. SEGURIDAD (IGUAL) ===============
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

// =============== 3. CONFIGURACIÓN y UTILS (ACTUALIZADO) ===============
// AUMENTADO: Distancia máxima para agrupar citas (en KM)
const MAX_DISTANCE_KM = 5; 

const SCHEDULE = {
  morning: { startHour: 9, endHour: 14 },   // Simplificado para franjas enteras
  afternoon: { startHour: 16, endHour: 20 }, // 16 a 20 (4 a 8 PM)
};

// Utiles de fecha (Mantenemos los tuyos y añadimos cálculo de distancia)
function toSpainDate(d=new Date()){return new Date(new Date(d).toLocaleString("en-US",{timeZone:"Europe/Madrid"}));}
function getSpainNow(){return toSpainDate(new Date());}
function addDays(d,days){return new Date(d.getTime() + days * 86400000);}

// Fórmula de Haversine para calcular distancia en KM entre dos coordenadas
function getDistanceInKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radio de la tierra en km
  const dLat = (lat2 - lat1) * (Math.PI/180);
  const dLon = (lon2 - lon1) * (Math.PI/180);
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * (Math.PI/180)) * Math.cos(lat2 * (Math.PI/180)) * Math.sin(dLon/2) * Math.sin(dLon/2); 
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
  return R * c;
}

// Verifica si dos rangos de tiempo se solapan
function isOverlapping(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

// =============== 4. ENDPOINTS PROTEGIDOS (IGUAL) ===============
// (Tus endpoints de admin se mantienen idénticos, no toco nada aquí)

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

// ... (Resto de endpoints admin se asumen presentes) ...

// =============== 5. LÓGICA DE CITAS MEJORADA (AQUÍ ESTÁ EL CAMBIO) ===============

app.post("/availability-smart", async (req, res) => {
  try {
    const { lat, lng, durationMinutes = 60 } = req.body; // Duración por defecto 60 min

    if (!lat || !lng) return res.status(400).json({ error: "Faltan coordenadas" });

    // 1. Definir rango de búsqueda (ej: próximos 7 días)
    const today = getSpainNow();
    const daysToCheck = 10;
    let availableSlots = [];

    // 2. Traer TODAS las citas futuras de la base de datos para comparar
    const startRange = new Date(today);
    startRange.setHours(0,0,0,0);
    const endRange = addDays(startRange, daysToCheck);
    
    const snapshot = await db.collection("appointments")
      .where("date", ">=", startRange)
      .where("date", "<=", endRange)
      .get();

    const existingApps = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        start: data.date.toDate(), // Convertir timestamp a JS Date
        end: new Date(data.date.toDate().getTime() + (data.duration || 60) * 60000),
        lat: data.location?.lat,
        lng: data.location?.lng
      };
    });

    // 3. Iterar por cada día
    for (let i = 0; i < daysToCheck; i++) {
      const currentDay = addDays(today, i);
      
      // Saltamos domingos (0) o sábados (6) si no trabajas findes
      const dayNum = currentDay.getDay();
      if (dayNum === 0 || dayNum === 6) continue; 

      // === FILTRO GEOGRÁFICO (La Regla de los 5km) ===
      // Buscamos si hay citas YA agendadas para este día
      const dayApps = existingApps.filter(app => 
        app.start.getDate() === currentDay.getDate() &&
        app.start.getMonth() === currentDay.getMonth()
      );

      let dayIsBlockedByDistance = false;

      // Si hay citas, comprobamos si la NUEVA dirección está cerca de las EXISTENTES
      // Si está lejos (> 5km) de CUALQUIERA de las citas del día, bloqueamos el día entero
      // para forzar agrupación por localidad.
      if (dayApps.length > 0) {
        for (const bookedApp of dayApps) {
          if (bookedApp.lat && bookedApp.lng) {
            const dist = getDistanceInKm(lat, lng, bookedApp.lat, bookedApp.lng);
            if (dist > MAX_DISTANCE_KM) {
              dayIsBlockedByDistance = true;
              break; // Ya encontramos una lejos, este día no sirve para la nueva zona
            }
          }
        }
      }

      if (dayIsBlockedByDistance) continue; // Saltamos al siguiente día

      // === GENERACIÓN DE FRANJAS HORARIAS (9-10, 10-11...) ===
      // Definimos bloques: Mañana y Tarde
      const blocks = [SCHEDULE.morning, SCHEDULE.afternoon];

      for (const block of blocks) {
        // Iteramos hora a hora dentro del bloque
        for (let hour = block.startHour; hour < block.endHour; hour++) {
          
          // Construimos la ventana propuesta: Ej 09:00 a 10:00
          const slotStart = new Date(currentDay);
          slotStart.setHours(hour, 0, 0, 0);
          
          const slotEnd = new Date(currentDay);
          slotEnd.setHours(hour + 1, 0, 0, 0); // Ventanas de 1 hora fija
          
          // Verificamos que la ventana no haya pasado ya (si es hoy)
          if (slotStart < new Date()) continue;

          // Verificamos colisiones con citas existentes
          let isOccupied = false;
          for (const booked of dayApps) {
            // Si hay solape entre la ventana propuesta y una cita real
            if (isOverlapping(slotStart, slotEnd, booked.start, booked.end)) {
              isOccupied = true;
              break;
            }
          }

          if (!isOccupied) {
            // Formatear respuesta amigable
            const startStr = slotStart.toLocaleTimeString("es-ES", { hour: '2-digit', minute: '2-digit' });
            const endStr = slotEnd.toLocaleTimeString("es-ES", { hour: '2-digit', minute: '2-digit' });
            
            // Texto para el frontend: "09:00 - 10:00"
            const label = `${startStr} - ${endStr}`;
            const message = `La visita se realizará entre las ${startStr} y las ${endStr}`;

            availableSlots.push({
              date: slotStart.toISOString().split('T')[0], // YYYY-MM-DD
              startTime: startStr,
              endTime: endStr,
              label: label,
              message: message,
              isoStart: slotStart.toISOString() // Para guardar en DB
            });
          }
        }
      }
    }

    // Agrupamos por día para enviar al frontend
    // Estructura: { "2023-10-25": [ {label...}, {label...} ] }
    const grouped = availableSlots.reduce((acc, slot) => {
      if (!acc[slot.date]) acc[slot.date] = [];
      acc[slot.date].push(slot);
      return acc;
    }, {});

    // Convertimos a array para el frontend
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

app.post("/appointment-request", async (req, res) => {
    // Lógica básica para guardar la cita
    // Asegúrate de guardar lat/lng para que el filtro de distancia funcione en el futuro
    try {
        const { slot, clientData, location } = req.body; 
        // slot debe traer { isoStart } del endpoint anterior
        
        await db.collection("appointments").add({
            date: admin.firestore.Timestamp.fromDate(new Date(slot.isoStart)),
            duration: 60, // O lo que marque el servicio
            client: clientData,
            location: location, // { lat: ..., lng: ... } IMPORTANTE
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

app.listen(PORT, () => console.log(`✅ Marsalva Server V12 (Smart Clustering) Running`));
