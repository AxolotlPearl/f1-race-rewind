// เฟส 0: สคริปต์สำรวจ OpenF1 API จริง (ไม่มี auth, rate limit 3 req/s / 30 req/min)
// ยิงทุก endpoint ที่จะใช้จริงกับ 2-3 เรซ แล้วพิมพ์รายงานให้ดูก่อนเขียนโค้ดเฟส 1
//
// รันด้วย: npm run probe

const BASE = "https://api.openf1.org/v1";
const DELAY_MS = 400; // ชิดกว่านี้เสี่ยงชน 3 req/s

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let requestCount = 0;

async function get(path) {
  requestCount += 1;
  const url = `${BASE}${path}`;
  const start = Date.now();
  const res = await fetch(url);
  const elapsed = Date.now() - start;
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    json = null;
  }
  console.log(`\n[${requestCount}] GET ${path}`);
  console.log(`    status=${res.status} time=${elapsed}ms bytes=${text.length}`);
  await sleep(DELAY_MS);
  return { status: res.status, data: json, raw: text };
}

function summarizeArray(label, data) {
  if (!Array.isArray(data)) {
    console.log(`    ${label}: ไม่ใช่ array! ค่าที่ได้ =`, data);
    return;
  }
  console.log(`    ${label}: ${data.length} records`);
  if (data.length > 0) {
    console.log(`    ตัวอย่าง record แรก:`, JSON.stringify(data[0], null, 2).split("\n").slice(0, 20).join("\n"));
  } else {
    console.log(`    (ว่างเปล่า - ไม่มีข้อมูลประเภทนี้สำหรับเรซนี้)`);
  }
}

async function probeSession(label, sessionKey) {
  console.log(`\n=================================================`);
  console.log(`เรซ: ${label} (session_key=${sessionKey})`);
  console.log(`=================================================`);

  const drivers = await get(`/drivers?session_key=${sessionKey}`);
  summarizeArray("drivers", drivers.data);

  const overtakes = await get(`/overtakes?session_key=${sessionKey}`);
  summarizeArray("overtakes", overtakes.data);

  const pit = await get(`/pit?session_key=${sessionKey}`);
  summarizeArray("pit", pit.data);

  const raceControl = await get(`/race_control?session_key=${sessionKey}`);
  summarizeArray("race_control", raceControl.data);

  const sessionResult = await get(`/session_result?session_key=${sessionKey}`);
  summarizeArray("session_result", sessionResult.data);

  return {
    label,
    sessionKey,
    counts: {
      drivers: Array.isArray(drivers.data) ? drivers.data.length : null,
      overtakes: Array.isArray(overtakes.data) ? overtakes.data.length : null,
      pit: Array.isArray(pit.data) ? pit.data.length : null,
      race_control: Array.isArray(raceControl.data) ? raceControl.data.length : null,
      session_result: Array.isArray(sessionResult.data) ? sessionResult.data.length : null,
    },
  };
}

