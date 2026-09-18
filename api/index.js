// api/index.js
// Express app — entry point ของ Vercel serverless function
// เส้นทางหลัก: /api/races, /api/race/:sessionKey (เฟส 2 จะเพิ่ม /api/positions/:sessionKey)

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSessions, getMeetings } from "../lib/openf1.js";
import { buildTimeline } from "../lib/timeline.js";
import { HashTable } from "../lib/HashTable.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(express.static(path.join(__dirname, "../public")));
// ให้ browser import lib/sort.js และ lib/HashTable.js ตรงจาก source เดียวกับ server ได้
// (ES module native, ไม่มี build step) เพื่อไม่ต้อง duplicate โค้ด DSA สองที่
app.use("/lib", express.static(path.join(__dirname, "../lib")));

app.get("/api/races", async (req, res) => {
  const year = Number(req.query.year);
  if (!Number.isInteger(year) || year < 2023) {
    return res.status(400).json({ error: "ต้องระบุ year เป็นตัวเลขปีที่ถูกต้อง (2023 เป็นต้นไป)" });
  }

  try {
    const [sessions, meetings] = await Promise.all([getSessions(year), getMeetings(year)]);

    const meetingLookup = new HashTable(16);
    for (const m of meetings) {
      meetingLookup.set(m.meeting_key, m);
    }

    const races = sessions
      .filter((s) => !s.is_cancelled)
      .map((s) => {
        const meeting = meetingLookup.get(s.meeting_key);
        return {
          sessionKey: s.session_key,
          year: s.year,
          location: s.location,
          countryName: s.country_name,
          dateStart: s.date_start,
          // session_type=Race ครอบคลุมทั้ง "Race" และ "Sprint" (สุดสัปดาห์ sprint มี 2 session
          // ที่ track เดียวกัน) จึงต้องส่ง sessionName แยกให้ UI แสดงต่างกันได้
          sessionName: s.session_name,
          circuitShortName: meeting?.circuit_short_name ?? s.location,
          meetingName: meeting?.meeting_name ?? s.location,
        };
      });

    res.json({ year, races });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "เรียกข้อมูลจาก OpenF1 ไม่สำเร็จ ลองใหม่อีกครั้ง" });
  }
});

app.get("/api/race/:sessionKey", async (req, res) => {
  const sessionKey = Number(req.params.sessionKey);
  if (!Number.isInteger(sessionKey)) {
    return res.status(400).json({ error: "session key ไม่ถูกต้อง" });
  }

  try {
    const timeline = await buildTimeline(sessionKey);
    res.json(timeline);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "เรียกข้อมูลจาก OpenF1 ไม่สำเร็จ ลองใหม่อีกครั้ง" });
  }
});

// สำหรับรันตรง ๆ ด้วย `npm run dev` (Vercel จะ import default export แล้วห่อเป็น handler เอง)
if (process.env.VERCEL === undefined) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`F1 Race Rewind กำลังรันที่ http://localhost:${port}`);
  });
}

export default app;
