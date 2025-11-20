export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).searchParams.get("force") === "true") {
      return await runAutoposter(env, true);
    }
    return new Response("PlayReportZA autoposter is active.");
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAutoposter(env, false));
  }
};

// =============================================================
// MAIN AUTPOSTER
// =============================================================
async function runAutoposter(env, manual = false) {
  const apiKey = env.API_FOOTBALL_KEY;
  const fbToken = env.FB_PAGE_TOKEN;
  const pageId = env.FB_PAGE_ID;
  const KV = env.LIVE_KV;

  if (!apiKey || !fbToken || !pageId) {
    return new Response(JSON.stringify({
      error: "Missing ENV vars",
      apiKey: !!apiKey,
      fbToken: !!fbToken,
      pageId: !!pageId
    }), { status: 500 });
  }

  const today = new Date().toISOString().split("T")[0];
  const fixtures = await fetchFixtures(apiKey, today);

  let live = {};
  let ht = {};
  let ft = {};
  let others = [];

  const now = Date.now();

  for (const f of fixtures) {
    const status = f.fixture.status.short;

    const isLive = ["1H", "2H", "ET", "PEN", "LIVE"].includes(status);
    const isHT = status === "HT";
    const isFT = ["FT", "AET", "PEN"].includes(status);
    const isPost = ["PST", "CANC"].includes(status);

    // Hide upcoming — only LIVE or FT in last 8 hours
    if (!isLive && !isHT && !isFT && !isPost) continue;

    // FULL-TIME FILTER: Only last 8 hours
    if (isFT) {
      const matchTime = new Date(f.fixture.date).getTime();
      if (now - matchTime > 8 * 60 * 60 * 1000) continue;
    }

    const leagueKey =
      (f.league && f.league.country && f.league.name)
        ? `${countryToFlag(f.league.country)} ${f.league.country} – ${f.league.name}`
        : "🌐 Others";

    if (!live[leagueKey]) live[leagueKey] = [];
    if (!ht[leagueKey]) ht[leagueKey] = [];
    if (!ft[leagueKey]) ft[leagueKey] = [];

    const saTime = toSA(f.fixture.date);
    const scoreBoxes = formatScoreBoxes(f.goals.home, f.goals.away);
    const minuteText = status === "HT"
      ? "HT"
      : status === "FT"
        ? "FT"
        : f.fixture.status.elapsed
          ? `${f.fixture.status.elapsed}'`
          : status === "PST"
            ? "Postponed"
            : "";

    // stats
    const stats = extractStats(f);

    // goals + scorers
    const goals = extractGoals(f);

    const line =
      `🕒 ${saTime} | ${f.teams.home.name} ${scoreBoxes} ${f.teams.away.name} ` +
      (minuteText ? `(${minuteText})` : "") +
      (goals ? `\n${goals}` : "") +
      (stats ? `\n${stats}` : "");

    if (isLive) live[leagueKey].push({ time: saTime, text: line });
    else if (isHT) ht[leagueKey].push({ time: saTime, text: line });
    else if (isFT) ft[leagueKey].push({ time: saTime, text: line });
    else if (isPost) others.push(`🕒 ${saTime} | ${f.teams.home.name} vs ${f.teams.away.name} (Postponed)`);
  }

  // DON'T POST IF NO LIVE MATCHES
  const hasLive = Object.values(live).some(arr => arr.length > 0);
  if (!hasLive) return new Response("No live matches – no post sent");

  const post = buildPost(live, ht, ft, others);

  // CHANGE DETECTION — do not post duplicates
  const hash = await hashText(post);
  const lastHash = await KV.get("last_posted_hash");

  if (hash === lastHash) {
    return new Response("No score changes – no post");
  }

  await KV.put("last_posted_hash", hash);

  const fbURL =
    `https://graph.facebook.com/${pageId}/feed?message=${encodeURIComponent(post)}&access_token=${fbToken}`;

  const fb = await fetch(fbURL, { method: "POST" }).then(r => r.json());

  if (manual) {
    return new Response(JSON.stringify({
      posted_preview: post.slice(0, 400),
      fb_result: fb
    }, null, 2));
  }

  return new Response("OK");
}

