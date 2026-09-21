// ─── IndexedDB offline outbox ─────────────────────────────────────────────────
const DB_NAME = "setu-local";
const STORE_NAME = "outbox";
let categoryChart = null;
let complaintMap = null;
let allComplaints = [];
let officialToken = null; // JWT stored in memory (not localStorage for security)

function openOutbox() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () =>
      req.result.createObjectStore(STORE_NAME, {
        keyPath: "localId",
        autoIncrement: true,
      });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function queueComplaint(complaint) {
  const db = await openOutbox();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).add(complaint);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function getQueuedComplaints() {
  const db = await openOutbox();
  const items = await new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME).objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return items;
}

async function removeQueuedComplaint(localId) {
  const db = await openOutbox();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(localId);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function sendComplaint(complaint) {
  const response = await fetch("/api/complaints", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(complaint),
  });
  if (!response.ok) throw new Error(`Complaint API returned ${response.status}`);
  return response.json();
}

/**
 * Authenticated PATCH for status updates.
 * Attaches the JWT if we have one; 401 triggers the login flow automatically.
 */
async function patchStatus(complaintId, status, photoData = null) {
  const headers = { "Content-Type": "application/json" };
  if (officialToken) headers["Authorization"] = `Bearer ${officialToken}`;

  const response = await fetch(`/api/complaints/${complaintId}/status`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ status, photo_data: photoData }),
  });

  if (response.status === 401) {
    // Token missing or expired — open the login modal and re-try after login
    const newToken = await promptOfficialLogin();
    if (!newToken) throw new Error("Authentication cancelled");
    return patchStatus(complaintId, status, photoData);
  }
  if (!response.ok) throw new Error(`Status update returned ${response.status}`);
  return response.json();
}

// ─── Offline sync ─────────────────────────────────────────────────────────────

async function syncOutbox() {
  if (!navigator.onLine) return;
  const queued = await getQueuedComplaints();
  let syncedCount = 0;
  for (const item of queued) {
    try {
      await sendComplaint(item.payload);
      await removeQueuedComplaint(item.localId);
      syncedCount += 1;
    } catch (error) {
      console.error("Sync paused; complaint remains queued", error);
      break;
    }
  }
  if (syncedCount > 0) showSyncBanner("Synced ✓", "synced");
}

function showSyncBanner(message, state) {
  const banner = document.querySelector("#sync-banner");
  banner.textContent = message;
  banner.className = `sync-banner ${state}`;
  banner.hidden = false;
  if (state === "synced") window.setTimeout(() => { banner.hidden = true; }, 3500);
}

function updateConnectionState(online) {
  const dot = document.querySelector("#connection-dot");
  const status = document.querySelector("#api-status");
  dot.classList.toggle("offline", !online);
  dot.title = online ? "Online" : "Offline";
  dot.setAttribute("aria-label", online ? "Online" : "Offline");
  status.textContent = online
    ? "Setu API is running"
    : "Offline mode — reports will sync automatically when connected";
  status.dataset.state = online ? "ready" : "offline";
}

// ─── Tab navigation ───────────────────────────────────────────────────────────

function setupTabs() {
  const tabs = [...document.querySelectorAll(".app-tab")];
  const panels = [...document.querySelectorAll(".tab-panel")];
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => {
        const active = t === tab;
        t.classList.toggle("active", active);
        t.setAttribute("aria-selected", String(active));
        t.tabIndex = active ? 0 : -1;
      });
      panels.forEach((p) => { p.hidden = p.id !== tab.dataset.panel; });
      if (tab.dataset.panel === "board-panel") {
        window.setTimeout(() => { if (complaintMap) complaintMap.invalidateSize(); }, 100);
      }
      if (tab.dataset.panel === "impact-panel" && categoryChart) {
        window.setTimeout(() => categoryChart.resize(), 0);
      }
    });
    tab.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      const next = e.key === "ArrowRight"
        ? (index + 1) % tabs.length
        : (index - 1 + tabs.length) % tabs.length;
      tabs[next].focus();
      tabs[next].click();
    });
  });
}

// ─── Photo helpers ────────────────────────────────────────────────────────────

function compressPhoto(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const reader = new FileReader();
    reader.onload = () => {
      image.onload = () => {
        const scale = Math.min(1, 1280 / image.width, 1280 / image.height);
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.65));
      };
      image.onerror = () => reject(new Error("Photo could not be read"));
      image.src = reader.result;
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ─── Civic photo classifier (pixel analysis — no external model needed) ───────
//
// Detects ONLY: pothole | garbage | water
//
// MobileNet's ImageNet labels (e.g. "worm fence", "alp", "stone wall") never
// contain words like "pothole", "garbage" or "flood", so keyword matching on
// those labels is useless. Instead we analyse the raw pixel data directly via
// a Canvas 2D context — fast, offline, 100% deterministic.
//
// Feature extraction per civic class:
//
//  pothole  — Road surface with dark irregular depression.
//             Signals: dominant grey/brown tones, HIGH local contrast variance
//             (the hole edge), LOW colour saturation, irregular dark patch
//             in the lower-centre region of the photo.
//
//  garbage  — Mixed coloured waste on ground.
//             Signals: HIGH colour saturation variance (many different hues),
//             HIGH hue diversity (lots of different colours), irregular shapes
//             across the whole frame.
//
//  water    — Standing/flowing water on road.
//             Signals: large uniform-brightness region (reflection),
//             predominantly blue/grey/silver hues, LOW hue diversity but
//             HIGH specular (bright) pixel ratio in the lower half.
//
// Each feature is scored 0–1 and combined with hand-tuned weights.
// Minimum confidence to make a claim: 0.42
// ─────────────────────────────────────────────────────────────────────────────

const CIVIC_CLASSIFIER_VERSION = "v3-pixel";
const CIVIC_PIXEL_THRESHOLD = 0.42;

/**
 * Extract pixel features from an HTMLImageElement.
 * Downsamples to 64×64 for speed, samples every pixel.
 * Returns an object of normalised (0–1) feature values.
 */
function extractPixelFeatures(image) {
  const SIZE = 64;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, SIZE, SIZE);
  const { data } = ctx.getImageData(0, 0, SIZE, SIZE); // RGBA flat array

  let totalR = 0, totalG = 0, totalB = 0;
  let satSum = 0, valSum = 0;
  const hueHist = new Float32Array(36); // 10° buckets
  let darkPixels = 0;      // value < 0.25
  let brightPixels = 0;    // value > 0.80
  let greyPixels = 0;      // saturation < 0.12
  let contrastSamples = [];

  const n = SIZE * SIZE;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    totalR += r; totalG += g; totalB += b;

    // Convert to HSV
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const delta = maxC - minC;
    const val = maxC;
    const sat = maxC === 0 ? 0 : delta / maxC;

    satSum += sat;
    valSum += val;

    if (val < 0.25) darkPixels++;
    if (val > 0.80) brightPixels++;
    if (sat < 0.12) greyPixels++;

    // Hue
    let hue = 0;
    if (delta > 0) {
      if (maxC === r) hue = ((g - b) / delta) % 6;
      else if (maxC === g) hue = (b - r) / delta + 2;
      else hue = (r - g) / delta + 4;
      hue = ((hue * 60) + 360) % 360;
    }
    hueHist[Math.floor(hue / 10)]++;
    contrastSamples.push(val);
  }

  // Normalise hue histogram
  for (let i = 0; i < hueHist.length; i++) hueHist[i] /= n;

  // Hue diversity: how many buckets have > 1% of pixels
  let hueDiversity = 0;
  for (let i = 0; i < hueHist.length; i++) if (hueHist[i] > 0.01) hueDiversity++;
  hueDiversity /= 36; // 0–1

  // Contrast variance (std dev of brightness)
  const meanVal = valSum / n;
  let varSum = 0;
  for (const v of contrastSamples) varSum += (v - meanVal) ** 2;
  const contrastStdDev = Math.sqrt(varSum / n); // 0–0.5 typical range

  // Blue-grey dominance (water signal)
  // Blue hues: buckets 18–26 (180°–260°), grey hues: low sat
  let blueGreyPixels = 0;
  for (let i = 18; i <= 26; i++) blueGreyPixels += hueHist[i];
  blueGreyPixels += greyPixels / n;

  // Lower-half analysis (potholes and water tend to be in lower portion)
  let lowerDark = 0, lowerBright = 0;
  const lowerStart = Math.floor(SIZE * SIZE / 2) * 4;
  for (let i = lowerStart; i < data.length; i += 4) {
    const r = data[i] / 255, g = data[i+1] / 255, b = data[i+2] / 255;
    const val = Math.max(r, g, b);
    if (val < 0.30) lowerDark++;
    if (val > 0.75) lowerBright++;
  }
  const lowerHalf = SIZE * SIZE / 2;
  const lowerDarkRatio   = lowerDark   / lowerHalf;
  const lowerBrightRatio = lowerBright / lowerHalf;

  return {
    meanR: totalR / n,
    meanG: totalG / n,
    meanB: totalB / n,
    meanSat:       satSum / n,
    meanVal:       meanVal,
    darkRatio:     darkPixels / n,
    brightRatio:   brightPixels / n,
    greyRatio:     greyPixels / n,
    hueDiversity,
    contrastStdDev,
    blueGreyPixels: Math.min(blueGreyPixels, 1),
    lowerDarkRatio,
    lowerBrightRatio,
  };
}

