// public/app.js
// Vanilla JS frontend — ไม่มี framework, ไม่มี build step
// import DSA เดียวกับที่ server ใช้ตรงจาก /lib ผ่าน Express static (ES module native ในเบราว์เซอร์)
import { mergeSort } from "/lib/sort.js";
import { HashTable } from "/lib/HashTable.js";
import { Queue } from "/lib/Queue.js";
import { applyTrackTransform } from "/lib/track.js";

const FIRST_YEAR = 2023;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// สร้างตัวจัดรูปแบบเวลาครั้งเดียวใช้ซ้ำ — toLocaleTimeString สร้างใหม่ทุกครั้งที่เรียก ช้ากว่า ~5 เท่า
// (render ไทม์ไลน์ 500 การ์ดเคยเสียเวลากับส่วนนี้ ~100ms ทุกครั้งที่กดเรียง/กรอง)
const clockFormat = new Intl.DateTimeFormat("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

// ---------- client-side cache (ชั้นที่ 2 ต่อจาก module-scope cache บน server) ----------
// เรซที่จบไปนานแล้วข้อมูลไม่เปลี่ยน cache ถาวรได้ แต่ "รายชื่อเรซของปีปัจจุบัน" กับ "เรซที่เพิ่งจบ"
// ต้องหมดอายุได้ ไม่งั้นเรซใหม่จะไม่โผล่ในเครื่องที่เคยเปิดเว็บไปแล้ว (เก็บเวลาบันทึกไว้คู่กับข้อมูล)
// เพิ่มเลขเวอร์ชันทุกครั้งที่ schema ของ response/รูปแบบ cache เปลี่ยน ไม่งั้นจะอ่านของเก่าที่ผิดรูปแบบ
const CACHE_PREFIX = "f1rr:v3:";

function cacheGet(key, maxAgeMs = Infinity) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const { savedAt, data } = JSON.parse(raw);
    return Date.now() - savedAt <= maxAgeMs ? data : null;
  } catch {
    return null;
  }
}

function cacheSet(key, data) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ savedAt: Date.now(), data }));
  } catch {
    // localStorage อาจไม่พร้อมใช้ (private mode, เต็ม) — ไม่เป็นไร แค่เสีย cache ไปเฉย ๆ
  }
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function getYears() {
  try {
    const { years } = await fetchJson("/api/years");
    return years;
  } catch {
    // API ล่มก็ยังเลือกปีได้ คำนวณเองจากนาฬิกาเครื่อง
    const years = [];
    for (let y = new Date().getFullYear(); y >= FIRST_YEAR; y--) years.push(y);
    return years;
  }
}

async function getRaces(year) {
  const key = `races:${year}`;
  const isCurrentSeason = year >= new Date().getFullYear();
  const cached = cacheGet(key, isCurrentSeason ? 10 * MINUTE_MS : Infinity);
  if (cached) return cached;
  const data = await fetchJson(`/api/races?year=${year}`);
  cacheSet(key, data);
  return data;
}

async function getRaceTimeline(race) {
  const key = `race:${race.sessionKey}`;
  // เรซที่เพิ่งจบไม่ถึงวัน OpenF1 อาจยังประมวลผลข้อมูลไม่ครบ อย่าเก็บถาวร
  const finishedLongAgo = Date.now() - new Date(race.dateEnd).getTime() > DAY_MS;
  const cached = cacheGet(key, finishedLongAgo ? Infinity : 10 * MINUTE_MS);
  if (cached) return cached;
  const data = await fetchJson(`/api/race/${race.sessionKey}`);
  cacheSet(key, data);
  return data;
}

/**
 * getTrack - เส้นสนามของเรซนี้: ลองไฟล์ที่ precompute ไว้ก่อน (เร็วสุด) ถ้าไม่มี (สนามใหม่ในปฏิทิน)
 * ให้ server สร้างสดจากพิกัดจริงผ่าน /api/track — เรซใหม่ สนามใหม่ ใช้ได้ทันทีโดยไม่ต้องแก้โค้ด
 */
