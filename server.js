const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT || 3000);
const APP_ROOT = __dirname;
const DB_DIR = path.join(APP_ROOT, "data");
const DB_PATH = process.env.PRAYAS_DB_PATH || path.join(DB_DIR, "prayas.sqlite");
const INDEX_PATH = path.join(APP_ROOT, "index.html");
const ASSETS_DIR = path.join(APP_ROOT, "assets");
const ADMIN_PASSWORD = process.env.PRAYAS_ADMIN_PASSWORD || "Prayas@2026";
const TOKEN_SECRET = process.env.PRAYAS_TOKEN_SECRET || "replace-this-secret-before-production";
const TOKEN_TTL_MS = 1000 * 60 * 60 * 2; // 2 hours
const DISTRICT_NAME = process.env.PRAYAS_DISTRICT_NAME || "Your District";
const STATE_NAME = process.env.PRAYAS_STATE_NAME || "Your State";
const STATE_ABBR = process.env.PRAYAS_STATE_ABBR || "ST";

// ── Email (Gmail SMTP via nodemailer) ────────────────────────────────────────
// Set PRAYAS_GMAIL_USER and PRAYAS_GMAIL_APP_PASSWORD to enable email features.
// Generate an App Password at: myaccount.google.com → Security → App Passwords
const GMAIL_USER = process.env.PRAYAS_GMAIL_USER || "";
const GMAIL_APP_PASSWORD = process.env.PRAYAS_GMAIL_APP_PASSWORD || "";
const ADMIN_EMAIL = process.env.PRAYAS_ADMIN_EMAIL || GMAIL_USER;

if (!process.env.PRAYAS_ADMIN_PASSWORD) {
  console.warn("[WARN] PRAYAS_ADMIN_PASSWORD is not set — using insecure default. Set this env var before exposing the server publicly.");
}
if (!process.env.PRAYAS_TOKEN_SECRET || process.env.PRAYAS_TOKEN_SECRET === "replace-this-secret-before-production") {
  console.warn("[WARN] PRAYAS_TOKEN_SECRET is not set or is still the placeholder value. Set a strong random secret before exposing the server publicly.");
}

// ── Brute-force protection for admin login ───────────────────────────────────
// Tracks failed attempts per IP. After 5 failures within 15 minutes, the IP is
// locked out for 15 minutes. State is in-memory; clears on server restart.
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const loginAttempts = new Map(); // ip -> { count, windowStart }

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 0, windowStart: now });
    return true; // allowed
  }
  return entry.count < LOGIN_MAX_ATTEMPTS;
}

function recordLoginFailure(ip) {
  const entry = loginAttempts.get(ip);
  if (entry) entry.count += 1;
}

function resetLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

// ── Gamification: points, streaks, civic ranks, badges ───────────────────────

const POINTS = {
  register:          10,
  missionJoin:       25,
  missionCompleted:  50,   // bonus on top of join when mission is marked completed
  milestone5:       100,
  milestone10:      200,
};

const CIVIC_RANKS = [
  { min: 1000, en: "Lok Nayak",    hi: "लोक नायक" },
  { min: 500,  en: "Jan Sewak",    hi: "जन सेवक" },
  { min: 300,  en: "Karyakarta",   hi: "कार्यकर्ता" },
  { min: 150,  en: "Prabhari",     hi: "प्रभारी" },
  { min: 50,   en: "Sevak",        hi: "सेवक" },
  { min: 0,    en: "Nagarik",      hi: "नागरिक" },
];

const CATEGORY_BADGES = [
  { category: "sanitation",     badge: "🧹" },
  { category: "environment",    badge: "🌱" },
  { category: "education",      badge: "📚" },
  { category: "health",         badge: "🏥" },
  { category: "arts",           badge: "🎨" },
  { category: "infrastructure", badge: "🏗️" },
  { category: "awareness",      badge: "📢" },
];

function getCivicRank(points) {
  return CIVIC_RANKS.find((r) => points >= r.min) || CIVIC_RANKS[CIVIC_RANKS.length - 1];
}