/**
 * Score features against each civic class.
 * Returns { pothole: 0–1, garbage: 0–1, water: 0–1 }
 */
function scoreCivicClasses(f) {
  // ── Pothole ──────────────────────────────────────────────────────────────
  // Road surface: grey, high contrast (hole edge), dark patch lower centre
  const pothole =
    f.greyRatio         * 0.30 +   // grey/brown road surface
    f.contrastStdDev    * 1.20 +   // rough/uneven surface → high contrast
    f.lowerDarkRatio    * 0.40 +   // dark hole in lower portion
    (1 - f.meanSat)     * 0.20 +   // low colour saturation
    (1 - f.hueDiversity)* 0.10;    // uniform hue (road grey)

  // ── Garbage ──────────────────────────────────────────────────────────────
  // Colourful mixed waste: high saturation, many hues, scattered bright patches
  const garbage =
    f.meanSat           * 0.35 +   // colourful items
    f.hueDiversity      * 0.40 +   // many different colours
    f.brightRatio       * 0.15 +   // plastic wrappers catch light
    f.contrastStdDev    * 0.30;    // irregular shapes → contrast

  // ── Water ────────────────────────────────────────────────────────────────
  // Reflective standing water: large uniform bright region, blue/grey hues
  const water =
    f.blueGreyPixels    * 0.40 +   // blue/grey colour
    f.lowerBrightRatio  * 0.35 +   // specular reflection in lower half
    (1 - f.hueDiversity)* 0.15 +   // uniform (not mixed colours)
    f.meanB             * 0.20;    // blue channel dominant

  // Clamp each to [0, 1]
  return {
    pothole: Math.min(Math.max(pothole, 0), 1),
    garbage: Math.min(Math.max(garbage, 0), 1),
    water:   Math.min(Math.max(water,   0), 1),
  };
}

async function classifyPhoto(file) {
  const statusEl       = document.querySelector("#classifier-status");
  const correctionLink = document.querySelector("#correct-classification");
  const confidenceBadge = document.querySelector("#classifier-confidence-badge");

  statusEl.textContent = "🔍 Scanning photo for civic issue…";
  if (correctionLink)   correctionLink.hidden   = true;
  if (confidenceBadge)  confidenceBadge.hidden  = true;

  try {
    const image = new Image();
    image.src = await compressPhoto(file);
    await image.decode();

    const features = extractPixelFeatures(image);
    const scores   = scoreCivicClasses(features);

    // Pick best class
    const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    const [bestClass, bestScore] = best;

    const pct = Math.round(bestScore * 100);

    // Debug log so you can tune weights in the console
    console.debug("[CivicClassifier v3]", {
      features: {
        greyRatio:       features.greyRatio.toFixed(3),
        meanSat:         features.meanSat.toFixed(3),
        hueDiversity:    features.hueDiversity.toFixed(3),
        contrastStdDev:  features.contrastStdDev.toFixed(3),
        lowerDarkRatio:  features.lowerDarkRatio.toFixed(3),
        lowerBrightRatio:features.lowerBrightRatio.toFixed(3),
        blueGreyPixels:  features.blueGreyPixels.toFixed(3),
        meanB:           features.meanB.toFixed(3),
      },
      scores: {
        pothole: scores.pothole.toFixed(3),
        garbage: scores.garbage.toFixed(3),
        water:   scores.water.toFixed(3),
      },
      verdict: bestScore >= CIVIC_PIXEL_THRESHOLD ? bestClass : "below threshold",
    });

    if (bestScore >= CIVIC_PIXEL_THRESHOLD) {
      const select = document.querySelector("#category");
      if (select) select.value = bestClass;

      const tier = bestScore >= 0.70 ? "high" : bestScore >= 0.55 ? "medium" : "low";
      statusEl.textContent = `Detected: ${bestClass.toUpperCase()} (${pct}% confidence).`;
      if (confidenceBadge) {
        confidenceBadge.textContent = `${pct}%`;
        confidenceBadge.className = `confidence-badge ${tier}`;
        confidenceBadge.hidden = false;
      }
      addAgentLog(2, "Civic Classifier",
        `[${CIVIC_CLASSIFIER_VERSION}] Pixel analysis → "${bestClass}" at ${pct}%. Scores — pothole:${Math.round(scores.pothole*100)}% garbage:${Math.round(scores.garbage*100)}% water:${Math.round(scores.water*100)}%. Category auto-selected.`);
      if (correctionLink) correctionLink.hidden = false;
      return { label: bestClass, confidence: bestScore };
    } else {
      statusEl.textContent =
        `Unclear image (${pct}% best match: ${bestClass}). Choose pothole, garbage, or water manually.`;
      addAgentLog(2, "Civic Classifier",
        `[${CIVIC_CLASSIFIER_VERSION}] Score ${pct}% (${bestClass}) below threshold ${Math.round(CIVIC_PIXEL_THRESHOLD*100)}%. Manual selection required.`);
      if (correctionLink) correctionLink.hidden = false;
      return { label: null, confidence: null };
    }
  } catch (error) {
    statusEl.textContent = "Classification failed — choose a category manually.";
    if (correctionLink) correctionLink.hidden = false;
    console.error("Civic classifier failed", error);
    return { label: null, confidence: null };
  }
}

// ─── API health check ─────────────────────────────────────────────────────────

async function checkApi() {
  const status = document.querySelector("#api-status");
  status.dataset.state = "loading";
  try {
    const response = await fetch("/api/health");
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const payload = await response.json();
    status.textContent = payload.message;
    status.dataset.state = "ready";
  } catch (error) {
    status.textContent = "Setu API is unavailable";
    status.dataset.state = "error";
    console.error(error);
  }
}

// ─── SLA formatting ───────────────────────────────────────────────────────────

function formatSla(deadline, status) {
  if (status === "Resolved") return "Resolved ✓";
  if (!deadline) return "No SLA deadline";
  const remaining = new Date(`${deadline.replace(" ", "T")}Z`) - Date.now();
  if (remaining <= 0) return "⚠ SLA overdue";
  const days = Math.floor(remaining / 86_400_000);
  const hours = Math.floor((remaining % 86_400_000) / 3_600_000);
  return `${days}d ${hours}h remaining`;
}

function makeTextElement(tagName, className, text) {
  const el = document.createElement(tagName);
  el.className = className;
  el.textContent = text;
  return el;
}

// ─── Category + node metadata ─────────────────────────────────────────────────

const CATEGORY_DETAILS = {
  pothole:     { icon: "◒", label: "Pothole" },
  garbage:     { icon: "▥", label: "Garbage" },
  streetlight: { icon: "☼", label: "Streetlight" },
  waste:       { icon: "▥", label: "Garbage" },
  water:       { icon: "≋", label: "Water" },
  other:       { icon: "•", label: "Other" },
};

const NODE_DETAILS = {
  // HSR Layout
  central:       { location: "Central HSR Corridor", reason: "🎯 High Priority Factor: Hub connecting 4 main traffic corridors & commercial hub." },
  north_gate:    { location: "HSR North Gate Junction", reason: "🎯 High Priority Factor: Connects 3 main arterial routes & Silk Board connector." },
  south_gate:    { location: "HSR South Gate Junction", reason: "🎯 Priority Factor: Connects 3 main arterial routes." },
  east_market:   { location: "HSR East Market Zone", reason: "⚡ Medium Priority Factor: Near high-footfall market & main bus route." },
  west_market:   { location: "HSR West Market Zone", reason: "⚡ Medium Priority Factor: Commercial market sector & service road." },
  school_north:  { location: "HSR Sector 2 (School Zone)", reason: "🚨 High Priority Factor: Located within 150m of Sector 2 Primary School & 2 bus routes." },
  school_south:  { location: "HSR Sector 1 (School Zone)", reason: "🚨 High Priority Factor: Located within 150m of Primary School corridor." },
  hospital_east: { location: "HSR East Hospital Zone", reason: "🚨 High Priority Factor: On HSR East Hospital Emergency Ambulance Route." },
  hospital_west: { location: "HSR West Hospital Corridor", reason: "🚨 High Priority Factor: Emergency Medical Transit Corridor." },
  park_north:    { location: "HSR Park North", reason: "📍 Priority Factor: Near public park & residential feeder road." },
  park_south:    { location: "HSR Park South", reason: "📍 Priority Factor: Near public park & residential feeder road." },
  bus_north:     { location: "HSR North Bus Interchange", reason: "⚡ Priority Factor: Major transit hub connecting 2 bus corridors." },
  bus_south:     { location: "HSR South Bus Stop", reason: "📍 Priority Factor: Bus stop & pedestrian crossing zone." },
  bridge_east:   { location: "HSR East Bridge", reason: "📍 Priority Factor: Outer ring service road connector." },
  bridge_west:   { location: "HSR West Bridge", reason: "📍 Priority Factor: Outer ring service road connector." },
};

