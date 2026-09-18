// scripts/build-track.js
// สคริปต์รันครั้งเดียว (offline, ไม่รันตอน request จริง) เพื่อดึงพิกัด /location ของนักขับ 1 คน
// ในช่วงเวลาหนึ่ง ตัดให้เหลือ 1 รอบสนาม แล้ว normalize เก็บเป็น JSON ใน public/tracks/
//
// วิธีใช้:
//   node scripts/build-track.js <sessionKey> [driverNumber] [offsetMinutes] [windowSeconds]
//
// ตัวอย่าง: node scripts/build-track.js 9472 1 20 150
//   -> ใช้เรซ session_key=9472, นักขับ #1, เริ่มดูที่ +20 นาทีจาก date_start ของเซสชัน,
//      ดึงหน้าต่างเวลา 150 วินาที (ต้องยาวพอให้ครบ 1 รอบ ไม่งั้นสคริปต์จะแจ้งว่าหาจุดปิดรอบไม่เจอ
//      ให้รันใหม่ด้วย windowSeconds ที่มากขึ้น หรือ offsetMinutes ที่ต่างไป)

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSessionInfo, getLocation } from "../lib/openf1.js";
import { extractOneLap, normalizeTrack } from "../lib/track.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "../public/tracks");

async function main() {
  const [sessionKeyArg, driverNumberArg, offsetMinutesArg, windowSecondsArg] = process.argv.slice(2);
  const sessionKey = Number(sessionKeyArg);
  const driverNumber = Number(driverNumberArg ?? 1);
  const offsetMinutes = Number(offsetMinutesArg ?? 20);
  const windowSeconds = Number(windowSecondsArg ?? 150);

  if (!Number.isInteger(sessionKey)) {
    console.error("ใช้งาน: node scripts/build-track.js <sessionKey> [driverNumber] [offsetMinutes] [windowSeconds]");
    process.exit(1);
  }

  console.log(`ดึงข้อมูล session ${sessionKey}...`);
  const sessions = await getSessionInfo(sessionKey);
  const session = sessions[0];
  if (!session) {
    console.error(`ไม่พบ session_key=${sessionKey}`);
    process.exit(1);
  }
  console.log(`  circuit_key=${session.circuit_key} (${session.circuit_short_name}, ${session.year})`);

  const outPath = path.join(OUT_DIR, `${session.circuit_key}.json`);
  if (existsSync(outPath) && !process.argv.includes("--force")) {
    console.log(`  มีไฟล์ ${outPath} อยู่แล้ว ข้าม (ใส่ --force ถ้าต้องการสร้างใหม่)`);
    return;
  }

  const start = new Date(session.date_start).getTime() + offsetMinutes * 60 * 1000;
  const end = start + windowSeconds * 1000;
  const fromIso = new Date(start).toISOString();
  const toIso = new Date(end).toISOString();

  console.log(`ดึงพิกัด driver_number=${driverNumber} ช่วง ${fromIso} ถึง ${toIso}...`);
  const rawPoints = await getLocation(sessionKey, { driverNumber, fromIso, toIso });
  console.log(`  ได้ ${rawPoints.length} จุด`);

  if (rawPoints.length < 10) {
    console.error("จุดพิกัดน้อยเกินไป — ลองปรับ offsetMinutes ให้อยู่ในช่วงที่รถวิ่งจริง (ไม่ใช่ตอนอยู่พิท/กริด)");
    process.exit(1);
  }

  const lap = extractOneLap(rawPoints);
  if (!lap) {
    console.error("หาจุดปิดรอบ (lap closure) ไม่เจอในหน้าต่างเวลานี้ — ลองเพิ่ม windowSeconds แล้วรันใหม่");
    process.exit(1);
  }

  const lapSeconds = (new Date(lap[lap.length - 1].date) - new Date(lap[0].date)) / 1000;
  console.log(`  ตัดได้ 1 รอบ: ${lap.length} จุด, ประมาณ ${lapSeconds.toFixed(1)} วินาที/รอบ`);

  const { transform, viewBox, points } = normalizeTrack(lap);

  const output = {
    circuitKey: session.circuit_key,
    circuitShortName: session.circuit_short_name,
    sourceSessionKey: sessionKey,
    sourceDriverNumber: driverNumber,
    generatedAt: new Date().toISOString(),
    transform,
    viewBox,
    points,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(outPath, JSON.stringify(output));
  console.log(`เขียนไฟล์ ${outPath} สำเร็จ (${points.length} จุด)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
