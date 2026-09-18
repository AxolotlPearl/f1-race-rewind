// public/app.js
// Vanilla JS frontend — ไม่มี framework, ไม่มี build step
// import DSA เดียวกับที่ server ใช้ตรงจาก /lib ผ่าน Express static (ES module native ในเบราว์เซอร์)
import { mergeSort } from "/lib/sort.js";
import { HashTable } from "/lib/HashTable.js";
import { applyTrackTransform } from "/lib/track.js";

const YEARS = [2025, 2024, 2023];
const DEFAULT_YEAR = 2024;

// ---------- client-side cache (ชั้นที่ 2 ต่อจาก module-scope cache บน server) ----------
// ข้อมูลเป็นข้อมูลย้อนหลังที่ไม่เปลี่ยนแปลงแล้ว จึง cache ถาวรได้เลยไม่ต้องมี TTL
// เพิ่มเลขเวอร์ชันทุกครั้งที่ schema ของ response เปลี่ยน (เช่นเพิ่ม field ใหม่) ไม่งั้น
// เบราว์เซอร์ที่เคย cache ไว้ก่อนหน้าจะอ่านข้อมูลเก่าที่ไม่มี field ใหม่ต่อไปเรื่อย ๆ
const CACHE_PREFIX = "f1rr:v2:";