function priorityTier(score) {
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

function priorityLabel(score) {
  const tier = priorityTier(score);
  return tier[0].toUpperCase() + tier.slice(1);
}

// ─── Photo gallery ────────────────────────────────────────────────────────────

function createPhotoGallery(complaint) {
  const gallery = document.createElement("div");
  gallery.className = "photo-gallery";
  const photos = [
    { label: "Before (Reported)", source: complaint.photo_data, emptyText: "No initial photo" },
    { label: "After (Resolution Proof)", source: complaint.resolution_photo_data, emptyText: "Awaiting fix proof" },
  ];
  for (const photo of photos) {
    const figure = document.createElement("figure");
    figure.className = "proof-photo";
    if (photo.source) {
      const img = document.createElement("img");
      img.src = photo.source;
      img.alt = `${photo.label} photo for complaint ${complaint.id}`;
      img.loading = "lazy";
      img.decoding = "async";
      img.addEventListener("error", () => {
        figure.classList.add("photo-missing");
        img.remove();
        figure.prepend(makeTextElement("span", "photo-placeholder", "Photo unavailable"));
      });
      figure.append(img);
    } else {
      figure.classList.add("photo-missing");
      figure.append(makeTextElement("span", "photo-placeholder", photo.emptyText));
    }
    figure.append(makeTextElement("figcaption", "photo-label", photo.label));
    gallery.append(figure);
  }
  return gallery;
}

// ─── Duplicate cluster ────────────────────────────────────────────────────────

function createReportCluster(reportCount, complaint) {
  const cluster = document.createElement("button");
  cluster.className = "report-cluster expandable";
  cluster.type = "button";
  const dots = document.createElement("span");
  dots.className = "report-dots";
  for (let i = 0; i < Math.min(reportCount, 4); i++) {
    dots.append(makeTextElement("i", `report-dot dot-${i + 1}`, ""));
  }
  cluster.append(dots);
  cluster.append(makeTextElement(
    "span", "report-count",
    `+${reportCount - 1} ${reportCount - 1 === 1 ? "other" : "others"} reported this`
  ));
  cluster.addEventListener("click", () => {
    const detail = document.createElement("p");
    detail.className = "duplicate-detail";
    detail.textContent = `${reportCount} total reports grouped at ${NODE_DETAILS[complaint.node_id]?.location || "this location"}.`;
    const existing = cluster.nextElementSibling;
    if (existing?.classList.contains("duplicate-detail")) existing.remove();
    else cluster.after(detail);
  });
  return cluster;
}

// ─── Impact panel ─────────────────────────────────────────────────────────────

async function renderImpact(complaints) {
  const total = complaints.length;
  const resolved = complaints.filter((c) => c.status === "Resolved").length;
  const duplicates = complaints.reduce((acc, c) => {
    const rc = Number(c.report_count);
    return acc + (Number.isFinite(rc) ? Math.max(0, rc - 1) : 0);
  }, 0);
  document.querySelector("#impact-total").textContent = total;
  document.querySelector("#impact-resolved").textContent = resolved;
  document.querySelector("#impact-duplicates").textContent = duplicates;
  try {
    const demoOnly = document.querySelector("#demo-toggle").checked;
    const resp = await fetch(`/api/impact?demo=${demoOnly ? "1" : "0"}`);
    const impact = await resp.json();
    document.querySelector("#impact-resolution-time").textContent =
      impact.average_resolution_minutes === null
        ? "No data"
        : `${impact.average_resolution_minutes} min`;
  } catch {
    document.querySelector("#impact-resolution-time").textContent = "No data";
  }

  const counts = complaints.reduce((acc, c) => {
    const cat = c.category.charAt(0).toUpperCase() + c.category.slice(1);
    acc[cat] = (acc[cat] || 0) + 1;
    return acc;
  }, {});
  const canvas = document.querySelector("#category-chart");
  const chartStatus = document.querySelector("#chart-status");
  if (!window.Chart) {
    canvas.hidden = true;
    chartStatus.hidden = false;
    chartStatus.textContent = "Chart unavailable, but the live totals are shown above.";
    return;
  }
  chartStatus.hidden = true;
  canvas.hidden = false;
  if (categoryChart) categoryChart.destroy();
  categoryChart = new window.Chart(canvas, {
    type: "bar",
    data: {
      labels: Object.keys(counts),
      datasets: [{
        label: "Reports",
        data: Object.values(counts),
        backgroundColor: ["#007f8f", "#00b8a5", "#39e6b0", "#063b42", "#a76316"],
        borderRadius: 8,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { displayColors: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: "#063b42" } },
        y: { beginAtZero: true, ticks: { precision: 0, color: "#063b42" }, grid: { color: "#9ee5d7" } },
      },
    },
  });
}

// ─── Map ──────────────────────────────────────────────────────────────────────

// ─── Map ──────────────────────────────────────────────────────────────────────

const GNN_WARD_NODES = {
  hsr_layout: {
    central: [12.9000, 77.6000, "Central HSR (Main Hub)"],
    north_gate: [12.9050, 77.6000, "HSR North Gate"],
    south_gate: [12.8950, 77.6000, "HSR South Gate"],
    east_market: [12.9000, 77.6060, "East Market"],
    west_market: [12.9000, 77.5940, "West Market"],
    school_north: [12.9060, 77.6060, "Sector 2 School Zone"],
    school_south: [12.8940, 77.5940, "Sector 1 School Zone"],
    hospital_east: [12.9060, 77.5940, "East Hospital Emergency"],
    hospital_west: [12.8940, 77.6060, "West Hospital Corridor"],
    park_north: [12.9100, 77.6000, "Park North Junction"],
    park_south: [12.8900, 77.6000, "Park South Junction"],
    bus_north: [12.9100, 77.6060, "North Bus Interchange"],
    bus_south: [12.8900, 77.5940, "South Bus Stop"],
    bridge_east: [12.9000, 77.6120, "East Service Road Bridge"],
    bridge_west: [12.9000, 77.5880, "West Service Road Bridge"],
  },
  koramangala: {
    central_sq: [12.9352, 77.6245, "Koramangala Central Sq"],
    forum_mall: [12.9344, 77.6101, "Forum Mall Hub"],
    "5th_block": [12.9406, 77.6189, "5th Block Junction"],
    "7th_block": [12.9279, 77.6201, "7th Block Junction"],
    kor_hospital: [12.9350, 77.6280, "Koramangala Hospital"],
    kor_school: [12.9390, 77.6150, "Koramangala School Zone"],
    ejipura: [12.9305, 77.6150, "Ejipura Signal"],
    silk_board: [12.9172, 77.6228, "Silk Board Flyover"],
  },
  indiranagar: {
    "100ft_road": [12.9784, 77.6408, "100ft Road Corridor"],
    "12th_main": [12.9716, 77.6412, "12th Main Junction"],
    ind_metro: [12.9716, 77.6395, "Indiranagar Metro Station"],
    ind_hospital: [12.9800, 77.6450, "Indiranagar Hospital"],
    ind_school: [12.9750, 77.6360, "Indiranagar Public School"],
    domlur: [12.9609, 77.6387, "Domlur Flyover"],
    hal_old: [12.9841, 77.6494, "HAL Old Airport Road"],
  },
};

const GNN_WARD_EDGES = {
  hsr_layout: [
    ["central","north_gate"],["central","south_gate"],["central","east_market"],["central","west_market"],
    ["north_gate","park_north"],["south_gate","park_south"],["east_market","bridge_east"],["west_market","bridge_west"],
    ["north_gate","school_north"],["north_gate","hospital_east"],["south_gate","school_south"],["south_gate","hospital_west"],
    ["school_north","bus_north"],["hospital_east","bus_north"],["school_south","bus_south"],["hospital_west","bus_south"],
    ["bus_north","bridge_east"],["bus_south","bridge_west"],
  ],
  koramangala: [
    ["central_sq","forum_mall"],["central_sq","5th_block"],["central_sq","7th_block"],["central_sq","kor_hospital"],
    ["5th_block","kor_school"],["forum_mall","ejipura"],["7th_block","ejipura"],["ejipura","silk_board"],["kor_school","5th_block"]
  ],
  indiranagar: [
    ["100ft_road","12th_main"],["100ft_road","ind_hospital"],["100ft_road","hal_old"],
    ["12th_main","ind_metro"],["12th_main","domlur"],["ind_metro","ind_school"],["ind_school","domlur"]
  ]
};

// Backwards-compat flat mapping
const GNN_SEED_NODES = {
  ...GNN_WARD_NODES.hsr_layout,
  ...GNN_WARD_NODES.koramangala,
  ...GNN_WARD_NODES.indiranagar,
};

function renderComplaintMap(complaints) {
  if (!window.L) return;
  const mapEl = document.querySelector("#complaint-map");
  if (!mapEl) return;

  if (!complaintMap) {
    complaintMap = window.L.map(mapEl).setView([12.9000, 77.6000], 13);
    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(complaintMap);
  }

  complaintMap.eachLayer((layer) => {
    if (layer instanceof window.L.Marker || layer instanceof window.L.Polyline || layer instanceof window.L.CircleMarker || layer instanceof window.L.Circle)
      complaintMap.removeLayer(layer);
  });

  const bounds = [];

  // Determine wards to render graph nodes and edges for
  const activeWards = new Set(complaints.map((c) => c.ward).filter(Boolean));
  if (activeWards.size === 0) {
    activeWards.add("hsr_layout");
    activeWards.add("koramangala");
    activeWards.add("indiranagar");
  }

  activeWards.forEach((w) => {
    const nodes = GNN_WARD_NODES[w];
    const edges = GNN_WARD_EDGES[w];
    if (nodes && edges) {
      edges.forEach(([a, b]) => {
        const fa = nodes[a], fb = nodes[b];
        if (fa && fb) {
          window.L.polyline([[fa[0], fa[1]], [fb[0], fb[1]]], {
            color: "#007f8f", weight: 4, opacity: 0.8, dashArray: "6,6",
          }).addTo(complaintMap);
        }
      });

      Object.entries(nodes).forEach(([key, [lat, lng, title]]) => {
        bounds.push([lat, lng]);
        const circle = window.L.circleMarker([lat, lng], {
          radius: 7, fillColor: "#00b8a5", color: "#063b42", weight: 2, opacity: 1, fillOpacity: 0.95,
        }).addTo(complaintMap);
        circle.bindPopup(`<strong>🔵 GNN Graph Node (${w.replace("_", " ").toUpperCase()})</strong><br>Node ID: <code>${key}</code><br>Corridor: ${title}`);
      });
    }
  });

  complaints.filter((c) => c.latitude && c.longitude).forEach((c) => {
    const score = Number(c.priority_score ?? 0);
    const tier = priorityTier(score);
    const resolved = c.status === "Resolved";
    let cls = "marker-medium", sym = "⚠️";
    if (resolved)       { cls = "marker-resolved"; sym = "✓"; }
    else if (tier === "high") { cls = "marker-high"; sym = "🚨"; }
    else if (tier === "low")  { cls = "marker-low"; sym = "📍"; }

    const icon = window.L.divIcon({
      className: `custom-map-pin ${cls}`,
      html: `<div class="pin-inner"><span>${sym}</span></div>`,
      iconSize: [32, 32], iconAnchor: [16, 32], popupAnchor: [0, -32],
    });
    bounds.push([c.latitude, c.longitude]);
    window.L.marker([c.latitude, c.longitude], { icon })
      .addTo(complaintMap)
      .bindPopup(`
        <div class="map-popup-card">
          <strong class="popup-title">${c.category.toUpperCase()}</strong>
          <p class="popup-desc">${c.description}</p>
          <div class="popup-meta">
            <span class="popup-badge">${c.status}</span>
            <span class="popup-priority">Priority: ${c.priority_score || 0}</span>
          </div>
          ${c.ward_note ? `<p class="approx-ward-note" style="margin-top:6px;">${c.ward_note}</p>` : ""}
        </div>`);
  });

  if (bounds.length) window.setTimeout(() => {
    complaintMap.invalidateSize();
    complaintMap.fitBounds(bounds, { padding: [35, 35] });
  }, 150);
}

// ─── Official login modal ─────────────────────────────────────────────────────

function promptOfficialLogin() {
  return new Promise((resolve) => {
    const modal = document.querySelector("#login-modal");
    const form = document.querySelector("#login-form");
    const error = document.querySelector("#login-error");
    const cancelBtn = document.querySelector("#login-cancel-btn");
    if (!modal) { resolve(null); return; }
    error.textContent = "";
    modal.hidden = false;

    // Focus password field if username is prefilled
    const userEl = document.querySelector("#login-username");
    const passEl = document.querySelector("#login-password");
    if (userEl && userEl.value) {
      if (passEl) passEl.focus();
    } else if (userEl) {
      userEl.focus();
    }

    const cleanup = (token) => {
      modal.hidden = true;
      window.removeEventListener("keydown", handleKey);
      modal.onclick = null;
      cancelBtn.onclick = null;
      form.onsubmit = null;
      resolve(token);
    };

    const handleKey = (e) => {
      if (e.key === "Escape" && !modal.hidden) {
        cleanup(null);
      }
    };
    window.addEventListener("keydown", handleKey);

    modal.onclick = (e) => {
      if (e.target === modal) {
        cleanup(null);
      }
    };

    cancelBtn.onclick = () => cleanup(null);

    form.onsubmit = async (e) => {
      e.preventDefault();
      const username = document.querySelector("#login-username").value.trim();
      const password = document.querySelector("#login-password").value.trim();
      try {
        const resp = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        if (!resp.ok) throw new Error("Invalid credentials");
        const { token } = await resp.json();
        officialToken = token;
        try { sessionStorage.setItem("officialToken", token); } catch (_) {}
        updateOfficialUI(true);
        addAgentLog(3, "Auth Guard", `Official "${username}" authenticated. JWT valid for 12 hours.`);
        cleanup(token);
        renderDashboard();
      } catch (err) {
        error.textContent = "Incorrect username or password.";
      }
    };
  });
}

function updateOfficialUI(loggedIn) {
  const loginBtn = document.querySelector("#official-login-btn");
  const logoutBtn = document.querySelector("#official-logout-btn");
  if (loginBtn) loginBtn.hidden = loggedIn;
  if (logoutBtn) logoutBtn.hidden = !loggedIn;
}

function setupAuthUI() {
  const loginBtn = document.querySelector("#official-login-btn");
  const logoutBtn = document.querySelector("#official-logout-btn");
  
  // Restore session from sessionStorage if present
  try {
    const savedToken = sessionStorage.getItem("officialToken");
    if (savedToken) {
      officialToken = savedToken;
      updateOfficialUI(true);
      addAgentLog(3, "Auth Guard", "Official session restored from browser storage.");
    }
  } catch (_) {}

  if (loginBtn) loginBtn.addEventListener("click", () => promptOfficialLogin());
  if (logoutBtn) logoutBtn.addEventListener("click", () => {
    officialToken = null;
    try { sessionStorage.removeItem("officialToken"); } catch (_) {}
    updateOfficialUI(false);
    addAgentLog(3, "Auth Guard", "Official session ended. Status updates now require re-authentication.");
    renderDashboard();
  });
}

// ─── Blockchain modal — real hashes from /api/verify ─────────────────────────

function setupModalClose() {
  const modal = document.querySelector("#blockchain-modal");
  const closeBtn = document.querySelector("#close-modal-btn");
  if (!modal) return;
  if (closeBtn) closeBtn.onclick = () => { modal.hidden = true; };
  modal.onclick = (e) => { if (e.target === modal) modal.hidden = true; };
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") modal.hidden = true; });
}

function openBlockchainModal(complaint) {
  const modal = document.querySelector("#blockchain-modal");
  const content = document.querySelector("#modal-ledger-content");
  if (!modal || !content) return;
  content.replaceChildren(makeTextElement("p", "modal-subtext", "Fetching cryptographic ledger from Setu API…"));
  modal.hidden = false;

  fetch(`/api/verify/${complaint.id}`)
    .then((r) => {
      if (!r.ok) throw new Error(`Server returned ${r.status} for complaint #${complaint.id}`);
      return r.json();
    })
    .then((data) => {
      content.replaceChildren();

      // ── Status header ──
      const header = document.createElement("div");
      header.className = "ledger-block";
      header.style.borderLeftColor = data.verified ? "var(--seafoam)" : "var(--red)";
      header.innerHTML = `
        <div class="ledger-block-header">
          <span>Complaint #${complaint.id} — ${complaint.category.toUpperCase()}</span>
          <span>${data.verified ? "✅ CHAIN VALID" : "❌ CHAIN TAMPERED"}</span>
        </div>
        <div class="ledger-meta">
          <span>Ward: ${data.complaint.ward || "HSR Layout"}</span>
          <span>Priority: ${data.complaint.priority_score || 0}</span>
          <span>Status: ${data.complaint.status}</span>
          <span>Blocks: ${data.entries}</span>
        </div>`;
      content.append(header);

      if (!data.chain || data.chain.length === 0) {
        content.append(makeTextElement("p", "modal-subtext", "No ledger entries yet. Status updates have not been recorded."));
        return;
      }

      // ── Render each real block from the chain ──
      data.chain.forEach((block) => {
        const blockEl = document.createElement("div");
        blockEl.className = "ledger-block";
        blockEl.style.borderLeftColor = block.valid ? "var(--teal)" : "var(--red)";

        const prevHashDisplay = block.previous_hash
          ? `<span class="ledger-hash">${block.previous_hash}</span>`
          : `<span class="ledger-hash ledger-genesis">GENESIS (no previous block)</span>`;

        const photoHashDisplay = block.photo_hash
          ? `<span class="ledger-hash">${block.photo_hash}</span>`
          : `<span style="color:var(--muted)">None</span>`;

        blockEl.innerHTML = `
          <div class="ledger-block-header">
            <span>Block #${block.sequence} — ${block.status}</span>
            <span>${block.valid ? "✓ Valid" : "⚠ Invalid"}</span>
          </div>
          <div>Timestamp: <span class="ledger-hash">${block.timestamp}</span></div>
          <div>Photo SHA-256: ${photoHashDisplay}</div>
          <div>Previous hash: ${prevHashDisplay}</div>
          <div>Block hash: <span class="ledger-hash ledger-hash-main">${block.hash}</span></div>`;
        content.append(blockEl);
      });

      // ── Copy-link to public verify page ──
      const verifyLink = document.createElement("a");
      verifyLink.className = "verify-deeplink";
      verifyLink.href = `/verify/${complaint.id}`;
      verifyLink.target = "_blank";
      verifyLink.rel = "noopener";
      verifyLink.textContent = "🔗 Open public verification page →";
      content.append(verifyLink);
    })
    .catch((err) => {
      content.replaceChildren();
      const isNetworkError = err instanceof TypeError && err.message.includes("fetch");
      const msg = isNetworkError
        ? "Cannot reach the Setu API. Make sure the server is running on port 5000."
        : `Failed to fetch ledger: ${err.message}`;
      content.append(makeTextElement("p", "modal-subtext", msg));
    });
}

// ─── Agent activity feed ──────────────────────────────────────────────────────

function addAgentLog(agentNum, agentName, message) {
  const feed = document.querySelector("#agent-activity-feed");
  if (!feed) return;
  const item = document.createElement("div");
  item.className = "agent-log-item";
  const tag = document.createElement("span");
  tag.className = `agent-tag agent-${agentNum}`;
  tag.textContent = `Agent ${agentNum}: ${agentName}`;
  const msg = document.createElement("span");
  msg.className = "agent-msg";
  msg.textContent = message;
  item.append(tag, msg);
  feed.prepend(item);
  // Cap feed to 20 items
  while (feed.children.length > 20) feed.removeChild(feed.lastChild);
}

// ─── Digital Twin (dynamic via /api/twin) ────────────────────────────────────

// Node options per ward — must match models/priority.py _WARD_DEFINITIONS
const TWIN_WARD_NODES = {
  hsr_layout: [
    { value: "central",       label: "Central HSR (4 main routes)" },
    { value: "north_gate",    label: "HSR North Gate (Silk Board)" },
    { value: "hospital_east", label: "HSR Hospital East (Emergency)" },
    { value: "school_north",  label: "HSR Sector 2 (School Zone)" },
    { value: "bus_north",     label: "HSR North Bus Interchange" },
  ],
  koramangala: [
    { value: "central_sq",   label: "Koramangala Central Square" },
    { value: "forum_mall",   label: "Forum Mall Junction" },
    { value: "silk_board",   label: "Silk Board Flyover" },
    { value: "kor_hospital", label: "Koramangala Hospital (Emergency)" },
    { value: "kor_school",   label: "Koramangala School Zone" },
  ],
  indiranagar: [
    { value: "100ft_road",  label: "100 Feet Road (Primary Arterial)" },
    { value: "12th_main",   label: "12th Main Indiranagar" },
    { value: "ind_metro",   label: "Indiranagar Metro Station" },
    { value: "ind_hospital",label: "Indiranagar Hospital" },
    { value: "domlur",      label: "Domlur Junction" },
  ],
};

function populateTwinNodeDropdown(ward) {
  const nodeSelect = document.querySelector("#twin-node-select");
  if (!nodeSelect) return;
  const nodes = TWIN_WARD_NODES[ward] || TWIN_WARD_NODES["hsr_layout"];
  nodeSelect.innerHTML = nodes
    .map((n) => `<option value="${n.value}">${n.label}</option>`)
    .join("");
}

function setupDigitalTwin() {
  const btn = document.querySelector("#run-simulation-btn");
  const results = document.querySelector("#digital-twin-results");
  const wardSelect = document.querySelector("#twin-ward-select");
  if (!btn || !results) return;

  // Populate nodes for the default ward on load
  populateTwinNodeDropdown(wardSelect ? wardSelect.value : "hsr_layout");

  // Repopulate nodes when ward changes
  if (wardSelect) {
    wardSelect.addEventListener("change", () => {
      populateTwinNodeDropdown(wardSelect.value);
      results.hidden = true; // hide stale results
    });
  }

  btn.addEventListener("click", async () => {
    const nodeSelect = document.querySelector("#twin-node-select");
    const ward = wardSelect ? wardSelect.value : "hsr_layout";
    const node = nodeSelect ? nodeSelect.value : "central";

    if (!ward || !node) return;

    btn.disabled = true;
    btn.textContent = "⏳ Running simulation…";
    results.hidden = true;

    try {
      const resp = await fetch(`/api/twin/${encodeURIComponent(ward)}/${encodeURIComponent(node)}`);
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `API returned ${resp.status}`);
      }
      const data = await resp.json();

      document.querySelector("#twin-flow").textContent    = data.flow_recovery_pct;
      document.querySelector("#twin-delay").textContent   = data.peak_delay_reduction_min;
      document.querySelector("#twin-bus").textContent     = data.bus_latency_reduction_pct;
      document.querySelector("#twin-safety").textContent  = data.safety_index;

      const openEl = document.querySelector("#twin-open-complaints");
      const avgEl  = document.querySelector("#twin-avg-priority");
      if (openEl) openEl.textContent = data.open_complaints;
      if (avgEl)  avgEl.textContent  = data.average_priority;

      results.hidden = false;
      addAgentLog(3, "GNN SLA Sentinel",
        `Digital Twin recomputed for ${ward} → ${node}: ${data.open_complaints} open complaints, avg priority ${data.average_priority}. Predicted flow recovery: ${data.flow_recovery_pct}.`);
    } catch (err) {
      console.error("Digital twin failed", err);
      addAgentLog(3, "GNN SLA Sentinel", `Digital Twin simulation failed: ${err.message}`);
      // Show error in results area instead of silently failing
      results.hidden = false;
      document.querySelector("#twin-flow").textContent   = "—";
      document.querySelector("#twin-delay").textContent  = "—";
      document.querySelector("#twin-bus").textContent    = "—";
      document.querySelector("#twin-safety").textContent = "Error";
    } finally {
      btn.disabled = false;
      btn.textContent = "▶ Run Digital Twin Simulation";
    }
  });
}

