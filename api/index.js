// api/index.js
// Express app — entry point ของ Vercel serverless function
// เส้นทางหลัก: /api/races, /api/race/:sessionKey (เฟส 2 จะเพิ่ม /api/positions/:sessionKey)

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSessions, getMeetings, getLocation } from "../lib/openf1.js";
import { buildTimeline } from "../lib/timeline.js";
import { HashTable } from "../lib/HashTable.js";
import { buildPositionsResponse } from "../lib/positions.js";

const MAX_POSITIONS_WINDOW_SECONDS = 60;

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
          dateEnd: s.date_end,
          // session_type=Race ครอบคลุมทั้ง "Race" และ "Sprint" (สุดสัปดาห์ sprint มี 2 session
          // ที่ track เดียวกัน) จึงต้องส่ง sessionName แยกให้ UI แสดงต่างกันได้
          sessionName: s.session_name,
          // ใช้เลือกไฟล์เส้นสนามที่ precompute ไว้ใน public/tracks/<circuitKey>.json (เฟส 2)
          circuitKey: s.circuit_key,
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

app.get("/api/positions/:sessionKey", async (req, res) => {
  const sessionKey = Number(req.params.sessionKey);
  if (!Number.isInteger(sessionKey)) {
    return res.status(400).json({ error: "session key ไม่ถูกต้อง" });
  }

  const fromIso = req.query.from;
  const toIso = req.query.to;
  const from = new Date(fromIso);
  const to = new Date(toIso);

  if (!fromIso || !toIso || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return res.status(400).json({ error: "ต้องระบุ from และ to เป็นวันที่ ISO ที่ถูกต้อง" });
  }

  const windowSeconds = (to.getTime() - from.getTime()) / 1000;
  if (windowSeconds <= 0 || windowSeconds > MAX_POSITIONS_WINDOW_SECONDS) {
    return res.status(400).json({ error: `ช่วงเวลาต้องมากกว่า 0 และไม่เกิน ${MAX_POSITIONS_WINDOW_SECONDS} วินาที` });
  }

  try {
    const rawPoints = await getLocation(sessionKey, { fromIso, toIso });
    const positions = buildPositionsResponse(rawPoints, windowSeconds);
    res.json({ sessionKey, from: fromIso, to: toIso, positions });
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