// Compute gamification stats for ALL volunteer profiles in two DB queries.
// Returns a Map: profileId -> { points, missionCount, streak, longestStreak, badges, attended }
function computeAllVolunteerStats() {
  const allParticipations = db.prepare(`
    SELECT vp.volunteer_profile_id, vp.created_at, vp.date_label, vp.mission_title, m.status, m.category
    FROM volunteer_participations vp
    LEFT JOIN missions m ON m.id = vp.mission_id
    ORDER BY vp.volunteer_profile_id, vp.created_at ASC
  `).all();

  // Group by profile
  const byProfile = {};
  allParticipations.forEach((row) => {
    const pid = row.volunteer_profile_id;
    if (!byProfile[pid]) byProfile[pid] = [];
    byProfile[pid].push(row);
  });

  const now = new Date();
  const thisYM  = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevYM  = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, "0")}`;

  const statsMap = new Map();

  Object.entries(byProfile).forEach(([pidStr, rows]) => {
    const pid = Number(pidStr);
    const missionCount    = rows.length;
    const completedCount  = rows.filter((r) => r.status === "completed").length;

    // Points
    let points = POINTS.register + missionCount * POINTS.missionJoin + completedCount * POINTS.missionCompleted;
    if (missionCount >= 10) points += POINTS.milestone10;
    else if (missionCount >= 5) points += POINTS.milestone5;

    // Streak — distinct months sorted
    const months = [...new Set(rows.map((r) => r.created_at.slice(0, 7)))].sort();
    let streak = months.length ? 1 : 0;
    let longestStreak = streak;
    for (let i = 1; i < months.length; i++) {
      const [py, pm] = months[i - 1].split("-").map(Number);
      const [cy, cm] = months[i].split("-").map(Number);
      if ((cy - py) * 12 + (cm - pm) === 1) {
        streak++;
        if (streak > longestStreak) longestStreak = streak;
      } else {
        streak = 1;
      }
    }
    const lastYM = months[months.length - 1] || "";
    const currentStreak = (lastYM === thisYM || lastYM === prevYM) ? streak : 0;

    // Category badges
    const catCount = {};
    rows.forEach((r) => { if (r.category) catCount[r.category] = (catCount[r.category] || 0) + 1; });
    const badges = CATEGORY_BADGES.filter((b) => (catCount[b.category] || 0) >= 2).map((b) => b.badge);
    if (missionCount >= 5)  badges.push("🏅");
    if (missionCount >= 10) badges.push("🌟");
    if (currentStreak >= 2) badges.push("🔥");

    // Attended missions — carries its own completion flag and date so the
    // client never has to re-derive "was this one completed?" by fuzzy-
    // matching mission titles against the current missions list (titles can
    // be edited or the mission archived after the volunteer attended it).
    const attended = rows
      .filter((r) => r.mission_title)
      .map((r) => ({
        title: r.mission_title,
        completed: r.status === "completed",
        dateLabel: r.date_label || ""
      }));

    statsMap.set(pid, { points, missionCount, completedCount, currentStreak, longestStreak, badges, attended });
  });

  return statsMap;
}

// Build real leaders from volunteer_profiles + computed stats
const AVATAR_COLORS = ["#7C3AED","#059669","#DC2626","#D97706","#0284C7","#9D174D","#065F46","#92400E","#B45309","#1D4ED8"];

function buildRealLeaders() {
  const profiles = db.prepare("SELECT id, name, area FROM volunteer_profiles").all();
  if (!profiles.length) return [];

  const statsMap = computeAllVolunteerStats();

  const enriched = profiles.map((p, idx) => {
    const stats = statsMap.get(p.id) || { points: POINTS.register, missionCount: 0, completedCount: 0, currentStreak: 0, longestStreak: 0, badges: [], attended: [] };
    const words = p.name.trim().split(/\s+/);
    const initials = words.slice(0, 2).map((w) => w[0]?.toUpperCase() || "").join("") || "?";
    const rank = getCivicRank(stats.points);
    return {
      id: p.id,
      name: p.name,
      area: p.area || "—",
      initials,
      color: AVATAR_COLORS[idx % AVATAR_COLORS.length],
      ...stats,
      civicRankEn: rank.en,
      civicRankHi: rank.hi,
    };
  });

  enriched.sort((a, b) => b.points - a.points || b.missionCount - a.missionCount);

  return enriched.slice(0, 10).map((v, idx) => ({
    id:           v.id,
    name:         v.name,
    area:         v.area,
    initials:     v.initials,
    color:        v.color,
    points:       v.points,
    missions:     v.missionCount,
    rank:         idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : String(idx + 1),
    cls:          idx === 0 ? "gold" : idx === 1 ? "silver" : idx === 2 ? "bronze" : "",
    badges:       v.badges,
    attended:     v.attended,
    completedCount: v.completedCount,
    civicRankEn:  v.civicRankEn,
    civicRankHi:  v.civicRankHi,
    streak:       v.currentStreak,
    longestStreak:v.longestStreak,
  }));
}

// Self-service passport lookup: any registered volunteer can fetch their own
// full stats (not just the top 10 shown on the public leaderboard) by
// confirming the name + phone they registered with.
function getMyPassport(body) {
  const name = String(body.name || "").trim();
  const phone = String(body.phone || "").trim();
  if (!name || !phone) {
    throw publicError(400, "Enter the name and mobile number you registered with.");
  }
  const profile = findVolunteerProfile(name, phone);
  if (!profile) {
    return { found: false };
  }

  const statsMap = computeAllVolunteerStats();
  const stats = statsMap.get(profile.id) || { points: POINTS.register, missionCount: 0, completedCount: 0, currentStreak: 0, longestStreak: 0, badges: [], attended: [] };
  const rank = getCivicRank(stats.points);

  // Rank this volunteer against ALL volunteers by points, not just the top 10.
  const allProfileIds = db.prepare("SELECT id FROM volunteer_profiles").all().map((r) => r.id);
  const totalVolunteers = allProfileIds.length;
  const sortedByPoints = allProfileIds
    .map((id) => ({ id, points: (statsMap.get(id) || { points: POINTS.register }).points }))
    .sort((a, b) => b.points - a.points);
  const position = sortedByPoints.findIndex((row) => row.id === profile.id) + 1;

  const words = profile.name.trim().split(/\s+/);
  const initials = words.slice(0, 2).map((w) => w[0]?.toUpperCase() || "").join("") || "?";

  return {
    found: true,
    leader: {
      id: profile.id,
      name: profile.name,
      area: profile.area || "—",
      phone: profile.phone,
      initials,
      color: AVATAR_COLORS[profile.id % AVATAR_COLORS.length],
      points: stats.points,
      missions: stats.missionCount,
      completedCount: stats.completedCount,
      rank: position === 1 ? "🥇" : position === 2 ? "🥈" : position === 3 ? "🥉" : String(position),
      cls: position === 1 ? "gold" : position === 2 ? "silver" : position === 3 ? "bronze" : "",
      badges: stats.badges,
      attended: stats.attended,
      civicRankEn: rank.en,
      civicRankHi: rank.hi,
      streak: stats.currentStreak,
      longestStreak: stats.longestStreak,
      position,
      totalVolunteers,
      memberSince: profile.first_registered_at || ""
    }
  };
}

// What a certificate/ID-card QR code resolves to. Public by design (mirrors
// what the leaderboard already shows anyone), but never includes the phone
// number — only the self-service passport lookup above does, and only to
// someone who already knows that phone number.
function getPublicVolunteerVerification(profileId) {
  const profile = db.prepare("SELECT id, name, area, first_registered_at FROM volunteer_profiles WHERE id = ?").get(profileId);
  if (!profile) {
    return { valid: false };
  }
  const statsMap = computeAllVolunteerStats();
  const stats = statsMap.get(profile.id) || { points: POINTS.register, missionCount: 0, completedCount: 0 };
  const rank = getCivicRank(stats.points);
  return {
    valid: true,
    name: profile.name,
    area: profile.area || "",
    points: stats.points,
    missions: stats.missionCount,
    completedCount: stats.completedCount,
    civicRankEn: rank.en,
    civicRankHi: rank.hi,
    memberSince: profile.first_registered_at || ""
  };
}

// Ward vs. Ward: aggregate volunteer_profiles by area
function buildWardLeaderboard() {
  return db.prepare(`
    SELECT
      p.area,
      COUNT(DISTINCT p.id)  AS volunteers,
      COUNT(vp.id)          AS participations
    FROM volunteer_profiles p
    LEFT JOIN volunteer_participations vp ON vp.volunteer_profile_id = p.id
    WHERE p.area != ''
    GROUP BY p.area
    ORDER BY participations DESC, volunteers DESC
    LIMIT 20
  `).all().map((r) => ({ area: r.area, volunteers: r.volunteers, participations: r.participations }));
}

// ── Email helpers ─────────────────────────────────────────────────────────────

let _transporter = null;
function getTransporter() {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) return null;
  if (!_transporter) {
    const nodemailer = require("nodemailer");
    _transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }
    });
  }
  return _transporter;
}

async function sendEmail(to, subject, html) {
  const t = getTransporter();
  if (!t) return false;
  try {
    await t.sendMail({ from: `"Prayas Portal" <${GMAIL_USER}>`, to, subject, html });
    return true;
  } catch (err) {
    console.error("[EMAIL] Failed:", to, err.message);
    return false;
  }
}

// Fire-and-forget admin alert — never blocks the HTTP response
function notifyAdmin(subject, html) {
  if (!ADMIN_EMAIL) return;
  sendEmail(ADMIN_EMAIL, subject, adminAlertHtml(subject, html)).catch(() => {});
}

function adminAlertHtml(title, bodyHtml) {
  return `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f4f4f4;padding:20px">
    <div style="background:#1B3A6B;color:#fff;padding:14px 20px;border-radius:8px 8px 0 0">
      <span style="font-size:16px;font-weight:700">Prayas Portal</span>
      <span style="font-size:13px;opacity:.8;margin-left:8px">Admin Alert</span>
    </div>
    <div style="background:#fff;padding:24px;border-radius:0 0 8px 8px;border:1px solid #ddd">
      <h2 style="margin:0 0 16px;color:#1B3A6B;font-size:18px">${title}</h2>
      ${bodyHtml}
    </div>
    <p style="color:#aaa;font-size:11px;text-align:center;margin-top:10px">
      ${DISTRICT_NAME} District Administration · Prayas Citizen Engagement Platform
    </p>
  </div>`;
}

function newsletterEmailHtml(subject, bodyText) {
  const escaped = bodyText
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
  return `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
    <div style="background:#FF9933;padding:20px;text-align:center;border-radius:8px 8px 0 0">
      <h1 style="color:#fff;margin:0;font-size:26px;letter-spacing:1px">प्रयास · Prayas</h1>
      <p style="color:#fff;margin:4px 0 0;font-size:13px;opacity:.9">
        ${DISTRICT_NAME} District · Citizen Engagement Platform
      </p>
    </div>
    <div style="padding:30px;background:#fff;border:1px solid #eee">
      <h2 style="color:#1B3A6B;margin-top:0">${subject}</h2>
      <p style="line-height:1.7;color:#333;font-size:15px">${escaped}</p>
    </div>
    <div style="background:#f9f9f9;padding:16px;text-align:center;font-size:12px;color:#aaa;
                border:1px solid #eee;border-top:none;border-radius:0 0 8px 8px">
      You are receiving this because you subscribed to district updates from Prayas.<br>
      ${DISTRICT_NAME} District Administration
    </div>
  </div>`;
}

async function sendNewsletterToAll(subject, bodyText) {
  const rows = db.prepare("SELECT email FROM newsletter_subscribers ORDER BY id").all();
  const emails = rows.map((r) => r.email).filter(Boolean);
  if (!emails.length) return 0;
  const html = newsletterEmailHtml(subject, bodyText);
  const results = await Promise.allSettled(
    emails.map((email) => sendEmail(email, subject, html))
  );
  return results.filter((r) => r.status === "fulfilled" && r.value === true).length;
}

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

const SERVER_START_TIME = Date.now();

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=NORMAL;
  PRAGMA cache_size=-20000;
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

  CREATE TABLE IF NOT EXISTS volunteer_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    normalized_phone TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    area TEXT NOT NULL DEFAULT '',
    occupation TEXT NOT NULL DEFAULT '',
    availability TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    skills_json TEXT NOT NULL,
    first_registered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_active_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS volunteer_participations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    volunteer_profile_id INTEGER NOT NULL REFERENCES volunteer_profiles(id) ON DELETE CASCADE,
    mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    mission_title TEXT NOT NULL,
    date_label TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(volunteer_profile_id, mission_id)
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

  CREATE TABLE IF NOT EXISTS admin_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL DEFAULT '',
    target_id INTEGER,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS mission_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    volunteer_phone TEXT NOT NULL,
    rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
    comment TEXT NOT NULL DEFAULT '',
    date_label TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(mission_id, volunteer_phone)
  );

  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'coordinator',
    scope_ward TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at TEXT
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
try {
  db.exec("ALTER TABLE missions ADD COLUMN outcome_note TEXT NOT NULL DEFAULT ''");
} catch (error) {}
try {
  db.exec("ALTER TABLE missions ADD COLUMN actual_turnout INTEGER NOT NULL DEFAULT 0");
} catch (error) {}
try {
  db.exec("ALTER TABLE missions ADD COLUMN photo_url TEXT NOT NULL DEFAULT ''");
} catch (error) {}
try {
  db.exec("ALTER TABLE missions ADD COLUMN archived_at TEXT");
} catch (error) {}
try {
  db.exec("ALTER TABLE missions ADD COLUMN check_in_code TEXT NOT NULL DEFAULT ''");
} catch (error) {}
try {
  db.exec("ALTER TABLE volunteer_participations ADD COLUMN attended_at TEXT");
} catch (error) {}
try {
  db.exec("ALTER TABLE missions ADD COLUMN completion_requested INTEGER NOT NULL DEFAULT 0");
} catch (error) {}
try {
  db.exec("ALTER TABLE missions ADD COLUMN completion_requested_by TEXT NOT NULL DEFAULT ''");
} catch (error) {}
try {
  db.exec("ALTER TABLE missions ADD COLUMN completion_requested_note TEXT NOT NULL DEFAULT ''");
} catch (error) {}
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mission_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      photo_data TEXT NOT NULL,
      caption TEXT NOT NULL DEFAULT '',
      uploaded_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
} catch (error) {}

seedDatabase();
migrateLegacyDemoRecords();
migrateVolunteerRegistry();
migrateCheckInCodes();
seedAdminUsers();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (url.pathname === "/health") {
      let dbOk = false;
      try { db.prepare("SELECT 1").get(); dbOk = true; } catch (e) {}
      return sendJson(res, dbOk ? 200 : 503, {
        ok: dbOk,
        dbOk,
        uptimeSeconds: Math.floor((Date.now() - SERVER_START_TIME) / 1000)
      });
    }

    if (req.method === "GET" && url.pathname === "/api/bootstrap") {
      const isAdmin = Boolean(tryGetAdmin(req));
      return sendJson(res, 200, buildBootstrapPayload(isAdmin));
    }

    if (req.method === "POST" && url.pathname === "/api/admin/login") {
      const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
      if (!checkLoginRateLimit(ip)) {
        return sendJson(res, 429, { error: "Too many failed login attempts. Please wait 15 minutes before trying again." });
      }
      const body = await readJsonBody(req);
      const username = String(body.username || "").trim().toLowerCase();
      const provided = String(body.password || "");
      if (!username || !provided) {
        return sendJson(res, 400, { error: "Username and password are required." });
      }
      const user = db.prepare("SELECT * FROM admin_users WHERE username = ?").get(username);
      const match = user && user.active && verifyPassword(provided, user.password_hash, user.password_salt);
      if (!match) {
        recordLoginFailure(ip);
        return sendJson(res, 401, { error: "Invalid username or password." });
      }
      resetLoginAttempts(ip);
      db.prepare("UPDATE admin_users SET last_login_at = ? WHERE id = ?").run(isoNow(), user.id);
      return sendJson(res, 200, { token: createAdminToken(user), user: sanitizeUserRow(user) });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/me") {
      const admin = requireAdmin(req);
      return sendJson(res, 200, { name: admin.name, username: admin.username, role: admin.role, scope: admin.scope || "" });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/users") {
      requireSuperAdmin(req);
      return sendJson(res, 200, { users: listAdminUsers() });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/users") {
      requireSuperAdmin(req);
      const body = await readJsonBody(req);
      return sendJson(res, 200, createAdminUser(body));
    }

    if (req.method === "POST" && /^\/api\/admin\/users\/\d+\/toggle$/.test(url.pathname)) {
      const admin = requireSuperAdmin(req);
      const userId = Number(url.pathname.split("/")[4]);
      return sendJson(res, 200, toggleAdminUser(userId, admin));
    }

    if (req.method === "POST" && /^\/api\/admin\/users\/\d+\/reset-password$/.test(url.pathname)) {
      requireSuperAdmin(req);
      const body = await readJsonBody(req);
      const userId = Number(url.pathname.split("/")[4]);
      return sendJson(res, 200, resetAdminUserPassword(userId, body));
    }

    if (req.method === "POST" && url.pathname === "/api/volunteers") {
      const body = await readJsonBody(req);
      const result = registerVolunteer(body);
      // Fire-and-forget admin notification
      const missionRow = body.missionId
        ? db.prepare("SELECT title FROM missions WHERE id = ?").get(Number(body.missionId))
        : null;
      const missionTitle = missionRow?.title || "";
      notifyAdmin(
        `New volunteer: ${String(body.name || "").trim()}`,
        `<table style="border-collapse:collapse;width:100%;font-size:14px">
          <tr><td style="padding:6px 10px;color:#666;width:120px">Name</td><td style="padding:6px 10px"><strong>${String(body.name || "").trim()}</strong></td></tr>
          <tr style="background:#f9f9f9"><td style="padding:6px 10px;color:#666">Phone</td><td style="padding:6px 10px">${String(body.phone || "").trim()}</td></tr>
          <tr><td style="padding:6px 10px;color:#666">Area</td><td style="padding:6px 10px">${String(body.area || "-").trim()}</td></tr>
          <tr style="background:#f9f9f9"><td style="padding:6px 10px;color:#666">Mission</td><td style="padding:6px 10px">${missionTitle || "General volunteer (no mission selected)"}</td></tr>
          <tr><td style="padding:6px 10px;color:#666">Skills</td><td style="padding:6px 10px">${(Array.isArray(body.skills) ? body.skills : []).join(", ") || "-"}</td></tr>
        </table>`
      );
      return sendJson(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/api/volunteers/lookup") {
      const body = await readJsonBody(req);
      return sendJson(res, 200, lookupVolunteerProfile(body));
    }

    // Self-service passport lookup — lets ANY registered volunteer (not just
    // the top-10 public leaderboard) fetch their own stats to view/download
    // their certificate and ID card. Gated the same lightweight way as the
    // existing lookup: the visitor must know both the registered name AND
    // phone number, which the leaderboard-only path did not require.
    if (req.method === "POST" && url.pathname === "/api/volunteers/passport") {
      const body = await readJsonBody(req);
      return sendJson(res, 200, getMyPassport(body));
    }

    // Public certificate/ID-card verification — what the QR code on a
    // downloaded certificate or ID card resolves to. Deliberately returns
    // only information that is already public via the leaderboard (name,
    // area, points, rank) and never the phone number.
    if (req.method === "GET" && /^\/api\/volunteers\/\d+\/verify$/.test(url.pathname)) {
      const profileId = Number(url.pathname.split("/")[3]);
      return sendJson(res, 200, getPublicVolunteerVerification(profileId));
    }

    if (req.method === "POST" && url.pathname === "/api/community-missions") {
      const body = await readJsonBody(req);
      const result = createCommunityMission(body);
      // Fire-and-forget admin notification
      notifyAdmin(
        `New mission request: ${String(body.title || "").trim()}`,
        `<table style="border-collapse:collapse;width:100%;font-size:14px">
          <tr><td style="padding:6px 10px;color:#666;width:120px">Title</td><td style="padding:6px 10px"><strong>${String(body.title || "").trim()}</strong></td></tr>
          <tr style="background:#f9f9f9"><td style="padding:6px 10px;color:#666">Host</td><td style="padding:6px 10px">${String(body.hostName || "").trim()}</td></tr>
          <tr><td style="padding:6px 10px;color:#666">Phone</td><td style="padding:6px 10px">${String(body.hostPhone || "").trim()}</td></tr>
          <tr style="background:#f9f9f9"><td style="padding:6px 10px;color:#666">Email</td><td style="padding:6px 10px">${String(body.hostEmail || "").trim()}</td></tr>
          <tr><td style="padding:6px 10px;color:#666">Location</td><td style="padding:6px 10px">${String(body.location || "").trim()}, ${String(body.ward || "").trim()}</td></tr>
          <tr style="background:#f9f9f9"><td style="padding:6px 10px;color:#666">Date</td><td style="padding:6px 10px">${String(body.date || "").trim()}</td></tr>
        </table>
        <p style="margin-top:16px;color:#666;font-size:13px">Log in to the admin panel to review and approve or reject this request.</p>`
      );
      return sendJson(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/api/newsletter/subscribe") {
      const body = await readJsonBody(req);
      return sendJson(res, 200, subscribeNewsletter(body));
    }

    if (req.method === "POST" && url.pathname === "/api/stories") {
      const body = await readJsonBody(req);
      const result = createStory(body);
      // Fire-and-forget admin notification
      notifyAdmin(
        `New story submitted: ${String(body.title || "").trim()}`,
        `<table style="border-collapse:collapse;width:100%;font-size:14px">
          <tr><td style="padding:6px 10px;color:#666;width:120px">Title</td><td style="padding:6px 10px"><strong>${String(body.title || "").trim()}</strong></td></tr>
          <tr style="background:#f9f9f9"><td style="padding:6px 10px;color:#666">By</td><td style="padding:6px 10px">${String(body.contributor || "").trim()} · ${String(body.role || "").trim()}</td></tr>
          <tr><td style="padding:6px 10px;color:#666">Category</td><td style="padding:6px 10px">${String(body.category || "").trim()}</td></tr>
        </table>
        <p style="margin-top:16px;color:#666;font-size:13px">Check the Showcase section on the portal to review the story.</p>`
      );
      return sendJson(res, 200, result);
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
      const admin = requireAdmin(req);
      const body = await readJsonBody(req);
      return sendJson(res, 200, createMission(body, admin));
    }

    if (req.method === "POST" && url.pathname === "/api/admin/announcements") {
      requireAdmin(req);
      const body = await readJsonBody(req);
      return sendJson(res, 200, createAnnouncement(body));
    }

    if (req.method === "POST" && /^\/api\/admin\/announcements\/\d+\/update$/.test(url.pathname)) {
      requireAdmin(req);
      const body = await readJsonBody(req);
      const announcementId = Number(url.pathname.split("/")[4]);
      return sendJson(res, 200, updateAnnouncement(announcementId, body));
    }

    if (req.method === "POST" && /^\/api\/admin\/announcements\/\d+\/delete$/.test(url.pathname)) {
      requireAdmin(req);
      const announcementId = Number(url.pathname.split("/")[4]);
      return sendJson(res, 200, deleteAnnouncement(announcementId));
    }

    if (req.method === "POST" && /^\/api\/admin\/missions\/\d+\/status$/.test(url.pathname)) {
      const admin = requireAdmin(req);
      const body = await readJsonBody(req);
      const missionId = Number(url.pathname.split("/")[4]);
      return sendJson(res, 200, updateMissionStatus(missionId, body, admin));
    }

    if (req.method === "POST" && /^\/api\/admin\/missions\/\d+\/review$/.test(url.pathname)) {
      const admin = requireAdmin(req);
      const body = await readJsonBody(req);
      const missionId = Number(url.pathname.split("/")[4]);
      return sendJson(res, 200, reviewMissionRequest(missionId, body, admin));
    }

    if (req.method === "POST" && /^\/api\/admin\/missions\/\d+\/update$/.test(url.pathname)) {
      const admin = requireAdmin(req);
      const body = await readJsonBody(req);
      const missionId = Number(url.pathname.split("/")[4]);
      return sendJson(res, 200, updateMission(missionId, body, admin));
    }

    if (req.method === "POST" && /^\/api\/admin\/missions\/\d+\/delete$/.test(url.pathname)) {
      const admin = requireAdmin(req);
      const missionId = Number(url.pathname.split("/")[4]);
      return sendJson(res, 200, deleteMission(missionId, admin));
    }

    if (req.method === "POST" && url.pathname === "/api/admin/data-mode") {
      requireSuperAdmin(req);
      const body = await readJsonBody(req);
      return sendJson(res, 200, setPortalDataMode(body));
    }

    if (req.method === "POST" && url.pathname === "/api/admin/locations") {
      requireSuperAdmin(req);
      const body = await readJsonBody(req);
      return sendJson(res, 200, saveLocationCatalog(body));
    }

    if (req.method === "POST" && url.pathname === "/api/admin/locations/upload") {
      const admin = requireSuperAdmin(req);
      const body = await readJsonBody(req);
      return sendJson(res, 200, uploadLocationStructure(body, admin));
    }

    if (req.method === "POST" && url.pathname === "/api/admin/locations/clear") {
      const admin = requireSuperAdmin(req);
      return sendJson(res, 200, clearLocationStructure(admin));
    }

    if (req.method === "POST" && url.pathname === "/api/admin/locations/structure") {
      const admin = requireSuperAdmin(req);
      const body = await readJsonBody(req);
      return sendJson(res, 200, updateLocationStructure(body, admin));
    }

    if (req.method === "POST" && url.pathname === "/api/admin/branding") {
      requireSuperAdmin(req);
      const body = await readJsonBody(req);
      return sendJson(res, 200, saveBranding(body));
    }

    if (req.method === "POST" && url.pathname === "/api/admin/departments") {
      requireAdmin(req);
      const body = await readJsonBody(req);
      return sendJson(res, 200, saveDepartmentCatalog(body));
    }

    if (req.method === "POST" && url.pathname === "/api/admin/mission-categories") {
      const admin = requireSuperAdmin(req);
      const body = await readJsonBody(req);
      return sendJson(res, 200, updateMissionCategories(body, admin));
    }

    if (req.method === "POST" && url.pathname === "/api/admin/nodal-departments") {
      const admin = requireSuperAdmin(req);
      const body = await readJsonBody(req);
      return sendJson(res, 200, updateNodalDepartments(body, admin));
    }

    if (req.method === "POST" && url.pathname === "/api/admin/activity-templates") {
      const admin = requireSuperAdmin(req);
      const body = await readJsonBody(req);
      return sendJson(res, 200, updateActivityTemplates(body, admin));
    }

    if (req.method === "POST" && url.pathname === "/api/admin/ticker-speed") {
      const admin = requireSuperAdmin(req);
      const body = await readJsonBody(req);
      return sendJson(res, 200, updateTickerSpeed(body, admin));
    }

    if (req.method === "POST" && url.pathname === "/api/admin/newsletter") {
      requireSuperAdmin(req);
      const body = await readJsonBody(req);
      return sendJson(res, 200, saveNewsletterDraft(body));
    }

    if (req.method === "POST" && url.pathname === "/api/admin/newsletter/send") {
      requireSuperAdmin(req);
      const body = await readJsonBody(req);
      // Save draft first
      saveNewsletterDraft(body);
      if (!getTransporter()) {
        return sendJson(res, 200, { ok: true, sent: 0, emailDisabled: true });
      }
      const sent = await sendNewsletterToAll(
        String(body.subject || "").trim(),
        String(body.body || "").trim()
      );
      return sendJson(res, 200, { ok: true, sent });
    }

    // ── Volunteer search (admin) ──────────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/admin/volunteers/search") {
      requireAdmin(req);
      return sendJson(res, 200, searchVolunteers(url.searchParams));
    }

    if (req.method === "POST" && /^\/api\/admin\/volunteers\/\d+\/update$/.test(url.pathname)) {
      const admin = requireAdmin(req);
      const profileId = Number(url.pathname.split("/")[4]);
      const body = await readJsonBody(req);
      return sendJson(res, 200, updateVolunteerProfileAdmin(profileId, body, admin));
    }

    if (req.method === "POST" && /^\/api\/admin\/volunteers\/\d+\/delete$/.test(url.pathname)) {
      const admin = requireSuperAdmin(req);
      const profileId = Number(url.pathname.split("/")[4]);
      return sendJson(res, 200, deleteVolunteerProfileAdmin(profileId, admin));
    }

    // ── Bulk approve/reject community missions ────────────────────────────────
    if (req.method === "POST" && url.pathname === "/api/admin/community-missions/bulk") {
      const admin = requireAdmin(req);
      const body = await readJsonBody(req);
      return sendJson(res, 200, bulkReviewMissions(body, admin));
    }

    // ── Soft-delete (archive) a mission ──────────────────────────────────────
    if (req.method === "POST" && /^\/api\/admin\/missions\/\d+\/archive$/.test(url.pathname)) {
      const admin = requireAdmin(req);
      const missionId = Number(url.pathname.split("/")[4]);
      return sendJson(res, 200, archiveMission(missionId, admin));
    }

    // ── Restore an archived mission ───────────────────────────────────────────
    if (req.method === "POST" && /^\/api\/admin\/missions\/\d+\/restore$/.test(url.pathname)) {
      const admin = requireAdmin(req);
      const missionId = Number(url.pathname.split("/")[4]);
      return sendJson(res, 200, restoreArchivedMission(missionId, admin));
    }

    // ── Analytics dashboard ───────────────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/admin/analytics") {
      requireAdmin(req);
      return sendJson(res, 200, buildAnalytics());
    }

    // ── Data exports ──────────────────────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/admin/export/missions.csv") {
      requireAdmin(req);
      return sendCsv(res, exportMissionsCsv());
    }
    if (req.method === "GET" && url.pathname === "/api/admin/export/stories.csv") {
      requireAdmin(req);
      return sendCsv(res, exportStoriesCsv());
    }
    if (req.method === "GET" && url.pathname === "/api/admin/export/subscribers.csv") {
      requireAdmin(req);
      return sendCsv(res, exportSubscribersCsv());
    }
    if (req.method === "GET" && url.pathname === "/api/admin/export/location-report.csv") {
      requireAdmin(req);
      return sendCsv(res, buildLocationReportCsv());
    }
    if (req.method === "GET" && url.pathname === "/api/admin/export/audit-log.csv") {
      requireAdmin(req);
      return sendCsv(res, buildAuditLogCsv());
    }

    // ── Admin audit log ───────────────────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/admin/audit-log") {
      requireAdmin(req);
      return sendJson(res, 200, { entries: getAuditLog() });
    }

    // ── Community mission status tracking (citizen) ───────────────────────────
    if (req.method === "GET" && url.pathname === "/api/my-missions") {
      const phone = String(url.searchParams.get("phone") || "").trim();
      return sendJson(res, 200, getMyMissions(phone));
    }

    // ── QR code check-in ──────────────────────────────────────────────────────
    if (req.method === "POST" && url.pathname === "/api/checkin") {
      const body = await readJsonBody(req);
      return sendJson(res, 200, checkInVolunteer(body));
    }

    // ── Post-mission feedback ─────────────────────────────────────────────────
    if (req.method === "POST" && url.pathname === "/api/feedback") {
      const body = await readJsonBody(req);
      return sendJson(res, 200, submitFeedback(body));
    }

    // ── Mission photo gallery ─────────────────────────────────────────────────
    if (req.method === "POST" && /^\/api\/missions\/\d+\/photos$/.test(url.pathname)) {
      const body = await readJsonBody(req);
      const missionId = Number(url.pathname.split("/")[3]);
      return sendJson(res, 200, addMissionPhoto(missionId, body));
    }

    if (req.method === "POST" && /^\/api\/admin\/photos\/\d+\/delete$/.test(url.pathname)) {
      const admin = requireAdmin(req);
      const photoId = Number(url.pathname.split("/")[4]);
      return sendJson(res, 200, deleteMissionPhoto(photoId, admin));
    }

    // ── Citizen-requested mission completion ─────────────────────────────────
    if (req.method === "POST" && /^\/api\/missions\/\d+\/request-completion$/.test(url.pathname)) {
      const body = await readJsonBody(req);
      const missionId = Number(url.pathname.split("/")[3]);
      return sendJson(res, 200, requestMissionCompletion(missionId, body));
    }

    if (req.method === "POST" && /^\/api\/admin\/missions\/\d+\/completion-request\/dismiss$/.test(url.pathname)) {
      const admin = requireAdmin(req);
      const missionId = Number(url.pathname.split("/")[4]);
      return sendJson(res, 200, dismissCompletionRequest(missionId, admin));
    }

    if (req.method === "GET" && /^\/api\/missions\/\d+\/feedback$/.test(url.pathname)) {
      const missionId = Number(url.pathname.split("/")[3]);
      return sendJson(res, 200, { feedback: getMissionFeedback(missionId) });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = fs.readFileSync(INDEX_PATH);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        ...securityHeaders()
      });
      res.end(html);
      return;
    }

    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── Static logo/emblem assets used by the certificate & ID card canvases ──
    // Deliberately narrow: only serves flat filenames (no path traversal) with
    // an allow-listed image extension, straight out of /assets.
    if (req.method === "GET" && /^\/assets\/[A-Za-z0-9][A-Za-z0-9._-]*\.(png|svg)$/.test(url.pathname)) {
      const fileName = path.basename(url.pathname);
      const filePath = path.join(ASSETS_DIR, fileName);
      if (path.dirname(filePath) === ASSETS_DIR && fs.existsSync(filePath)) {
        const ext = path.extname(fileName).toLowerCase();
        res.writeHead(200, {
          "Content-Type": ext === ".svg" ? "image/svg+xml" : "image/png",
          "Cache-Control": "public, max-age=86400",
          ...securityHeaders()
        });
        res.end(fs.readFileSync(filePath));
        return;
      }
    }

    sendJson(res, 404, { error: "Not found." });
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(res, status, { error: error.publicMessage || error.message || "Unexpected server error." });
  }
});

server.listen(PORT, () => {
  console.log(`Prayas portal running on http://localhost:${PORT}`);
  if (ALLOWED_ORIGIN === "*") {
    console.warn("[WARN] PRAYAS_ALLOWED_ORIGIN is not set — CORS allows all origins. Set this env var to your domain before going public.");
  }
});

