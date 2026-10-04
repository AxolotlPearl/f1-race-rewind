// api/index.js
// Express app — entry point ของ Vercel serverless function
// เส้นทาง: /api/races, /api/race/:sessionKey, /api/positions/:sessionKey, /api/track/:sessionKey

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSessions, getMeetings, getLocation } from "../lib/openf1.js";
import { buildTimeline } from "../lib/timeline.js";
import { HashTable } from "../lib/HashTable.js";
import { buildPositionsResponse } from "../lib/positions.js";
import { buildTrackAuto } from "../lib/trackBuilder.js";

const MAX_POSITIONS_WINDOW_SECONDS = 60;
const FIRST_YEAR = 2023; // OpenF1 มีข้อมูลย้อนหลังตั้งแต่ปี 2023

// ให้ CDN ของ Vercel cache คำตอบไว้ตรงหน้า function — ข้อมูลเรซที่จบแล้วไม่เปลี่ยน คนถัดไปที่ขอ
// URL เดียวกันได้ทันทีโดยไม่ต้องปลุก function หรือยิง OpenF1 ซ้ำ (cache ชั้นที่ 3 ต่อจาก
// module-scope ฝั่ง server และ localStorage ฝั่ง browser)
function setCdnCache(res, seconds) {
  res.set("Cache-Control", `public, max-age=60, s-maxage=${seconds}`);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(express.static(path.join(__dirname, "../public")));
// ให้ browser import lib/sort.js และ lib/HashTable.js ตรงจาก source เดียวกับ server ได้
// (ES module native, ไม่มี build step) เพื่อไม่ต้อง duplicate โค้ด DSA สองที่
app.use("/lib", express.static(path.join(__dirname, "../lib")));

// ปีที่เลือกได้คำนวณจากวันที่ปัจจุบัน ไม่ hardcode — ขึ้นปีใหม่แล้วปีนั้นโผล่เองโดยไม่ต้องแก้โค้ด
app.get("/api/years", (req, res) => {
  const currentYear = new Date().getUTCFullYear();
  const years = [];
  for (let y = currentYear; y >= FIRST_YEAR; y--) years.push(y);
  setCdnCache(res, 3600);
  res.json({ years });
});

app.get("/api/races", async (req, res) => {
  const year = Number(req.query.year);
  const currentYear = new Date().getUTCFullYear();
  if (!Number.isInteger(year) || year < FIRST_YEAR || year > currentYear) {
    return res.status(400).json({ error: `ต้องระบุ year เป็นปีที่ถูกต้อง (${FIRST_YEAR}–${currentYear})` });
  }

  try {
    const [sessions, meetings] = await Promise.all([getSessions(year), getMeetings(year)]);

    const meetingLookup = new HashTable(16);
    for (const m of meetings) {
      meetingLookup.set(m.meeting_key, m);
    }

    const now = Date.now();
    const races = sessions
      // ปฏิทินของปีปัจจุบันมีเรซที่ยังไม่แข่งปนมาด้วย (ยังไม่มีข้อมูลให้ replay) ตัดออก
      // เรซใหม่จะโผล่ในรายการเองทันทีที่แข่งจบ ไม่ต้องแก้โค้ด
      .filter((s) => !s.is_cancelled && new Date(s.date_end).getTime() < now)
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
          // ใช้สนามของ session เองก่อน: บาง meeting ถูกย้ายสนาม (เช่น 2026 meeting ชื่อ "Bahrain
          // Grand Prix" แต่แข่งจริงที่ Kuala Lumpur) ข้อมูลระดับ meeting จะชี้สนามผิด
          circuitShortName: s.circuit_short_name ?? meeting?.circuit_short_name ?? s.location,
          meetingName: meeting?.meeting_name ?? s.location,
        };
      });

    // ปีปัจจุบันต้อง refresh บ่อยให้เรซที่เพิ่งจบโผล่เร็ว ปีที่จบไปแล้ว cache ได้นาน
    setCdnCache(res, year === currentYear ? 300 : 86400);
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
    setCdnCache(res, 3600);
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

  // client ยกเลิก (กระโดดเวลา/เปลี่ยนเรซ) ระหว่างรอคิว → ไม่ต้องยิง OpenF1 จริง ประหยัดโควตา
  // ใช้ res ไม่ใช่ req: ใน Node รุ่นใหม่ req "close" ยิงทันทีที่อ่าน GET request จบ (ไม่ได้แปลว่ายกเลิก)
  // ส่วน res "close" ก่อนตอบเสร็จ (writableFinished = false) แปลว่า client ตัดการเชื่อมต่อไปจริง
  let cancelled = false;
  res.on("close", () => {
    if (!res.writableFinished) cancelled = true;
  });

  try {
    // ก้อนที่ client ระบุว่าโหลดล่วงหน้า (header X-Prefetch) ให้ priority ต่ำ — request ที่ผู้ใช้รออยู่ไปก่อน
    // ส่วนก้อนที่ต้องใช้วาดรถ "ตอนนี้" ถือว่าผู้ใช้กำลังรอ ให้ priority สูงเท่ากับ request อื่น
    const priority = req.get("x-prefetch") === "1" ? "low" : "high";
    const rawPoints = await getLocation(sessionKey, { fromIso, toIso, priority, isCancelled: () => cancelled });
    const positions = buildPositionsResponse(rawPoints, windowSeconds);
    setCdnCache(res, 86400);
    res.json({ sessionKey, from: fromIso, to: toIso, positions });
  } catch (err) {
    if (err.name === "AbortError") return; // client ไปแล้ว ไม่ต้องตอบ
    console.error(err);
    res.status(502).json({ error: "เรียกข้อมูลจาก OpenF1 ไม่สำเร็จ ลองใหม่อีกครั้ง" });
  }
});

// สร้างเส้นสนามสดสำหรับสนามที่ไม่มีไฟล์ precompute ใน public/tracks (เช่นสนามใหม่ในปฏิทินปีล่าสุด)
// ฝั่ง client จะเรียกอันนี้ก็ต่อเมื่อ /tracks/<circuitKey>.json ตอบ 404 เท่านั้น
app.get("/api/track/:sessionKey", async (req, res) => {
  const sessionKey = Number(req.params.sessionKey);
  if (!Number.isInteger(sessionKey)) {
    return res.status(400).json({ error: "session key ไม่ถูกต้อง" });
  }

  try {
    const track = await buildTrackAuto(sessionKey);
    if (!track) {
      setCdnCache(res, 600); // ลองใหม่ได้ในอีก 10 นาที (เผื่อข้อมูลเรซเพิ่งจบยังมาไม่ครบ)
      return res.status(404).json({ error: "ยังสร้างเส้นสนามของเรซนี้ไม่ได้" });
    }
    // สร้างครั้งแรกใช้ OpenF1 หลาย request — cache ที่ CDN ยาว ๆ ให้คนถัดไปได้ทันที
    setCdnCache(res, 30 * 86400);
    res.json(track);
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