// ─── SLA agent trigger ────────────────────────────────────────────────────────

function setupAgentSlaTrigger() {
  const btn = document.querySelector("#trigger-agent-sla");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "⚡ Running Agent…";
    try {
      const resp = await fetch("/api/sla/check", { method: "POST" });
      const data = await resp.json();
      const count = data.escalated_count;
      addAgentLog(3, "GNN SLA Sentinel",
        count > 0
          ? `SLA check complete: ${count} complaint${count === 1 ? "" : "s"} escalated to higher urgency. IDs: ${data.complaint_ids.join(", ")}.`
          : "SLA check complete: all complaints are within their deadline. No escalations needed."
      );
      await renderDashboard();
    } catch (err) {
      console.error("SLA check agent failed", err);
    } finally {
      btn.disabled = false;
      btn.textContent = "⚡ Run SLA Sentinel Agent";
    }
  });
}

// ─── Card actions (protected) ─────────────────────────────────────────────────

async function updateComplaintStatus(complaintId, status, photoData = null) {
  return patchStatus(complaintId, status, photoData);
}

function addCardActions(card, complaint) {
  const actions = document.createElement("div");
  actions.className = "card-actions";

  if (complaint.status !== "Resolved") {
    const progressBtn = makeTextElement("button", "card-action", "Mark In Progress");
    progressBtn.type = "button";
    progressBtn.title = "Requires official login";
    progressBtn.addEventListener("click", async () => {
      progressBtn.disabled = true;
      try {
        await updateComplaintStatus(complaint.id, "In Progress");
        addAgentLog(3, "GNN SLA Sentinel", `Complaint #${complaint.id} marked In Progress by official.`);
        await renderDashboard();
      } catch (err) {
        progressBtn.disabled = false;
        if (err.message !== "Authentication cancelled") console.error(err);
      }
    });
    actions.append(progressBtn);

    const input = document.createElement("input");
    input.className = "resolve-photo-input";
    input.type = "file";
    input.accept = "image/*";
    input.title = "Upload resolution proof photo (official only)";
    input.addEventListener("change", async () => {
      if (!input.files[0]) return;
      input.disabled = true;
      try {
        const proof = await compressPhoto(input.files[0]);
        await updateComplaintStatus(complaint.id, "Resolved", proof);
        addAgentLog(1, "Sync & Deduplicator",
          `Complaint #${complaint.id} resolved. Resolution proof photo hashed and sealed into ledger.`);
        await renderDashboard();
      } catch (err) {
        input.disabled = false;
        if (err.message !== "Authentication cancelled") console.error(err);
      }
    });
    actions.append(input);
  }

  // Delete button for officials
  const deleteBtn = makeTextElement("button", "card-action delete-card-btn", "🗑️ Delete");
  deleteBtn.type = "button";
  deleteBtn.title = "Delete this complaint (Official only)";
  deleteBtn.style.cssText = "background: #fee2e2; border: 1px solid #f87171; color: #b91c1c; font-weight: 700; border-radius: 6px; padding: 4px 10px; cursor: pointer;";
  deleteBtn.addEventListener("click", async () => {
    const shortDesc = (complaint.description || "").slice(0, 35);
    if (!confirm(`Are you sure you want to delete report #${complaint.id} ("${shortDesc}...")?`)) {
      return;
    }
    deleteBtn.disabled = true;
    try {
      let token = getOfficialToken();
      if (!token) {
        token = await promptOfficialLogin();
        if (!token) {
          deleteBtn.disabled = false;
          return;
        }
      }
      let resp = await fetch(`/api/complaints/${complaint.id}`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${token}` },
      });
      if (resp.status === 401) {
        clearOfficialToken();
        token = await promptOfficialLogin();
        if (!token) { deleteBtn.disabled = false; return; }
        resp = await fetch(`/api/complaints/${complaint.id}`, {
          method: "DELETE",
          headers: { "Authorization": `Bearer ${token}` },
        });
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      addAgentLog(1, "Sync & Deduplicator", `Report #${complaint.id} deleted from priority board.`);
      await renderDashboard();
    } catch (err) {
      deleteBtn.disabled = false;
      alert("Error deleting report: " + err.message);
    }
  });
  actions.append(deleteBtn);

  card.append(actions);
}

// ─── Dashboard render ─────────────────────────────────────────────────────────

async function renderDashboard() {
  const list = document.querySelector("#dashboard-list");
  const count = document.querySelector("#dashboard-count");
  const refreshButton = document.querySelector("#refresh-dashboard");
  refreshButton.disabled = true;
  refreshButton.textContent = "Refreshing…";
  list.setAttribute("aria-busy", "true");
  list.replaceChildren(makeTextElement("p", "empty-state", "Loading complaints…"));

  try {
    const response = await fetch("/api/complaints");
    if (!response.ok) throw new Error(`Dashboard API returned ${response.status}`);
    allComplaints = await response.json();

    const showDemo = document.querySelector("#demo-toggle").checked;
    const complaints = showDemo ? allComplaints : allComplaints.filter((c) => !c.is_demo_seed);

    renderImpact(complaints);
    renderComplaintMap(complaints);
    count.textContent = `${complaints.length} report${complaints.length === 1 ? "" : "s"}`;
    list.replaceChildren();

    if (!complaints.length) {
      list.append(makeTextElement("p", "empty-state", "No public reports yet."));
      return;
    }

    for (const complaint of complaints) {
      const card = document.createElement("article");
      card.className = "complaint-card";
      card.dataset.status = complaint.status;

      const top = document.createElement("div");
      top.className = "card-top";
      const details = CATEGORY_DETAILS[complaint.category] || { icon: "•", label: complaint.category };
      const node = NODE_DETAILS[complaint.node_id] || {
        location: complaint.ward ? complaint.ward.replace("_", " ").toUpperCase() : "HSR Layout",
        reason: "🚨 Priority Factor: GNN Road Connectivity & Emergency Proximity Score calculated."
      };

      const headingGroup = document.createElement("div");
      headingGroup.className = "card-heading";
      headingGroup.append(
        makeTextElement("span", "category-icon", details.icon),
        makeTextElement("h3", "card-title", `${details.label} · ${node.location}`)
      );

      const score = Number(complaint.priority_score ?? 0);
      const priority = makeTextElement("span", `priority-score ${priorityTier(score)}`, priorityLabel(score));
      top.append(headingGroup, priority);

      const description = makeTextElement("p", "card-description", complaint.description);
      const reason = makeTextElement("p", "priority-reason", node.reason);

      const meta = document.createElement("div");
      meta.className = "card-meta";
      const statusPill = makeTextElement("span", "pill", complaint.status);
      statusPill.dataset.status = complaint.status;
      const sla = makeTextElement("span", "", formatSla(complaint.sla_deadline, complaint.status));
      const wardBadge = makeTextElement("span", "ward-badge", complaint.ward || "hsr_layout");
      meta.append(statusPill, sla, wardBadge);

      card.append(top, description, reason, meta);
      if (complaint.is_approximate_ward || complaint.ward_note) {
        const approxNote = makeTextElement(
          "div",
          "approx-ward-note",
          complaint.ward_note || "Approximate ward assignment — nearest mapped area used."
        );
        card.append(approxNote);
      }
      card.append(createPhotoGallery(complaint));

      if (complaint.report_count > 1) card.append(createReportCluster(complaint.report_count, complaint));

      if (complaint.status === "Resolved") {
        const badge = makeTextElement("button", "verified-badge", "Verified ✓ (Inspect Block)");
        badge.type = "button";
        badge.title = "Open SHA-256 Ledger Explorer";
        badge.addEventListener("click", () => openBlockchainModal(complaint));
        card.append(badge);
      }

      addCardActions(card, complaint);
      list.append(card);
    }
  } catch (error) {
    count.textContent = "Unavailable";
    list.replaceChildren(makeTextElement("p", "empty-state", "Dashboard unavailable. Try refreshing."));
    console.error(error);
  } finally {
    refreshButton.disabled = false;
    refreshButton.textContent = "Refresh board";
    list.setAttribute("aria-busy", "false");
  }
}

// ─── Geolocation ──────────────────────────────────────────────────────────────

function getLocation() {
  if (!navigator.geolocation) return Promise.resolve({});
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      () => resolve({}),
      { enableHighAccuracy: true, timeout: 5000 }
    );
  });
}