function gracefulShutdown(signal) {
  console.log(`[${signal}] Closing server gracefully...`);
  server.close(() => {
    console.log("HTTP server closed.");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Set PRAYAS_ALLOWED_ORIGIN to your domain in production (e.g. "https://prayas.example.com").
// Defaults to "*" for local development only.
const ALLOWED_ORIGIN = process.env.PRAYAS_ALLOWED_ORIGIN || "*";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

function securityHeaders() {
  return {
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy":
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; " +
      "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; " +
      "img-src 'self' data: blob: https:; " +
      "connect-src 'self';"
  };
}

function sendCsv(res, csvContent) {
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Cache-Control": "no-cache",
    ...corsHeaders(),
    ...securityHeaders()
  });
  // A leading UTF-8 BOM does two things: it stops Excel from mis-detecting a
  // CSV whose header starts with "ID" as an old SYLK file, and it makes Excel
  // render non-ASCII (Hindi) text correctly instead of as mojibake.
  res.end("﻿" + csvContent);
}

function stripHtml(value) {
  return String(value || "").replace(/<[^>]*>/g, "").trim();
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
    ...corsHeaders(),
    ...securityHeaders()
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2_500_000) {
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

function createAdminToken(user) {
  const payload = {
    uid: user.id,
    name: user.name,
    username: user.username,
    role: user.role,
    scope: user.scope_ward || "",
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
  return verifyAdminToken(token);
}

// Non-throwing check for endpoints (like /api/bootstrap) that serve both the
// public site and the logged-in admin panel from the same handler: returns
// the verified admin payload, or null for anonymous/invalid/expired tokens —
// never throws, so a public visitor with no token just gets null.
function tryGetAdmin(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return null;
  try {
    return verifyAdminToken(token);
  } catch (error) {
    return null;
  }
}

function requireSuperAdmin(req) {
  const admin = requireAdmin(req);
  if (admin.role !== "super_admin") {
    throw publicError(403, "Only the district administrator can do this.");
  }
  return admin;
}

// Coordinators may only act on missions in their own ward/block. Super admins
// (district / CEO Janpad level) are unrestricted.
function assertMissionScope(admin, missionId) {
  if (!admin || admin.role !== "coordinator") return;
  const row = db.prepare("SELECT ward FROM missions WHERE id = ?").get(missionId);
  if (!row) throw publicError(404, "Mission not found.");
  if (String(row.ward || "").trim() !== String(admin.scope || "").trim()) {
    throw publicError(403, "This mission belongs to a different block. You can only manage missions in your own block.");
  }
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

// ── Admin user accounts (district admin + block/ward coordinators) ──────────

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const attempt = crypto.scryptSync(String(password), salt, 64).toString("hex");
  const a = Buffer.from(attempt, "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function seedAdminUsers() {
  const count = db.prepare("SELECT COUNT(*) AS n FROM admin_users").get().n;
  if (count > 0) return;
  const { hash, salt } = hashPassword(ADMIN_PASSWORD);
  db.prepare(`
    INSERT INTO admin_users (name, username, password_hash, password_salt, role, scope_ward, active, created_at)
    VALUES (?, 'admin', ?, ?, 'super_admin', '', 1, ?)
  `).run(`${DISTRICT_NAME} District Admin`, hash, salt, isoNow());
  console.log('[INFO] Seeded default super admin login — username "admin", password is your PRAYAS_ADMIN_PASSWORD value.');
}

function sanitizeUserRow(row) {
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    role: row.role,
    scope: row.scope_ward || "",
    active: Boolean(row.active),
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at || null
  };
}

function listAdminUsers() {
  const rows = db.prepare("SELECT * FROM admin_users ORDER BY role DESC, name ASC").all();
  return rows.map(sanitizeUserRow);
}

function createAdminUser(body) {
  const name = String(body.name || "").trim().slice(0, 100);
  const username = String(body.username || "").trim().toLowerCase().slice(0, 60);
  const password = String(body.password || "");
  const role = body.role === "super_admin" ? "super_admin" : "coordinator";
  const scopeWard = role === "coordinator" ? String(body.scope || "").trim() : "";
  if (!name || !username || !password) {
    throw publicError(400, "Name, username, and password are required.");
  }
  if (!/^[a-z0-9._-]{3,60}$/.test(username)) {
    throw publicError(400, "Username must be 3-60 characters: letters, numbers, dots, dashes, underscores only.");
  }
  if (password.length < 6) {
    throw publicError(400, "Password must be at least 6 characters.");
  }
  if (role === "coordinator" && !scopeWard) {
    throw publicError(400, "Select the ward/block this coordinator is responsible for.");
  }
  const existing = db.prepare("SELECT id FROM admin_users WHERE username = ?").get(username);
  if (existing) {
    throw publicError(409, "That username is already taken.");
  }
  const { hash, salt } = hashPassword(password);
  db.prepare(`
    INSERT INTO admin_users (name, username, password_hash, password_salt, role, scope_ward, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
  `).run(name, username, hash, salt, role, scopeWard, isoNow());
  const newId = Number(db.prepare("SELECT last_insert_rowid() AS id").get().id);
  writeAuditLog("create_user", "admin_user", newId, `Login created for ${name} (${username}) — ${role}${scopeWard ? ", " + scopeWard : ""}`);
  return { ok: true, id: newId };
}

function toggleAdminUser(userId, admin) {
  const row = db.prepare("SELECT * FROM admin_users WHERE id = ?").get(userId);
  if (!row) throw publicError(404, "Login not found.");
  if (row.username === "admin" || row.id === admin.uid) {
    throw publicError(400, "You can't deactivate the primary admin login or your own account.");
  }
  const nextActive = row.active ? 0 : 1;
  db.prepare("UPDATE admin_users SET active = ? WHERE id = ?").run(nextActive, userId);
  writeAuditLog(nextActive ? "activate_user" : "deactivate_user", "admin_user", userId, `${row.name} (${row.username}) ${nextActive ? "activated" : "deactivated"}`);
  return { ok: true, active: Boolean(nextActive) };
}

function resetAdminUserPassword(userId, body) {
  const row = db.prepare("SELECT * FROM admin_users WHERE id = ?").get(userId);
  if (!row) throw publicError(404, "Login not found.");
  const password = String(body.password || "");
  if (password.length < 6) {
    throw publicError(400, "Password must be at least 6 characters.");
  }
  const { hash, salt } = hashPassword(password);
  db.prepare("UPDATE admin_users SET password_hash = ?, password_salt = ? WHERE id = ?").run(hash, salt, userId);
  writeAuditLog("reset_password", "admin_user", userId, `Password reset for ${row.name} (${row.username})`);
  return { ok: true };
}

function signValue(value) {
  return crypto.createHmac("sha256", TOKEN_SECRET).update(value).digest("base64url");
}

function base64Url(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function buildBootstrapPayload(isAdmin = false) {
  const dataMode = getSetting("portal_data_mode", "demo") === "real" ? "real" : "demo";
  const demoFlag = dataMode === "demo" ? 1 : 0;
  const locations = safeJsonArray(getSetting("location_catalog_json", "[]"));
  const departments = safeJsonArray(getSetting("department_catalog_json", "[]"));
  const announcementRows = db.prepare("SELECT id, text FROM announcements WHERE is_demo = ? ORDER BY id DESC").all(demoFlag);
  const missionRows = db.prepare("SELECT * FROM missions WHERE is_demo = ? AND archived_at IS NULL ORDER BY id DESC").all(demoFlag);
  const discussionStmt = db.prepare("SELECT name, text, time_label FROM mission_discussions WHERE mission_id = ? ORDER BY id DESC");
  const photoStmt = db.prepare("SELECT id, photo_data, caption, uploaded_by, created_at FROM mission_photos WHERE mission_id = ? ORDER BY id ASC");
  const fundRows = [];
  const storyRows = db.prepare("SELECT * FROM stories WHERE is_demo = ? ORDER BY id DESC").all(demoFlag);
  const storyCommentStmt = db.prepare("SELECT name, text, time_label FROM story_comments WHERE story_id = ? ORDER BY id ASC");
  const leaderRows = db.prepare("SELECT * FROM leaders WHERE is_demo = ? ORDER BY points DESC, id ASC").all(demoFlag);
  const volunteerProfileRows = db.prepare("SELECT * FROM volunteer_profiles ORDER BY last_active_at DESC, id DESC").all();
  const volunteerParticipationRows = db.prepare(`
    SELECT vp.id, vp.mission_id, vp.mission_title, vp.date_label, vp.created_at, p.name, p.phone, p.area
    FROM volunteer_participations vp
    JOIN volunteer_profiles p ON p.id = vp.volunteer_profile_id
    ORDER BY vp.created_at DESC, vp.id DESC
  `).all();
  const sponsorRows = [];
  const donationRows = [];
  const subscriberRows = db.prepare("SELECT email, date_label FROM newsletter_subscribers ORDER BY id DESC").all();

  // Real volunteers who actually joined each mission — used to show genuine
  // participant initials on the public mission card instead of fabricated
  // placeholder avatars. Only real registrations produce rows here; demo/seed
  // missions have none, so their cards simply show no avatars.
  const participantsByMission = new Map();
  db.prepare(`
    SELECT vp.mission_id, p.id AS profile_id, p.name
    FROM volunteer_participations vp
    JOIN volunteer_profiles p ON p.id = vp.volunteer_profile_id
    ORDER BY vp.created_at DESC, vp.id DESC
  `).all().forEach((row) => {
    const list = participantsByMission.get(row.mission_id) || [];
    if (list.length < 5) {
      list.push({
        initials: buildInitials(row.name),
        color: AVATAR_COLORS[row.profile_id % AVATAR_COLORS.length]
      });
      participantsByMission.set(row.mission_id, list);
    }
  });

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
    outcomeNote: mission.outcome_note || "",
    actualTurnout: mission.actual_turnout || 0,
    photoUrl: mission.photo_url || "",
    // The real check-in code is only meaningful when read out at the venue —
    // shipping it to every anonymous /api/bootstrap caller would let anyone
    // "check in" remotely from the public website. Only a verified admin
    // request (the logged-in admin panel, which calls this same endpoint)
    // gets the real value; everyone else gets "".
    checkInCode: isAdmin ? (mission.check_in_code || "") : "",
    completionRequested: Boolean(mission.completion_requested),
    completionRequestedBy: mission.completion_requested_by || "",
    completionRequestedNote: mission.completion_requested_note || "",
    participantsPreview: participantsByMission.get(mission.id) || [],
    discussion: discussionStmt.all(mission.id).map((entry) => ({
      name: entry.name,
      text: entry.text,
      time: entry.time_label
    })),
    photos: photoStmt.all(mission.id).map((photo) => ({
      id: photo.id,
      dataUrl: photo.photo_data,
      caption: photo.caption,
      uploadedBy: photo.uploaded_by,
      createdAt: photo.created_at
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

  // In real mode, compute leaders dynamically from volunteer data.
  // In demo mode (or when no real volunteers exist), fall back to seed records.
  const realVolunteerCount = db.prepare("SELECT COUNT(*) as n FROM volunteer_profiles").get().n;
  const leaders = (dataMode === "real" && realVolunteerCount > 0)
    ? buildRealLeaders()
    : leaderRows.map((leader) => {
        // Demo/seed leaders only ever stored plain title strings with no
        // completion tracking of their own. Normalize to the same
        // { title, completed, dateLabel } shape real leaders use, so the
        // client never has to special-case demo vs. real data. Since these
        // are showcase records with no underlying mission link, every
        // listed activity is treated as completed.
        const attended = safeJsonArray(leader.attended_json).map((title) => ({
          title,
          completed: true,
          dateLabel: ""
        }));
        return {
          id: leader.id,
          name: leader.name,
          area: leader.area,
          initials: leader.initials,
          color: leader.color,
          points: leader.points,
          missions: leader.missions,
          completedCount: attended.length,
          rank: leader.rank_label,
          cls: leader.cls,
          badges: safeJsonArray(leader.badges_json),
          attended,
          civicRankEn: getCivicRank(leader.points).en,
          civicRankHi: getCivicRank(leader.points).hi,
          streak: 0,
          longestStreak: 0,
        };
      });

  const wardLeaderboard = buildWardLeaderboard();

  const volunteerStatsMap = computeAllVolunteerStats();
  const volunteers = volunteerProfileRows.map((volunteer) => ({
    id: volunteer.id,
    name: volunteer.name,
    phone: volunteer.phone,
    email: volunteer.email,
    area: volunteer.area,
    occupation: volunteer.occupation,
    availability: volunteer.availability,
    message: volunteer.message,
    skills: safeJsonArray(volunteer.skills_json),
    mission: "",
    points: volunteerStatsMap.get(volunteer.id)?.points || POINTS.register,
    date: new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "long", year: "numeric" }).format(new Date(volunteer.last_active_at || volunteer.first_registered_at || new Date()))
  }));

  const volunteerEvents = volunteerParticipationRows.map((entry) => ({
    id: entry.id,
    name: entry.name,
    phone: entry.phone,
    area: entry.area || "",
    mission: entry.mission_title,
    date: entry.date_label
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
    districtName: DISTRICT_NAME,
    stateName: STATE_NAME,
    stateAbbr: STATE_ABBR,
    siteBadgeEn: getSetting("site_badge_en", ""),
    siteBadgeHi: getSetting("site_badge_hi", ""),
    locations,
    locationStructure: safeJsonObject(getSetting("location_structure_json", ""), { blocks: [], municipalBodies: [] }),
    departments,
    missionCategories: safeJsonArrayOr(getSetting("mission_categories_json", ""), DEFAULT_MISSION_CATEGORIES),
    nodalDepartmentsList: safeJsonArrayOr(getSetting("nodal_departments_json", ""), DEFAULT_NODAL_DEPARTMENTS),
    activityTemplatesList: safeJsonArrayOr(getSetting("activity_templates_json", ""), DEFAULT_ACTIVITY_TEMPLATES),
    tickerSpeedSeconds: Math.max(8, Math.min(120, Number(getSetting("ticker_speed_seconds", "18")) || 18)),
    announcements: announcementRows.map((row) => row.text),
    announcementRecords: announcementRows.map((row) => ({ id: row.id, text: row.text })),
    missions,
    funds,
    stories,
    leaders,
    wardLeaderboard,
    volunteers,
    volunteerEvents,
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

function safeJsonObject(value, fallback) {
  try {
    const parsed = JSON.parse(value || "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch (error) {
    return fallback;
  }
}

function safeJsonArrayOr(value, fallback) {
  const parsed = safeJsonArray(value);
  return parsed.length ? parsed : fallback;
}

const DEFAULT_MISSION_CATEGORIES = [
  { key: "sanitation", en: "Sanitation", hi: "स्वच्छता", emoji: "🧹", dot: "#F97316" },
  { key: "environment", en: "Environment", hi: "पर्यावरण", emoji: "🌳", dot: "#16A34A" },
  { key: "awareness", en: "Awareness", hi: "जागरूकता", emoji: "🚦", dot: "#0284C7" },
  { key: "arts", en: "Arts & Culture", hi: "कला व संस्कृति", emoji: "🎨", dot: "#9333EA" },
  { key: "education", en: "Education", hi: "शिक्षा", emoji: "📚", dot: "#2563EB" },
  { key: "health", en: "Health", hi: "स्वास्थ्य", emoji: "🏥", dot: "#DC2626" },
  { key: "sports", en: "Sports", hi: "खेल", emoji: "🏅", dot: "#0F766E" },
  { key: "welfare", en: "Social Welfare", hi: "सामाजिक कल्याण", emoji: "🤝", dot: "#7C3AED" },
  { key: "heritage", en: "Heritage", hi: "विरासत", emoji: "🏛️", dot: "#92400E" },
  { key: "digital", en: "Digital Inclusion", hi: "डिजिटल समावेशन", emoji: "💻", dot: "#1D4ED8" },
  { key: "youth", en: "Youth Engagement", hi: "युवा सहभागिता", emoji: "⚡", dot: "#DB2777" },
  { key: "governance", en: "Public Governance", hi: "जन शासन", emoji: "📋", dot: "#475569" },
  { key: "other", en: "Other / Custom", hi: "अन्य / कस्टम", emoji: "✨", dot: "#64748B" }
];

const DEFAULT_NODAL_DEPARTMENTS = [
  { en: "Municipal Administration", hi: "नगर प्रशासन" },
  { en: "Rural Development", hi: "ग्रामीण विकास" },
  { en: "Education Department", hi: "शिक्षा विभाग" },
  { en: "Health Department", hi: "स्वास्थ्य विभाग" },
  { en: "Women and Child Development", hi: "महिला एवं बाल विकास" },
  { en: "Forest Department", hi: "वन विभाग" },
  { en: "Police / Traffic", hi: "पुलिस / यातायात" },
  { en: "Youth Affairs and Sports", hi: "युवा एवं खेल" },
  { en: "Other", hi: "अन्य" }
];

const DEFAULT_ACTIVITY_TEMPLATES = [
  { key: "sanitation-drive", labelEn: "Sanitation Drive", labelHi: "स्वच्छता अभियान", category: "sanitation", titleEn: "Sanitation Drive", titleHi: "स्वच्छता अभियान", duration: "3 hours", slots: 60, impactEn: "Cleaner public spaces and higher citizen participation", impactHi: "स्वच्छ सार्वजनिक स्थान और अधिक नागरिक भागीदारी", descriptionEn: "Mobilise citizens for cleanliness, waste segregation, sweeping, and public-space restoration with local support teams.", descriptionHi: "नागरिकों को स्वच्छता, कचरा पृथक्करण, सफाई और सार्वजनिक स्थान सुधार के लिए स्थानीय टीमों के साथ जोड़ें।" },
  { key: "blood-donation", labelEn: "Blood Donation Drive", labelHi: "रक्तदान शिविर", category: "awareness", titleEn: "Blood Donation Drive", titleHi: "रक्तदान शिविर", duration: "4 hours", slots: 80, impactEn: "Improved emergency blood availability", impactHi: "आपातकालीन रक्त उपलब्धता में सुधार", descriptionEn: "Coordinate hospitals, blood banks, donor registration, awareness messaging, and volunteer support for a structured blood donation camp.", descriptionHi: "रक्तदान शिविर के लिए अस्पताल, ब्लड बैंक, दाता पंजीकरण, जागरूकता संदेश और स्वयंसेवी सहायता का समन्वय करें।" },
  { key: "wall-painting", labelEn: "Wall Painting / Public Art", labelHi: "वॉल पेंटिंग / सार्वजनिक कला", category: "arts", titleEn: "Wall Painting Drive", titleHi: "वॉल पेंटिंग अभियान", duration: "1 full day", slots: 50, impactEn: "Beautified public areas and civic messaging", impactHi: "सार्वजनिक क्षेत्रों का सौंदर्यीकरण और नागरिक संदेश", descriptionEn: "Organise artists, students, paint logistics, design approvals, and theme-based public murals for civic engagement.", descriptionHi: "नागरिक सहभागिता के लिए कलाकारों, छात्रों, पेंट सामग्री, डिज़ाइन अनुमोदन और थीम-आधारित भित्ति चित्रों का आयोजन करें।" },
  { key: "awareness-drive", labelEn: "Awareness Drive / Rally", labelHi: "जागरूकता अभियान / रैली", category: "awareness", titleEn: "Awareness Drive", titleHi: "जागरूकता अभियान", duration: "2.5 hours", slots: 100, impactEn: "Higher citizen awareness and visibility", impactHi: "अधिक नागरिक जागरूकता और दृश्यता", descriptionEn: "Plan route, marshals, messaging material, public announcements, and institution participation for a focused awareness drive.", descriptionHi: "एक केंद्रित जागरूकता अभियान के लिए मार्ग, मार्शल, संदेश सामग्री, सार्वजनिक घोषणाएँ और संस्थागत भागीदारी की योजना बनाएं।" },
  { key: "tree-plantation", labelEn: "Tree Plantation Drive", labelHi: "वृक्षारोपण अभियान", category: "environment", titleEn: "Tree Plantation Drive", titleHi: "वृक्षारोपण अभियान", duration: "Half day", slots: 120, impactEn: "Improved green cover and long-term stewardship", impactHi: "हरित आवरण में सुधार और दीर्घकालिक संरक्षण", descriptionEn: "Coordinate saplings, pit preparation, watering teams, school participation, and survival tracking for plantation sites.", descriptionHi: "वृक्षारोपण स्थलों के लिए पौधे, गड्ढा तैयारी, सिंचाई टीम, स्कूल भागीदारी और संरक्षण ट्रैकिंग का समन्वय करें।" },
  { key: "teaching-camp", labelEn: "Teaching / Learning Camp", labelHi: "शिक्षण / अध्ययन शिविर", category: "education", titleEn: "Teaching Support Camp", titleHi: "शिक्षण सहायता शिविर", duration: "2 hours", slots: 30, impactEn: "Improved learner attendance and support", impactHi: "सीखने वालों की उपस्थिति और सहायता में सुधार", descriptionEn: "Bring volunteers together for teaching support, reading sessions, remedial help, and activity-based learning.", descriptionHi: "स्वयंसेवकों को शिक्षण सहायता, पठन सत्र, सुधारात्मक मदद और गतिविधि-आधारित सीखने के लिए साथ लाएं।" },
  { key: "health-camp", labelEn: "Health Camp", labelHi: "स्वास्थ्य शिविर", category: "awareness", titleEn: "Community Health Camp", titleHi: "सामुदायिक स्वास्थ्य शिविर", duration: "5 hours", slots: 45, impactEn: "Improved public health outreach and screening", impactHi: "सार्वजनिक स्वास्थ्य पहुंच और स्क्रीनिंग में सुधार", descriptionEn: "Support registrations, patient queues, awareness desks, follow-up coordination, and local medical partners for a health camp.", descriptionHi: "स्वास्थ्य शिविर के लिए पंजीकरण, कतार प्रबंधन, जागरूकता डेस्क, फॉलो-अप समन्वय और चिकित्सा साझेदारों को समर्थन दें।" },
  { key: "sports-event", labelEn: "Sports for Youth", labelHi: "युवा खेल कार्यक्रम", category: "awareness", titleEn: "Community Sports Event", titleHi: "सामुदायिक खेल कार्यक्रम", duration: "4 hours", slots: 60, impactEn: "Youth engagement and fitness", impactHi: "युवा जुड़ाव और फिटनेस", descriptionEn: "Organise neighbourhood sports events to engage youth and promote teamwork.", descriptionHi: "युवाओं को जोड़ने और टीम भावना बढ़ाने के लिए खेल कार्यक्रम आयोजित करें।" },
  { key: "nutrition-drive", labelEn: "Nutrition Awareness", labelHi: "पोषण जागरूकता", category: "awareness", titleEn: "Nutrition Awareness Drive", titleHi: "पोषण जागरूकता अभियान", duration: "3 hours", slots: 45, impactEn: "Improved maternal and child health awareness", impactHi: "मातृ एवं बाल स्वास्थ्य जागरूकता में सुधार", descriptionEn: "Run outreach on nutrition, anemia prevention, and healthy household practices.", descriptionHi: "पोषण, एनीमिया रोकथाम और स्वस्थ घरेलू आदतों पर अभियान चलाएँ।" },
  { key: "career-guidance", labelEn: "Career Guidance Camp", labelHi: "कैरियर मार्गदर्शन शिविर", category: "education", titleEn: "Career Guidance Camp", titleHi: "कैरियर मार्गदर्शन शिविर", duration: "2 hours", slots: 40, impactEn: "Better career awareness for students", impactHi: "छात्रों में बेहतर कैरियर जागरूकता", descriptionEn: "Invite mentors and professionals to guide students on opportunities and exams.", descriptionHi: "मेंटर्स और पेशेवरों को बुलाकर छात्रों को अवसरों और परीक्षाओं पर मार्गदर्शन दें।" },
  { key: "library-drive", labelEn: "Library Setup Drive", labelHi: "पुस्तकालय स्थापना अभियान", category: "education", titleEn: "Library Setup Drive", titleHi: "पुस्तकालय स्थापना अभियान", duration: "1 day", slots: 35, impactEn: "Improved access to books and reading spaces", impactHi: "पुस्तकों और पठन स्थानों तक बेहतर पहुंच", descriptionEn: "Set up or refresh a school or community library with volunteers and book donors.", descriptionHi: "स्वयंसेवकों और पुस्तक दाताओं के साथ स्कूल या समुदाय पुस्तकालय तैयार करें।" },
  { key: "plastic-free", labelEn: "Plastic-Free Campaign", labelHi: "प्लास्टिक मुक्त अभियान", category: "environment", titleEn: "Plastic-Free Campaign", titleHi: "प्लास्टिक मुक्त अभियान", duration: "3 hours", slots: 55, impactEn: "Cleaner public spaces and reduced plastic use", impactHi: "स्वच्छ सार्वजनिक स्थान और कम प्लास्टिक उपयोग", descriptionEn: "Conduct awareness and collection drives to reduce single-use plastic.", descriptionHi: "सिंगल-यूज प्लास्टिक कम करने के लिए जागरूकता और संग्रह अभियान चलाएँ।" },
  { key: "waterbody-cleanup", labelEn: "Water Body Cleanup", labelHi: "जलाशय सफाई अभियान", category: "environment", titleEn: "Water Body Cleanup", titleHi: "जलाशय सफाई अभियान", duration: "Half day", slots: 70, impactEn: "Cleaner ponds, lakes, and river edges", impactHi: "तालाब, झील और नदी किनारे अधिक स्वच्छ", descriptionEn: "Mobilise citizens to clean local water bodies and surrounding zones.", descriptionHi: "स्थानीय जलाशयों और आसपास के क्षेत्रों की सफाई के लिए नागरिकों को जोड़ें।" },
  { key: "public-hearing-support", labelEn: "Public Hearing Support", labelHi: "जन-सुनवाई सहायता", category: "awareness", titleEn: "Public Hearing Support Desk", titleHi: "जन-सुनवाई सहायता डेस्क", duration: "5 hours", slots: 20, impactEn: "Better grievance support and citizen guidance", impactHi: "शिकायत सहायता और नागरिक मार्गदर्शन में सुधार", descriptionEn: "Support queues, guidance desks, and documentation help during grievance camps.", descriptionHi: "शिकायत शिविरों के दौरान कतार, मार्गदर्शन और दस्तावेज़ सहायता दें।" },
  { key: "digital-literacy", labelEn: "Digital Literacy Camp", labelHi: "डिजिटल साक्षरता शिविर", category: "education", titleEn: "Digital Literacy Camp", titleHi: "डिजिटल साक्षरता शिविर", duration: "3 hours", slots: 30, impactEn: "Better citizen access to digital services", impactHi: "डिजिटल सेवाओं तक नागरिक पहुंच में सुधार", descriptionEn: "Teach basic smartphone, internet, and digital service usage to citizens.", descriptionHi: "नागरिकों को स्मार्टफोन, इंटरनेट और डिजिटल सेवाओं का मूल उपयोग सिखाएँ।" },
  { key: "women-safety", labelEn: "Women Safety Outreach", labelHi: "महिला सुरक्षा अभियान", category: "awareness", titleEn: "Women Safety Outreach", titleHi: "महिला सुरक्षा अभियान", duration: "2.5 hours", slots: 35, impactEn: "Safer public spaces and reporting awareness", impactHi: "अधिक सुरक्षित सार्वजनिक स्थान और रिपोर्टिंग जागरूकता", descriptionEn: "Run outreach on safety helplines, safe travel, and reporting support.", descriptionHi: "सुरक्षा हेल्पलाइन, सुरक्षित आवागमन और रिपोर्टिंग सहायता पर अभियान चलाएँ।" },
  { key: "heritage-walk", labelEn: "Heritage Walk", labelHi: "विरासत भ्रमण", category: "arts", titleEn: "Heritage Walk", titleHi: "विरासत भ्रमण", duration: "2 hours", slots: 50, impactEn: "Better heritage awareness and local pride", impactHi: "विरासत जागरूकता और स्थानीय गौरव में सुधार", descriptionEn: "Organise guided community walks around important heritage or cultural sites.", descriptionHi: "महत्वपूर्ण विरासत या सांस्कृतिक स्थलों पर समुदाय भ्रमण आयोजित करें।" },
  { key: "street-theatre", labelEn: "Street Theatre Campaign", labelHi: "नुक्कड़ नाटक अभियान", category: "arts", titleEn: "Street Theatre Campaign", titleHi: "नुक्कड़ नाटक अभियान", duration: "3 hours", slots: 25, impactEn: "Better awareness through creative public messaging", impactHi: "रचनात्मक सार्वजनिक संदेश से अधिक जागरूकता", descriptionEn: "Use theatre to raise awareness on health, sanitation, voting, or safety.", descriptionHi: "स्वास्थ्य, स्वच्छता, मतदान या सुरक्षा पर जागरूकता के लिए नाटक का उपयोग करें।" },
  { key: "school-repair", labelEn: "School Repair Day", labelHi: "स्कूल मरम्मत दिवस", category: "sanitation", titleEn: "School Repair Day", titleHi: "स्कूल मरम्मत दिवस", duration: "1 day", slots: 40, impactEn: "Improved school infrastructure", impactHi: "स्कूल अवसंरचना में सुधार", descriptionEn: "Coordinate small repair and painting activities in public schools.", descriptionHi: "सरकारी स्कूलों में छोटी मरम्मत और पेंटिंग गतिविधियों का समन्वय करें।" },
  { key: "traffic-awareness", labelEn: "Traffic Awareness Drive", labelHi: "यातायात जागरूकता अभियान", category: "awareness", titleEn: "Traffic Awareness Drive", titleHi: "यातायात जागरूकता अभियान", duration: "2 hours", slots: 50, impactEn: "Safer junction behavior", impactHi: "अधिक सुरक्षित यातायात व्यवहार", descriptionEn: "Run junction awareness activities for helmet, seatbelt, and lane discipline.", descriptionHi: "हेलमेट, सीटबेल्ट और लेन अनुशासन पर जागरूकता अभियान चलाएँ।" },
  { key: "waste-segregation", labelEn: "Waste Segregation Drive", labelHi: "कचरा पृथक्करण अभियान", category: "sanitation", titleEn: "Waste Segregation Drive", titleHi: "कचरा पृथक्करण अभियान", duration: "3 hours", slots: 45, impactEn: "Better waste sorting and cleaner neighbourhoods", impactHi: "बेहतर कचरा पृथक्करण और स्वच्छ मोहल्ले", descriptionEn: "Train households and market areas on dry-wet waste segregation practices.", descriptionHi: "घरों और बाजार क्षेत्रों को सूखा-गीला कचरा पृथक्करण सिखाएँ।" }
];

function slugify(text, fallbackPrefix) {
  const base = String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return base || `${fallbackPrefix}-${Date.now()}`;
}

function sanitizeMissionCategories(input) {
  const list = Array.isArray(input?.categories) ? input.categories : [];
  const seenKeys = new Set();
  const cleaned = [];
  list.forEach((item) => {
    const en = String(item?.en || "").trim().slice(0, 60);
    if (!en) return;
    let key = String(item?.key || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "") || slugify(en, "category");
    while (seenKeys.has(key)) key = `${key}-2`;
    seenKeys.add(key);
    cleaned.push({
      key,
      en,
      hi: String(item?.hi || "").trim().slice(0, 60) || en,
      emoji: String(item?.emoji || "").trim().slice(0, 8) || "⭐",
      dot: /^#[0-9A-Fa-f]{3,8}$/.test(String(item?.dot || "")) ? item.dot : "#64748B"
    });
  });
  if (!cleaned.length) {
    throw publicError(400, "Keep at least one mission category — add a new one before removing the last.");
  }
  return cleaned;
}

function sanitizeNodalDepartments(input) {
  const list = Array.isArray(input?.departments) ? input.departments : [];
  const seenEn = new Set();
  const cleaned = [];
  list.forEach((item) => {
    const en = String(item?.en || "").trim().slice(0, 100);
    if (!en || seenEn.has(en.toLowerCase())) return;
    seenEn.add(en.toLowerCase());
    cleaned.push({ en, hi: String(item?.hi || "").trim().slice(0, 100) || en });
  });
  if (!cleaned.length) {
    throw publicError(400, "Keep at least one nodal department — add a new one before removing the last.");
  }
  return cleaned;
}

function sanitizeActivityTemplates(input) {
  const list = Array.isArray(input?.templates) ? input.templates : [];
  const seenKeys = new Set();
  const cleaned = [];
  list.forEach((item) => {
    const labelEn = String(item?.labelEn || "").trim().slice(0, 100);
    if (!labelEn) return;
    let key = String(item?.key || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "") || slugify(labelEn, "template");
    while (seenKeys.has(key)) key = `${key}-2`;
    seenKeys.add(key);
    cleaned.push({
      key,
      labelEn,
      labelHi: String(item?.labelHi || "").trim().slice(0, 100) || labelEn,
      category: String(item?.category || "other").trim().slice(0, 40) || "other",
      titleEn: String(item?.titleEn || "").trim().slice(0, 100) || labelEn,
      titleHi: String(item?.titleHi || "").trim().slice(0, 100) || (String(item?.labelHi || "").trim() || labelEn),
      duration: String(item?.duration || "").trim().slice(0, 40) || "2 hours",
      slots: Math.max(1, Math.min(10000, Number(item?.slots) || 50)),
      impactEn: String(item?.impactEn || "").trim().slice(0, 200),
      impactHi: String(item?.impactHi || "").trim().slice(0, 200),
      descriptionEn: String(item?.descriptionEn || "").trim().slice(0, 500),
      descriptionHi: String(item?.descriptionHi || "").trim().slice(0, 500)
    });
  });
  if (!cleaned.length) {
    throw publicError(400, "Keep at least one activity template — add a new one before removing the last.");
  }
  return cleaned;
}

function persistMissionCategories(list, admin) {
  setSetting("mission_categories_json", JSON.stringify(list));
  writeAuditLog("update_mission_categories", "settings", null, `Mission categories updated (${list.length} categories) by ${admin?.username || "admin"}.`);
  return { ok: true, count: list.length, categories: list };
}

function persistNodalDepartments(list, admin) {
  setSetting("nodal_departments_json", JSON.stringify(list));
  writeAuditLog("update_nodal_departments", "settings", null, `Nodal departments updated (${list.length} departments) by ${admin?.username || "admin"}.`);
  return { ok: true, count: list.length, departments: list };
}

function persistActivityTemplates(list, admin) {
  setSetting("activity_templates_json", JSON.stringify(list));
  writeAuditLog("update_activity_templates", "settings", null, `Activity templates updated (${list.length} templates) by ${admin?.username || "admin"}.`);
  return { ok: true, count: list.length, templates: list };
}

function updateMissionCategories(body, admin) {
  return persistMissionCategories(sanitizeMissionCategories(body), admin);
}

function updateNodalDepartments(body, admin) {
  return persistNodalDepartments(sanitizeNodalDepartments(body), admin);
}

function updateActivityTemplates(body, admin) {
  return persistActivityTemplates(sanitizeActivityTemplates(body), admin);
}

function updateTickerSpeed(body, admin) {
  const seconds = Math.max(8, Math.min(120, Number(body?.seconds) || 18));
  setSetting("ticker_speed_seconds", String(seconds));
  writeAuditLog("update_ticker_speed", "settings", null, `Announcement ticker speed set to ${seconds}s by ${admin?.username || "admin"}.`);
  return { ok: true, seconds };
}

function getAuditLogFull() {
  return db.prepare(`
    SELECT id, action, target_type, target_id, detail, created_at
    FROM admin_audit_log
    ORDER BY id DESC
  `).all();
}

function buildAuditLogCsv() {
  const rows = getAuditLogFull();
  const header = "ID,Action,TargetType,TargetID,Detail,Time\n";
  const lines = rows.map((r) =>
    [r.id, r.action, r.target_type, r.target_id, r.detail, r.created_at].map(csvEscape).join(",")
  );
  return header + lines.join("\n");
}

function migrateVolunteerRegistry() {
  const legacyRows = db.prepare("SELECT * FROM volunteers ORDER BY id ASC").all();
  legacyRows.forEach((row) => {
    const profileId = upsertVolunteerProfile({
      name: row.name,
      phone: row.phone,
      email: row.email,
      area: row.area,
      occupation: row.occupation,
      availability: row.availability,
      message: row.message,
      skills: safeJsonArray(row.skills_json)
    });
    if (!profileId) return;
    const missionTitle = String(row.mission || "").trim();
    if (!missionTitle || missionTitle === "General volunteer") return;
    const mission = db.prepare("SELECT id, title FROM missions WHERE title = ? LIMIT 1").get(missionTitle);
    if (!mission) return;
    db.prepare(`
      INSERT OR IGNORE INTO volunteer_participations (
        volunteer_profile_id, mission_id, mission_title, date_label, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(profileId, mission.id, mission.title, row.date_label || displayDate(), row.created_at || isoNow());
  });
}

function migrateCheckInCodes() {
  const missions = db.prepare("SELECT id FROM missions WHERE (check_in_code IS NULL OR check_in_code = '') AND archived_at IS NULL").all();
  missions.forEach((m) => {
    const code = generateCheckInCode();
    db.prepare("UPDATE missions SET check_in_code = ? WHERE id = ?").run(code, m.id);
  });
}

function registerVolunteer(body) {
  const name = String(body.name || "").trim();
  const phone = String(body.phone || "").trim();
  if (!name || !phone) {
    throw publicError(400, "Name and mobile number are required.");
  }
  const normalizedPhone = normalizeVolunteerPhone(phone);
  if (normalizedPhone.length !== 10) {
    throw publicError(400, "Mobile number must be a valid 10-digit number.");
  }
  const emailRaw = String(body.email || "").trim();
  if (emailRaw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) {
    throw publicError(400, "Please provide a valid email address.");
  }

  const missionId = Number(body.missionId || 0);
  const mission = missionId
    ? db.prepare("SELECT id, title, volunteers, total, status FROM missions WHERE id = ?").get(missionId)
    : null;

  if (missionId && !mission) {
    throw publicError(404, "Mission not found.");
  }

  if (mission && (mission.status === "full" || mission.status === "completed" || mission.status === "closed")) {
    throw publicError(409, mission.status === "completed" ? "This activity has already been completed." : mission.status === "closed" ? "This mission is temporarily closed." : "This mission is already full.");
  }

  const existingProfile = findVolunteerProfile(name, phone);
  const resolvedEmail = String(body.email || "").trim() || existingProfile?.email || "";
  const resolvedArea = String(body.area || "").trim() || existingProfile?.area || "";
  const resolvedOccupation = String(body.occupation || "").trim() || existingProfile?.occupation || "";
  const resolvedAvailability = String(body.availability || "").trim() || existingProfile?.availability || "";
  const resolvedMessage = String(body.message || "").trim() || existingProfile?.message || "";
  const incomingSkills = Array.isArray(body.skills) ? body.skills.map((item) => String(item || "").trim()).filter(Boolean) : [];
  const resolvedSkills = incomingSkills.length ? incomingSkills : (existingProfile ? safeJsonArray(existingProfile.skills_json) : []);

  const dateLabel = displayDate();
  const profileId = upsertVolunteerProfile({
    name,
    phone,
    email: resolvedEmail,
    area: resolvedArea,
    occupation: resolvedOccupation,
    availability: resolvedAvailability,
    message: resolvedMessage,
    skills: resolvedSkills
  });
  const finalProfile = profileId
    ? db.prepare("SELECT * FROM volunteer_profiles WHERE id = ?").get(profileId)
    : existingProfile;

  if (!mission && existingProfile) {
    return { ok: true, returningVolunteer: true, alreadyRegistered: true };
  }

  if (mission && finalProfile) {
    const existingParticipation = db.prepare(`
      SELECT id
      FROM volunteer_participations
      WHERE volunteer_profile_id = ? AND mission_id = ?
      LIMIT 1
    `).get(finalProfile.id, mission.id);
    if (existingParticipation) {
      return { ok: true, returningVolunteer: true, alreadyJoinedMission: true };
    }
    db.exec("BEGIN");
    try {
      db.prepare(`
        INSERT INTO volunteer_participations (
          volunteer_profile_id, mission_id, mission_title, date_label, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(finalProfile.id, mission.id, mission.title, dateLabel, isoNow());
      const nextVolunteers = Math.min(mission.total, mission.volunteers + 1);
      const nextStatus = nextVolunteers >= mission.total ? "full" : mission.status;
      db.prepare("UPDATE missions SET volunteers = ?, status = ? WHERE id = ?").run(nextVolunteers, nextStatus, mission.id);
      db.exec("COMMIT");
    } catch (txErr) {
      db.exec("ROLLBACK");
      throw txErr;
    }
  }

  return { ok: true, returningVolunteer: Boolean(existingProfile) };
}

function normalizeVolunteerName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeVolunteerPhone(value) {
  const digits = String(value || "").replace(/\D+/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function findVolunteerProfile(name, phone) {
  const normalizedName = normalizeVolunteerName(name);
  const normalizedPhone = normalizeVolunteerPhone(phone);
  if (!normalizedName || !normalizedPhone) return null;
  return db.prepare(`
    SELECT *
    FROM volunteer_profiles
    WHERE normalized_name = ? AND normalized_phone = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(normalizedName, normalizedPhone) || null;
}

function upsertVolunteerProfile(profile) {
  const name = String(profile.name || "").trim();
  const phone = String(profile.phone || "").trim();
  const normalizedName = normalizeVolunteerName(name);
  const normalizedPhone = normalizeVolunteerPhone(phone);
  if (!name || !phone || !normalizedName || !normalizedPhone) return;

  const existing = findVolunteerProfile(name, phone);
  const email = String(profile.email || "").trim();
  const area = String(profile.area || "").trim();
  const occupation = String(profile.occupation || "").trim();
  const availability = String(profile.availability || "").trim();
  const message = String(profile.message || "").trim();
  const skillsJson = JSON.stringify(Array.isArray(profile.skills) ? profile.skills : []);
  const now = isoNow();

  if (existing) {
    db.prepare(`
      UPDATE volunteer_profiles
      SET name = ?, phone = ?, email = ?, area = ?, occupation = ?, availability = ?, message = ?, skills_json = ?, last_active_at = ?
      WHERE id = ?
    `).run(
      name,
      phone,
      email || existing.email || "",
      area || existing.area || "",
      occupation || existing.occupation || "",
      availability || existing.availability || "",
      message || existing.message || "",
      Array.isArray(profile.skills) && profile.skills.length ? skillsJson : existing.skills_json,
      now,
      existing.id
    );
    return existing.id;
  }

  db.prepare(`
    INSERT INTO volunteer_profiles (
      name, normalized_name, phone, normalized_phone, email, area, occupation, availability, message, skills_json, first_registered_at, last_active_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    normalizedName,
    phone,
    normalizedPhone,
    email,
    area,
    occupation,
    availability,
    message,
    skillsJson,
    now,
    now
  );
  return Number(db.prepare("SELECT last_insert_rowid() AS id").get().id || 0);
}

function lookupVolunteerProfile(body) {
  const name = String(body.name || "").trim();
  const phone = String(body.phone || "").trim();
  if (!name || !phone) {
    throw publicError(400, "Name and mobile number are required.");
  }
  const profile = findVolunteerProfile(name, phone);
  if (!profile) {
    return { found: false };
  }
  return {
    found: true,
    profile: {
      name: profile.name,
      phone: profile.phone,
      email: profile.email || "",
      area: profile.area || "",
      occupation: profile.occupation || "",
      availability: profile.availability || "",
      message: profile.message || "",
      skills: safeJsonArray(profile.skills_json)
    }
  };
}

function subscribeNewsletter(body) {
  const email = String(body.email || "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
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
  const contributor = stripHtml(body.contributor).slice(0, 100);
  const role = stripHtml(body.role).slice(0, 100);
  const title = stripHtml(body.title).slice(0, 200);
  const story = stripHtml(body.story).slice(0, 5000);
  const category = stripHtml(body.category).slice(0, 50);
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
  const name = stripHtml(body.name).slice(0, 100);
  const text = stripHtml(body.text).slice(0, 1000);
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
  const name = stripHtml(body.name).slice(0, 100);
  const text = stripHtml(body.text).slice(0, 1000);
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

function createMission(body, admin) {
  const category = String(body.category || "other").trim() || "other";
  // Block/ward coordinators can only post missions in their own ward — the ward
  // is locked server-side to their assigned scope regardless of what the form sent.
  const ward = admin && admin.role === "coordinator"
    ? String(admin.scope || "").trim()
    : String(body.ward || body.area || "").trim();
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
  appendDepartmentCatalog(nodalDepartment);

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
  const newMissionId = Number(db.prepare("SELECT last_insert_rowid() AS id").get().id);
  ensureCheckInCode(newMissionId);
  writeAuditLog("create_mission", "mission", newMissionId, `New mission created: ${title}${admin ? ` by ${admin.name} (${admin.role === "coordinator" ? admin.scope : "district admin"})` : ""}`);

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

function updateAnnouncement(announcementId, body) {
  ensureRowExists("announcements", announcementId, "Announcement not found.");
  const text = String(body.text || "").trim();
  if (!text) {
    throw publicError(400, "Announcement text is required.");
  }
  db.prepare("UPDATE announcements SET text = ? WHERE id = ?").run(text, announcementId);
  writeAuditLog("update_announcement", "announcement", announcementId, `Announcement updated: ${text.slice(0, 80)}`);
  return { ok: true };
}

function deleteAnnouncement(announcementId) {
  ensureRowExists("announcements", announcementId, "Announcement not found.");
  db.prepare("DELETE FROM announcements WHERE id = ?").run(announcementId);
  writeAuditLog("delete_announcement", "announcement", announcementId, `Announcement #${announcementId} deleted`);
  return { ok: true };
}

function updateMissionStatus(missionId, body, admin) {
  ensureRowExists("missions", missionId, "Mission not found.");
  assertMissionScope(admin, missionId);
  const status = String(body.status || "").trim();
  const allowed = new Set(["open", "upcoming", "full", "completed", "closed"]);
  if (!allowed.has(status)) {
    throw publicError(400, "Invalid activity status.");
  }
  if (status === "completed") {
    const outcomeNote = String(body.outcomeNote || "").trim();
    const actualTurnout = Math.max(0, Number(body.actualTurnout || 0));
    const photoUrl = String(body.photoUrl || "").trim();
    db.prepare(`
      UPDATE missions
      SET status = ?, outcome_note = ?, actual_turnout = ?, photo_url = ?,
          completion_requested = 0, completion_requested_by = '', completion_requested_note = ''
      WHERE id = ?
    `).run(status, outcomeNote, actualTurnout, photoUrl, missionId);
  } else {
    db.prepare("UPDATE missions SET status = ? WHERE id = ?").run(status, missionId);
  }
  return { ok: true };
}

function reviewMissionRequest(missionId, body, admin) {
  ensureRowExists("missions", missionId, "Mission not found.");
  assertMissionScope(admin, missionId);
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
  appendDepartmentCatalog(nodalDepartment);
  const newStatus = approvalStatus === "approved" ? status : "upcoming";
  if (approvalStatus === "approved") {
    ensureCheckInCode(missionId);
  }
  db.prepare("UPDATE missions SET approval_status = ?, nodal_department = ?, status = ? WHERE id = ?").run(
    approvalStatus,
    nodalDepartment,
    newStatus,
    missionId
  );
  writeAuditLog(`${approvalStatus}_mission`, "mission", missionId, `Mission ${approvalStatus} by ${admin ? admin.name : "admin"}, dept: ${nodalDepartment}`);
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

function saveLocationCatalog(body) {
  const locations = Array.isArray(body.locations) ? body.locations : [];
  const cleaned = [...new Set(locations.map((item) => String(item || "").trim()).filter(Boolean))];
  setSetting("location_catalog_json", JSON.stringify(cleaned));
  return { ok: true, count: cleaned.length };
}

// ── District location structure: Blocks → Gram Panchayats, plus Municipal
// Bodies (nagar panchayat / nagar nigam etc). This replaces the old flat
// "ward" list with the real administrative hierarchy a district actually
// has, uploaded once as a CSV. We still also maintain the old flat
// "location_catalog_json" string list underneath it (auto-derived) so every
// existing dropdown/datalist/filter that already reads that list keeps
// working without change — the structure is additive, not a schema break.
function flattenLocationLabel(entry) {
  if (entry.type === "municipal") return `${entry.name} (Municipal)`;
  return `${entry.name} (${entry.block})`;
}

function flattenLocationStructure(structure) {
  const flat = [];
  (structure.blocks || []).forEach((block) => {
    (block.gps || []).forEach((gp) => {
      flat.push({ type: "gp", block: block.name, name: gp, label: `${gp} (${block.name})` });
    });
  });
  (structure.municipalBodies || []).forEach((name) => {
    flat.push({ type: "municipal", block: "", name, label: `${name} (Municipal)` });
  });
  return flat;
}

// Parses an uploaded CSV/TSV with header row: Type,Block,Name
// Type is "GP" (a gram panchayat inside a block) or "Municipal" (a nagar
// panchayat/parishad/nigam, no block). Tolerant of extra whitespace, blank
// lines, and either comma or tab separation.
function parseLocationCsv(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) throw publicError(400, "The uploaded file is empty.");

  const splitLine = (line) => (line.includes("\t") ? line.split("\t") : line.split(","))
    .map((cell) => cell.trim().replace(/^"|"$/g, ""));

  const header = splitLine(lines[0]).map((h) => h.toLowerCase());
  const typeIdx = header.indexOf("type");
  const blockIdx = header.indexOf("block");
  const nameIdx = header.indexOf("name");
  const hasHeader = typeIdx !== -1 && nameIdx !== -1;
  const dataLines = hasHeader ? lines.slice(1) : lines;
  const effTypeIdx = hasHeader ? typeIdx : 0;
  const effBlockIdx = hasHeader ? blockIdx : 1;
  const effNameIdx = hasHeader ? nameIdx : 2;

  const blockMap = new Map(); // name -> Set of GP names
  const municipalSet = new Set();

  dataLines.forEach((line) => {
    const cells = splitLine(line);
    const type = String(cells[effTypeIdx] || "").trim().toLowerCase();
    const block = String(cells[effBlockIdx] || "").trim();
    const name = String(cells[effNameIdx] || "").trim();
    if (!name) return;
    if (type === "municipal" || type === "municipality" || type === "nagar panchayat" || type === "nagar nigam") {
      municipalSet.add(name);
    } else {
      // Default to GP when the type column is missing/unrecognised, since
      // that's the overwhelming majority of rows in a real district list.
      if (!block) return; // a GP row needs a block name to mean anything
      if (!blockMap.has(block)) blockMap.set(block, new Set());
      blockMap.get(block).add(name);
    }
  });

  if (!blockMap.size && !municipalSet.size) {
    throw publicError(400, "No valid rows found. Expected columns: Type (GP/Municipal), Block, Name.");
  }

  return {
    blocks: [...blockMap.entries()].map(([name, gps]) => ({ name, gps: [...gps] })),
    municipalBodies: [...municipalSet]
  };
}

function persistLocationStructure(structure, admin) {
  setSetting("location_structure_json", JSON.stringify(structure));
  const flatLabels = flattenLocationStructure(structure).map((entry) => entry.label);
  setSetting("location_catalog_json", JSON.stringify([...new Set(flatLabels)]));
  const gpCount = (structure.blocks || []).reduce((sum, b) => sum + (b.gps || []).length, 0);
  writeAuditLog(
    "update_location_structure",
    "settings",
    null,
    `Location structure updated by ${admin ? admin.name : "admin"}: ${(structure.blocks || []).length} blocks, ${gpCount} GPs, ${(structure.municipalBodies || []).length} municipal bodies`
  );
  return { ok: true, blocks: (structure.blocks || []).length, gps: gpCount, municipalBodies: (structure.municipalBodies || []).length };
}

function uploadLocationStructure(body, admin) {
  const structure = parseLocationCsv(body.csvText);
  return persistLocationStructure(structure, admin);
}

// Direct edits from the admin panel (rename/delete/add a single Block, GP, or
// Municipal Body) send the whole edited structure back here rather than a
// CSV — the client does the small edit locally, this just validates and
// re-saves it the same way a fresh upload would.
function sanitizeLocationStructure(input) {
  const blocksIn = Array.isArray(input?.blocks) ? input.blocks : [];
  const blocks = blocksIn
    .map((b) => ({
      name: String(b?.name || "").trim().slice(0, 100),
      gps: Array.isArray(b?.gps) ? [...new Set(b.gps.map((g) => String(g || "").trim().slice(0, 100)).filter(Boolean))] : []
    }))
    .filter((b) => b.name);
  const municipalBodies = [...new Set(
    (Array.isArray(input?.municipalBodies) ? input.municipalBodies : [])
      .map((m) => String(m || "").trim().slice(0, 100))
      .filter(Boolean)
  )];
  if (!blocks.length && !municipalBodies.length) {
    throw publicError(400, "The geography can't be saved empty — delete it with Clear Geography instead.");
  }
  return { blocks, municipalBodies };
}

function updateLocationStructure(body, admin) {
  const structure = sanitizeLocationStructure(body);
  return persistLocationStructure(structure, admin);
}

function clearLocationStructure(admin) {
  setSetting("location_structure_json", JSON.stringify({ blocks: [], municipalBodies: [] }));
  writeAuditLog("clear_location_structure", "settings", null, `Location structure cleared by ${admin ? admin.name : "admin"}`);
  return { ok: true };
}

function buildLocationReportCsv() {
  const structure = safeJsonObject(getSetting("location_structure_json", ""), { blocks: [], municipalBodies: [] });
  const entries = flattenLocationStructure(structure);
  const missions = db.prepare(`
    SELECT ward, status FROM missions WHERE is_demo = 0 AND archived_at IS NULL
  `).all();
  const byLabel = new Map();
  missions.forEach((m) => {
    const key = String(m.ward || "").trim();
    if (!key) return;
    if (!byLabel.has(key)) byLabel.set(key, { total: 0, open: 0, completed: 0 });
    const bucket = byLabel.get(key);
    bucket.total += 1;
    if (m.status === "completed") bucket.completed += 1;
    else bucket.open += 1;
  });

  const header = "Type,Block,Location,TotalActivities,OpenOrUpcoming,Completed\n";
  const rows = entries
    .sort((a, b) => (a.block || "").localeCompare(b.block || "") || a.name.localeCompare(b.name))
    .map((entry) => {
      const stats = byLabel.get(entry.label) || { total: 0, open: 0, completed: 0 };
      return [
        entry.type === "municipal" ? "Municipal Body" : "Gram Panchayat",
        entry.block,
        entry.name,
        stats.total,
        stats.open,
        stats.completed
      ].map(csvEscape).join(",");
    });
  return header + rows.join("\n");
}

function saveBranding(body) {
  const badgeEn = String(body.badgeEn || "").trim().slice(0, 80);
  const badgeHi = String(body.badgeHi || "").trim().slice(0, 80);
  if (!badgeEn) {
    throw publicError(400, "The English badge line cannot be empty.");
  }
  setSetting("site_badge_en", badgeEn);
  setSetting("site_badge_hi", badgeHi || badgeEn);
  writeAuditLog("update_branding", "settings", null, `Hero badge text updated to "${badgeEn}"`);
  return { ok: true, badgeEn, badgeHi: badgeHi || badgeEn };
}

function saveDepartmentCatalog(body) {
  const departments = Array.isArray(body.departments) ? body.departments : [];
  const cleaned = [...new Set(departments.map((item) => String(item || "").trim()).filter(Boolean))];
  setSetting("department_catalog_json", JSON.stringify(cleaned));
  return { ok: true, count: cleaned.length };
}

function appendDepartmentCatalog(departmentName) {
  const value = String(departmentName || "").trim();
  if (!value) return;
  const existing = safeJsonArray(getSetting("department_catalog_json", "[]"));
  if (existing.includes(value)) return;
  setSetting("department_catalog_json", JSON.stringify([...existing, value]));
}

function updateMission(missionId, body, admin) {
  ensureRowExists("missions", missionId, "Mission not found.");
  assertMissionScope(admin, missionId);
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
  appendDepartmentCatalog(nodalDepartment);
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

function deleteMission(missionId, admin) {
  return archiveMission(missionId, admin);
}

function archiveMission(missionId, admin) {
  ensureRowExists("missions", missionId, "Mission not found.");
  assertMissionScope(admin, missionId);
  db.prepare("UPDATE missions SET archived_at = ? WHERE id = ?").run(isoNow(), missionId);
  writeAuditLog("archive_mission", "mission", missionId, `Mission ${missionId} archived by ${admin ? admin.name : "admin"}`);
  return { ok: true };
}

function restoreArchivedMission(missionId, admin) {
  const row = db.prepare("SELECT id FROM missions WHERE id = ?").get(missionId);
  if (!row) throw publicError(404, "Mission not found.");
  assertMissionScope(admin, missionId);
  db.prepare("UPDATE missions SET archived_at = NULL WHERE id = ?").run(missionId);
  writeAuditLog("restore_mission", "mission", missionId, `Mission ${missionId} restored by ${admin ? admin.name : "admin"}`);
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

const ALLOWED_TABLES = new Set(["stories", "missions", "funds", "announcements", "mission_photos"]);

function ensureRowExists(table, id, message) {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`ensureRowExists: invalid table name "${table}"`);
  }
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

// ── Admin audit log ───────────────────────────────────────────────────────────

function writeAuditLog(action, targetType, targetId, detail) {
  try {
    db.prepare(`
      INSERT INTO admin_audit_log (action, target_type, target_id, detail, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(action, targetType || "", targetId || null, detail || "", isoNow());
  } catch (e) {
    // Audit log failures must never crash the main request
    console.error("[AUDIT LOG ERROR]", e.message);
  }
}

function getAuditLog() {
  return db.prepare(`
    SELECT id, action, target_type, target_id, detail, created_at
    FROM admin_audit_log
    ORDER BY id DESC
    LIMIT 200
  `).all();
}

// ── Volunteer search (admin) ──────────────────────────────────────────────────

function searchVolunteers(params) {
  const q = String(params.get("q") || "").trim();
  const ward = String(params.get("ward") || "").trim();
  const skill = String(params.get("skill") || "").trim();
  const sort = String(params.get("sort") || "recent").trim();
  const page = Math.max(1, Number(params.get("page") || 1));
  const limit = Math.min(100, Math.max(1, Number(params.get("limit") || 50)));

  let where = "1=1";
  const args = [];

  if (q) {
    where += " AND (name LIKE ? OR phone LIKE ? OR area LIKE ?)";
    const like = `%${q}%`;
    args.push(like, like, like);
  }
  if (ward) {
    where += " AND area = ?";
    args.push(ward);
  }
  if (skill) {
    where += " AND skills_json LIKE ?";
    args.push(`%${skill}%`);
  }

  const allRows = db.prepare(`
    SELECT id, name, phone, email, area, occupation, availability, skills_json,
           first_registered_at, last_active_at
    FROM volunteer_profiles
    WHERE ${where}
  `).all(...args);

  const statsMap = sort === "points" ? computeAllVolunteerStats() : null;
  const withPoints = allRows.map((r) => ({
    row: r,
    points: statsMap ? (statsMap.get(r.id)?.points || POINTS.register) : null
  }));

  withPoints.sort((a, b) => {
    if (sort === "points") return b.points - a.points;
    return new Date(b.row.last_active_at || 0) - new Date(a.row.last_active_at || 0) || (b.row.id - a.row.id);
  });

  const total = withPoints.length;
  const offset = (page - 1) * limit;
  const pageRows = withPoints.slice(offset, offset + limit);

  // Points are shown for every row regardless of sort mode, so reuse the
  // stats map already computed for "points" sort, or compute it once here.
  const pointsLookup = statsMap || computeAllVolunteerStats();

  return {
    total,
    page,
    limit,
    volunteers: pageRows.map(({ row: r }) => ({
      id: r.id,
      name: r.name,
      phone: r.phone,
      email: r.email || "",
      area: r.area || "",
      occupation: r.occupation || "",
      availability: r.availability || "",
      skills: safeJsonArray(r.skills_json),
      points: pointsLookup.get(r.id)?.points || POINTS.register,
      joinedDate: new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" })
        .format(new Date(r.first_registered_at || isoNow()))
    }))
  };
}

function updateVolunteerProfileAdmin(profileId, body, admin) {
  const existing = db.prepare("SELECT * FROM volunteer_profiles WHERE id = ?").get(profileId);
  if (!existing) throw publicError(404, "Volunteer not found.");

  const name = String(body.name || "").trim();
  const phone = String(body.phone || "").trim();
  if (!name || !phone) {
    throw publicError(400, "Name and mobile number are required.");
  }
  const normalizedPhone = normalizeVolunteerPhone(phone);
  if (normalizedPhone.length !== 10) {
    throw publicError(400, "Mobile number must be a valid 10-digit number.");
  }
  const email = String(body.email || "").trim();
  const area = String(body.area || "").trim();
  const occupation = String(body.occupation || "").trim();
  const availability = String(body.availability || "").trim();

  db.prepare(`
    UPDATE volunteer_profiles
    SET name = ?, normalized_name = ?, phone = ?, normalized_phone = ?, email = ?, area = ?, occupation = ?, availability = ?
    WHERE id = ?
  `).run(name, normalizeVolunteerName(name), phone, normalizedPhone, email, area, occupation, availability, profileId);

  writeAuditLog("update_volunteer", "volunteer_profile", profileId, `Volunteer #${profileId} edited by ${admin ? admin.name : "admin"}`);
  return { ok: true };
}

function deleteVolunteerProfileAdmin(profileId, admin) {
  const existing = db.prepare("SELECT id, name FROM volunteer_profiles WHERE id = ?").get(profileId);
  if (!existing) throw publicError(404, "Volunteer not found.");
  // ON DELETE CASCADE (foreign_keys = ON) also removes this volunteer's
  // participations, so their points/leaderboard/mission counts update
  // automatically once the profile itself is gone.
  db.prepare("DELETE FROM volunteer_profiles WHERE id = ?").run(profileId);
  writeAuditLog("delete_volunteer", "volunteer_profile", profileId, `Volunteer "${existing.name}" (#${profileId}) deleted by ${admin ? admin.name : "admin"}`);
  return { ok: true };
}

// ── Bulk approve/reject community missions ────────────────────────────────────

function bulkReviewMissions(body, admin) {
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean) : [];
  const action = String(body.action || "").trim();
  const nodalDepartment = String(body.nodalDepartment || "").trim();
  if (!ids.length) throw publicError(400, "No mission IDs provided.");
  if (!["approve", "reject"].includes(action)) throw publicError(400, "Action must be 'approve' or 'reject'.");
  if (action === "approve" && !nodalDepartment) throw publicError(400, "Select a nodal department for bulk approval.");
  ids.forEach((id) => assertMissionScope(admin, id));

  const approvalStatus = action === "approve" ? "approved" : "rejected";
  const missionStatus = action === "approve" ? "open" : "upcoming";

  db.exec("BEGIN");
  try {
    const stmt = db.prepare(
      "UPDATE missions SET approval_status = ?, nodal_department = ?, status = ? WHERE id = ?"
    );
    ids.forEach((id) => {
      stmt.run(approvalStatus, action === "approve" ? nodalDepartment : "", missionStatus, id);
      writeAuditLog(`bulk_${action}_mission`, "mission", id, `Bulk ${action} by ${admin ? admin.name : "admin"}`);
    });
    if (action === "approve" && nodalDepartment) appendDepartmentCatalog(nodalDepartment);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  return { ok: true, processed: ids.length };
}

// ── Mission analytics ─────────────────────────────────────────────────────────

function buildAnalytics() {
  const totalVolunteers = db.prepare("SELECT COUNT(*) AS n FROM volunteer_profiles").get().n;
  const totalMissions = db.prepare("SELECT COUNT(*) AS n FROM missions WHERE archived_at IS NULL").get().n;
  const completedMissions = db.prepare("SELECT COUNT(*) AS n FROM missions WHERE status = 'completed' AND archived_at IS NULL").get().n;
  const pendingRequests = db.prepare("SELECT COUNT(*) AS n FROM missions WHERE source_type = 'community' AND approval_status = 'pending' AND archived_at IS NULL").get().n;
  const totalParticipations = db.prepare("SELECT COUNT(*) AS n FROM volunteer_participations").get().n;

  const byCategory = db.prepare(`
    SELECT category, COUNT(*) AS missions, SUM(volunteers) AS participants
    FROM missions
    WHERE archived_at IS NULL
    GROUP BY category
    ORDER BY participants DESC
  `).all();

  const top5Missions = db.prepare(`
    SELECT m.id, m.title, m.category, m.volunteers, m.total, m.status, m.date
    FROM missions m
    WHERE m.archived_at IS NULL
    ORDER BY m.volunteers DESC
    LIMIT 5
  `).all();

  const volunteersByWard = db.prepare(`
    SELECT area, COUNT(*) AS count
    FROM volunteer_profiles
    WHERE area != ''
    GROUP BY area
    ORDER BY count DESC
    LIMIT 10
  `).all();

  const monthlyRegistrations = db.prepare(`
    SELECT strftime('%Y-%m', first_registered_at) AS month, COUNT(*) AS count
    FROM volunteer_profiles
    GROUP BY month
    ORDER BY month DESC
    LIMIT 12
  `).all();

  const avgRating = db.prepare("SELECT AVG(rating) AS avg FROM mission_feedback").get().avg;

  return {
    totalVolunteers,
    totalMissions,
    completedMissions,
    pendingRequests,
    totalParticipations,
    completionRate: totalMissions > 0 ? Math.round((completedMissions / totalMissions) * 100) : 0,
    avgFeedbackRating: avgRating ? Math.round(avgRating * 10) / 10 : null,
    byCategory,
    top5Missions,
    volunteersByWard,
    monthlyRegistrations
  };
}

// ── CSV exports ───────────────────────────────────────────────────────────────

function csvEscape(value) {
  const str = String(value == null ? "" : value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function exportMissionsCsv() {
  const rows = db.prepare(`
    SELECT m.id, m.title, m.category, m.ward, m.date, m.location, m.status,
           m.approval_status, m.volunteers, m.total, m.coordinator,
           m.nodal_department, m.host_name, m.host_phone, m.created_at
    FROM missions m
    WHERE m.is_demo = 0 AND m.archived_at IS NULL
    ORDER BY m.id DESC
  `).all();
  const header = "ID,Title,Category,Ward,Date,Location,Status,Approval,Registered,Capacity,Coordinator,Department,HostName,HostPhone,CreatedAt\n";
  const lines = rows.map((r) =>
    [r.id, r.title, r.category, r.ward, r.date, r.location, r.status, r.approval_status,
     r.volunteers, r.total, r.coordinator, r.nodal_department, r.host_name, r.host_phone, r.created_at]
      .map(csvEscape).join(",")
  );
  return header + lines.join("\n");
}

function exportStoriesCsv() {
  const rows = db.prepare(`
    SELECT id, contributor, role, title, likes, date_label, created_at
    FROM stories
    WHERE is_demo = 0
    ORDER BY id DESC
  `).all();
  const header = "ID,Contributor,Role,Title,Likes,Date,CreatedAt\n";
  const lines = rows.map((r) =>
    [r.id, r.contributor, r.role, r.title, r.likes, r.date_label, r.created_at]
      .map(csvEscape).join(",")
  );
  return header + lines.join("\n");
}

function exportSubscribersCsv() {
  const rows = db.prepare("SELECT email, date_label, created_at FROM newsletter_subscribers ORDER BY id DESC").all();
  const header = "Email,SubscribedDate,CreatedAt\n";
  const lines = rows.map((r) => [r.email, r.date_label, r.created_at].map(csvEscape).join(","));
  return header + lines.join("\n");
}

// ── Community mission tracking (citizen) ─────────────────────────────────────

function getMyMissions(phone) {
  if (!phone) return { missions: [] };
  const normalized = normalizeVolunteerPhone(phone);
  if (normalized.length < 10) return { missions: [] };

  const rows = db.prepare(`
    SELECT id, title, category, date, location, status, approval_status, created_at
    FROM missions
    WHERE host_phone LIKE ?
    ORDER BY id DESC
  `).all(`%${normalized}%`);

  return {
    missions: rows.map((r) => ({
      id: r.id,
      title: r.title,
      category: r.category,
      date: r.date,
      location: r.location,
      status: r.status,
      approvalStatus: r.approval_status,
      createdAt: displayDate(r.created_at)
    }))
  };
}

// ── QR code check-in ──────────────────────────────────────────────────────────

function generateCheckInCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase(); // 6-char hex e.g. "A3F2B1"
}

function ensureCheckInCode(missionId) {
  const row = db.prepare("SELECT check_in_code FROM missions WHERE id = ?").get(missionId);
  if (!row) throw publicError(404, "Mission not found.");
  if (row.check_in_code) return row.check_in_code;
  const code = generateCheckInCode();
  db.prepare("UPDATE missions SET check_in_code = ? WHERE id = ?").run(code, missionId);
  return code;
}

function checkInVolunteer(body) {
  const code = String(body.code || "").trim().toUpperCase();
  const phone = String(body.phone || "").trim();
  if (!code || !phone) throw publicError(400, "Check-in code and volunteer phone are required.");
  const normalizedPhone = normalizeVolunteerPhone(phone);

  const mission = db.prepare("SELECT id, title, status FROM missions WHERE check_in_code = ? AND archived_at IS NULL").get(code);
  if (!mission) throw publicError(404, "Invalid check-in code. Please verify with your mission coordinator.");

  const profile = db.prepare("SELECT id FROM volunteer_profiles WHERE normalized_phone = ? LIMIT 1").get(normalizedPhone);
  if (!profile) throw publicError(404, "Volunteer not found. Please register first.");

  const participation = db.prepare(`
    SELECT id, attended_at FROM volunteer_participations
    WHERE volunteer_profile_id = ? AND mission_id = ?
    LIMIT 1
  `).get(profile.id, mission.id);

  if (!participation) throw publicError(409, "You are not registered for this mission. Please register first.");
  if (participation.attended_at) return { ok: true, alreadyCheckedIn: true, missionTitle: mission.title };

  db.prepare("UPDATE volunteer_participations SET attended_at = ? WHERE id = ?").run(isoNow(), participation.id);
  return { ok: true, checkedIn: true, missionTitle: mission.title };
}

// ── Mission photo gallery ──────────────────────────────────────────────────────

const MAX_PHOTOS_PER_MISSION = 8;
const MAX_PHOTO_DATA_LENGTH = 2_000_000; // ~1.5MB decoded, plenty for a compressed JPEG

function addMissionPhoto(missionId, body) {
  const mission = ensureRowExists("missions", missionId, "Mission not found.");
  const photoData = String(body.photoData || "");
  const caption = String(body.caption || "").trim().slice(0, 200);
  const uploadedBy = String(body.uploadedBy || "").trim().slice(0, 100) || "Anonymous";

  if (!photoData.startsWith("data:image/")) {
    throw publicError(400, "Photo must be a valid image.");
  }
  if (photoData.length > MAX_PHOTO_DATA_LENGTH) {
    throw publicError(413, "Photo is too large. Please use a smaller or more compressed image.");
  }

  const existingCount = db.prepare("SELECT COUNT(*) AS n FROM mission_photos WHERE mission_id = ?").get(missionId).n;
  if (existingCount >= MAX_PHOTOS_PER_MISSION) {
    throw publicError(400, `This mission already has the maximum of ${MAX_PHOTOS_PER_MISSION} photos. Remove one before adding another.`);
  }

  db.prepare(`
    INSERT INTO mission_photos (mission_id, photo_data, caption, uploaded_by, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(missionId, photoData, caption, uploadedBy, isoNow());

  return { ok: true, count: existingCount + 1 };
}

function deleteMissionPhoto(photoId, admin) {
  const photo = db.prepare("SELECT mission_id FROM mission_photos WHERE id = ?").get(photoId);
  if (!photo) throw publicError(404, "Photo not found.");
  assertMissionScope(admin, photo.mission_id);
  db.prepare("DELETE FROM mission_photos WHERE id = ?").run(photoId);
  writeAuditLog("delete_mission_photo", "mission", photo.mission_id, `Photo #${photoId} deleted by ${admin ? admin.name : "admin"}`);
  return { ok: true };
}

// ── Citizen-requested mission completion ────────────────────────────────────────

function requestMissionCompletion(missionId, body) {
  const mission = ensureRowExists("missions", missionId, "Mission not found.");
  const row = db.prepare("SELECT status, archived_at FROM missions WHERE id = ?").get(missionId);
  if (row.archived_at) throw publicError(400, "This mission has been archived.");
  if (row.status === "completed") throw publicError(400, "This mission is already marked completed.");
  const requestedBy = String(body.requestedBy || "").trim().slice(0, 100);
  const note = String(body.note || "").trim().slice(0, 300);
  if (!requestedBy) throw publicError(400, "Your name is required to request completion.");
  db.prepare(`
    UPDATE missions SET completion_requested = 1, completion_requested_by = ?, completion_requested_note = ?
    WHERE id = ?
  `).run(requestedBy, note, missionId);
  return { ok: true };
}

function dismissCompletionRequest(missionId, admin) {
  ensureRowExists("missions", missionId, "Mission not found.");
  assertMissionScope(admin, missionId);
  db.prepare("UPDATE missions SET completion_requested = 0, completion_requested_by = '', completion_requested_note = '' WHERE id = ?").run(missionId);
  writeAuditLog("dismiss_completion_request", "mission", missionId, `Completion request dismissed by ${admin ? admin.name : "admin"}`);
  return { ok: true };
}

// ── Post-mission feedback ─────────────────────────────────────────────────────

function submitFeedback(body) {
  const missionId = Number(body.missionId || 0);
  const phone = String(body.phone || "").trim();
  const rating = Number(body.rating || 0);
  const comment = stripHtml(body.comment || "").slice(0, 500);

  if (!missionId) throw publicError(400, "Mission ID is required.");
  if (!phone) throw publicError(400, "Phone number is required.");
  if (rating < 1 || rating > 5) throw publicError(400, "Rating must be between 1 and 5.");

  const normalizedPhone = normalizeVolunteerPhone(phone);
  const profile = db.prepare("SELECT id FROM volunteer_profiles WHERE normalized_phone = ? LIMIT 1").get(normalizedPhone);
  if (!profile) throw publicError(404, "Volunteer not found. Please register to leave feedback.");

  const participation = db.prepare(`
    SELECT id FROM volunteer_participations
    WHERE volunteer_profile_id = ? AND mission_id = ?
    LIMIT 1
  `).get(profile.id, missionId);
  if (!participation) throw publicError(403, "You must be registered for this mission to leave feedback.");

  try {
    db.prepare(`
      INSERT INTO mission_feedback (mission_id, volunteer_phone, rating, comment, date_label, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(missionId, normalizedPhone, rating, comment, displayDate(), isoNow());
  } catch (e) {
    if (e.message && e.message.includes("UNIQUE")) {
      db.prepare("UPDATE mission_feedback SET rating = ?, comment = ? WHERE mission_id = ? AND volunteer_phone = ?")
        .run(rating, comment, missionId, normalizedPhone);
    } else throw e;
  }

  return { ok: true };
}

function getMissionFeedback(missionId) {
  return db.prepare(`
    SELECT rating, comment, date_label
    FROM mission_feedback
    WHERE mission_id = ?
    ORDER BY created_at DESC
    LIMIT 50
  `).all(missionId).map((r) => ({
    rating: r.rating,
    comment: r.comment,
    date: r.date_label
  }));
}