// =============================================================
// BUILD POST TEXT
// =============================================================
function buildPost(live, ht, ft, others) {
  let out = `⚽ LIVE SCORE UPDATES (SA Time)\n`;

  // LIVE
  out += `\n🔴 *LIVE MATCHES*\n`;
  for (const league of Object.keys(live)) {
    if (live[league].length === 0) continue;
    out += `\n${league}\n${live[league].map(m => m.text).join("\n")}\n`;
  }

  // HALF-TIME
  if (Object.keys(ht).some(k => ht[k].length > 0)) {
    out += `\n🟡 *HALF-TIME*\n`;
    for (const league of Object.keys(ht)) {
      if (ht[league].length === 0) continue;
      out += `\n${league}\n${ht[league].map(m => m.text).join("\n")}\n`;
    }
  }

  // FULL TIME — DESCENDING (MOST RECENT FIRST)
  if (Object.keys(ft).some(k => ft[k].length > 0)) {
    out += `\n🟢 *FULL-TIME RESULTS (Last 8 hrs)*\n`;
    for (const league of Object.keys(ft)) {
      if (ft[league].length === 0) continue;
      const sorted = ft[league].sort((a, b) => b.time.localeCompare(a.time)); // DESCENDING
      out += `\n${league}\n${sorted.map(m => m.text).join("\n")}\n`;
    }
  }

  // Postponed / Pending
  if (others.length > 0) {
    out += `\n⏳ *PENDING / POSTPONED*\n${others.join("\n")}\n`;
  }

  out += `\n📣 Follow PlayReportZA for more updates!\n`;
  out += `#PlayReportZA #LiveScores #Football #Soccer #AfricanFootball #EuropeanFootball #CAF #UEFA #CONMEBOL #FIFA #MatchDay`;

  return out.trim();
}

// =============================================================
// HELPERS
// =============================================================

function extractStats(f) {
  if (!f.statistics || f.statistics.length < 2) return "";

  const h = f.statistics[0].statistics;
  const a = f.statistics[1].statistics;

  return [
    statLine(h, a, "Ball Possession", "📊 Possession"),
    statLine(h, a, "Shots on Goal", "🎯 On Target"),
    statLine(h, a, "Shots off Goal", "🎯 Off Target")
  ]
    .filter(Boolean)
    .join("\n");
}

function statLine(h, a, key, label) {
  const H = h.find(s => s.type === key)?.value;
  const A = a.find(s => s.type === key)?.value;
  if (!H || !A) return "";
  return `${label}: ${H} – ${A}`;
}

function extractGoals(f) {
  if (!f.events) return "";
  const out = [];
  f.events.forEach(ev => {
    if (ev.type === "Goal") {
      const sc = ev.player?.name || "";
      out.push(`⚽ ${ev.time.elapsed}' – ${sc}`);
    }
  });
  return out.join("\n");
}

function formatScoreBoxes(h, a) {
  if (h == null || a == null) return "–";
  const winH = h > a, winA = a > h;
  return `${winH ? "🟦" : "🟥"}${h} ${winA ? "🟦" : "🟥"}${a}`;
}