async function main() {
  console.log("=== เฟส 0: สำรวจ OpenF1 API จริง ===");

  // 1) หา session ของเรซจริงในปี 2023 และ 2024
  const sessions2023 = await get(`/sessions?year=2023&session_type=Race`);
  const sessions2024 = await get(`/sessions?year=2024&session_type=Race`);

  console.log(`\nจำนวนเรซในปี 2023: ${sessions2023.data?.length}`);
  console.log(`จำนวนเรซในปี 2024: ${sessions2024.data?.length}`);

  if (Array.isArray(sessions2023.data) && sessions2023.data.length > 0) {
    console.log(`\nตัวอย่าง session object (2023 รอบแรก):`);
    console.log(JSON.stringify(sessions2023.data[0], null, 2));
  }

  // เลือก 3 เรซมาทดสอบ: เรซแรกของปี 2023, เรซแรกของปี 2024, และเรซท้าย ๆ ของปี 2024 (ถ้ามี)
  const races2023 = sessions2023.data ?? [];
  const races2024 = sessions2024.data ?? [];

  const picks = [];
  if (races2023.length > 0) {
    picks.push({ label: `2023 - ${races2023[0].location} (${races2023[0].country_name})`, sessionKey: races2023[0].session_key });
  }
  if (races2024.length > 0) {
    picks.push({ label: `2024 - ${races2024[0].location} (${races2024[0].country_name})`, sessionKey: races2024[0].session_key });
  }
  if (races2024.length > 5) {
    const mid = races2024[Math.floor(races2024.length / 2)];
    picks.push({ label: `2024 - ${mid.location} (${mid.country_name})`, sessionKey: mid.session_key });
  }

  // 2) ทดสอบ /meetings
  const meetings2024 = await get(`/meetings?year=2024`);
  console.log(`\nจำนวน meetings ปี 2024: ${meetings2024.data?.length}`);
  if (Array.isArray(meetings2024.data) && meetings2024.data.length > 0) {
    console.log(`ตัวอย่าง meeting object:`);
    console.log(JSON.stringify(meetings2024.data[0], null, 2));
  }

  // 3) ทดสอบทุก endpoint หลักกับ 2-3 เรซที่เลือก
  const results = [];
  for (const pick of picks) {
    const r = await probeSession(pick.label, pick.sessionKey);
    results.push(r);
  }

  // 4) ทดสอบ /location กับหน้าต่างเวลาสั้น ๆ (10 วินาที) ของ 1 เรซ เพื่อดูขนาดข้อมูลจริง
  if (picks.length > 0) {
    const testSessionKey = picks[0].sessionKey;
    console.log(`\n=================================================`);
    console.log(`ทดสอบ /location แบบหน้าต่างเวลาสั้น (10 วินาที) session_key=${testSessionKey}`);
    console.log(`=================================================`);

    // ต้องหา driver_number ก่อน (ใช้จาก drivers ที่ดึงไปแล้ว ถ้าไม่มีให้ดึงใหม่)
    const driversRes = await get(`/drivers?session_key=${testSessionKey}`);
    const firstDriver = Array.isArray(driversRes.data) && driversRes.data.length > 0 ? driversRes.data[0] : null;

    if (firstDriver) {
      const driverNumber = firstDriver.driver_number;
      // ใช้ session_result หรือ date_start ของ session เพื่อหาช่วงเวลาที่มีจริง - ลองดึงจาก race_control แรกที่มี date
      // เพื่อความง่ายเฟส 0: ลองใช้ date_start จาก session object ปี 2023/2024 ที่ query ไว้แล้ว
      const sessionInfo = races2023.find((s) => s.session_key === testSessionKey) || races2024.find((s) => s.session_key === testSessionKey);
      if (sessionInfo && sessionInfo.date_start) {
        const start = new Date(sessionInfo.date_start);
        const from = new Date(start.getTime() + 5 * 60 * 1000); // +5 นาทีหลังเริ่มเรซ กันช่วง grid/formation lap
        const to = new Date(from.getTime() + 10 * 1000); // +10 วินาที
        const fromIso = from.toISOString();
        const toIso = to.toISOString();

        console.log(`ทดสอบ driver_number=${driverNumber} ช่วง ${fromIso} ถึง ${toIso}`);
        const loc = await get(`/location?session_key=${testSessionKey}&driver_number=${driverNumber}&date>=${fromIso}&date<=${toIso}`);
        summarizeArray("location (10s, 1 driver)", loc.data);
        if (Array.isArray(loc.data) && loc.data.length > 0) {
          const freq = loc.data.length / 10;
          console.log(`    => ประมาณ ${freq.toFixed(1)} Hz สำหรับนักขับคนเดียวใน 10 วินาที`);
        }
      } else {
        console.log("    ไม่พบ date_start ของ session นี้ ข้ามการทดสอบ /location");
      }
    } else {
      console.log("    ไม่พบ driver ใน session นี้ ข้ามการทดสอบ /location");
    }
  }

  console.log(`\n=================================================`);
  console.log(`สรุปผลรวม`);
  console.log(`=================================================`);
  console.log(`จำนวน request ทั้งหมดที่ยิงไป: ${requestCount}`);
  for (const r of results) {
    console.log(`\n- ${r.label} (session_key=${r.sessionKey})`);
    console.log(`  drivers=${r.counts.drivers}, overtakes=${r.counts.overtakes}, pit=${r.counts.pit}, race_control=${r.counts.race_control}, session_result=${r.counts.session_result}`);
  }
  console.log(`\nเสร็จเฟส 0 - รอตรวจสอบผลก่อนเขียนโค้ดเฟส 1`);
}

main().catch((err) => {
  console.error("เกิดข้อผิดพลาดระหว่างสำรวจ API:", err);
  process.exit(1);
});
