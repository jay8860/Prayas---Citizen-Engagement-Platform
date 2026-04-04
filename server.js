const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT || 3000);
const APP_ROOT = __dirname;
const DB_DIR = path.join(APP_ROOT, "data");
const DB_PATH = path.join(DB_DIR, "prayas.sqlite");
const INDEX_PATH = path.join(APP_ROOT, "index.html");
const ADMIN_PASSWORD = process.env.PRAYAS_ADMIN_PASSWORD || "Prayas@2026";
const TOKEN_SECRET = process.env.PRAYAS_TOKEN_SECRET || "replace-this-secret-before-production";
const TOKEN_TTL_MS = 1000 * 60 * 60 * 12;

const seedAnnouncements = [
  "Van Mahotsav registrations open - 500 spots available.",
  "Wall Art Competition submissions close on 15 April.",
  "Road Safety Corps waitlist now open.",
  "Earth Day Jal Shakti March route updated."
];

const seedMissions = [
  {
    category: "sanitation",
    ward: "Ward 2",
    emoji: "🧹",
    bg: "linear-gradient(135deg,#FFF3E0,#FFE0B2)",
    title: "Swachh Market Drive",
    desc: "Join the Sunday morning market clean-up with gloves, bags, masks, and disposal support already arranged by the administration.",
    date: "Every Sunday, 7-10 AM",
    location: "Civil Lines Market",
    volunteers: 48,
    total: 60,
    status: "completed",
    coordinator: "Anita Mishra (Municipal Officer)",
    duration: "3 hours",
    age: "16+",
    impact: "6 tonnes of waste removed",
    discussion: [
      { name: "Ramesh K.", text: "Do we need to bring our own gloves?", time: "2 days ago" },
      { name: "Admin", text: "No. All equipment is provided at the venue.", time: "1 day ago" },
      { name: "Preethi V.", text: "See everyone on Sunday.", time: "5 hours ago" }
    ]
  },
  {
    category: "arts",
    ward: "Ward 1",
    emoji: "🎨",
    bg: "linear-gradient(135deg,#F3E5F5,#E1BEE7)",
    title: "Wall Art Competition 2026",
    desc: "Paint district boundary walls on themes of national pride, local culture, and civic responsibility. Winning pieces get district recognition.",
    date: "15 Apr 2026",
    location: "MG Road and Station Road",
    volunteers: 72,
    total: 80,
    status: "completed",
    coordinator: "Rahul Gupta (Culture Department)",
    duration: "1 full day",
    age: "All ages",
    impact: "2.4 km of walls beautified",
    discussion: [
      { name: "Ananya S.", text: "Can we use spray paint or only brushes?", time: "3 days ago" },
      { name: "Admin", text: "Both are allowed. Please bring your own supplies.", time: "2 days ago" }
    ]
  },
  {
    category: "environment",
    ward: "Ward 3",
    emoji: "🌳",
    bg: "linear-gradient(135deg,#E8F5E9,#C8E6C9)",
    title: "Van Mahotsav - Plant 1,000 Trees",
    desc: "District-wide plantation campaign across schools, roadsides, parks, and panchayat sites. Saplings and guidance are arranged centrally.",
    date: "20 Apr 2026",
    location: "District-wide (12 sites)",
    volunteers: 320,
    total: 500,
    status: "open",
    coordinator: "Forest Department",
    duration: "Full day",
    age: "14+",
    impact: "840 trees planted so far",
    discussion: [
      { name: "Deepak M.", text: "Which site is nearest to Sector 4?", time: "1 day ago" },
      { name: "Admin", text: "Site 7 at Sector 4 Park. Report at 7 AM.", time: "20 hours ago" }
    ]
  },
  {
    category: "awareness",
    ward: "Ward 1",
    emoji: "🚦",
    bg: "linear-gradient(135deg,#FFF8E1,#FFECB3)",
    title: "Road Safety Volunteer Corps",
    desc: "Support traffic police during peak hours at key intersections, promote school-zone discipline, and guide pedestrians safely.",
    date: "Mon-Sat, 8-10 AM",
    location: "12 major intersections",
    volunteers: 100,
    total: 100,
    status: "full",
    coordinator: "Traffic Police District HQ",
    duration: "2 hours / day",
    age: "18+",
    impact: "40% fewer violations in active zones",
    discussion: [
      { name: "Sunita B.", text: "What if it rains?", time: "4 days ago" },
      { name: "Admin", text: "The drive continues unless there is a storm warning.", time: "3 days ago" }
    ]
  },
  {
    category: "education",
    ward: "Ward 4",
    emoji: "📚",
    bg: "linear-gradient(135deg,#E3F2FD,#BBDEFB)",
    title: "Padh Aage - Evening Classes",
    desc: "Teach children aged 8-14 in weekday evening classes. Volunteers can contribute in language, maths, science, or life skills.",
    date: "Mon, Wed, Fri - 5-7 PM",
    location: "Community Hall, Sector 4",
    volunteers: 22,
    total: 30,
    status: "open",
    coordinator: "Dr. Sunita Rao",
    duration: "2 hours / session",
    age: "18+",
    impact: "86 children enrolled",
    discussion: [
      { name: "Deepak M.", text: "I can teach basic computer skills.", time: "2 days ago" },
      { name: "Dr. Sunita Rao", text: "That would be wonderful. Please register.", time: "1 day ago" }
    ]
  },
  {
    category: "awareness",
    ward: "Ward 5",
    emoji: "💧",
    bg: "linear-gradient(135deg,#E1F5FE,#B3E5FC)",
    title: "Jal Shakti Awareness March",
    desc: "Join the Earth Day march on water conservation, rainwater harvesting, plastic reduction, and protection of local water bodies.",
    date: "22 Apr 2026 (Earth Day)",
    location: "Starting: Collectorate Gate",
    volunteers: 120,
    total: 200,
    status: "upcoming",
    coordinator: "Water Department and NGO Network",
    duration: "Half day",
    age: "All ages",
    impact: "5,000+ citizens expected",
    discussion: [
      { name: "NCC Cadet", text: "Can our battalion join as a group?", time: "1 day ago" },
      { name: "Admin", text: "Absolutely. Group registrations are welcome.", time: "18 hours ago" }
    ]
  }
];

