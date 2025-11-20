export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.get("force") === "true") {
      // Manual test in browser: ?force=true
      return await runAutoposter(env, true);
    }
    return new Response("PlayReportZA autoposter is active.");
  },

  async scheduled(event, env, ctx) {
    // Called by your cron (e.g. every 3 / 15 minutes)
    ctx.waitUntil(runAutoposter(env, false));
  }
};

async function runAutoposter(env, manual = false) {
  const apiKey = env.API_FOOTBALL_KEY;
  const fbToken = env.FB_PAGE_TOKEN;
  const pageId = env.FB_PAGE_ID;

  if (!apiKey || !fbToken || !pageId) {
    return new Response(
      JSON.stringify(
        {
          error: "Missing environment variables",
          apiKey: !!apiKey,
          fbToken: !!fbToken,
          pageId: !!pageId
        },
        null,
        2
      ),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const today = new Date().toISOString().split("T")[0];
  const fixtures = await fetchFixtures(today, apiKey);
  const now = new Date();

  const live = {};   // league -> [{ time, text }]
  const ft = {};     // league -> [{ time, text, utc }]
  const others = []; // lines with unknown league/country

  for (const f of fixtures) {
    const status = f.fixture.status.short;

    // Only LIVE + FT style statuses
    const isLive = ["1H", "2H", "HT", "ET", "PEN", "LIVE"].includes(status);
    const isFT   = ["FT", "AET", "PEN"].includes(status);

    if (!isLive && !isFT) continue; // skip upcoming etc.

    const utcDate = new Date(f.fixture.date);
    const saTime  = toSA(utcDate);

    const score =
      f.goals.home !== null && f.goals.away !== null
        ? `${f.goals.home}–${f.goals.away}`
        : "";

    const minute =
      status === "FT"
        ? "FT"
        : status === "HT"
        ? "HT"
        : f.fixture.status.elapsed
        ? `${f.fixture.status.elapsed}'`
        : "";

    // Goal minutes
    const goals = [];
    if (Array.isArray(f.events)) {
      for (const ev of f.events) {
        if (ev.type === "Goal" && ev.time?.elapsed) {
          goals.push(`${ev.time.elapsed}'`);
        }
      }
    }
    const goalsLine = goals.length ? `⚽ Goals: ${goals.join(", ")}` : "";

    // Live-only stats (corners + possession)
    let stats = "";
    if (isLive && Array.isArray(f.statistics) && f.statistics.length > 1) {
      const homeStats = f.statistics[0].statistics || [];
      const awayStats = f.statistics[1].statistics || [];

      const cornersHome = findStat(homeStats, "Corner Kicks");
      const cornersAway = findStat(awayStats, "Corner Kicks");
      const posHome     = findStat(homeStats, "Ball Possession");
      const posAway     = findStat(awayStats, "Ball Possession");

      const corners =
        cornersHome && cornersAway ? `🚩 Corners: ${cornersHome}–${cornersAway}` : "";
      const possession =
        posHome && posAway ? `📊 Possession: ${posHome}–${posAway}` : "";

      stats = [corners, possession].filter(Boolean).join("\n");
    }

    // Detect league + country (for flags). If missing → "Others".
    let leagueName = "Others";
    let country = "World";
    if (f.league && f.league.name) {
      const c = f.league.country || "World";
      leagueName = `${c} - ${f.league.name}`;
      country = c;
    }

    const line =
      `⏱ ${saTime} | ${f.teams.home.name} ${score} ${f.teams.away.name}` +
      (minute ? ` (${minute})` : "") +
      (goalsLine ? `\n${goalsLine}` : "") +
      (stats && isLive ? `\n${stats}` : "");

    if (leagueName === "Others") {
      // No clear league/country info, but we still don't want to lose the match
      others.push({ time: saTime, text: line });
      continue;
    }

    // Grouping
    if (isLive) {
      if (!live[leagueName]) live[leagueName] = [];
      live[leagueName].push({ time: saTime, text: line, country });
    } else if (isFT) {
      // Only FT results within last 8 hours
      const diffHours = (now - utcDate) / (1000 * 60 * 60);
      if (diffHours <= 8) {
        if (!ft[leagueName]) ft[leagueName] = [];
        ft[leagueName].push({ time: saTime, text: line.replace(/\n.*/g, ""), utc: utcDate, country });
      }
    }
  }

  // 🔒 If there are NO live matches at all → DO NOT POST
  const hasLive = Object.values(live).some((arr) => arr.length > 0) || others.length > 0;
  if (!hasLive) {
    const msg = "No live matches right now. Skipping Facebook post.";
    if (manual) {
      return new Response(
        JSON.stringify(
          { status: "NO_LIVE", message: msg },
          null,
          2
        ),
        { headers: { "Content-Type": "application/json" } }
      );
    }
    // For cron: just exit quietly
    return new Response(msg);
  }

  const post = buildPost(live, ft, others);

  const fbURL =
    `https://graph.facebook.com/${pageId}/feed?message=${encodeURIComponent(post)}&access_token=${fbToken}`;

  const fbResponse = await fetch(fbURL, { method: "POST" });
  const fbData = await fbResponse.json();

  if (manual) {
    return new Response(
      JSON.stringify(
        {
          status: "POST_SENT",
          posted_message_preview: post.slice(0, 250),
          facebook_result: fbData
        },
        null,
        2
      ),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response("OK");
}

// ------------------ BUILD POST --------------------

function buildPost(live, ft, others) {
  let post = `⚽ Today's Live Fixtures (SA Time)\n`;

  // LIVE
  if (Object.keys(live).length > 0 || others.length > 0) {
    post += `\n🔴 Live Matches\n`;

    // Normal leagues with country
    for (const league of Object.keys(live)) {
      if (live[league].length === 0) continue;
      const [countryName] = league.split(" - ");
      const flag = countryToFlag(countryName);
      const sorted = live[league].sort((a, b) => a.time.localeCompare(b.time));

      post += `\n📍 ${flag} ${league}\n${sorted.map((m) => m.text).join("\n")}\n`;
    }

    // Others bucket (leagues we couldn't map properly)
    if (others.length > 0) {
      const sortedOthers = others.sort((a, b) => a.time.localeCompare(b.time));
      post += `\n📦 Others\n${sortedOthers.map((m) => m.text).join("\n")}\n`;
    }
  }

  // CHANNEL BREAK MESSAGE
  post += `\n━━━━━━━━━━━━━━━━━━━━\n📣 Follow PlayReportZA for instant live score updates! Please follow the page and like 👍❤️\n━━━━━━━━━━━━━━━━━━━━\n`;

  // FT RESULTS (last 8h only, sorted by time DESC inside each league)
  if (Object.keys(ft).length > 0) {
    post += `\n🟢 Full-Time Results (Last 8 Hours)\n`;
    for (const league of Object.keys(ft)) {
      if (ft[league].length === 0) continue;
      const [countryName] = league.split(" - ");
      const flag = countryToFlag(countryName);

      // Sort by SA time descending (most recent first)
      const sorted = ft[league].sort((a, b) => b.time.localeCompare(a.time));
      post += `\n📍 ${flag} ${league}\n${sorted.map((m) => m.text).join("\n")}\n`;
    }
  }

  // HASHTAGS
  post += `\n#LiveScores #Football #SoccerLive #ScoreUpdate #Matchday #FTResults #LiveMatchTracker #GlobalFootball #SportsUpdates #PlayReportZA`;

  return post.trim();
}

// ----------------- HELPERS --------------------

function toSA(dateObj) {
  return dateObj.toLocaleTimeString("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Johannesburg"
  });
}

function findStat(arr, name) {
  if (!Array.isArray(arr)) return null;
  const s = arr.find((x) => x.type === name);
  return s?.value || null;
}

async function fetchFixtures(date, apiKey) {
  const res = await fetch(`https://v3.football.api-sports.io/fixtures?date=${date}`, {
    headers: { "x-apisports-key": apiKey }
  });
  const data = await res.json();
  return data.response || [];
}

// ----------------- FLAGS --------------------

// Extended flag map: continents + many football countries
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