function countryToFlag(country) {
  if (!country) return "🌍";

  const map = {
    // Continents
    "World": "🌍",
    "International": "🌍",
    "Europe": "🌍",
    "Africa": "🌍",
    "Asia": "🌏",
    "South America": "🌎",
    "North America": "🌎",
    "Oceania": "🌏",
    "Central America": "🌎",
    "Caribbean": "🌴",

    // UK Regions
    "England": "🏴",
    "Scotland": "🏴",
    "Wales": "🏴",
    "Northern Ireland": "🏴",
    "Great Britain": "🇬🇧",
    "United Kingdom": "🇬🇧",

    // Europe (Big Football Nations)
    "France": "🇫🇷",
    "Germany": "🇩🇪",
    "Spain": "🇪🇸",
    "Portugal": "🇵🇹",
    "Italy": "🇮🇹",
    "Netherlands": "🇳🇱",
    "Belgium": "🇧🇪",
    "Switzerland": "🇨🇭",
    "Austria": "🇦🇹",
    "Poland": "🇵🇱",
    "Czechia": "🇨🇿",
    "Slovakia": "🇸🇰",
    "Sweden": "🇸🇪",
    "Norway": "🇳🇴",
    "Denmark": "🇩🇰",
    "Finland": "🇫🇮",
    "Iceland": "🇮🇸",
    "Serbia": "🇷🇸",
    "Croatia": "🇭🇷",
    "Slovenia": "🇸🇮",
    "Bosnia": "🇧🇦",
    "Albania": "🇦🇱",
    "Greece": "🇬🇷",
    "Turkey": "🇹🇷",
    "Romania": "🇷🇴",
    "Bulgaria": "🇧🇬",
    "Hungary": "🇭🇺",
    "Ukraine": "🇺🇦",
    "Russia": "🇷🇺",
    "Lithuania": "🇱🇹",
    "Latvia": "🇱🇻",
    "Estonia": "🇪🇪",
    "Georgia": "🇬🇪",
    "Armenia": "🇦🇲",
    "Azerbaijan": "🇦🇿",
    "Kosovo": "🇽🇰",
    "North Macedonia": "🇲🇰",
    "Montenegro": "🇲🇪",
    "Luxembourg": "🇱🇺",
    "Moldova": "🇲🇩",
    "San Marino": "🇸🇲",
    "Malta": "🇲🇹",
    "Cyprus": "🇨🇾",

    // South America
    "Argentina": "🇦🇷",
    "Brazil": "🇧🇷",
    "Uruguay": "🇺🇾",
    "Chile": "🇨🇱",
    "Colombia": "🇨🇴",
    "Ecuador": "🇪🇨",
    "Peru": "🇵🇪",
    "Paraguay": "🇵🇾",
    "Bolivia": "🇧🇴",
    "Venezuela": "🇻🇪",

    // North America
    "USA": "🇺🇸",
    "United States": "🇺🇸",
    "Canada": "🇨🇦",
    "Mexico": "🇲🇽",
    "Jamaica": "🇯🇲",
    "Costa Rica": "🇨🇷",
    "Panama": "🇵🇦",
    "Haiti": "🇭🇹",
    "Honduras": "🇭🇳",
    "El Salvador": "🇸🇻",
    "Cuba": "🇨🇺",
    "Guatemala": "🇬🇹",
    "Dominican Republic": "🇩🇴",
    "Trinidad and Tobago": "🇹🇹",
    "Puerto Rico": "🇵🇷",

    // Africa (FULL SET)
    "South Africa": "🇿🇦",
    "Nigeria": "🇳🇬",
    "Ghana": "🇬🇭",
    "Ivory Coast": "🇨🇮",
    "Senegal": "🇸🇳",
    "Morocco": "🇲🇦",
    "Egypt": "🇪🇬",
    "Tunisia": "🇹🇳",
    "Algeria": "🇩🇿",
    "Angola": "🇦🇴",
    "Cameroon": "🇨🇲",
    "DR Congo": "🇨🇩",
    "Congo": "🇨🇬",
    "Mali": "🇲🇱",
    "Burkina Faso": "🇧🇫",
    "Guinea": "🇬🇳",
    "Guinea-Bissau": "🇬🇼",
    "Mauritania": "🇲🇷",
    "Kenya": "🇰🇪",
    "Uganda": "🇺🇬",
    "Rwanda": "🇷🇼",
    "Tanzania": "🇹🇿",
    "Zambia": "🇿🇲",
    "Zimbabwe": "🇿🇼",
    "Namibia": "🇳🇦",
    "Botswana": "🇧🇼",
    "Benin": "🇧🇯",
    "Togo": "🇹🇬",
    "Sierra Leone": "🇸🇱",
    "Liberia": "🇱🇷",
    "Ethiopia": "🇪🇹",
    "Sudan": "🇸🇩",
    "South Sudan": "🇸🇸",
    "Cape Verde": "🇨🇻",
    "Comoros": "🇰🇲",
    "Madagascar": "🇲🇬",
    "Eswatini": "🇸🇿",
    "Lesotho": "🇱🇸",
    "Gabon": "🇬🇦",
    "Burundi": "🇧🇮",
    "Mozambique": "🇲🇿",

    // Middle East
    "Saudi Arabia": "🇸🇦",
    "UAE": "🇦🇪",
    "Qatar": "🇶🇦",
    "Kuwait": "🇰🇼",
    "Bahrain": "🇧🇭",
    "Oman": "🇴🇲",
    "Jordan": "🇯🇴",
    "Iraq": "🇮🇶",
    "Iran": "🇮🇷",
    "Syria": "🇸🇾",
    "Lebanon": "🇱🇧",
    "Yemen": "🇾🇪",
    "Israel": "🇮🇱",
    "Palestine": "🇵🇸",

    // Asia
    "Japan": "🇯🇵",
    "South Korea": "🇰🇷",
    "North Korea": "🇰🇵",
    "China": "🇨🇳",
    "India": "🇮🇳",
    "Indonesia": "🇮🇩",
    "Malaysia": "🇲🇾",
    "Singapore": "🇸🇬",
    "Australia": "🇦🇺",
    "New Zealand": "🇳🇿",
    "Thailand": "🇹🇭",
    "Vietnam": "🇻🇳",
    "Philippines": "🇵🇭",
    "Bangladesh": "🇧🇩",
    "Pakistan": "🇵🇰",
    "Nepal": "🇳🇵",
    "Sri Lanka": "🇱🇰",

    // Oceania
    "Fiji": "🇫🇯",
    "Solomon Islands": "🇸🇧",
    "Vanuatu": "🇻🇺",
    "New Caledonia": "🇳🇨",
    "Tahiti": "🇵🇫",
    "Papua New Guinea": "🇵🇬",
  };

  // Exact match
  if (map[country]) return map[country];

  // Partial match detection
  for (const key of Object.keys(map)) {
    if (country.includes(key)) return map[key];
  }

  return "🌍";
      }

function toSA(date) {
  return new Date(date).toLocaleTimeString("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Johannesburg"
  });
}

async function fetchFixtures(apiKey, date) {
  return fetch(`https://v3.football.api-sports.io/fixtures?date=${date}`, {
    headers: { "x-apisports-key": apiKey }
  }).then(r => r.json()).then(d => d.response || []);
}

async function hashText(t) {
  const m = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(m)).map(b => b.toString(16).padStart(2, "0")).join("");
        }