const seedFunds = [
  { missionId: 1, title: "Swachh Drive", emoji: "🧹", color: "#FF9933", target: 50000, raised: 32400, donors: 186, daysLeft: 12 },
  { missionId: 3, title: "Van Mahotsav", emoji: "🌳", color: "#138808", target: 100000, raised: 71200, donors: 341, daysLeft: 8 },
  { missionId: 2, title: "Wall Art", emoji: "🎨", color: "#7C3AED", target: 30000, raised: 18600, donors: 94, daysLeft: 15 },
  { missionId: 5, title: "Padh Aage", emoji: "📚", color: "#0284C7", target: 40000, raised: 11000, donors: 53, daysLeft: 20 }
];

const seedStories = [
  {
    contributor: "Ananya S.",
    initials: "AS",
    color: "#7C3AED",
    role: "Teacher and Volunteer",
    title: "Painting hope on blank walls",
    story: "I coordinated 40 student artists over two weekends. The station road mural now greets thousands daily with messages of pride and civic responsibility.",
    bg: "linear-gradient(135deg,#EDE9FE,#C4B5FD)",
    emoji: "🎨",
    tags: ["Arts", "Youth", "District Winner"],
    likes: 45,
    comments: [
      { name: "District Admin", text: "A beautiful example of citizen-led place making.", time: "2 days ago" }
    ],
    imageUrl: ""
  },
  {
    contributor: "Ramesh K.",
    initials: "RK",
    color: "#059669",
    role: "Retired Banker",
    title: "Planting trees and building ownership",
    story: "At 62, I planted 18 saplings in one day and now water them every week. The mission made me feel useful, healthy, and connected to my ward again.",
    bg: "linear-gradient(135deg,#D1FAE5,#A7F3D0)",
    emoji: "🌱",
    tags: ["Environment", "Senior Volunteer"],
    likes: 62,
    comments: [
      { name: "Meera", text: "This inspired my father to join too.", time: "1 day ago" }
    ],
    imageUrl: ""
  },
  {
    contributor: "Preethi V.",
    initials: "PV",
    color: "#DC2626",
    role: "Medical Student",
    title: "Sunday mornings with purpose",
    story: "The Swachh Market Drive has become my weekly meditation. We cleaned the market, but more importantly, we changed how people treat shared spaces.",
    bg: "linear-gradient(135deg,#FEE2E2,#FECACA)",
    emoji: "🧹",
    tags: ["Sanitation", "Consistency"],
    likes: 31,
    comments: [],
    imageUrl: ""
  },
  {
    contributor: "Deepak M.",
    initials: "DM",
    color: "#D97706",
    role: "Software Engineer",
    title: "Teaching beyond textbooks",
    story: "I joined Padh Aage to teach English but ended up introducing Scratch to a group of curious children. Two now want to become engineers.",
    bg: "linear-gradient(135deg,#FEF3C7,#FDE68A)",
    emoji: "💡",
    tags: ["Education", "Tech Skills"],
    likes: 78,
    comments: [
      { name: "Sunita Rao", text: "The children talk about your class every week.", time: "8 hours ago" }
    ],
    imageUrl: ""
  },
  {
    contributor: "Sunita B.",
    initials: "SB",
    color: "#0284C7",
    role: "Homemaker and Safety Advocate",
    title: "Intersections are safer now",
    story: "Standing at a junction felt daunting at first, but violation numbers dropped in our zone and parents started thanking the volunteer team personally.",
    bg: "linear-gradient(135deg,#DBEAFE,#BFDBFE)",
    emoji: "🚦",
    tags: ["Awareness", "Road Safety"],
    likes: 29,
    comments: [],
    imageUrl: ""
  },
  {
    contributor: "NCC Battalion 7",
    initials: "NCC",
    color: "#065F46",
    role: "Group Volunteer Team",
    title: "A river bank clean-up that shifted habits",
    story: "Our battalion removed plastic from the river edge in four hours. The bigger success was convincing nearby households to start waste segregation.",
    bg: "linear-gradient(135deg,#D1FAE5,#6EE7B7)",
    emoji: "🏞️",
    tags: ["Group Effort", "Environment"],
    likes: 54,
    comments: [],
    imageUrl: ""
  }
];

const seedLeaders = [
  {
    name: "Ananya Srivastava",
    area: "Civil Lines",
    initials: "AS",
    color: "#7C3AED",
    points: 920,
    missions: 14,
    rank: "🥇",
    cls: "gold",
    badges: ["🌱", "🏅", "🌟", "🎨"],
    attended: ["Wall Art Competition", "Van Mahotsav", "Padh Aage", "Swachh Market Drive"]
  },
  {
    name: "Ramesh Kumar",
    area: "Sector 3",
    initials: "RK",
    color: "#059669",
    points: 840,
    missions: 11,
    rank: "🥈",
    cls: "silver",
    badges: ["🌱", "🏅", "🌟", "🌳"],
    attended: ["Van Mahotsav", "Jal Shakti March", "Swachh Market Drive"]
  },
  {
    name: "Preethi Verma",
    area: "Station Road",
    initials: "PV",
    color: "#DC2626",
    points: 790,
    missions: 10,
    rank: "🥉",
    cls: "bronze",
    badges: ["🌱", "🏅", "🌟", "🧹"],
    attended: ["Swachh Market Drive", "Van Mahotsav", "Padh Aage"]
  },
  {
    name: "Deepak Mehta",
    area: "Sector 4",
    initials: "DM",
    color: "#D97706",
    points: 680,
    missions: 8,
    rank: "4",
    cls: "",
    badges: ["🌱", "🏅", "📚"],
    attended: ["Padh Aage", "Wall Art Competition"]
  }
];