// ─── Report form ──────────────────────────────────────────────────────────────

function setupReportForm() {
  const form = document.querySelector("#complaint-form");
  const validation = document.querySelector("#form-validation");
  const photoInput = document.querySelector("#photo");
  const preview = document.querySelector("#photo-preview");
  const voiceButton = document.querySelector("#voice-button");
  const voiceStatus = document.querySelector("#voice-status");
  const voiceLangSelect = document.querySelector("#voice-lang");
  const submitButton = document.querySelector("#submit-report");
  const correctionLink = document.querySelector("#correct-classification");
  let photoData = null;
  let classification = { label: null, confidence: null };
  let voiceTranscript = "";

  photoInput.addEventListener("change", async () => {
    const file = photoInput.files[0];
    if (!file) return;
    photoData = await compressPhoto(file);
    preview.src = photoData;
    preview.hidden = false;
    classification = await classifyPhoto(file);
  });

  if (correctionLink) correctionLink.addEventListener("click", () => {
    document.querySelector("#category").focus();
  });

  // ── Voice recording with live transcript + review flow ──────────────────
  // Flow:
  //   1. User clicks mic → button animates, status shows "Listening…"
  //   2. Interim results stream into the review box as greyed text
  //   3. When recognition ends, the review box shows the final transcript
  //      with three buttons: ✓ Use this | ✎ Edit | ↺ Record again
  //   4. Only when user clicks "Use this" or "Edit+confirm" does the text
  //      land in the description field
  // ───────────────────────────────────────────────────────────────────────

  const voiceReviewBox  = document.querySelector("#voice-review-box");
  const voiceInterimEl  = document.querySelector("#voice-interim-text");
  const voiceFinalEl    = document.querySelector("#voice-final-text");
  const voiceEditEl     = document.querySelector("#voice-edit-input");
  const voiceUseBtn     = document.querySelector("#voice-use-btn");
  const voiceEditBtn    = document.querySelector("#voice-edit-btn");
  const voiceRedoBtn    = document.querySelector("#voice-redo-btn");
  const voiceConfirmBtn = document.querySelector("#voice-confirm-edit-btn");

  let activeRecognition = null;

  // ── Always-available helper — safe to call even if SpeechRec is null ──
  function resetVoiceReview() {
    if (voiceReviewBox)  voiceReviewBox.hidden  = true;
    if (voiceInterimEl)  { voiceInterimEl.textContent = ""; voiceInterimEl.hidden = false; }
    if (voiceFinalEl)    { voiceFinalEl.hidden   = true; }
    if (voiceEditEl)     { voiceEditEl.hidden     = true; }
    if (voiceUseBtn)     voiceUseBtn.hidden     = true;
    if (voiceEditBtn)    voiceEditBtn.hidden    = true;
    if (voiceRedoBtn)    voiceRedoBtn.hidden    = true;
    if (voiceConfirmBtn) voiceConfirmBtn.hidden = true;
  }

  function showVoiceResult(finalText) {
    if (!voiceReviewBox || !finalText.trim()) return;
    voiceReviewBox.hidden = false;
    if (voiceInterimEl)  voiceInterimEl.hidden = true;
    if (voiceFinalEl)    { voiceFinalEl.textContent = `"${finalText.trim()}"`; voiceFinalEl.hidden = false; }
    if (voiceEditEl)     voiceEditEl.hidden    = true;
    if (voiceConfirmBtn) voiceConfirmBtn.hidden = true;
    if (voiceUseBtn)     voiceUseBtn.hidden    = false;
    if (voiceEditBtn)    voiceEditBtn.hidden   = false;
    if (voiceRedoBtn)    voiceRedoBtn.hidden   = false;
  }

  function applyTranscriptToForm(text) {
    voiceTranscript = text.trim();
    const descInput = document.querySelector("#description");
    if (descInput) descInput.value = voiceTranscript;
    voiceStatus.textContent = `✓ Voice note applied — review and edit the description if needed.`;
    resetVoiceReview();
    addAgentLog(2, "Multilingual STT",
      `Applied transcript: "${voiceTranscript.slice(0, 80)}${voiceTranscript.length > 80 ? "…" : ""}"`);
  }

  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    voiceButton.disabled = true;
    voiceStatus.textContent = "Voice input is not supported in this browser. Use Chrome or Edge.";
  } else {
    function startRecording() {
      if (activeRecognition) {
        try { activeRecognition.stop(); } catch (_) {}
        activeRecognition = null;
      }

      resetVoiceReview();

      const rec = new SpeechRec();
      activeRecognition = rec;
      const lang = voiceLangSelect ? voiceLangSelect.value : "en-IN";
      rec.lang = lang;
      rec.interimResults = true;   // live streaming
      rec.maxAlternatives = 1;
      // Do NOT set continuous=true — it prevents onend from firing reliably

      let finalTranscript = "";
      let interimTranscript = "";
      let onendTimer = null;

      voiceButton.textContent = "⏹ Stop recording";
      voiceButton.classList.add("recording");
      voiceStatus.textContent = `🎙 Listening in ${lang} — speak now…`;

      // Show review box immediately with placeholder
      if (voiceReviewBox) {
        voiceReviewBox.hidden = false;
        if (voiceInterimEl) {
          voiceInterimEl.textContent = "Waiting for speech…";
          voiceInterimEl.hidden = false;
        }
      }

      rec.onresult = (e) => {
        // Clear any pending onend timer — results arrived, not done yet
        if (onendTimer) { clearTimeout(onendTimer); onendTimer = null; }

        interimTranscript = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) {
            finalTranscript += t + " ";
          } else {
            interimTranscript += t;
          }
        }
        if (voiceInterimEl) {
          voiceInterimEl.textContent = (finalTranscript + interimTranscript) || "Listening…";
        }
      };

      rec.onerror = (e) => {
        if (onendTimer) clearTimeout(onendTimer);
        voiceButton.textContent = "🎙️ Add voice note";
        voiceButton.classList.remove("recording");
        activeRecognition = null;
        const msg =
          e.error === "no-speech"    ? "No speech detected — try again." :
          e.error === "not-allowed"  ? "Microphone access denied. Allow it in browser settings." :
          e.error === "aborted"      ? "Recording stopped." :
          `Voice error: ${e.error}. Try again.`;
        voiceStatus.textContent = msg;
        resetVoiceReview();
      };

      rec.onend = () => {
        voiceButton.textContent = "🎙️ Add voice note";
        voiceButton.classList.remove("recording");
        activeRecognition = null;

        // Small delay: on Chrome, onend fires ~50ms before the last onresult
        // so we wait 120ms to make sure we have the final transcript
        onendTimer = setTimeout(() => {
          onendTimer = null;
          const cleanFinal = finalTranscript.trim() || interimTranscript.trim();
          if (!cleanFinal) {
            voiceStatus.textContent = "Nothing captured — tap the mic and try again.";
            resetVoiceReview();
            return;
          }
          voiceStatus.textContent = "Recording done — review below, then click ✓ Use this.";
          showVoiceResult(cleanFinal);
        }, 120);
      };

      try {
        rec.start();
      } catch (err) {
        voiceButton.textContent = "🎙️ Add voice note";
        voiceButton.classList.remove("recording");
        voiceStatus.textContent = "Could not start microphone — check browser permissions.";
        activeRecognition = null;
      }
    }

    voiceButton.addEventListener("click", () => {
      if (activeRecognition) {
        activeRecognition.stop();
      } else {
        startRecording();
      }
    });

    if (voiceUseBtn) {
      voiceUseBtn.addEventListener("click", () => {
        const text = voiceFinalEl ? voiceFinalEl.textContent.replace(/^"|"$/g, "") : "";
        if (text.trim()) applyTranscriptToForm(text);
      });
    }

    if (voiceEditBtn) {
      voiceEditBtn.addEventListener("click", () => {
        const text = voiceFinalEl ? voiceFinalEl.textContent.replace(/^"|"$/g, "") : "";
        if (voiceEditEl)    { voiceEditEl.value = text; voiceEditEl.hidden = false; voiceEditEl.focus(); }
        if (voiceFinalEl)   voiceFinalEl.hidden = true;
        if (voiceUseBtn)    voiceUseBtn.hidden    = true;
        if (voiceEditBtn)   voiceEditBtn.hidden   = true;
        if (voiceConfirmBtn) voiceConfirmBtn.hidden = false;
      });
    }

    if (voiceConfirmBtn) {
      voiceConfirmBtn.addEventListener("click", () => {
        const text = voiceEditEl ? voiceEditEl.value.trim() : "";
        if (!text) { voiceStatus.textContent = "Edit field is empty — type something first."; return; }
        applyTranscriptToForm(text);
      });
    }

    if (voiceRedoBtn) {
      voiceRedoBtn.addEventListener("click", () => {
        voiceTranscript = "";
        voiceStatus.textContent = "Starting new recording…";
        startRecording();
      });
    }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    validation.textContent = "";
    const status = document.querySelector("#form-status");
    const categoryInput = document.querySelector("#category");
    const descInput = document.querySelector("#description");
    const wardInput = document.querySelector("#ward-select");

    if (!categoryInput.value) {
      validation.textContent = "Please choose a category before saving.";
      categoryInput.focus();
      return;
    }
    if (!descInput.value.trim()) {
      validation.textContent = "Please add a description before saving.";
      descInput.focus();
      return;
    }

    const location = await getLocation();
    const payload = {
      category: categoryInput.value,
      description: descInput.value.trim(),
      photo_data: photoData,
      voice_transcript: voiceTranscript || null,
      classifier_label: classification.label,
      classifier_confidence: classification.confidence,
      ward: wardInput ? wardInput.value : "hsr_layout",
      ...location,
    };

    status.textContent = navigator.onLine ? "Saving report…" : "Saving to this device…";
    status.dataset.state = "loading";
    submitButton.disabled = true;

    try {
      if (navigator.onLine) {
        const res = await sendComplaint(payload);
        status.textContent = "Report saved and added to the public board.";
        if (res.duplicate) {
          addAgentLog(1, "Sync & Deduplicator",
            `Merged with existing report #${res.id} at ${NODE_DETAILS[res.node_id]?.location || "this location"} (within 100m). Report count now ${res.report_count}. Priority re-scored: ${res.priority_score || 0}.`);
        } else {
          addAgentLog(1, "Sync & Deduplicator",
            `Accepted new report #${res.id} in ${res.ward || "hsr_layout"}. GNN node: ${res.node_id || "none"}. Priority score: ${res.priority_score || 0}.`);
        }
      } else {
        await queueComplaint({ payload });
        status.textContent = "Saved offline — will sync automatically when connected.";
        showSyncBanner("Saved offline — will sync automatically when connected.", "offline");
        addAgentLog(1, "Sync & Deduplicator", "Device offline. Report queued in IndexedDB outbox for auto-sync.");
      }
      status.dataset.state = "success";
      form.reset();
      preview.hidden = true;
      photoData = null;
      classification = { label: null, confidence: null };
      voiceTranscript = "";
      const classStatus = document.querySelector("#classifier-status");
      const confBadge = document.querySelector("#classifier-confidence-badge");
      if (classStatus) classStatus.textContent = "Upload a photo to classify it on this device.";
      if (correctionLink) correctionLink.hidden = true;
      if (confBadge) confBadge.hidden = true;
      resetVoiceReview();
      voiceStatus.textContent = "Voice input is optional. Speaks in Kannada, English, or Hindi.";
      await renderDashboard();
      // Auto-switch to Priority Board tab so user immediately sees their report
      const boardTab = document.querySelector("#tab-board");
      if (boardTab) boardTab.click();
    } catch (err) {
      if (!navigator.onLine) {
        await queueComplaint({ payload });
        status.textContent = "Saved offline — will sync automatically when connected.";
        showSyncBanner("Saved offline — will sync automatically when connected.", "offline");
        status.dataset.state = "success";
        addAgentLog(1, "Sync & Deduplicator", "Device offline. Saved to IndexedDB outbox.");
      } else {
        status.textContent = "Could not save report. Please try again.";
        status.dataset.state = "error";
      }
      console.error(err);
    } finally {
      submitButton.disabled = false;
    }
  });
}