function cacheGet(key) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function cacheSet(key, value) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value));
  } catch {
    // localStorage อาจไม่พร้อมใช้ (private mode, เต็ม) — ไม่เป็นไร แค่เสีย cache ไปเฉย ๆ
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function getRaces(year) {
  const key = `races:${year}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const data = await fetchJson(`/api/races?year=${year}`);
  cacheSet(key, data);
  return data;
}

async function getRaceTimeline(sessionKey) {
  const key = `race:${sessionKey}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const data = await fetchJson(`/api/race/${sessionKey}`);
  cacheSet(key, data);
  return data;
}

async function getPositions(sessionKey, fromIso, toIso) {
  // ไม่ cache ที่นี่ (ต่างจากข้างบน) เพราะ scrubber สร้างหน้าต่างเวลาที่ต่างกันทุกครั้งที่ลาก
  // cache ไว้จะบวมเปล่า ๆ โดยไม่ได้ hit ซ้ำจริง
  return fetchJson(`/api/positions/${sessionKey}?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`);
}

// ---------- DOM refs ----------
const yearSelect = document.getElementById("year-select");
const raceSelect = document.getElementById("race-select");
const raceError = document.getElementById("race-error");

const summarySkeleton = document.getElementById("summary-skeleton");
const summaryContent = document.getElementById("summary-content");

const timelineSkeleton = document.getElementById("timeline-skeleton");
const timelineEmpty = document.getElementById("timeline-empty");
const timelineErrorEl = document.getElementById("timeline-error");
const timelineRetryBtn = document.getElementById("timeline-retry");
const timelineList = document.getElementById("timeline-list");

const driverFilterSelect = document.getElementById("driver-filter");
const typeFilterSelect = document.getElementById("type-filter");
const sortButtons = Array.from(document.querySelectorAll(".sort-btn"));

const resultsSkeleton = document.getElementById("results-skeleton");
const resultsEmpty = document.getElementById("results-empty");
const resultsTable = document.getElementById("results-table");
const resultsTbody = resultsTable.querySelector("tbody");

const pitsSkeleton = document.getElementById("pits-skeleton");
const pitsEmpty = document.getElementById("pits-empty");
const pitsList = document.getElementById("pits-list");

const mapSkeleton = document.getElementById("map-skeleton");
const mapEmpty = document.getElementById("map-empty");
const mapErrorEl = document.getElementById("map-error");
const mapView = document.getElementById("map-view");
const mapStatusLabel = document.getElementById("map-status-label");
const trackPath = document.getElementById("track-path");
const carDotsGroup = document.getElementById("car-dots");
const timeScrubber = document.getElementById("time-scrubber");
const scrubberTimeLabel = document.getElementById("scrubber-time-label");

// ---------- state ----------
const state = {
  currentSessionKey: null,
  timeline: null, // ผลดิบจาก /api/race/:sessionKey
  sortKey: "time", // time | lap | driver
  driverFilter: "",
  typeFilter: "",
  highlightedDriver: null,
  resultsSortKey: "position",
  resultsSortAsc: true,
  driverEventIndex: null, // HashTable: driverNumber -> HashTable(eventId -> true)
  racesByKey: new HashTable(64), // sessionKey -> race object (จากรายชื่อเรซ) สำหรับ lookup circuitKey/dateStart
  trackData: null, // ผลจาก public/tracks/<circuitKey>.json ของเรซปัจจุบัน
  mapAnimationHandle: null,
  scrubberDebounceHandle: null,
  mapRequestId: 0, // กัน race condition: ถ้ามีคำขอใหม่กว่าเริ่มไปแล้ว ผลของคำขอเก่าที่ resolve ทีหลังต้องถูกทิ้ง
};

const TYPE_ICON = {
  overtake: "🔁",
  pit: "🔧",
  flag: "🚩",
  safety_car: "🚨",
  drs: "⚡",
  other_control: "ℹ️",
};

const FLAG_COLOR = {
  GREEN: "#2ea043",
  YELLOW: "#d29922",
  RED: "#f85149",
  BLUE: "#58a6ff",
  CHEQUERED: "#e6edf3",
  CLEAR: "#2ea043",
};

function show(el) {
  el.hidden = false;
}
function hide(el) {
  el.hidden = true;
}

// ---------- sort compare functions (ใช้ mergeSort จาก lib/sort.js เท่านั้น) ----------
function compareByTime(a, b) {
  return new Date(a.date) - new Date(b.date);
}
function compareByLap(a, b) {
  const la = a.lap ?? -1;
  const lb = b.lap ?? -1;
  if (la !== lb) return la - lb;
  return compareByTime(a, b);
}
function compareByDriver(a, b) {
  const da = a.drivers[0]?.acronym ?? "";
  const db = b.drivers[0]?.acronym ?? "";
  if (da !== db) return da < db ? -1 : 1;
  return compareByTime(a, b);
}

const SORT_COMPARATORS = {
  time: compareByTime,
  lap: compareByLap,
  driver: compareByDriver,
};

// ---------- rendering ----------

function renderSummary(summary, dataAvailability) {
  if (!summary || !summary.winner) {
    summaryContent.innerHTML = `<div class="summary-chip"><div class="label">สรุป</div><div class="value">ไม่มีข้อมูลสรุปสำหรับเรซนี้</div></div>`;
  } else {
    const chips = [
      { label: "ผู้ชนะ", value: `${summary.winner.fullName ?? "-"}` , color: summary.winner.teamColour },
      { label: "จำนวนรอบ", value: summary.totalLaps ?? "-" },
      { label: "แซงกี่ครั้ง", value: dataAvailability.hasOvertakes ? summary.overtakeCount : "ไม่มีข้อมูล" },
      { label: "เข้าพิทกี่ครั้ง", value: dataAvailability.hasPit ? summary.pitCount : "ไม่มีข้อมูล" },
    ];
    summaryContent.innerHTML = chips
      .map(
        (c) => `<div class="summary-chip" ${c.color ? `style="--team-color:#${c.color}"` : ""}>
          <div class="label">${c.label}</div>
          <div class="value">${c.value}</div>
        </div>`
      )
      .join("");
  }
  hide(summarySkeleton);
  show(summaryContent);
}

function eventCardHtml(e) {
  const icon = TYPE_ICON[e.type] ?? "•";
  const teamColor = e.drivers[0]?.teamColour ?? "888888";
  const lapLabel = e.lap != null ? `รอบ ${e.lap}${e.lapIsEstimated ? " (~)" : ""}` : "รอบ -";
  const timeLabel = new Date(e.date).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const flagStyle = e.type === "flag" && FLAG_COLOR[e.flag] ? ` style="--team-color:${FLAG_COLOR[e.flag]}"` : ` style="--team-color:#${teamColor}"`;

  const driverChips = e.drivers
    .map((d) => `<span class="driver-chip" data-driver="${d.driverNumber}" style="color:#${d.teamColour}">${d.acronym}</span>`)
    .join(" ");

  return `<li class="timeline-card" data-id="${e.id}" data-global="${e.driverNumbers.length === 0}"${flagStyle}>
    <span class="icon">${icon}</span>
    <div class="body">
      <div class="meta-row">
        <span class="lap-badge">${lapLabel}</span>
        <span>${timeLabel}</span>
      </div>
      <div class="message">${escapeHtml(e.message ?? "-")} ${driverChips}</div>
    </div>
  </li>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function getVisibleEvents() {
  const { timeline, sortKey, driverFilter, typeFilter } = state;
  if (!timeline) return [];

  let events = timeline.events;

  if (driverFilter) {
    const num = Number(driverFilter);
    events = events.filter((e) => e.driverNumbers.length === 0 || e.driverNumbers.includes(num));
  }
  if (typeFilter) {
    events = events.filter((e) => e.type === typeFilter);
  }

  // เรียงใน memory ด้วย mergeSort เอง ไม่ยิง API ใหม่ ตอบสนองทันที
  return mergeSort(events, SORT_COMPARATORS[sortKey]);
}

function renderTimeline() {
  if (!state.timeline) return;

  hide(timelineSkeleton);
  hide(timelineErrorEl);

  const events = getVisibleEvents();

  if (events.length === 0) {
    hide(timelineList);
    show(timelineEmpty);
    return;
  }

  hide(timelineEmpty);
  timelineList.innerHTML = events.map(eventCardHtml).join("");
  show(timelineList);

  applyHighlight();
}

function buildDriverEventIndex(events) {
  const index = new HashTable(32);
  for (const e of events) {
    for (const num of e.driverNumbers) {
      if (!index.has(num)) index.set(num, new HashTable(64));
      index.get(num).set(e.id, true);
    }
  }
  return index;
}

/**
 * applyHighlight - ใช้ HashTable (driverEventIndex) เพื่อเช็คว่าการ์ดนี้เกี่ยวกับนักขับที่เลือก
 * หรือไม่แบบ O(1) ต่อการ์ด (รวม O(n) ต่อการคลิกหนึ่งครั้งเพราะต้องวน DOM ทุกใบ แต่การเช็ค
 * ความเป็นสมาชิกเป็น O(1) ไม่ใช่ O(k) แบบ array.includes())
 */
function applyHighlight() {
  const cards = timelineList.querySelectorAll(".timeline-card");
  const num = state.highlightedDriver;

  for (const card of cards) {
    if (num == null) {
      card.classList.remove("dimmed", "highlighted");
      continue;
    }
    const isGlobal = card.dataset.global === "true";
    const membership = state.driverEventIndex?.get(num);
    const belongs = isGlobal || (membership ? membership.has(card.dataset.id) : false);
    card.classList.toggle("highlighted", belongs);
    card.classList.toggle("dimmed", !belongs);
  }
}

function renderResultsTable() {
  const { timeline, resultsSortKey, resultsSortAsc } = state;
  hide(resultsSkeleton);

  if (!timeline || timeline.sessionResult.length === 0) {
    hide(resultsTable);
    show(resultsEmpty);
    return;
  }
  hide(resultsEmpty);

  const compare = (a, b) => {
    const va = a[resultsSortKey];
    const vb = b[resultsSortKey];
    let cmp;
    if (typeof va === "string") cmp = va < vb ? -1 : va > vb ? 1 : 0;
    else cmp = (va ?? 0) - (vb ?? 0);
    return resultsSortAsc ? cmp : -cmp;
  };

  const sorted = mergeSort(timeline.sessionResult, compare);

  resultsTbody.innerHTML = sorted
    .map(
      (r) => `<tr>
        <td>${r.dnf ? "DNF" : r.position ?? "-"}</td>
        <td><span class="team-dot" style="--dot-color:#${r.teamColour}"></span>${escapeHtml(r.fullName)}</td>
        <td>${escapeHtml(r.teamName)}</td>
        <td>${r.points ?? 0}</td>
      </tr>`
    )
    .join("");

  resultsTable.querySelectorAll("th").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.sortKey === resultsSortKey);
  });

  show(resultsTable);
}

function renderPits() {
  hide(pitsSkeleton);
  const pits = state.timeline?.fastestPits ?? [];
  if (pits.length === 0) {
    hide(pitsList);
    show(pitsEmpty);
    return;
  }
  hide(pitsEmpty);
  pitsList.innerHTML = pits
    .slice(0, 8)
    .map(
      (p) => `<li><span class="team-dot" style="--dot-color:#${p.teamColour}"></span>${escapeHtml(p.fullName)} — ${p.pitDuration.toFixed(1)}s (รอบ ${p.lap ?? "-"})</li>`
    )
    .join("");
  show(pitsList);
}

function populateDriverFilter() {
  const drivers = state.timeline?.drivers ?? [];
  driverFilterSelect.innerHTML =
    `<option value="">ทุกคน</option>` +
    drivers.map((d) => `<option value="${d.driverNumber}">${escapeHtml(d.acronym)} — ${escapeHtml(d.teamName)}</option>`).join("");
  driverFilterSelect.value = state.driverFilter;
}

// ---------- track map (เฟส 2) ----------

function stopMapAnimation() {
  if (state.mapAnimationHandle != null) {
    cancelAnimationFrame(state.mapAnimationHandle);
    state.mapAnimationHandle = null;
  }
}

function renderTrackPath(trackData) {
  const d = trackData.points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ") + " Z";
  trackPath.setAttribute("d", d);
  document.getElementById("track-svg").setAttribute("viewBox", `0 0 ${trackData.viewBox.width} ${trackData.viewBox.height}`);
}

/** initCarDots - สร้าง SVG element ของรถแต่ละคันครั้งเดียวตอนโหลดเรซ แล้วแก้แค่ตำแหน่ง/opacity ทีหลัง */
function initCarDots(drivers) {
  carDotsGroup.innerHTML = drivers
    .map(
      (d) => `<g class="car-dot" data-driver="${d.driverNumber}" style="opacity:0">
        <circle r="7" fill="#${d.teamColour}"></circle>
        <text y="-11">${escapeHtml(d.acronym)}</text>
      </g>`
    )
    .join("");
}

/** interpolatePosition - เดา (x,y) ที่เวลา targetMs จาก sample ที่มี (เชิงเส้นระหว่าง 2 จุดที่ใกล้ที่สุด) */
function interpolatePosition(samples, targetMs) {
  if (!samples || samples.length === 0) return null;
  if (samples.length === 1) return samples[0];

  let prev = samples[0];
  const prevTime = new Date(prev.date).getTime();
  if (targetMs <= prevTime) return prev;

  for (let i = 1; i < samples.length; i++) {
    const cur = samples[i];
    const curMs = new Date(cur.date).getTime();
    const prevMs = new Date(prev.date).getTime();
    if (targetMs <= curMs) {
      const ratio = curMs === prevMs ? 0 : (targetMs - prevMs) / (curMs - prevMs);
      return { x: prev.x + (cur.x - prev.x) * ratio, y: prev.y + (cur.y - prev.y) * ratio };
    }
    prev = cur;
  }
  return samples[samples.length - 1];
}

/** updateDotsAtTime - วางจุดรถทุกคันที่เวลา targetMs, ทำให้นักขับใน highlightDriverNumbers เต็ม คนอื่นจาง */
function updateDotsAtTime(positions, targetMs, highlightDriverNumbers = []) {
  if (!state.trackData) return;
  const highlight = highlightDriverNumbers.length > 0 ? new HashTable(8) : null;
  if (highlight) highlightDriverNumbers.forEach((n) => highlight.set(n, true));

  const dots = carDotsGroup.querySelectorAll(".car-dot");
  for (const dot of dots) {
    const driverNumber = Number(dot.dataset.driver);
    const samples = positions[driverNumber] ?? positions[String(driverNumber)];
    const raw = interpolatePosition(samples, targetMs);
    if (!raw) {
      dot.style.opacity = "0";
      continue;
    }
    const { x, y } = applyTrackTransform(state.trackData.transform, raw);
    dot.setAttribute("transform", `translate(${x.toFixed(1)}, ${y.toFixed(1)})`);
    dot.style.opacity = !highlight || highlight.has(driverNumber) ? "1" : "0.25";
  }
}

function showMapLoading() {
  stopMapAnimation();
  hide(mapView);
  hide(mapEmpty);
  hide(mapErrorEl);
  show(mapSkeleton);
  mapStatusLabel.textContent = "";
}

function showMapEmpty() {
  stopMapAnimation();
  hide(mapSkeleton);
  hide(mapView);
  hide(mapErrorEl);
  show(mapEmpty);
}

function showMapErrorState() {
  stopMapAnimation();
  hide(mapSkeleton);
  hide(mapView);
  hide(mapEmpty);
  show(mapErrorEl);
}

function initScrubberRange(race) {
  const startMs = new Date(race.dateStart).getTime();
  const endMs = new Date(race.dateEnd ?? race.dateStart).getTime();
  timeScrubber.min = String(startMs);
  timeScrubber.max = String(endMs > startMs ? endMs : startMs + 60 * 60 * 1000);
}

function formatClock(ms) {
  return new Date(ms).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** seekMapTo - โหลดตำแหน่งรถรอบเวลา targetMs (±5s) แล้วแสดงภาพนิ่งที่เวลานั้นพอดี (ใช้กับ scrubber) */
async function seekMapTo(targetMs, highlightDriverNumbers = []) {
  if (!state.trackData || state.currentSessionKey == null) return;
  stopMapAnimation();
  const requestId = ++state.mapRequestId;

  const fromIso = new Date(targetMs - 5000).toISOString();
  const toIso = new Date(targetMs + 5000).toISOString();

  try {
    const { positions } = await getPositions(state.currentSessionKey, fromIso, toIso);
    // ระหว่างรอ fetch อาจมีการสั่ง seek/play ใหม่แซงมาแล้ว (เช่นลาก scrubber เร็ว ๆ) ถ้าไม่ใช่
    // คำขอล่าสุดอีกต่อไป ต้องทิ้งผลนี้ ไม่งั้นจะไปเขียนทับตำแหน่งที่ใหม่กว่าด้วยข้อมูลเก่า
    if (requestId !== state.mapRequestId) return;
    updateDotsAtTime(positions, targetMs, highlightDriverNumbers);
  } catch (err) {
    console.error(err);
    // ไม่ทำให้แผนที่พัง แค่ไม่ขยับตำแหน่งรถในครั้งนี้ (เช่นช่วงเวลานั้นไม่มีข้อมูล)
  }
}

/** playEventOnMap - เล่น animation ตำแหน่งรถช่วง ±5 วินาทีรอบ event ที่คลิกในไทม์ไลน์ */
async function playEventOnMap(event) {
  if (!state.trackData || state.currentSessionKey == null) return;
  stopMapAnimation();
  const requestId = ++state.mapRequestId;

  const centerMs = new Date(event.date).getTime();
  const fromMs = centerMs - 5000;
  const toMs = centerMs + 5000;
  const fromIso = new Date(fromMs).toISOString();
  const toIso = new Date(toMs).toISOString();

  mapStatusLabel.textContent = "▶ กำลังเล่นเหตุการณ์...";
  timeScrubber.value = String(centerMs);
  scrubberTimeLabel.textContent = formatClock(centerMs);

  try {
    const { positions } = await getPositions(state.currentSessionKey, fromIso, toIso);
    if (requestId !== state.mapRequestId) return; // มีคำขอใหม่กว่าแซงมาระหว่างรอ fetch นี้

    const durationMs = toMs - fromMs;
    const animStart = performance.now();

    const tick = () => {
      if (requestId !== state.mapRequestId) return; // ถูกยกเลิกโดยคำสั่งใหม่กว่าระหว่าง animate
      const elapsed = performance.now() - animStart;
      const simTime = fromMs + Math.min(elapsed, durationMs);
      updateDotsAtTime(positions, simTime, event.driverNumbers);
      if (elapsed < durationMs) {
        state.mapAnimationHandle = requestAnimationFrame(tick);
      } else {
        mapStatusLabel.textContent = "";
      }
    };
    tick();
  } catch (err) {
    console.error(err);
    if (requestId !== state.mapRequestId) return;
    mapStatusLabel.textContent = "โหลดตำแหน่งรถของเหตุการณ์นี้ไม่สำเร็จ";
  }
}

async function loadTrackForRace(race) {
  showMapLoading();
  state.trackData = null;

  if (!race.circuitKey) {
    showMapEmpty();
    return;
  }

  try {
    const res = await fetch(`/tracks/${race.circuitKey}.json`);
    if (!res.ok) {
      showMapEmpty();
      return;
    }
    state.trackData = await res.json();
    renderTrackPath(state.trackData);
    initCarDots(state.timeline?.drivers ?? []);
    initScrubberRange(race);

    hide(mapSkeleton);
    show(mapView);

    // แสดงตำแหน่งเริ่มต้นจาก event แรกในไทม์ไลน์ (รับประกันว่าช่วงนั้นมีรถวิ่งจริงแน่ ๆ)
    const initialMs = state.timeline?.events?.[0] ? new Date(state.timeline.events[0].date).getTime() : new Date(race.dateStart).getTime();
    timeScrubber.value = String(initialMs);
    scrubberTimeLabel.textContent = formatClock(initialMs);
    await seekMapTo(initialMs);
  } catch (err) {
    console.error(err);
    showMapErrorState();
  }
}

// ---------- error / loading states for the whole race panel ----------

function showTimelineLoading() {
  hide(timelineList);
  hide(timelineEmpty);
  hide(timelineErrorEl);
  show(timelineSkeleton);

  hide(resultsTable);
  hide(resultsEmpty);
  show(resultsSkeleton);

  hide(pitsList);
  hide(pitsEmpty);
  show(pitsSkeleton);

  hide(summaryContent);
  show(summarySkeleton);
}

function showTimelineError() {
  hide(timelineSkeleton);
  hide(timelineEmpty);
  hide(timelineList);
  show(timelineErrorEl);

  hide(resultsSkeleton);
  hide(resultsTable);
  show(resultsEmpty);
  resultsEmpty.querySelector("p").textContent = "โหลดผลจบการแข่งไม่สำเร็จ";

  hide(pitsSkeleton);
  hide(pitsList);
  show(pitsEmpty);
  pitsEmpty.querySelector("p").textContent = "โหลดข้อมูลพิทไม่สำเร็จ";

  hide(summarySkeleton);
  show(summaryContent);
  summaryContent.innerHTML = `<div class="summary-chip"><div class="label">สรุป</div><div class="value">โหลดข้อมูลไม่สำเร็จ</div></div>`;
}

// ---------- main load ----------

async function loadRace(sessionKey) {
  state.currentSessionKey = sessionKey;
  state.highlightedDriver = null;
  showTimelineLoading();
  showMapLoading();

  try {
    const timeline = await getRaceTimeline(sessionKey);
    if (state.currentSessionKey !== sessionKey) return; // ผู้ใช้เปลี่ยนเรซไปแล้วระหว่างรอ

    state.timeline = timeline;
    state.driverEventIndex = buildDriverEventIndex(timeline.events);
    state.driverFilter = "";
    state.typeFilter = "";
    typeFilterSelect.value = "";

    populateDriverFilter();
    renderSummary(timeline.summary, timeline.dataAvailability);
    renderTimeline();
    renderResultsTable();
    renderPits();

    const race = state.racesByKey.get(sessionKey);
    if (race) loadTrackForRace(race);
    else showMapEmpty();
  } catch (err) {
    console.error(err);
    if (state.currentSessionKey !== sessionKey) return;
    showTimelineError();
    showMapErrorState();
  }
}

async function loadRacesForYear(year) {
  hide(raceError);
  raceSelect.disabled = true;
  raceSelect.innerHTML = `<option>กำลังโหลด...</option>`;

  try {
    const { races } = await getRaces(year);
    if (races.length === 0) {
      raceSelect.innerHTML = `<option>ไม่มีเรซในปีนี้</option>`;
      return;
    }
    for (const r of races) state.racesByKey.set(r.sessionKey, r);
    raceSelect.innerHTML = races
      .map((r) => `<option value="${r.sessionKey}">${escapeHtml(r.meetingName)} — ${escapeHtml(r.sessionName)}</option>`)
      .join("");
    raceSelect.disabled = false;
    raceSelect.value = String(races[0].sessionKey);
    await loadRace(races[0].sessionKey);
  } catch (err) {
    console.error(err);
    raceSelect.innerHTML = `<option>โหลดรายชื่อเรซไม่สำเร็จ</option>`;
    show(raceError);
    raceError.textContent = "โหลดรายชื่อเรซไม่สำเร็จ — ตรวจสอบการเชื่อมต่อแล้วลองเลือกปีใหม่อีกครั้ง";
  }
}

// ---------- event wiring ----------

function initYearSelect() {
  yearSelect.innerHTML = YEARS.map((y) => `<option value="${y}">${y}</option>`).join("");
  yearSelect.value = String(DEFAULT_YEAR);
}

yearSelect.addEventListener("change", () => {
  loadRacesForYear(Number(yearSelect.value));
});

raceSelect.addEventListener("change", () => {
  if (raceSelect.value) loadRace(Number(raceSelect.value));
});

sortButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    sortButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.sortKey = btn.dataset.sort;
    renderTimeline();
  });
});

driverFilterSelect.addEventListener("change", () => {
  state.driverFilter = driverFilterSelect.value;
  renderTimeline();
});

typeFilterSelect.addEventListener("change", () => {
  state.typeFilter = typeFilterSelect.value;
  renderTimeline();
});

timelineList.addEventListener("click", (evt) => {
  const chip = evt.target.closest(".driver-chip");
  if (chip) {
    const num = Number(chip.dataset.driver);
    state.highlightedDriver = state.highlightedDriver === num ? null : num;
    applyHighlight();
    return;
  }

  // คลิกที่ตัวการ์ด (ไม่ใช่ driver-chip) → เล่น animation ตำแหน่งรถบนแผนที่ช่วง ±5s ของ event นั้น
  const card = evt.target.closest(".timeline-card");
  if (!card) return;
  const event = state.timeline?.events.find((e) => e.id === card.dataset.id);
  if (event) playEventOnMap(event);
});

timeScrubber.addEventListener("input", () => {
  const targetMs = Number(timeScrubber.value);
  scrubberTimeLabel.textContent = formatClock(targetMs);
  clearTimeout(state.scrubberDebounceHandle);
  state.scrubberDebounceHandle = setTimeout(() => seekMapTo(targetMs), 200);
});

timelineRetryBtn.addEventListener("click", () => {
  if (state.currentSessionKey != null) loadRace(state.currentSessionKey);
});

resultsTable.querySelectorAll("th[data-sort-key]").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.sortKey;
    if (state.resultsSortKey === key) {
      state.resultsSortAsc = !state.resultsSortAsc;
    } else {
      state.resultsSortKey = key;
      state.resultsSortAsc = true;
    }
    renderResultsTable();
  });
});

// ---------- init: ต้องมีเรซ default โหลดไว้แล้วตั้งแต่เปิดหน้า ----------
initYearSelect();
loadRacesForYear(DEFAULT_YEAR);