fs.mkdirSync(DB_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    is_demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS missions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    ward TEXT NOT NULL,
    emoji TEXT NOT NULL,
    bg TEXT NOT NULL,
    title TEXT NOT NULL,
    desc TEXT NOT NULL,
    date TEXT NOT NULL,
    location TEXT NOT NULL,
    volunteers INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'admin',
    approval_status TEXT NOT NULL DEFAULT 'approved',
    host_name TEXT NOT NULL DEFAULT '',
    host_phone TEXT NOT NULL DEFAULT '',
    host_email TEXT NOT NULL DEFAULT '',
    nodal_department TEXT NOT NULL DEFAULT '',
    is_demo INTEGER NOT NULL DEFAULT 0,
    coordinator TEXT NOT NULL,
    duration TEXT NOT NULL,
    age TEXT NOT NULL,
    impact TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS mission_discussions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    text TEXT NOT NULL,
    time_label TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS funds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id INTEGER REFERENCES missions(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    emoji TEXT NOT NULL,
    color TEXT NOT NULL,
    target INTEGER NOT NULL,
    raised INTEGER NOT NULL DEFAULT 0,
    donors INTEGER NOT NULL DEFAULT 0,
    days_left INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS stories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contributor TEXT NOT NULL,
    initials TEXT NOT NULL,
    color TEXT NOT NULL,
    role TEXT NOT NULL,
    title TEXT NOT NULL,
    story TEXT NOT NULL,
    bg TEXT NOT NULL,
    emoji TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    likes INTEGER NOT NULL DEFAULT 0,
    image_url TEXT NOT NULL DEFAULT '',
    is_demo INTEGER NOT NULL DEFAULT 0,
    date_label TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS story_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    text TEXT NOT NULL,
    time_label TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS leaders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    area TEXT NOT NULL,
    initials TEXT NOT NULL,
    color TEXT NOT NULL,
    points INTEGER NOT NULL,
    missions INTEGER NOT NULL,
    rank_label TEXT NOT NULL,
    cls TEXT NOT NULL,
    badges_json TEXT NOT NULL,
    attended_json TEXT NOT NULL,
    is_demo INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS volunteers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    area TEXT NOT NULL DEFAULT '',
    occupation TEXT NOT NULL DEFAULT '',
    availability TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    skills_json TEXT NOT NULL,
    mission TEXT NOT NULL DEFAULT '',
    date_label TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sponsors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company TEXT NOT NULL,
    contact TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT NOT NULL,
    tier TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    date_label TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS donations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fund_id INTEGER NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
    donor_name TEXT NOT NULL,
    donor_phone TEXT NOT NULL DEFAULT '',
    donor_email TEXT NOT NULL DEFAULT '',
    anonymous INTEGER NOT NULL DEFAULT 0,
    amount INTEGER NOT NULL,
    preferred_mode TEXT NOT NULL DEFAULT 'cash',
    payment_method TEXT NOT NULL,
    transaction_reference TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    verified_at TEXT,
    date_label TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS newsletter_subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    date_label TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

try {
  db.exec("ALTER TABLE donations ADD COLUMN donor_phone TEXT NOT NULL DEFAULT ''");
} catch (error) {}
try {
  db.exec("ALTER TABLE donations ADD COLUMN donor_email TEXT NOT NULL DEFAULT ''");
} catch (error) {}
try {
  db.exec("ALTER TABLE donations ADD COLUMN preferred_mode TEXT NOT NULL DEFAULT 'cash'");
} catch (error) {}
try {
  db.exec("ALTER TABLE announcements ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0");
} catch (error) {}
try {
  db.exec("ALTER TABLE missions ADD COLUMN source_type TEXT NOT NULL DEFAULT 'admin'");
} catch (error) {}
try {
  db.exec("ALTER TABLE missions ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved'");
} catch (error) {}
try {
  db.exec("ALTER TABLE missions ADD COLUMN host_name TEXT NOT NULL DEFAULT ''");
} catch (error) {}
try {
  db.exec("ALTER TABLE missions ADD COLUMN host_phone TEXT NOT NULL DEFAULT ''");
} catch (error) {}
try {
  db.exec("ALTER TABLE missions ADD COLUMN host_email TEXT NOT NULL DEFAULT ''");
} catch (error) {}
try {
  db.exec("ALTER TABLE missions ADD COLUMN nodal_department TEXT NOT NULL DEFAULT ''");
} catch (error) {}
try {
  db.exec("ALTER TABLE missions ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0");
} catch (error) {}
try {
  db.exec("ALTER TABLE stories ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0");
} catch (error) {}
try {
  db.exec("ALTER TABLE leaders ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0");
} catch (error) {}

seedDatabase();
migrateLegacyDemoRecords();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (url.pathname === "/health") {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/bootstrap") {
      return sendJson(res, 200, buildBootstrapPayload());
    }

    if (req.method === "POST" && url.pathname === "/api/admin/login") {
      const body = await readJsonBody(req);
      if (!String(body.password || "").trim()) {
        return sendJson(res, 400, { error: "Enter any password to continue during testing." });
      }
      return sendJson(res, 200, { token: createAdminToken() });
    }

    if (req.method === "POST" && url.pathname === "/api/volunteers") {
      const body = await readJsonBody(req);
      return sendJson(res, 200, registerVolunteer(body));
    }

    if (req.method === "POST" && url.pathname === "/api/community-missions") {
      const body = await readJsonBody(req);
      return sendJson(res, 200, createCommunityMission(body));
    }

    if (req.method === "POST" && url.pathname === "/api/newsletter/subscribe") {
      const body = await readJsonBody(req);
      return sendJson(res, 200, subscribeNewsletter(body));
    }

    if (req.method === "POST" && url.pathname === "/api/stories") {
      const body = await readJsonBody(req);
      return sendJson(res, 200, createStory(body));
    }

    if (req.method === "POST" && /^\/api\/stories\/\d+\/comments$/.test(url.pathname)) {
      const body = await readJsonBody(req);
      const storyId = Number(url.pathname.split("/")[3]);
      return sendJson(res, 200, addStoryComment(storyId, body));
    }

    if (req.method === "POST" && /^\/api\/stories\/\d+\/cheer$/.test(url.pathname)) {
      const storyId = Number(url.pathname.split("/")[3]);
      return sendJson(res, 200, cheerStory(storyId));
    }

    if (req.method === "POST" && /^\/api\/missions\/\d+\/discussion$/.test(url.pathname)) {
      const body = await readJsonBody(req);
      const missionId = Number(url.pathname.split("/")[3]);
      return sendJson(res, 200, addMissionDiscussion(missionId, body));
    }

    if (req.method === "POST" && url.pathname === "/api/donations") {
      const body = await readJsonBody(req);
      return sendJson(res, 200, recordDonation(body));
    }

    if (req.method === "POST" && /^\/api\/admin\/donations\/\d+\/verify$/.test(url.pathname)) {
      requireAdmin(req);
      const donationId = Number(url.pathname.split("/")[4]);
      return sendJson(res, 200, verifyDonation(donationId));
    }

    if (req.method === "POST" && url.pathname === "/api/sponsors") {
      const body = await readJsonBody(req);
      return sendJson(res, 200, recordSponsor(body));
    }

    if (req.method === "POST" && url.pathname === "/api/admin/missions") {
      requireAdmin(req);
      const body = await readJsonBody(req);
      return sendJson(res, 200, createMission(body));
    }

    if (req.method === "POST" && url.pathname === "/api/admin/announcements") {
      requireAdmin(req);
      const body = await readJsonBody(req);
      return sendJson(res, 200, createAnnouncement(body));
    }

    if (req.method === "POST" && /^\/api\/admin\/missions\/\d+\/status$/.test(url.pathname)) {
      requireAdmin(req);
      const body = await readJsonBody(req);
      const missionId = Number(url.pathname.split("/")[4]);
      return sendJson(res, 200, updateMissionStatus(missionId, body));
    }

    if (req.method === "POST" && /^\/api\/admin\/missions\/\d+\/review$/.test(url.pathname)) {
      requireAdmin(req);
      const body = await readJsonBody(req);
      const missionId = Number(url.pathname.split("/")[4]);
      return sendJson(res, 200, reviewMissionRequest(missionId, body));
    }

    if (req.method === "POST" && /^\/api\/admin\/missions\/\d+\/update$/.test(url.pathname)) {
      requireAdmin(req);
      const body = await readJsonBody(req);
      const missionId = Number(url.pathname.split("/")[4]);
      return sendJson(res, 200, updateMission(missionId, body));
    }

    if (req.method === "POST" && /^\/api\/admin\/missions\/\d+\/delete$/.test(url.pathname)) {
      requireAdmin(req);
      const missionId = Number(url.pathname.split("/")[4]);
      return sendJson(res, 200, deleteMission(missionId));
    }

    if (req.method === "POST" && url.pathname === "/api/admin/data-mode") {
      requireAdmin(req);
      const body = await readJsonBody(req);
      return sendJson(res, 200, setPortalDataMode(body));
    }

    if (req.method === "POST" && url.pathname === "/api/admin/newsletter") {
      requireAdmin(req);
      const body = await readJsonBody(req);
      return sendJson(res, 200, saveNewsletterDraft(body));
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = fs.readFileSync(INDEX_PATH);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache"
      });
      res.end(html);
      return;
    }

    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    sendJson(res, 404, { error: "Not found." });
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(res, status, { error: error.publicMessage || error.message || "Unexpected server error." });
  }
});