// ─── Baseline Comparison ─────────────────────────────────────────────────────

/**
 * Animates a numeric display from its current text value to a target number.
 * Runs for ~600 ms using requestAnimationFrame.
 */
function animateNumber(element, targetValue, decimals = 1, suffix = "") {
  const start = parseFloat(element.textContent) || 0;
  const duration = 600;
  const startTime = performance.now();

  function step(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    // Ease-out cubic
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = start + (targetValue - start) * eased;
    element.textContent = current.toFixed(decimals) + suffix;
    if (progress < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

/**
 * Renders a small inline bar chart comparing FIFO position vs Setu position
 * for high-impact complaints, using the ordinal data returned by the API.
 *
 * Each complaint gets two horizontal bars side by side:
 *   FIFO  ████████████████  day 6
 *   Setu  ████             day 2
 */
function renderComparisonBars(data) {
  const container = document.querySelector("#cmp-bar-chart");
  if (!container) return;
  container.innerHTML = "";

  const timeline = data.timeline && data.timeline.length > 0 ? data.timeline : null;
  const fifoHi  = data.fifo.avg_days_high_impact;
  const setuHi  = data.setu.avg_days_high_impact;
  const maxDays = Math.max(
    fifoHi,
    setuHi,
    ...(timeline ? timeline.map(t => Math.max(t.fifo_day, t.setu_day)) : [6])
  );

  if (timeline) {
    timeline.forEach((item, index) => {
      const fifoDay = item.fifo_day;
      const setuDay = item.setu_day;
      const savedDays = fifoDay - setuDay;

      const row = document.createElement("div");
      row.className = "cmp-bar-row";

      const labelEl = document.createElement("span");
      labelEl.className = "cmp-bar-row-label";
      labelEl.textContent = item.label;

      const barsWrap = document.createElement("div");
      barsWrap.className = "cmp-bar-pair";

      // FIFO bar
      const fifoBar = document.createElement("div");
      fifoBar.className = "cmp-bar cmp-bar-fifo";
      fifoBar.style.setProperty("--bar-pct", "0%");
      fifoBar.setAttribute("title", `FIFO: day ${fifoDay}`);
      const fifoTip = document.createElement("span");
      fifoTip.className = "cmp-bar-tip";
      fifoTip.textContent = `${fifoDay}d`;
      fifoBar.append(fifoTip);

      // Setu bar
      const setuBar = document.createElement("div");
      setuBar.className = "cmp-bar cmp-bar-setu";
      setuBar.style.setProperty("--bar-pct", "0%");
      setuBar.setAttribute("title", `Setu: day ${setuDay} (${savedDays > 0 ? savedDays + 'd faster' : 'same'})`);
      const setuTip = document.createElement("span");
      setuTip.className = "cmp-bar-tip";
      setuTip.textContent = savedDays > 0 ? `${setuDay}d (${savedDays}d faster⚡)` : `${setuDay}d`;
      setuBar.append(setuTip);

      barsWrap.append(fifoBar, setuBar);
      row.append(labelEl, barsWrap);
      container.append(row);

      const fifoPct = Math.min((fifoDay / maxDays) * 100, 100).toFixed(1) + "%";
      const setuPct = Math.min((setuDay / maxDays) * 100, 100).toFixed(1) + "%";
      window.setTimeout(() => {
        fifoBar.style.setProperty("--bar-pct", fifoPct);
        setuBar.style.setProperty("--bar-pct", setuPct);
      }, 120 + index * 80);
    });
  } else {
    // Fallback if no timeline provided
    const quintiles = 5;
    for (let q = 0; q < quintiles; q++) {
      const label = `Q${q + 1}`;
      const fifoDay = Math.round(fifoHi * (0.6 + (q / quintiles) * 0.8));
      const setuDay = Math.round(setuHi * (0.4 + (q / quintiles) * 1.2));
      const savedDays = fifoDay - setuDay;

      const row = document.createElement("div");
      row.className = "cmp-bar-row";
      const labelEl = document.createElement("span");
      labelEl.className = "cmp-bar-row-label";
      labelEl.textContent = label;
      const barsWrap = document.createElement("div");
      barsWrap.className = "cmp-bar-pair";

      const fifoBar = document.createElement("div");
      fifoBar.className = "cmp-bar cmp-bar-fifo";
      fifoBar.style.setProperty("--bar-pct", "0%");
      const fifoTip = document.createElement("span");
      fifoTip.className = "cmp-bar-tip";
      fifoTip.textContent = `${fifoDay}d`;
      fifoBar.append(fifoTip);

      const setuBar = document.createElement("div");
      setuBar.className = "cmp-bar cmp-bar-setu";
      setuBar.style.setProperty("--bar-pct", "0%");
      const setuTip = document.createElement("span");
      setuTip.className = "cmp-bar-tip";
      setuTip.textContent = savedDays > 0 ? `${setuDay}d (${savedDays}d faster⚡)` : `${setuDay}d`;
      setuBar.append(setuTip);

      barsWrap.append(fifoBar, setuBar);
      row.append(labelEl, barsWrap);
      container.append(row);

      const fifoPct = Math.min((fifoDay / maxDays) * 100, 100).toFixed(1) + "%";
      const setuPct = Math.min((setuDay / maxDays) * 100, 100).toFixed(1) + "%";
      window.setTimeout(() => {
        fifoBar.style.setProperty("--bar-pct", fifoPct);
        setuBar.style.setProperty("--bar-pct", setuPct);
      }, 120 + q * 80);
    }
  }
}

function setupComparison() {
  const btn       = document.querySelector("#run-comparison-btn");
  const idleEl    = document.querySelector("#cmp-idle");
  const loadingEl = document.querySelector("#cmp-loading");
  const resultsEl = document.querySelector("#cmp-results");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    // ── Show loading state ──
    btn.disabled = true;
    btn.textContent = "⏳ Computing…";
    if (idleEl)    idleEl.hidden    = true;
    if (loadingEl) loadingEl.hidden = false;
    if (resultsEl) resultsEl.hidden = true;

    try {
      const resp = await fetch("/api/comparison");
      if (!resp.ok) throw new Error(`API returned ${resp.status}`);
      const data = await resp.json();

      // ── Populate metadata ──
      const countEl = document.querySelector("#cmp-count");
      if (countEl) countEl.textContent = data.complaint_count;

      const totalPill = document.querySelector("#cmp-meta-total");
      const hiPill    = document.querySelector("#cmp-meta-hi");
      const synPill   = document.querySelector("#cmp-meta-syn");
      const ratePill  = document.querySelector("#cmp-meta-rate");
      if (totalPill) totalPill.textContent = `${data.complaint_count} complaints`;
      if (hiPill)    hiPill.textContent    = `${data.high_impact_count} high-impact`;
      if (synPill) {
        if (data.synthetic_count > 0) {
          synPill.textContent = `${data.synthetic_count} synthetic (padded to 30)`;
          synPill.hidden = false;
        } else {
          synPill.hidden = true;
        }
      }
      if (ratePill) ratePill.textContent = `${data.complaints_per_day} resolved/day`;

      // ── Reveal results, then animate numbers ──
      if (loadingEl) loadingEl.hidden = true;
      if (resultsEl) resultsEl.hidden = false;

      const fifoDaysEl  = document.querySelector("#cmp-fifo-days");
      const setuDaysEl  = document.querySelector("#cmp-setu-days");
      const fifoAllEl   = document.querySelector("#cmp-fifo-all");
      const setuAllEl   = document.querySelector("#cmp-setu-all");
      const setuBadgeEl = document.querySelector("#cmp-setu-badge");
      const pctEl       = document.querySelector("#cmp-pct");
      const impLabelEl  = document.querySelector("#cmp-improvement-label");
      const impRowEl    = document.querySelector("#cmp-improvement-row");

      if (fifoDaysEl) animateNumber(fifoDaysEl, data.fifo.avg_days_high_impact, 1);
      if (setuDaysEl) animateNumber(setuDaysEl, data.setu.avg_days_high_impact, 1);
      if (fifoAllEl)  fifoAllEl.textContent = `${data.fifo.avg_days_all} days weighted avg delay`;
      if (setuAllEl)  setuAllEl.textContent = `${data.setu.avg_days_all} days weighted avg delay`;

      const daysSaved = (data.fifo.avg_days_high_impact - data.setu.avg_days_high_impact).toFixed(1);
      if (setuBadgeEl) {
        if (daysSaved > 0) {
          setuBadgeEl.textContent = `⚡ ${daysSaved} days faster for high-impact locations!`;
          setuBadgeEl.hidden = false;
        } else {
          setuBadgeEl.hidden = true;
        }
      }

      if (pctEl && impRowEl) {
        const pct = data.improvement_pct;
        if (pct > 0) {
          animateNumber(pctEl, pct, 1, "%");
          if (impLabelEl) impLabelEl.textContent = "faster resolution for high-impact locations with Setu";
          impRowEl.className = "cmp-improvement cmp-improvement-positive";
        } else if (pct === 0) {
          pctEl.textContent = "0%";
          if (impLabelEl) impLabelEl.textContent = "identical result — add more high-impact complaints to see a difference";
          impRowEl.className = "cmp-improvement cmp-improvement-neutral";
        } else {
          // Setu is slower — shouldn't happen with valid data, but handle gracefully
          animateNumber(pctEl, Math.abs(pct), 1, "%");
          if (impLabelEl) impLabelEl.textContent = "slower — priority scores need review";
          impRowEl.className = "cmp-improvement cmp-improvement-negative";
        }
      }

      // ── Bar chart ──
      renderComparisonBars(data);

      // ── Agent log ──
      addAgentLog(3, "GNN SLA Sentinel",
        `Baseline comparison complete: FIFO avg ${data.fifo.avg_days_high_impact}d vs Setu avg ${data.setu.avg_days_high_impact}d for ${data.high_impact_count} high-impact complaints. ${data.improvement_pct}% faster with priority ordering.`);

    } catch (err) {
      console.error("Comparison failed", err);
      if (loadingEl) loadingEl.hidden = true;
      if (idleEl) {
        idleEl.hidden = false;
        idleEl.querySelector("p").textContent = `Error: ${err.message}. Try again.`;
      }
      addAgentLog(3, "GNN SLA Sentinel", `Baseline comparison failed: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "↺ Re-run comparison";
    }
  });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");

checkApi();
setupReportForm();
setupDigitalTwin();
setupAgentSlaTrigger();
setupTabs();
setupModalClose();
setupAuthUI();
setupComparison();
document.querySelector("#refresh-dashboard").addEventListener("click", renderDashboard);
document.querySelector("#demo-toggle").addEventListener("change", renderDashboard);
renderDashboard();
updateConnectionState(navigator.onLine);
window.addEventListener("online", syncOutbox);
window.addEventListener("online", () => {
  updateConnectionState(true);
  showSyncBanner("Connection restored. Syncing reports…", "syncing");
  renderDashboard();
});
window.addEventListener("offline", () => updateConnectionState(false));
syncOutbox();