async function getTrack(race, onGenerating) {
  const key = `track:${race.circuitKey}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const res = await fetch(`/tracks/${race.circuitKey}.json`);
  let track;
  if (res.ok) {
    track = await res.json();
  } else if (res.status === 404) {
    onGenerating?.();
    track = await fetchJson(`/api/track/${race.sessionKey}`);
  } else {
    throw new Error(`HTTP ${res.status}`);
  }
  cacheSet(key, track);
  return track;
}

async function getPositions(sessionKey, fromMs, toMs, { signal, prefetch = false } = {}) {
  // ไม่ cache ใน localStorage (ข้อมูลก้อนใหญ่ เก็บแล้วเต็มเร็ว) แต่ขอบเวลาถูกจัดให้ตรง "ตาราง" เสมอ
  // (ดู CHUNK_MS) URL เดิมซ้ำได้ → CDN ของ Vercel ตอบจาก cache ได้ ทั้งของเราเองและผู้ใช้คนอื่น
  // บอก server ว่าเป็นการโหลดล่วงหน้าผ่าน header (ไม่ใส่ใน URL ไม่งั้น cache key ของ CDN จะแตกเป็น 2 ชุด)
  const from = encodeURIComponent(new Date(fromMs).toISOString());
  const to = encodeURIComponent(new Date(toMs).toISOString());
  const headers = prefetch ? { "X-Prefetch": "1" } : undefined;
  return fetchJson(`/api/positions/${sessionKey}?from=${from}&to=${to}`, { signal, headers });
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
const playPauseBtn = document.getElementById("play-pause-btn");
const skipBackBtn = document.getElementById("skip-back-btn");
const skipForwardBtn = document.getElementById("skip-forward-btn");
const speedButtons = Array.from(document.querySelectorAll(".speed-btn"));
const bufferFill = document.getElementById("buffer-fill");

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
  pitWindowIndex: null, // HashTable: driverNumber -> [{startMs, endMs}] ช่วงที่กำลังเข้าพิท (ใช้กับแมพ)
  eventTimes: [], // เวลา (ms) ของแต่ละ event ใน timeline.events แปลงไว้ครั้งเดียว ไว้ค้นแบบ binary search
  cardById: null, // HashTable: eventId -> <li> การ์ดในไทม์ไลน์ (สร้างใหม่ทุกครั้งที่ render)
  cardTops: null, // HashTable: eventId -> offsetTop ของการ์ด (จำไว้ ไม่ต้องอ่าน layout ทุกเฟรม)
  markedCard: null, // การ์ดที่ติด class current-time อยู่ตอนนี้
  lastSyncedEventId: null, // event ปัจจุบันที่ mark ไว้ตามเวลาของแมพ (ใช้ re-mark หลัง re-render ด้วย)
  racesByKey: new HashTable(64), // sessionKey -> race object (จากรายชื่อเรซ) สำหรับ lookup circuitKey/dateStart
  trackData: null, // เส้นสนามของเรซปัจจุบัน (จาก public/tracks หรือ /api/track)
  dots: [], // [{ driverNumber, el, badge, lastTransform, lastOpacity, lastBadge }] สร้างครั้งเดียวต่อเรซ
  mapAnimationHandle: null,
  scrubberDebounceHandle: null,
  player: {
    playing: false,
    waiting: false, // กดเล่นแล้วแต่ข้อมูลล่วงหน้ายังไม่พอ → หยุดนาฬิการอ (แบบวิดีโอ buffering)
    speed: 1, // x1/x2/x5/x10
    currentMs: null, // เวลาปัจจุบันของการเล่น (epoch ms)
    chunks: new Queue(8), // คิวก้อนพิกัดที่โหลดแล้ว เรียงตามเวลา (หัวคิว = เก่าสุด)
    bufferedUntilMs: null, // ปลายสุดของข้อมูลที่โหลดต่อเนื่องแล้ว
    // กัน race condition: ทุกครั้งที่ล้างบัฟเฟอร์ (กระโดดเวลา/เปลี่ยนเรซ) เลขนี้เพิ่ม ผลของ request
    // รุ่นเก่าที่ตอบกลับมาทีหลังจะถูกทิ้ง ไม่ไปปนกับข้อมูลของตำแหน่งใหม่
    bufferGen: 0,
    fetchingGen: null, // generation ของตัวโหลดที่กำลังทำงาน (null = ว่าง)
    loadError: false,
    abort: null, // AbortController ของ request ที่ค้างอยู่ ยกเลิกได้ตอนกระโดดไปเวลาอื่น
    lastFrameTime: null,
    lastClockSecond: null,
    clip: null, // { endMs, highlight } ตอนเล่นคลิปเหตุการณ์ที่คลิกจากไทม์ไลน์
  },
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
  const timeLabel = clockFormat.format(Date.parse(e.date));
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

  // index การ์ดตาม eventId ไว้ให้ตัว sync กับแผนที่หาเจอแบบ O(1) ทุกเฟรม แทน querySelector ทั้งลิสต์
  state.cardById = new HashTable(Math.max(16, events.length * 2));
  for (const card of timelineList.children) state.cardById.set(card.dataset.id, card);
  state.cardTops = null; // การ์ดชุดใหม่ ตำแหน่งเปลี่ยน ต้องวัดใหม่
  state.markedCard = null;

  applyHighlight();
  markCurrentTimeCard(state.lastSyncedEventId); // re-render (เปลี่ยน sort/filter) ทำให้ DOM เดิมหาย ต้อง mark ใหม่ (ไม่ scroll)
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

// เข้าพิทใช้เวลาจริงราว ๆ pitDuration วินาทีจาก event.date (เวลาที่เข้า pit lane) แต่ log ของ
// /pit ไม่บอกเวลาที่ "ออกจาก" pit lane ตรง ๆ จึงประมาณช่วงเข้าพิทเป็น [date, date+pitDuration]
// แล้วขยายเผื่อ (padding) อีกเล็กน้อยทั้งสองด้าน ให้ badge บนแมพขึ้น/ลงไม่กระทันหันเกินไป
const PIT_WINDOW_PADDING_MS = 1500;

/** buildPitWindowIndex - HashTable: driverNumber -> array ของช่วงเวลาที่กำลังเข้าพิท (ใช้กับแมพ) */
function buildPitWindowIndex(events) {
  const index = new HashTable(16);
  for (const e of events) {
    if (e.type !== "pit" || e.pitDuration == null) continue;
    const startMs = new Date(e.date).getTime() - PIT_WINDOW_PADDING_MS;
    const endMs = startMs + e.pitDuration * 1000 + PIT_WINDOW_PADDING_MS * 2;
    for (const num of e.driverNumbers) {
      if (!index.has(num)) index.set(num, []);
      index.get(num).push({ startMs, endMs });
    }
  }
  return index;
}

/** isInPitWindow - เช็คว่า driverNumber กำลังอยู่ในช่วงเข้าพิทที่ targetMs หรือไม่ */
function isInPitWindow(pitWindowIndex, driverNumber, targetMs) {
  const windows = pitWindowIndex?.get(driverNumber);
  if (!windows) return false;
  return windows.some((w) => targetMs >= w.startMs && targetMs <= w.endMs);
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

/**
 * upperBound - หา index สุดท้ายที่ times[i] <= target ด้วย binary search (คืน -1 ถ้าไม่มี)
 * Time complexity: O(log n) — ถูกเรียกทุกเฟรมตอนเล่นแผนที่ (เดิมวน + parse วันที่ทุก event ทุกเฟรม = O(n))
 */
function upperBound(times, target) {
  let lo = 0;
  let hi = times.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= target) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * findEventBracket - หา event "ปัจจุบัน" และ "ถัดไป" ครอบ targetMs ไว้ พร้อม progress (0-1)
 * ว่าระหว่างสอง event นี้ผ่านไปแล้วกี่เปอร์เซ็นต์ (events เรียงตามเวลาจาก server อยู่แล้ว)
 * ใช้ progress นี้ไปเลื่อนจอแบบต่อเนื่อง (interpolate) ไม่ใช่กระโดดเป็นช่วง ๆ ทีละการ์ด
 */
function findEventBracket(targetMs) {
  const events = state.timeline?.events;
  const times = state.eventTimes;
  if (!events || events.length === 0) return null;

  const i = upperBound(times, targetMs);
  if (i < 0) return { current: events[0], next: events[1] ?? null, progress: 0 };
  if (i >= events.length - 1) return { current: events[events.length - 1], next: null, progress: 0 };

  const span = times[i + 1] - times[i];
  const progress = span === 0 ? 1 : (targetMs - times[i]) / span;
  return { current: events[i], next: events[i + 1], progress };
}

/** markCurrentTimeCard - ใส่/เอา class current-time ตาม eventId ที่ให้มา (ไม่ scroll) */
function markCurrentTimeCard(eventId) {
  const card = eventId ? state.cardById?.get(eventId) : null;
  if (state.markedCard === card) return;
  state.markedCard?.classList.remove("current-time");
  card?.classList.add("current-time");
  state.markedCard = card ?? null;
}

/**
 * cardTop - ตำแหน่ง offsetTop ของการ์ด (เทียบกับ .timeline-list ที่ตั้ง position: relative)
 * วัดทุกใบครั้งเดียวแล้วจำใน HashTable — ถ้าอ่าน offsetTop สด ๆ ทุกเฟรมหลังจากเพิ่งขยับจุดรถ
 * เบราว์เซอร์จะถูกบังคับคำนวณ layout ทั้งหน้าใหม่ทุกเฟรม (forced reflow) ซึ่งเป็นต้นเหตุหลักของอาการกระตุก
 */
function cardTop(eventId) {
  if (!state.cardTops) {
    state.cardTops = new HashTable(Math.max(16, timelineList.children.length * 2));
    for (const card of timelineList.children) state.cardTops.set(card.dataset.id, card.offsetTop);
  }
  return state.cardTops.get(eventId);
}

/**
 * syncTimelineToTime - เลื่อนไทม์ไลน์ด้านล่างให้ตามเวลาปัจจุบันแบบต่อเนื่อง (การ์ดปัจจุบันค่อย ๆ
 * เลื่อนขึ้นไปแทนที่การ์ดก่อนหน้าตาม progress ระหว่าง event ปัจจุบันกับ event ถัดไป)
 */
function syncTimelineToTime(targetMs) {
  const bracket = findEventBracket(targetMs);
  if (!bracket) return;

  state.lastSyncedEventId = bracket.current.id;

  const currentTop = cardTop(bracket.current.id);
  markCurrentTimeCard(bracket.current.id);
  if (currentTop == null) return; // ถูกกรองออกด้วย filter อยู่ ข้ามการเลื่อนจอ

  const nextTop = (bracket.next && cardTop(bracket.next.id)) ?? currentTop;
  const target = Math.max(0, currentTop + (nextTop - currentTop) * bracket.progress);

  // เลื่อนแค่กล่อง timelineList เอง ไม่เลื่อนหน้าเว็บทั้งหน้า เพื่อให้เห็นแมพกับไทม์ไลน์พร้อมกันตลอด
  if (Math.abs(timelineList.scrollTop - target) >= 0.5) timelineList.scrollTop = target;
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
//
// ตัวเล่นแผนที่ทำงานแบบเดียวกับเครื่องเล่นวิดีโอ: "เก็บข้อมูลล่วงหน้าก่อนแล้วค่อยวิ่ง"
//   - พิกัดรถถูกโหลดเป็นก้อน ๆ ละ CHUNK_MS ต่อท้ายคิว (Queue ที่เขียนเอง) ไว้ล่วงหน้าเสมอ
//   - กดเล่นแล้วถ้าข้อมูลล่วงหน้ายังไม่พอ จะ "รอ" (หยุดนาฬิกา + แสดง % ที่โหลดแล้ว) จนพอค่อยวิ่ง
//   - ถ้าเน็ตช้าจนตามไม่ทันกลางทาง นาฬิกาหยุดรอ แทนที่เวลาเดินต่อแต่จุดรถค้างอยู่กับที่ (อาการ
//     "กระตุก" แบบเดิม) แล้ววิ่งต่อเมื่อมีข้อมูลล่วงหน้าพออีกครั้ง
//   - ก้อนที่เล่นผ่านไปนานแล้ว dequeue ออกจากหัวคิว (O(1)) memory จึงไม่บวมแม้เล่นทั้งเรซ

const CHUNK_MS = 50000; // ต้อง ≤ 60 วินาที (ข้อจำกัดของ /api/positions)
const BACK_BUFFER_MS = 15000; // เก็บข้อมูลย้อนหลังไว้บ้าง ให้กด ⏪ 10s ได้ทันทีไม่ต้องโหลดใหม่

/** ข้อมูลล่วงหน้าที่อยากมีเสมอ (เวลาจำลอง) — ยิ่งเร่งความเร็วยิ่งต้องเยอะ เพราะเวลาจำลองหมดเร็วกว่าเวลาจริง */
function bufferAheadTargetMs() {
  return Math.max(100000, 25000 * state.player.speed);
}

/**
 * ต้องมีข้อมูลล่วงหน้าอย่างน้อยเท่านี้ก่อนเริ่มเล่น/เล่นต่อหลังสะดุด — คิดเป็นเวลาจริงราว 10 วินาที
 * (x1 ใช้ขั้นต่ำ 30 วินาที) เผื่อให้ตัวโหลดตามทันถ้าเน็ตช้าลงกลางทาง แทนที่จะวิ่ง-หยุดถี่ ๆ
 */
function startReadyMs() {
  return Math.max(30000, 10000 * state.player.speed);
}

/**
 * alignToChunk - ปัดเวลาลงให้ตรง "ตาราง" ทุก CHUNK_MS เสมอ ทำให้ URL ของแต่ละก้อนเหมือนเดิมทุกครั้ง
 * ไม่ว่าจะเริ่มเล่นจากจุดไหน → CDN ตอบจาก cache ได้ (ทั้งการเล่นซ้ำของเราเองและของผู้ใช้คนอื่น)
 */
function alignToChunk(ms) {
  return Math.floor(ms / CHUNK_MS) * CHUNK_MS;
}

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

/** initCarDots - สร้าง SVG ของรถแต่ละคันครั้งเดียวต่อเรซ เก็บ reference ไว้ ไม่ต้อง querySelector ทุกเฟรม */
function initCarDots(drivers) {
  carDotsGroup.innerHTML = drivers
    .map(
      (d) => `<g class="car-dot" data-driver="${d.driverNumber}" style="opacity:0">
        <circle r="7" fill="#${d.teamColour}"></circle>
        <text y="-11">${escapeHtml(d.acronym)}</text>
        <text class="pit-badge" y="18" opacity="0">🔧 PIT</text>
      </g>`
    )
    .join("");
  state.dots = Array.from(carDotsGroup.children).map((el) => ({
    driverNumber: Number(el.dataset.driver),
    el,
    badge: el.querySelector(".pit-badge"),
    lastTransform: null,
    lastOpacity: "0",
    lastBadge: "0",
  }));
}

/**
 * parseChunk - แปลงพิกัดดิบของก้อนหนึ่งให้พร้อมใช้ทุกเฟรม: parse วันที่เป็นตัวเลขครั้งเดียวตอนโหลด
 * (เดิม parse ใหม่ทุกจุดทุกเฟรม) และเก็บแยกตามนักขับใน HashTable ไว้หาแบบ O(1)
 */
function parseChunk(fromMs, toMs, positions) {
  const series = new HashTable(32);
  for (const key of Object.keys(positions)) {
    const samples = positions[key];
    const n = samples.length;
    if (n === 0) continue;
    const t = new Float64Array(n);
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      t[i] = Date.parse(samples[i].date);
      x[i] = samples[i].x;
      y[i] = samples[i].y;
    }
    series.set(Number(key), { t, x, y });
  }
  return { fromMs, toMs, series };
}

/** findChunkIndex - ตำแหน่งในคิวของก้อนที่ครอบเวลา ms (คิวสั้นแค่ ~2–8 ก้อน) คืน -1 ถ้ายังไม่มี */
function findChunkIndex(ms) {
  const chunks = state.player.chunks;
  for (let i = 0; i < chunks.size; i++) {
    const c = chunks.at(i);
    if (ms >= c.fromMs && ms < c.toMs) return i;
  }
  const last = chunks.peekLast();
  return last && ms === last.toMs ? chunks.size - 1 : -1;
}

/**
 * sampleAt - ตำแหน่ง (x,y) ที่เวลา ms แบบ linear interpolation ระหว่าง 2 จุดที่ครอบอยู่
 * หาด้วย binary search: O(log n) ต่อคัน (เดิมวนหาแบบ linear + parse วันที่ทุกจุด)
 */
function sampleAt(s, ms, nextSeries) {
  const n = s.t.length;
  if (ms <= s.t[0]) return { x: s.x[0], y: s.y[0] };
  if (ms >= s.t[n - 1]) {
    // เลยจุดสุดท้ายของก้อนนี้แต่ยังไม่ถึงก้อนถัดไป → ต่อเส้นไปหาจุดแรกของก้อนถัดไป ไม่ให้รถค้างตรงรอยต่อ
    if (nextSeries && nextSeries.t[0] > s.t[n - 1]) {
      const r = Math.min(1, (ms - s.t[n - 1]) / (nextSeries.t[0] - s.t[n - 1]));
      return { x: s.x[n - 1] + (nextSeries.x[0] - s.x[n - 1]) * r, y: s.y[n - 1] + (nextSeries.y[0] - s.y[n - 1]) * r };
    }
    return { x: s.x[n - 1], y: s.y[n - 1] };
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s.t[mid] <= ms) lo = mid;
    else hi = mid;
  }
  const r = (ms - s.t[lo]) / (s.t[hi] - s.t[lo] || 1);
  return { x: s.x[lo] + (s.x[hi] - s.x[lo]) * r, y: s.y[lo] + (s.y[hi] - s.y[lo]) * r };
}

/** renderDots - วางจุดรถทุกคันที่เวลา ms โดยเขียน DOM เฉพาะค่าที่เปลี่ยนจริง (ลดงาน layout/paint ต่อเฟรม) */
function renderDots(ms) {
  if (!state.trackData) return;
  const idx = findChunkIndex(ms);
  if (idx < 0) return; // ยังไม่มีข้อมูลช่วงนี้ ค้างตำแหน่งเดิมไว้ (ตัวเล่นจะหยุดนาฬิการอเอง)
  const chunk = state.player.chunks.at(idx);
  const nextChunk = state.player.chunks.at(idx + 1);
  const highlight = state.player.clip?.highlight ?? null;

  for (const dot of state.dots) {
    const s = chunk.series.get(dot.driverNumber);
    let transform = dot.lastTransform;
    let opacity = "0";
    let badge = "0";
    if (s) {
      const raw = sampleAt(s, ms, nextChunk?.series.get(dot.driverNumber));
      const { x, y } = applyTrackTransform(state.trackData.transform, raw);
      transform = `translate(${x.toFixed(1)}, ${y.toFixed(1)})`;
      opacity = !highlight || highlight.has(dot.driverNumber) ? "1" : "0.25";
      badge = isInPitWindow(state.pitWindowIndex, dot.driverNumber, ms) ? "1" : "0";
    }
    if (transform !== dot.lastTransform) {
      dot.el.setAttribute("transform", transform);
      dot.lastTransform = transform;
    }
    if (opacity !== dot.lastOpacity) {
      dot.el.style.opacity = opacity;
      dot.lastOpacity = opacity;
    }
    if (badge !== dot.lastBadge) {
      dot.badge.setAttribute("opacity", badge);
      dot.lastBadge = badge;
    }
  }
}

function formatClock(ms) {
  return clockFormat.format(ms);
}

/**
 * renderClock - อัปเดต scrubber + นาฬิกาเฉพาะตอนวินาทีเปลี่ยน ไม่ใช่ทุกเฟรม
 * วัดจริงแล้วการเขียนค่า <input type="range"> เป็นงานที่แพงที่สุดในเฟรม (บังคับเบราว์เซอร์คำนวณ
 * layout ใหม่) ทั้งที่การแข่ง 2 ชั่วโมงบนแถบกว้าง ~600px ที่ x1 ปุ่มเลื่อนขยับแค่ ~0.08px/วินาที
 * อัปเดตทุกเฟรมจึงไม่ได้อะไรเพิ่มนอกจากภาระ (x10 ยังได้ 10 ครั้ง/วินาที ลื่นพอ)
 */
function renderClock(ms) {
  const second = Math.floor(ms / 1000);
  if (second === state.player.lastClockSecond) return;
  timeScrubber.value = String(Math.round(ms));
  scrubberTimeLabel.textContent = formatClock(ms);
  state.player.lastClockSecond = second;
}

function renderFrame() {
  const ms = state.player.currentMs;
  if (ms == null) return;
  // ไทม์ไลน์ก่อน: ส่วนนี้ "อ่าน" scrollTop/ตำแหน่งการ์ด ต้องอ่านตอน layout ยังสะอาดอยู่
  // ถ้าเขียน transform จุดรถก่อนแล้วค่อยอ่าน เบราว์เซอร์ต้องคำนวณ layout ใหม่กลางเฟรม
  syncTimelineToTime(ms);
  renderDots(ms);
  renderClock(ms);
}

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

function getSessionBounds() {
  return { min: Number(timeScrubber.min), max: Number(timeScrubber.max) };
}

function initScrubberRange(race) {
  const startMs = new Date(race.dateStart).getTime();
  const endMs = new Date(race.dateEnd ?? race.dateStart).getTime();
  timeScrubber.min = String(startMs);
  timeScrubber.max = String(endMs > startMs ? endMs : startMs + 60 * MINUTE_MS);
}

/** updateBufferBar - แถบใต้ scrubber แสดงช่วงที่โหลดเก็บไว้แล้ว (แบบแถบ buffer ของวิดีโอ) */
function updateBufferBar() {
  const { min, max } = getSessionBounds();
  const front = state.player.chunks.peek();
  if (!front || max <= min) {
    bufferFill.style.width = "0%";
    return;
  }
  const from = clamp(front.fromMs, min, max);
  const to = clamp(state.player.bufferedUntilMs, min, max);
  bufferFill.style.left = `${((from - min) / (max - min)) * 100}%`;
  bufferFill.style.width = `${((to - from) / (max - min)) * 100}%`;
}

function updatePlayerStatus() {
  const p = state.player;
  let text = "";
  if (p.loadError) {
    text = "โหลดตำแหน่งรถไม่สำเร็จ — กำลังลองใหม่";
  } else if (p.playing && p.waiting) {
    const { max } = getSessionBounds();
    const need = Math.min(startReadyMs(), max - p.currentMs) || 1;
    const ahead = Math.max(0, (p.bufferedUntilMs ?? p.currentMs) - p.currentMs);
    text = `⏳ กำลังโหลดข้อมูลล่วงหน้า ${Math.min(99, Math.floor((ahead / need) * 100))}%`;
  } else if (p.clip) {
    text = "▶ กำลังเล่นเหตุการณ์";
  }
  if (mapStatusLabel.textContent !== text) mapStatusLabel.textContent = text;
}

/** trimBackBuffer - dequeue ก้อนที่เล่นผ่านไปนานแล้วออกจากหัวคิว (O(1) ต่อก้อน) memory ไม่บวมแม้เล่นทั้งเรซ */
function trimBackBuffer() {
  const p = state.player;
  while (p.chunks.size > 1 && p.chunks.peek().toMs < p.currentMs - BACK_BUFFER_MS) {
    p.chunks.dequeue();
  }
}

/** resetBuffer - ล้างคิวทั้งหมด (กระโดดไปเวลาที่ไม่ได้โหลดไว้) และยกเลิก request ที่ค้างของตำแหน่งเดิม */
function resetBuffer(fromMs) {
  const p = state.player;
  p.bufferGen++;
  p.abort?.abort();
  p.abort = null;
  p.fetchingGen = null;
  p.chunks.clear();
  p.bufferedUntilMs = fromMs == null ? null : alignToChunk(fromMs);
  p.loadError = false;
  updateBufferBar();
}

/**
 * fillBuffer - ตัวโหลด: เติมก้อนต่อท้ายคิวทีละก้อน (ทีละ request เพื่อเคารพ rate limit) จนมีข้อมูล
 * ล่วงหน้าถึงเป้า ทำงานได้ทีละตัวต่อ generation ถ้ามีการกระโดดเวลา (generation เปลี่ยน) ตัวเก่าหยุดเอง
 */
async function fillBuffer() {
  const p = state.player;
  const gen = p.bufferGen;
  if (p.fetchingGen === gen || state.currentSessionKey == null || p.currentMs == null || p.bufferedUntilMs == null) return;
  p.fetchingGen = gen;
  const controller = new AbortController();
  p.abort = controller;
  const sessionKey = state.currentSessionKey;

  try {
    while (gen === p.bufferGen) {
      const { max } = getSessionBounds();
      // ตอนหยุดอยู่ (แค่เปิดดูเรซ/ลาก scrubber) โหลดแค่พอกดเล่นได้ทันที ตอนเล่นจริงค่อยเก็บล่วงหน้าเต็มที่
      // — OpenF1 ให้โควตาแค่ 30 req/นาที ไม่ควรเสียไปกับการโหลดล่วงหน้าของเรซที่ผู้ใช้แค่กดผ่าน
      const target = p.playing ? bufferAheadTargetMs() : startReadyMs();
      if (p.bufferedUntilMs >= max || p.bufferedUntilMs - p.currentMs >= target) break;

      const fromMs = p.bufferedUntilMs;
      const toMs = fromMs + CHUNK_MS;
      // ข้อมูลที่ผู้ใช้กำลังรออยู่ตอนนี้ (ยังวาดรถไม่ได้ / กดเล่นแล้วรอโหลด) = ด่วน ส่วนที่เกินจากนั้น = ล่วงหน้า
      const prefetch = p.bufferedUntilMs - p.currentMs >= startReadyMs();
      const { positions } = await getPositions(sessionKey, fromMs, toMs, { signal: controller.signal, prefetch });
      if (gen !== p.bufferGen) return;

      p.chunks.enqueue(parseChunk(fromMs, toMs, positions));
      p.bufferedUntilMs = toMs;
      p.loadError = false;
      trimBackBuffer();
      updateBufferBar();
      if (!p.playing) renderFrame(); // ตอนหยุดอยู่ไม่มี loop วาดให้ ต้องวาดเองเมื่อข้อมูลมาถึง
    }
  } catch (err) {
    if (err.name === "AbortError" || gen !== p.bufferGen) return;
    console.error(err);
    p.loadError = true;
    updatePlayerStatus();
    // ลองใหม่เองอัตโนมัติ — เน็ตหลุดชั่วคราวไม่ควรทำให้ผู้ใช้ต้องกดเล่นใหม่
    setTimeout(() => {
      if (gen === p.bufferGen) fillBuffer();
    }, 2000);
  } finally {
    if (p.fetchingGen === gen) {
      p.fetchingGen = null;
      if (p.abort === controller) p.abort = null;
    }
  }
}

/**
 * seekTo - ย้ายเวลาเล่นไป targetMs: ถ้าอยู่ในช่วงที่โหลดไว้แล้วขยับได้ทันทีไม่ต้องโหลดใหม่
 * (เช่นกด ⏪/⏩ 10s) ถ้าอยู่นอกช่วง ล้างคิวแล้วเริ่มโหลดจากจุดใหม่ (ถ้ากำลังเล่น จะรอโหลดก่อนค่อยวิ่ง)
 */
function seekTo(targetMs) {
  const p = state.player;
  const { min, max } = getSessionBounds();
  const ms = clamp(targetMs, min, max);
  p.currentMs = ms;
  p.lastClockSecond = null; // บังคับให้ scrubber/นาฬิกาอัปเดตทันทีหลังกระโดดเวลา

  const front = p.chunks.peek();
  const inBuffer = front && ms >= front.fromMs && ms < p.bufferedUntilMs;
  if (!inBuffer) {
    resetBuffer(ms);
    if (p.playing) p.waiting = true;
  }
  fillBuffer();
  renderFrame();
  updatePlayerStatus();
}

/** tick - หนึ่งเฟรมของการเล่น: เดินนาฬิกา (หรือหยุดรอถ้าข้อมูลล่วงหน้าไม่พอ) แล้ววาด */
function startLoop() {
  stopMapAnimation();
  state.player.lastFrameTime = performance.now();

  const tick = (now) => {
    const p = state.player;
    if (!p.playing) {
      state.mapAnimationHandle = null;
      return;
    }
    // จำกัด dt กันเวลากระโดดไกลตอนสลับแท็บกลับมา (เบราว์เซอร์หยุด rAF ตอนแท็บไม่ได้แสดง)
    const dt = Math.min(now - p.lastFrameTime, 250);
    p.lastFrameTime = now;

    const { max } = getSessionBounds();
    const dataEnd = Math.min(p.bufferedUntilMs ?? p.currentMs, max);
    const ahead = dataEnd - p.currentMs;

    if (p.waiting) {
      if (ahead >= Math.min(startReadyMs(), max - p.currentMs)) p.waiting = false;
    } else if (ahead <= 0 && p.currentMs < max) {
      p.waiting = true; // ข้อมูลหมดก่อนโหลดทัน → หยุดนาฬิการอ ไม่ให้เวลาเดินแต่รถค้าง
    }

    if (!p.waiting) {
      const rate = p.clip ? 1 : p.speed; // คลิปเหตุการณ์เล่นความเร็วจริงเสมอ ให้ดูทัน
      p.currentMs = Math.min(p.currentMs + dt * rate, dataEnd);
    }

    trimBackBuffer();
    fillBuffer();
    renderFrame();
    updatePlayerStatus();

    if ((p.clip && p.currentMs >= p.clip.endMs) || p.currentMs >= max) {
      pausePlayer();
      return;
    }
    state.mapAnimationHandle = requestAnimationFrame(tick);
  };
  state.mapAnimationHandle = requestAnimationFrame(tick);
}

function playPlayer() {
  const p = state.player;
  if (!state.trackData || p.currentMs == null) return;
  const { min, max } = getSessionBounds();
  if (p.currentMs >= max) seekTo(min); // เล่นจบแล้วกดเล่นอีกครั้ง = เริ่มใหม่ตั้งแต่ต้น

  const ahead = (p.bufferedUntilMs ?? p.currentMs) - p.currentMs;
  p.playing = true;
  p.waiting = ahead < Math.min(startReadyMs(), max - p.currentMs); // "เก็บค่าก่อนแล้วค่อยวิ่ง"
  playPauseBtn.textContent = "⏸";
  fillBuffer();
  updatePlayerStatus();
  startLoop();
}

function pausePlayer() {
  const p = state.player;
  p.playing = false;
  p.waiting = false;
  p.clip = null;
  playPauseBtn.textContent = "▶";
  stopMapAnimation();
  updatePlayerStatus();
}

/**
 * playEventOnMap - คลิกเหตุการณ์ในไทม์ไลน์ → เล่นช่วง ±5 วินาทีรอบเหตุการณ์นั้นที่ความเร็วจริง
 * นักขับที่เกี่ยวข้องสว่างเต็ม คนอื่นจาง (ใช้บัฟเฟอร์เดียวกับการเล่นปกติ จึงได้ preload ด้วย)
 */
function playEventOnMap(event) {
  if (!state.trackData || state.player.currentMs == null) return;
  const centerMs = new Date(event.date).getTime();
  let highlight = null;
  if (event.driverNumbers.length > 0) {
    highlight = new HashTable(8);
    for (const n of event.driverNumbers) highlight.set(n, true);
  }
  state.player.playing = false; // ให้ seekTo ไม่ตั้ง waiting ซ้ำ playPlayer จะตัดสินเอง
  state.player.clip = { endMs: centerMs + 5000, highlight };
  seekTo(centerMs - 5000);
  playPlayer();
}

function showMapLoading() {
  pausePlayer();
  resetBuffer(null);
  state.player.currentMs = null;
  state.player.lastClockSecond = null;
  hide(mapView);
  hide(mapEmpty);
  hide(mapErrorEl);
  show(mapSkeleton);
  mapStatusLabel.textContent = "";
}

function showMapEmpty() {
  pausePlayer();
  hide(mapSkeleton);
  hide(mapView);
  hide(mapErrorEl);
  show(mapEmpty);
}

function showMapErrorState() {
  pausePlayer();
  hide(mapSkeleton);
  hide(mapView);
  hide(mapEmpty);
  show(mapErrorEl);
}

async function loadTrackForRace(race) {
  showMapLoading();
  state.trackData = null;
  const sessionKey = race.sessionKey;

  if (!race.circuitKey) {
    showMapEmpty();
    return;
  }

  try {
    const track = await getTrack(race, () => {
      mapStatusLabel.textContent = "⏳ สนามใหม่ — กำลังสร้างเส้นสนามจากพิกัดจริง...";
    });
    if (state.currentSessionKey !== sessionKey) return; // ผู้ใช้เปลี่ยนเรซไปแล้วระหว่างรอ

    state.trackData = track;
    renderTrackPath(track);
    initCarDots(state.timeline?.drivers ?? []);
    initScrubberRange(race);
    mapStatusLabel.textContent = "";
    hide(mapSkeleton);
    show(mapView);

    // เริ่มที่เหตุการณ์แรกในไทม์ไลน์ (รับประกันว่าช่วงนั้นมีรถอยู่ในสนามจริง) แล้ว preload รอไว้เลย
    const initialMs = state.eventTimes.length > 0 ? state.eventTimes[0] : new Date(race.dateStart).getTime();
    seekTo(initialMs);
  } catch (err) {
    if (state.currentSessionKey !== sessionKey) return;
    console.error(err);
    if (err.status === 404) showMapEmpty();
    else showMapErrorState();
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
  const race = state.racesByKey.get(sessionKey);
  if (!race) return;
  state.currentSessionKey = sessionKey;
  state.highlightedDriver = null;
  showTimelineLoading();
  showMapLoading();

  try {
    const timeline = await getRaceTimeline(race);
    if (state.currentSessionKey !== sessionKey) return; // ผู้ใช้เปลี่ยนเรซไปแล้วระหว่างรอ

    state.timeline = timeline;
    state.eventTimes = timeline.events.map((e) => Date.parse(e.date));
    state.driverEventIndex = buildDriverEventIndex(timeline.events);
    state.pitWindowIndex = buildPitWindowIndex(timeline.events);
    state.lastSyncedEventId = null;
    state.driverFilter = "";
    state.typeFilter = "";
    typeFilterSelect.value = "";

    populateDriverFilter();
    renderSummary(timeline.summary, timeline.dataAvailability);
    renderTimeline();
    renderResultsTable();
    renderPits();

    loadTrackForRace(race);
  } catch (err) {
    console.error(err);
    if (state.currentSessionKey !== sessionKey) return;
    showTimelineError();
    showMapErrorState();
  }
}

/** loadRacesForYear - โหลดรายชื่อเรซของปีนั้น แล้วเปิดเรซล่าสุดให้เลย คืนจำนวนเรซ (null ถ้าโหลดไม่ได้) */
async function loadRacesForYear(year) {
  hide(raceError);
  raceSelect.disabled = true;
  raceSelect.innerHTML = `<option>กำลังโหลด...</option>`;

  try {
    const { races } = await getRaces(year);
    if (races.length === 0) {
      raceSelect.innerHTML = `<option>ยังไม่มีเรซที่แข่งจบในปีนี้</option>`;
      return 0;
    }
    for (const r of races) state.racesByKey.set(r.sessionKey, r);
    raceSelect.innerHTML = races
      .map(
        (r) =>
          `<option value="${r.sessionKey}">${escapeHtml(r.meetingName)} — ${escapeHtml(r.sessionName)} · ${escapeHtml(r.circuitShortName)}</option>`
      )
      .join("");
    raceSelect.disabled = false;

    // เปิดเรซล่าสุดที่แข่งจบแล้ว — เรซใหม่ที่เพิ่งจบโผล่เป็นค่าเริ่มต้นเองโดยไม่ต้องแก้โค้ด
    const latest = races[races.length - 1];
    raceSelect.value = String(latest.sessionKey);
    loadRace(latest.sessionKey);
    return races.length;
  } catch (err) {
    console.error(err);
    raceSelect.innerHTML = `<option>โหลดรายชื่อเรซไม่สำเร็จ</option>`;
    show(raceError);
    raceError.textContent = "โหลดรายชื่อเรซไม่สำเร็จ — ตรวจสอบการเชื่อมต่อแล้วลองเลือกปีใหม่อีกครั้ง";
    return null;
  }
}

// ---------- event wiring ----------

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

  // คลิกที่ตัวการ์ด (ไม่ใช่ driver-chip) → เล่นตำแหน่งรถบนแผนที่ช่วง ±5s ของ event นั้น
  const card = evt.target.closest(".timeline-card");
  if (!card) return;
  const event = state.timeline?.events.find((e) => e.id === card.dataset.id);
  if (event) playEventOnMap(event);
});

timeScrubber.addEventListener("input", () => {
  if (state.player.playing) pausePlayer(); // ลาก scrubber = ควบคุมเอง หยุดเล่นต่อเนื่องไว้ก่อน
  state.player.clip = null;
  const targetMs = Number(timeScrubber.value);
  scrubberTimeLabel.textContent = formatClock(targetMs);
  clearTimeout(state.scrubberDebounceHandle);
  state.scrubberDebounceHandle = setTimeout(() => seekTo(targetMs), 150);
});

playPauseBtn.addEventListener("click", () => {
  if (!state.trackData) return;
  if (state.player.playing) {
    pausePlayer();
  } else {
    state.player.clip = null;
    playPlayer();
  }
});

function skipBy(deltaMs) {
  if (!state.trackData || state.player.currentMs == null) return;
  state.player.clip = null;
  seekTo(state.player.currentMs + deltaMs);
}

skipBackBtn.addEventListener("click", () => skipBy(-10000));
skipForwardBtn.addEventListener("click", () => skipBy(10000));

speedButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    speedButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.player.speed = Number(btn.dataset.speed);
    fillBuffer(); // เร็วขึ้นต้องเก็บล่วงหน้ามากขึ้น เริ่มโหลดเพิ่มทันที
  });
});

// ความกว้างจอเปลี่ยน → การ์ดตัดบรรทัดต่างไป ตำแหน่งที่จำไว้ใช้ไม่ได้แล้ว
window.addEventListener("resize", () => {
  state.cardTops = null;
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

// ---------- init: เปิดหน้ามาต้องมีเรซโหลดไว้แล้ว — เรซล่าสุดของปีล่าสุดที่มีเรซแข่งจบแล้ว ----------
async function init() {
  const years = await getYears();
  yearSelect.innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join("");
  // ต้นปีใหม่ที่ยังไม่มีเรซแข่งจบ ให้ถอยไปเปิดปีก่อนหน้าแทนหน้าว่าง
  for (const year of years) {
    yearSelect.value = String(year);
    const count = await loadRacesForYear(year);
    if (count !== 0) break;
  }
}

init();