server.listen(PORT, () => {
  console.log(`Prayas portal running on http://localhost:${PORT}`);
});

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
    ...corsHeaders()
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) {
        reject(publicError(413, "Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(publicError(400, "Invalid JSON payload."));
      }
    });
    req.on("error", reject);
  });
}

function publicError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicMessage = message;
  return error;
}

function isoNow() {
  return new Date().toISOString();
}

function displayDate(value = isoNow()) {
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric"
  }).format(new Date(value));
}

function getSetting(key, fallback = "") {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function seedDatabase() {
  const missionCount = db.prepare("SELECT COUNT(*) AS count FROM missions").get().count;
  if (missionCount > 0) return;

  setSetting("portal_data_mode", "demo");
  setSetting("newsletter_subscriber_base", "847");
  setSetting("newsletter_draft_subject", "District Update");
  setSetting("newsletter_draft_body", "Write your newsletter body to preview it here.");

  const insertAnnouncement = db.prepare("INSERT INTO announcements (text, is_demo, created_at) VALUES (?, 1, ?)");
  seedAnnouncements.forEach((text, index) => {
    insertAnnouncement.run(text, new Date(Date.now() - index * 60_000).toISOString());
  });

  const insertMission = db.prepare(`
    INSERT INTO missions (
      category, ward, emoji, bg, title, desc, date, location, volunteers, total, status, source_type, approval_status, host_name, host_phone, host_email, nodal_department, is_demo, coordinator, duration, age, impact, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admin', 'approved', '', '', '', '', 1, ?, ?, ?, ?, ?)
  `);
  const insertDiscussion = db.prepare(`
    INSERT INTO mission_discussions (mission_id, name, text, time_label, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  seedMissions.forEach((mission, missionIndex) => {
    const createdAt = new Date(Date.now() - missionIndex * 3_600_000).toISOString();
    const result = insertMission.run(
      mission.category,
      mission.ward,
      mission.emoji,
      mission.bg,
      mission.title,
      mission.desc,
      mission.date,
      mission.location,
      mission.volunteers,
      mission.total,
      mission.status,
      mission.coordinator,
      mission.duration,
      mission.age,
      mission.impact,
      createdAt
    );
    mission.discussion.forEach((entry, discussionIndex) => {
      insertDiscussion.run(
        Number(result.lastInsertRowid),
        entry.name,
        entry.text,
        entry.time,
        new Date(Date.now() - discussionIndex * 60_000).toISOString()
      );
    });
  });

  const insertFund = db.prepare(`
    INSERT INTO funds (mission_id, title, emoji, color, target, raised, donors, days_left)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  seedFunds.forEach((fund) => {
    insertFund.run(fund.missionId, fund.title, fund.emoji, fund.color, fund.target, fund.raised, fund.donors, fund.daysLeft);
  });

  const insertStory = db.prepare(`
    INSERT INTO stories (
      contributor, initials, color, role, title, story, bg, emoji, tags_json, likes, image_url, is_demo, date_label, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);
  const insertStoryComment = db.prepare(`
    INSERT INTO story_comments (story_id, name, text, time_label, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  seedStories.forEach((story, storyIndex) => {
    const createdAt = new Date(Date.now() - storyIndex * 5_400_000).toISOString();
    const result = insertStory.run(
      story.contributor,
      story.initials,
      story.color,
      story.role,
      story.title,
      story.story,
      story.bg,
      story.emoji,
      JSON.stringify(story.tags),
      story.likes,
      story.imageUrl,
      displayDate(createdAt),
      createdAt
    );
    story.comments.forEach((comment, commentIndex) => {
      insertStoryComment.run(
        Number(result.lastInsertRowid),
        comment.name,
        comment.text,
        comment.time,
        new Date(Date.now() - commentIndex * 60_000).toISOString()
      );
    });
  });

  const insertLeader = db.prepare(`
    INSERT INTO leaders (name, area, initials, color, points, missions, rank_label, cls, badges_json, attended_json, is_demo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  seedLeaders.forEach((leader) => {
    insertLeader.run(
      leader.name,
      leader.area,
      leader.initials,
      leader.color,
      leader.points,
      leader.missions,
      leader.rank,
      leader.cls,
      JSON.stringify(leader.badges),
      JSON.stringify(leader.attended)
    );
  });
}

function migrateLegacyDemoRecords() {
  seedAnnouncements.forEach((text) => {
    db.prepare("UPDATE announcements SET is_demo = 1 WHERE text = ?").run(text);
  });
  seedMissions.forEach((mission) => {
    db.prepare("UPDATE missions SET is_demo = 1, source_type = COALESCE(NULLIF(source_type, ''), 'admin'), approval_status = COALESCE(NULLIF(approval_status, ''), 'approved') WHERE title = ?").run(mission.title);
  });
  seedStories.forEach((story) => {
    db.prepare("UPDATE stories SET is_demo = 1 WHERE title = ?").run(story.title);
  });
  seedLeaders.forEach((leader) => {
    db.prepare("UPDATE leaders SET is_demo = 1 WHERE name = ?").run(leader.name);
  });
}

function createAdminToken() {
  const payload = {
    role: "admin",
    exp: Date.now() + TOKEN_TTL_MS
  };
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signature = signValue(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function requireAdmin(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    throw publicError(401, "Admin authentication required.");
  }
  verifyAdminToken(token);
}

function verifyAdminToken(token) {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) {
    throw publicError(401, "Invalid admin token.");
  }
  const expected = signValue(encodedPayload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw publicError(401, "Invalid admin token.");
  }
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  if (!payload.exp || Date.now() > payload.exp) {
    throw publicError(401, "Admin session expired.");
  }
  return payload;
}

function signValue(value) {
  return crypto.createHmac("sha256", TOKEN_SECRET).update(value).digest("base64url");
}

function base64Url(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function buildBootstrapPayload() {
  const dataMode = getSetting("portal_data_mode", "demo") === "real" ? "real" : "demo";
  const demoFlag = dataMode === "demo" ? 1 : 0;
  const announcementRows = db.prepare("SELECT text FROM announcements WHERE is_demo = ? ORDER BY id DESC").all(demoFlag);
  const missionRows = db.prepare("SELECT * FROM missions WHERE is_demo = ? ORDER BY id DESC").all(demoFlag);
  const discussionStmt = db.prepare("SELECT name, text, time_label FROM mission_discussions WHERE mission_id = ? ORDER BY id DESC");
  const fundRows = [];
  const storyRows = db.prepare("SELECT * FROM stories WHERE is_demo = ? ORDER BY id DESC").all(demoFlag);
  const storyCommentStmt = db.prepare("SELECT name, text, time_label FROM story_comments WHERE story_id = ? ORDER BY id ASC");
  const leaderRows = db.prepare("SELECT * FROM leaders WHERE is_demo = ? ORDER BY points DESC, id ASC").all(demoFlag);
  const volunteerRows = db.prepare("SELECT * FROM volunteers ORDER BY id DESC").all();
  const sponsorRows = [];
  const donationRows = [];
  const subscriberRows = db.prepare("SELECT email, date_label FROM newsletter_subscribers ORDER BY id DESC").all();

  const missions = missionRows.map((mission) => ({
    id: mission.id,
    category: mission.category,
    ward: mission.ward,
    emoji: mission.emoji,
    bg: mission.bg,
    title: mission.title,
    desc: mission.desc,
    date: mission.date,
    location: mission.location,
    volunteers: mission.volunteers,
    total: mission.total,
    status: mission.status,
    sourceType: mission.source_type || "admin",
    approvalStatus: mission.approval_status || "approved",
    hostName: mission.host_name || "",
    hostPhone: mission.host_phone || "",
    hostEmail: mission.host_email || "",
    nodalDepartment: mission.nodal_department || "",
    coordinator: mission.coordinator,
    duration: mission.duration,
    age: mission.age,
    impact: mission.impact,
    discussion: discussionStmt.all(mission.id).map((entry) => ({
      name: entry.name,
      text: entry.text,
      time: entry.time_label
    }))
  }));

  const funds = fundRows.map((fund) => ({
    id: fund.id,
    missionId: fund.mission_id,
    title: fund.title,
    emoji: fund.emoji,
    color: fund.color,
    target: fund.target,
    raised: fund.raised,
    donors: fund.donors,
    daysLeft: fund.days_left
  }));

  const stories = storyRows.map((story) => ({
    id: story.id,
    contributor: story.contributor,
    initials: story.initials,
    color: story.color,
    role: story.role,
    title: story.title,
    story: story.story,
    bg: story.bg,
    emoji: story.emoji,
    tags: safeJsonArray(story.tags_json),
    likes: story.likes,
    imageUrl: story.image_url,
    date: story.date_label,
    comments: storyCommentStmt.all(story.id).map((comment) => ({
      name: comment.name,
      text: comment.text,
      time: comment.time_label
    }))
  }));

  const leaders = leaderRows.map((leader) => ({
    id: leader.id,
    name: leader.name,
    area: leader.area,
    initials: leader.initials,
    color: leader.color,
    points: leader.points,
    missions: leader.missions,
    rank: leader.rank_label,
    cls: leader.cls,
    badges: safeJsonArray(leader.badges_json),
    attended: safeJsonArray(leader.attended_json)
  }));

  const volunteers = volunteerRows.map((volunteer) => ({
    id: volunteer.id,
    name: volunteer.name,
    phone: volunteer.phone,
    email: volunteer.email,
    area: volunteer.area,
    occupation: volunteer.occupation,
    availability: volunteer.availability,
    message: volunteer.message,
    skills: safeJsonArray(volunteer.skills_json),
    mission: volunteer.mission,
    date: volunteer.date_label
  }));

  const sponsorLeads = sponsorRows.map((lead) => ({
    id: lead.id,
    company: lead.company,
    contact: lead.contact,
    phone: lead.phone,
    email: lead.email,
    tier: lead.tier,
    message: lead.message,
    date: lead.date_label
  }));

  const donations = donationRows.map((donation) => ({
    id: donation.id,
    fundId: donation.fund_id,
    fundTitle: donation.fund_title || "Community Fund",
    donorName: donation.donor_name,
    donorPhone: donation.donor_phone || "",
    donorEmail: donation.donor_email || "",
    anonymous: Boolean(donation.anonymous),
    amount: donation.amount,
    preferredMode: donation.preferred_mode || "cash",
    paymentMethod: donation.payment_method,
    transactionReference: donation.transaction_reference,
    note: donation.note,
    status: donation.status,
    date: donation.date_label
  }));

  const newsletterSignups = subscriberRows.map((subscriber) => ({
    email: subscriber.email,
    date: subscriber.date_label
  }));

  const baseSubscribers = Number(getSetting("newsletter_subscriber_base", "847")) || 847;

  return {
    dataMode,
    announcements: announcementRows.map((row) => row.text),
    missions,
    funds,
    stories,
    leaders,
    volunteers,
    sponsorLeads,
    donations,
    newsletterSubs: baseSubscribers + newsletterSignups.length,
    newsletterSignups,
    newsletterDraft: {
      subject: getSetting("newsletter_draft_subject", "District Update"),
      body: getSetting("newsletter_draft_body", "Write your newsletter body to preview it here.")
    }
  };
}

function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function registerVolunteer(body) {
  const name = String(body.name || "").trim();
  const phone = String(body.phone || "").trim();
  if (!name || !phone) {
    throw publicError(400, "Name and mobile number are required.");
  }

  const missionId = Number(body.missionId || 0);
  const mission = missionId
    ? db.prepare("SELECT id, title, volunteers, total, status FROM missions WHERE id = ?").get(missionId)
    : null;

  if (mission && (mission.status === "full" || mission.status === "completed" || mission.status === "closed")) {
    throw publicError(409, mission.status === "completed" ? "This activity has already been completed." : mission.status === "closed" ? "This mission is temporarily closed." : "This mission is already full.");
  }

  const dateLabel = displayDate();
  db.prepare(`
    INSERT INTO volunteers (name, phone, email, area, occupation, availability, message, skills_json, mission, date_label, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    phone,
    String(body.email || "").trim(),
    String(body.area || "").trim(),
    String(body.occupation || "").trim(),
    String(body.availability || "").trim(),
    String(body.message || "").trim(),
    JSON.stringify(Array.isArray(body.skills) ? body.skills : []),
    mission ? mission.title : String(body.mission || "").trim(),
    dateLabel,
    isoNow()
  );

  if (mission) {
    const nextVolunteers = Math.min(mission.total, mission.volunteers + 1);
    const nextStatus = nextVolunteers >= mission.total ? "full" : mission.status;
    db.prepare("UPDATE missions SET volunteers = ?, status = ? WHERE id = ?").run(nextVolunteers, nextStatus, mission.id);
  }

  return { ok: true };
}

function subscribeNewsletter(body) {
  const email = String(body.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw publicError(400, "A valid email address is required.");
  }

  const existing = db.prepare("SELECT id FROM newsletter_subscribers WHERE email = ?").get(email);
  if (existing) {
    throw publicError(409, "This email is already subscribed.");
  }

  db.prepare(`
    INSERT INTO newsletter_subscribers (email, date_label, created_at)
    VALUES (?, ?, ?)
  `).run(email, displayDate(), isoNow());

  return { ok: true };
}

function createStory(body) {
  const contributor = String(body.contributor || "").trim();
  const role = String(body.role || "").trim();
  const title = String(body.title || "").trim();
  const story = String(body.story || "").trim();
  const category = String(body.category || "").trim();
  if (!contributor || !role || !title || !story || !category) {
    throw publicError(400, "Story contributor, role, category, title, and story are required.");
  }

  const result = db.prepare(`
    INSERT INTO stories (
      contributor, initials, color, role, title, story, bg, emoji, tags_json, likes, image_url, date_label, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    contributor,
    buildInitials(contributor),
    ["#7C3AED", "#059669", "#DC2626", "#0284C7", "#D97706"][Math.floor(Math.random() * 5)],
    role,
    title,
    story,
    "linear-gradient(135deg,#EAF2FF,#D4E7FF)",
    categoryEmoji(category),
    JSON.stringify([categoryLabel(category), "Citizen Story"]),
    0,
    String(body.imageUrl || ""),
    displayDate(),
    isoNow()
  );

  return { ok: true, id: Number(result.lastInsertRowid) };
}

function addStoryComment(storyId, body) {
  ensureRowExists("stories", storyId, "Story not found.");
  const name = String(body.name || "").trim();
  const text = String(body.text || "").trim();
  if (!name || !text) {
    throw publicError(400, "Comment name and text are required.");
  }
  db.prepare(`
    INSERT INTO story_comments (story_id, name, text, time_label, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(storyId, name, text, "Just now", isoNow());
  return { ok: true };
}

function cheerStory(storyId) {
  ensureRowExists("stories", storyId, "Story not found.");
  db.prepare("UPDATE stories SET likes = likes + 1 WHERE id = ?").run(storyId);
  return { ok: true };
}

function addMissionDiscussion(missionId, body) {
  ensureRowExists("missions", missionId, "Mission not found.");
  const name = String(body.name || "").trim();
  const text = String(body.text || "").trim();
  if (!name || !text) {
    throw publicError(400, "Discussion name and text are required.");
  }
  db.prepare(`
    INSERT INTO mission_discussions (mission_id, name, text, time_label, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(missionId, name, text, "Just now", isoNow());
  return { ok: true };
}

function recordDonation(body) {
  const fundId = Number(body.fundId || 0);
  const amount = Number(body.amount || 0);
  const donorName = String(body.donor || body.donorName || "").trim();
  const donorPhone = String(body.donorPhone || body.phone || "").trim();
  const donorEmail = String(body.donorEmail || body.email || "").trim();
  const preferredMode = String(body.preferredMode || body.paymentMethod || "cash").trim().toLowerCase();
  const paymentMethod = preferredMode;
  const transactionReference = String(body.transactionReference || "").trim();
  if (!fundId || amount <= 0 || !donorName || (!donorPhone && !donorEmail)) {
    throw publicError(400, "Fund, amount, donor name, and at least one contact detail are required.");
  }
  ensureRowExists("funds", fundId, "Fund not found.");
  const status = transactionReference ? "pending" : "lead";
  db.prepare(`
    INSERT INTO donations (
      fund_id, donor_name, donor_phone, donor_email, anonymous, amount, preferred_mode, payment_method, transaction_reference, note, status, date_label, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fundId,
    donorName,
    donorPhone,
    donorEmail,
    body.anonymous ? 1 : 0,
    amount,
    preferredMode,
    paymentMethod,
    transactionReference || `LEAD-${Date.now()}`,
    String(body.note || "").trim(),
    status,
    displayDate(),
    isoNow()
  );
  return { ok: true };
}

function verifyDonation(donationId) {
  const donation = db.prepare("SELECT * FROM donations WHERE id = ?").get(donationId);
  if (!donation) {
    throw publicError(404, "Donation not found.");
  }
  if (donation.status !== "verified") {
    db.prepare("UPDATE donations SET status = 'verified', verified_at = ? WHERE id = ?").run(isoNow(), donationId);
    db.prepare("UPDATE funds SET raised = raised + ?, donors = donors + 1 WHERE id = ?").run(donation.amount, donation.fund_id);
  }
  return { ok: true };
}

function recordSponsor(body) {
  const company = String(body.company || "").trim();
  const contact = String(body.contact || "").trim();
  const phone = String(body.phone || "").trim();
  const email = String(body.email || "").trim();
  const tier = String(body.tier || "").trim();
  if (!company || !contact || !phone || !email || !tier) {
    throw publicError(400, "Sponsor company, contact, phone, email, and tier are required.");
  }

  db.prepare(`
    INSERT INTO sponsors (company, contact, phone, email, tier, message, date_label, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(company, contact, phone, email, tier, String(body.message || "").trim(), displayDate(), isoNow());

  return { ok: true };
}

function createMission(body) {
  const category = String(body.category || "other").trim() || "other";
  const ward = String(body.ward || body.area || "").trim();
  const title = String(body.title || "").trim();
  const desc = String(body.desc || "").trim();
  const date = String(body.date || "").trim();
  const location = String(body.location || "").trim();
  const coordinator = String(body.coordinator || "").trim();
  const duration = String(body.duration || "").trim();
  const total = Number(body.total || 0);
  const nodalDepartment = String(body.nodalDepartment || "").trim();

  if (!category || !ward || !title || !desc || !date || !location || !coordinator || !duration || total <= 0 || !nodalDepartment) {
    throw publicError(400, "All mission fields are required.");
  }

  db.prepare(`
    INSERT INTO missions (
      category, ward, emoji, bg, title, desc, date, location, volunteers, total, status, source_type, approval_status, host_name, host_phone, host_email, nodal_department, is_demo, coordinator, duration, age, impact, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admin', 'approved', '', '', '', ?, 0, ?, ?, ?, ?, ?)
  `).run(
    category,
    ward,
    categoryEmoji(category),
    categoryGradient(category),
    title,
    desc,
    date,
    location,
    0,
    total,
    "open",
    nodalDepartment,
    coordinator,
    duration,
    String(body.age || "16+"),
    String(body.impact || "Just launched"),
    isoNow()
  );

  return { ok: true };
}

function createCommunityMission(body) {
  const category = String(body.category || "other").trim() || "other";
  const ward = String(body.ward || body.area || "").trim();
  const title = String(body.title || "").trim();
  const desc = String(body.desc || "").trim();
  const date = String(body.date || "").trim();
  const location = String(body.location || "").trim();
  const coordinator = String(body.coordinator || body.hostName || "").trim();
  const duration = String(body.duration || "").trim();
  const total = Number(body.total || 0);
  const hostName = String(body.hostName || "").trim();
  const hostPhone = String(body.hostPhone || "").trim();
  const hostEmail = String(body.hostEmail || "").trim();

  if (!ward || !title || !desc || !date || !location || !coordinator || !duration || total <= 0 || !hostName || !hostPhone || !hostEmail) {
    throw publicError(400, "All mission request fields are required, including phone and email.");
  }

  db.prepare(`
    INSERT INTO missions (
      category, ward, emoji, bg, title, desc, date, location, volunteers, total, status, source_type, approval_status, host_name, host_phone, host_email, nodal_department, is_demo, coordinator, duration, age, impact, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'upcoming', 'community', 'pending', ?, ?, ?, '', 0, ?, ?, ?, ?, ?)
  `).run(
    category,
    ward,
    categoryEmoji(category),
    categoryGradient(category),
    title,
    desc,
    date,
    location,
    0,
    total,
    hostName,
    hostPhone,
    hostEmail,
    coordinator,
    duration,
    String(body.age || "16+"),
    String(body.impact || "Awaiting admin review"),
    isoNow()
  );

  return { ok: true };
}

function createAnnouncement(body) {
  const text = String(body.text || "").trim();
  if (!text) {
    throw publicError(400, "Announcement text is required.");
  }
  db.prepare("INSERT INTO announcements (text, created_at) VALUES (?, ?)").run(text, isoNow());
  return { ok: true };
}

function updateMissionStatus(missionId, body) {
  ensureRowExists("missions", missionId, "Mission not found.");
  const status = String(body.status || "").trim();
  const allowed = new Set(["open", "upcoming", "full", "completed", "closed"]);
  if (!allowed.has(status)) {
    throw publicError(400, "Invalid activity status.");
  }
  db.prepare("UPDATE missions SET status = ? WHERE id = ?").run(status, missionId);
  return { ok: true };
}

function reviewMissionRequest(missionId, body) {
  ensureRowExists("missions", missionId, "Mission not found.");
  const approvalStatus = String(body.approvalStatus || "").trim();
  const nodalDepartment = String(body.nodalDepartment || "").trim();
  const status = String(body.status || "open").trim();
  const allowed = new Set(["approved", "rejected"]);
  if (!allowed.has(approvalStatus)) {
    throw publicError(400, "Invalid review action.");
  }
  if (approvalStatus === "approved" && !nodalDepartment) {
    throw publicError(400, "Select a nodal department before approval.");
  }
  db.prepare("UPDATE missions SET approval_status = ?, nodal_department = ?, status = ? WHERE id = ?").run(
    approvalStatus,
    nodalDepartment,
    approvalStatus === "approved" ? status : "upcoming",
    missionId
  );
  return { ok: true };
}

function setPortalDataMode(body) {
  const mode = String(body.mode || "").trim();
  if (!["demo", "real"].includes(mode)) {
    throw publicError(400, "Invalid portal data mode.");
  }
  setSetting("portal_data_mode", mode);
  return { ok: true, mode };
}

function updateMission(missionId, body) {
  ensureRowExists("missions", missionId, "Mission not found.");
  const category = String(body.category || "").trim();
  const ward = String(body.ward || body.area || "").trim();
  const title = String(body.title || "").trim();
  const desc = String(body.desc || "").trim();
  const date = String(body.date || "").trim();
  const location = String(body.location || "").trim();
  const coordinator = String(body.coordinator || "").trim();
  const duration = String(body.duration || "").trim();
  const total = Number(body.total || 0);
  const nodalDepartment = String(body.nodalDepartment || "").trim();
  const status = String(body.status || "open").trim();
  if (!category || !ward || !title || !desc || !date || !location || !coordinator || !duration || total <= 0 || !nodalDepartment) {
    throw publicError(400, "All mission fields are required.");
  }
  db.prepare(`
    UPDATE missions
    SET category = ?, ward = ?, emoji = ?, bg = ?, title = ?, desc = ?, date = ?, location = ?, total = ?, status = ?, nodal_department = ?, coordinator = ?, duration = ?, age = ?, impact = ?, approval_status = 'approved'
    WHERE id = ?
  `).run(
    category,
    ward,
    categoryEmoji(category),
    categoryGradient(category),
    title,
    desc,
    date,
    location,
    total,
    status,
    nodalDepartment,
    coordinator,
    duration,
    String(body.age || "16+"),
    String(body.impact || "Updated"),
    missionId
  );
  return { ok: true };
}

function deleteMission(missionId) {
  ensureRowExists("missions", missionId, "Mission not found.");
  db.prepare("DELETE FROM missions WHERE id = ?").run(missionId);
  return { ok: true };
}

function saveNewsletterDraft(body) {
  const subject = String(body.subject || "").trim();
  const draftBody = String(body.body || "").trim();
  if (!subject || !draftBody) {
    throw publicError(400, "Newsletter subject and body are required.");
  }
  setSetting("newsletter_draft_subject", subject);
  setSetting("newsletter_draft_body", draftBody);
  return { ok: true };
}

function ensureRowExists(table, id, message) {
  const row = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id);
  if (!row) {
    throw publicError(404, message);
  }
  return row;
}

function buildInitials(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("") || "PV";
}

function categoryEmoji(category) {
  return {
    sanitation: "🧹",
    environment: "🌳",
    awareness: "🚦",
    arts: "🎨",
    education: "📚"
  }[category] || "⭐";
}

function categoryLabel(category) {
  return {
    sanitation: "Sanitation",
    environment: "Environment",
    awareness: "Awareness",
    arts: "Arts",
    education: "Education"
  }[category] || category;
}

function categoryGradient(category) {
  return {
    sanitation: "linear-gradient(135deg,#FFF3E0,#FFE0B2)",
    environment: "linear-gradient(135deg,#E8F5E9,#C8E6C9)",
    awareness: "linear-gradient(135deg,#E1F5FE,#B3E5FC)",
    arts: "linear-gradient(135deg,#F3E5F5,#E1BEE7)",
    education: "linear-gradient(135deg,#E3F2FD,#BBDEFB)"
  }[category] || "linear-gradient(135deg,#EEF2F8,#DCE8F7)";
}
