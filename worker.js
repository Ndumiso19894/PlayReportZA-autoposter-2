export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.get("force") === "true") {
      return await runAutoposter(env, true);
    }
    return new Response("PlayReportZA autoposter is active.");
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAutoposter(env, false));
  }
};

async function runAutoposter(env, manual = false) {
  const apiKey = env.API_FOOTBALL_KEY;
  const fbToken = env.FB_PAGE_TOKEN;
  const pageId = env.FB_PAGE_ID;

  if (!apiKey || !fbToken || !pageId) {
    return new Response(JSON.stringify({
      error: "Missing environment variables",
      apiKey: !!apiKey,
      fbToken: !!fbToken,
      pageId: !!pageId
    }, null, 2), { status: 500 });
  }

  const today = new Date().toISOString().split("T")[0];
  const fixtures = await fetchFixtures(today, apiKey);

  const live = {};
  const ft = {};
  const pending = {};
  const others = [];

  const now = new Date();

  for (const f of fixtures) {
    const status = f.fixture.status.short;
    const league = formatLeague(f);

    const saTime = toSA(f.fixture.date);
    const localFixtureTime = new Date(f.fixture.date);

    const score =
      f.goals.home !== null && f.goals.away !== null
        ? `${f.goals.home}–${f.goals.away}`
        : "";

    // ------------------------------
    // 🔥 (1) Detect Live minute, Added Time, Extra Time
    // ------------------------------

    let minuteDisplay = "";
    const elapsed = f.fixture.status.elapsed;
    const added = f.fixture.status.extra;

    if (status === "FT") minuteDisplay = "FT";
    else if (status === "HT") minuteDisplay = "HT";
    else if (status === "ET") minuteDisplay = `${elapsed}' (ET)`;
    else if (status === "PEN") minuteDisplay = `Penalty Shootout`;
    else if (elapsed) minuteDisplay = `${elapsed}'${added ? `+${added}` : ""}`;
    else minuteDisplay = ""; // fallback

    // ------------------------------
    // 🔥 (2) Handle Postponed / Cancelled / Suspended / Not Started
    // ------------------------------

    if (["PST", "SUS", "CANC", "ABD", "AWD", "WO"].includes(status)) {
      const tag =
        status === "PST"
          ? "❌ Postponed"
          : status === "SUS"
          ? "⚠️ Suspended"
          : status === "CANC"
          ? "❌ Cancelled"
          : "⚠️ Match Issue";

      if (!others[league]) others[league] = [];
      others.push(`⏱ ${saTime} | ${f.teams.home.name} vs ${f.teams.away.name} — ${tag}`);
      continue;
    }

    // ------------------------------
    // 🔥 (3) Detect PENDING (match should be live but no data yet)
    // ------------------------------

    if (status === "NS" && now > localFixtureTime) {
      if (!pending[league]) pending[league] = [];
      pending[league].push({
        time: saTime,
        text: `⏳ ${saTime} | ${f.teams.home.name} vs ${f.teams.away.name} (Pending)`
      });
      continue;
    }

    // ------------------------------
    // 🔥 (4) Filter Live vs Full Time (8 hours limit)
    // ------------------------------

    const isLive = ["1H", "2H", "HT", "ET", "PEN", "LIVE"].includes(status);

    const isFT = status === "FT" && withinLastHours(f.fixture.date, 8);

    if (!isLive && !isFT) continue;

    // ------------------------------
    // 🔥 (5) Goal minutes + scorers
    // ------------------------------

    let goals = [];
    if (f.events) {
      f.events.forEach((ev) => {
        if (ev.type === "Goal") {
          const t = ev.time?.elapsed ? `${ev.time.elapsed}'` : "";
          const scorer = ev.player?.name || "";
          goals.push(`${t} ${scorer}`);
        }
      });
    }
    const goalsLine = goals.length ? `⚽ Goals: ${goals.join(", ")}` : "";

    // ------------------------------
    // 🔥 (6) Stats (Live only)
    // ------------------------------

    let stats = "";
    if (isLive && f.statistics?.length > 1) {
      const homeStats = f.statistics[0].statistics;
      const awayStats = f.statistics[1].statistics;

      const corners = statPair(homeStats, awayStats, "Corner Kicks", "🚩 Corners");
      const possession = statPair(homeStats, awayStats, "Ball Possession", "📊 Possession");
      const shotsOn = statPair(homeStats, awayStats, "Shots on Goal", "🎯 Shots on Target");
      const shotsOff = statPair(homeStats, awayStats, "Shots off Goal", "🥅 Shots Off Target");

      stats = [corners, possession, shotsOn, shotsOff].filter(Boolean).join("\n");
    }

    // ------------------------------
    // 🔥 (7) Final match line
    // ------------------------------

    const line =
      `⏱ ${saTime} | ${countryToFlag(f.league.country)} ${f.teams.home.name} ${score} ${f.teams.away.name}` +
      (minuteDisplay ? ` (${minuteDisplay})` : "") +
      (goalsLine ? `\n${goalsLine}` : "") +
      (stats && isLive ? `\n${stats}` : "");

    if (isLive) {
      if (!live[league]) live[league] = [];
      live[league].push({ time: saTime, text: line });
    } else if (isFT) {
      if (!ft[league]) ft[league] = [];
      ft[league].push({ time: saTime, text: line.replace(/\n.*/g, "") });
    }
  }

  // DO NOT POST IF NO LIVE MATCHES
  if (Object.keys(live).length === 0) {
    if (manual) {
      return new Response("No live matches → No post generated.");
    }
    return new Response("Skipped — no live matches.");
  }

  const post = buildPost(live, pending, ft);

  const fbURL = `https://graph.facebook.com/${pageId}/feed?message=${encodeURIComponent(
    post
  )}&access_token=${fbToken}`;

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

// -----------------------------
// 📌 BUILD POST
// -----------------------------

function buildPost(live, pending, ft) {
  let post = `⚽ Today's Live Fixtures ⚽ (SA Time)\n`;

  // 🔥 LIVE
  post += `\n🔴 LIVE MATCHES\n`;
  for (const league of Object.keys(live)) {
    const sorted = live[league].sort((a, b) => a.time.localeCompare(b.time));
    post += `\n📍 ${league}\n${sorted.map((x) => x.text).join("\n")}\n`;
  }

  // 🔥 PENDING
  if (Object.keys(pending).length > 0) {
    post += `\n⏳ Pending Matches\n`;
    for (const league of Object.keys(pending)) {
      const sorted = pending[league].sort((a, b) => a.time.localeCompare(b.time));
      post += `\n📍 ${league}\n${sorted.map((x) => x.text).join("\n")}\n`;
    }
  }

  post +=
    `\n━━━━━━━━━━━━━━━━━━━━` +
    `\n📣 Follow PlayReportZA for instant live score updates! Like & Follow ❤️` +
    `\n━━━━━━━━━━━━━━━━━━━━\n`;

  // 🔥 FULL-TIME (8 HOURS ONLY)
  if (Object.keys(ft).length > 0) {
    post += `\n🟢 Most Recent Full-Time Results\n`;
    for (const league of Object.keys(ft)) {
      const sorted = ft[league].sort((a, b) => b.time.localeCompare(a.time)); // DESCENDING
      post += `\n📍 ${league}\n${sorted.map((x) => x.text).join("\n")}\n`;
    }
  }

  post += `\n#LiveScores #Football #SoccerLive #SportsUpdate #Matchday #GlobalFootball #FTResults #PlayReportZA #LiveMatchTracker #WorldFootball`;

  return post.trim();
}

// -----------------------------
// 📌 HELPERS
// -----------------------------

function statPair(home, away, key, label) {
  const h = findStat(home, key);
  const a = findStat(away, key);
  return h && a ? `${label}: ${h}–${a}` : "";
}

function toSA(utc) {
  return new Date(utc).toLocaleTimeString("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Johannesburg"
  });
}

function withinLastHours(utcDate, hours) {
  const diff = Date.now() - new Date(utcDate).getTime();
  return diff <= hours * 3600000;
}

function formatLeague(f) {
  return `${countryToFlag(f.league.country)} ${f.league.country} - ${f.league.name}`;
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

function findStat(arr, name) {
  const s = arr.find((x) => x.type === name);
  return s?.value || null;
}

async function fetchFixtures(date, apiKey) {
  const res = await fetch(
    `https://v3.football.api-sports.io/fixtures?date=${date}`,
    { headers: { "x-apisports-key": apiKey } }
  );
  const data = await res.json();
  return data.response || [];
}
