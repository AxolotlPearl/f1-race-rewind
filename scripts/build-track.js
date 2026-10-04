// scripts/build-track.js
// สคริปต์รันแบบ offline (ไม่รันตอน request จริง) เพื่อ precompute เส้นสนามเก็บเป็น JSON ใน public/tracks/
// ไม่บังคับต้องรัน: สนามที่ไม่มีไฟล์ precompute เว็บจะเรียก /api/track/:sessionKey สร้างสดให้เอง
// สคริปต์นี้มีไว้ "อุ่น" ไฟล์ล่วงหน้าให้สนามที่ใช้บ่อย โหลดเร็วกว่าและไม่เปลือง rate limit
//
// วิธีใช้:
//   node scripts/build-track.js <sessionKey>                 เลือกนักขับ/ช่วงเวลาให้อัตโนมัติ
//   node scripts/build-track.js <sessionKey> <driver> <offsetMinutes> <windowSeconds>   กำหนดเอง
//   ใส่ --force เพื่อเขียนทับไฟล์ที่มีอยู่แล้ว
//
// ตัวอย่าง: node scripts/build-track.js 11369
//           node scripts/build-track.js 9496 1 45 150 --force

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSessionInfo } from "../lib/openf1.js";
import { buildTrackAuto, buildTrackFromWindow } from "../lib/trackBuilder.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "../public/tracks");

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const force = process.argv.includes("--force");
  const [sessionKeyArg, driverArg, offsetArg, windowArg] = args;
  const sessionKey = Number(sessionKeyArg);

  if (!Number.isInteger(sessionKey)) {
    console.error("ใช้งาน: node scripts/build-track.js <sessionKey> [driver offsetMinutes windowSeconds] [--force]");
    process.exit(1);
  }

  const [session] = await getSessionInfo(sessionKey);
  if (!session) {
    console.error(`ไม่พบ session_key=${sessionKey}`);
    process.exit(1);
  }
  console.log(`session ${sessionKey}: circuit_key=${session.circuit_key} (${session.circuit_short_name}, ${session.year})`);

  const outPath = path.join(OUT_DIR, `${session.circuit_key}.json`);
  if (existsSync(outPath) && !force) {
    console.log(`มีไฟล์ ${outPath} อยู่แล้ว ข้าม (ใส่ --force ถ้าต้องการสร้างใหม่)`);
    return;
  }

  const manual = driverArg != null;
  const track = manual
    ? await buildTrackFromWindow(session, Number(driverArg), Number(offsetArg ?? 20), Number(windowArg ?? 150))
    : await buildTrackAuto(sessionKey);

  if (!track) {
    console.error(
      manual
        ? "หาจุดปิดรอบที่สมเหตุสมผลไม่เจอในช่วงนี้ — ลองเปลี่ยนนักขับ/offset/window"
        : "ลองครบทุกแบบอัตโนมัติแล้วยังหา 1 รอบไม่เจอ — ลองโหมดกำหนดเอง"
    );
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(outPath, JSON.stringify(track));
  console.log(`เขียน ${outPath} สำเร็จ: ${track.points.length} จุด, รอบละ ~${track.lapSeconds}s (นักขับ #${track.sourceDriverNumber})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
