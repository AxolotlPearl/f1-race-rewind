// public/app.js
// Vanilla JS frontend — ไม่มี framework, ไม่มี build step
// import DSA เดียวกับที่ server ใช้ตรงจาก /lib ผ่าน Express static (ES module native ในเบราว์เซอร์)
import { mergeSort } from "/lib/sort.js";
import { HashTable } from "/lib/HashTable.js";

const YEARS = [2025, 2024, 2023];
const DEFAULT_YEAR = 2024;

// ---------- client-side cache (ชั้นที่ 2 ต่อจาก module-scope cache บน server) ----------
// ข้อมูลเป็นข้อมูลย้อนหลังที่ไม่เปลี่ยนแปลงแล้ว จึง cache ถาวรได้เลยไม่ต้องมี TTL
const CACHE_PREFIX = "f1rr:v1:";

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
  } catch (err) {
    console.error(err);
    if (state.currentSessionKey !== sessionKey) return;
    showTimelineError();
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
  if (!chip) return;
  const num = Number(chip.dataset.driver);
  state.highlightedDriver = state.highlightedDriver === num ? null : num;
  applyHighlight();
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
