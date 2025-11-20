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

// =============================== MAIN ENGINE ===================================

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
  const others = [];

  const now = Date.now();

  for (const f of fixtures) {
    const status = f.fixture.status.short;

    const isLive = ["1H","2H","HT","ET","PEN","LIVE"].includes(status);
    const isFT = ["FT","AET","PEN"].includes(status);

    // Skip unrelated
    if (!isLive && !isFT) continue;

    const saTime = toSA(f.fixture.date);
    const league = formatLeague(f);

    const score = formatScore(f);
    const minute = formatMinute(f, status);

    // Goal events
    const goalsData = extractGoalEvents(f);
    const goalLine = goalsData.length ? `⚽ Goals: ${goalsData.join(", ")}` : "";

    // Stats for LIVE
    const stats = isLive ? extractStats(f) : "";

    // BASE LINE TEXT
    const line = 
      `⏱ ${saTime} | ${maybeDerby(f)}${f.teams.home.name} ${score} ${f.teams.away.name}` +
      (minute ? ` (${minute})` : "") +
      (goalLine ? `\n${goalLine}` : "") +
      (stats ? `\n${stats}` : "");

    if (isLive) {
      if (!live[league]) live[league] = [];
      live[league].push({ time: saTime, text: line });
    }

    if (isFT) {
      const matchEnd = new Date(f.fixture.date).getTime() + 2 * 60 * 60 * 1000;
      if (now - matchEnd <= 8 * 60 * 60 * 1000) {
        if (!ft[league]) ft[league] = [];
        ft[league].push({
          time: saTime,
          text: line.replace(/\n.*/g, "")
        });
      }
    }
  }

  // DO NOT POST if NO LIVE MATCHES
  if (Object.keys(live).length === 0) {
    return new Response("NO LIVE MATCHES — No Post.");
  }

  const post = buildPost(live, ft);

  const fbURL =
    `https://graph.facebook.com/${pageId}/feed?message=${encodeURIComponent(post)}&access_token=${fbToken}`;

  const fbResponse = await fetch(fbURL, { method: "POST" });
  const fbData = await fbResponse.json();

  if (manual) {
    return new Response(JSON.stringify({
      status: "POST_SENT",
      preview: post.slice(0, 350),
      facebook_response: fbData
    }, null, 2));
  }

  return new Response("OK");
}

// =============================== POST BUILDER ==================================

function buildPost(live, ft) {
  let post = `⚽ Today's Live Football Fixtures ⚽\n`;

  // LIVE
  post += `\n🔴 LIVE MATCHES\n`;
  for (const league of Object.keys(live)) {
    const sorted = live[league].sort((a,b) => a.time.localeCompare(b.time));
    post += `\n${league}\n${sorted.map(m => m.text).join("\n")}\n`;
  }

  post += `\n━━━━━━━━━━━━━━━━━━\n📣 Follow PlayReportZA for instant score updates!\n━━━━━━━━━━━━━━━━━━\n`;

  // FULL TIME
  if (Object.keys(ft).length > 0) {
    post += `\n🟢 FULL-TIME RESULTS (LAST 8 HOURS)\n`;
    for (const league of Object.keys(ft)) {
      const sorted = ft[league].sort((a,b) => b.time.localeCompare(a.time));
      post += `\n${league}\n${sorted.map(m => m.text).join("\n")}\n`;
    }
  }

  // HASHTAGS
  post += `
#Football #LiveScores #SoccerUpdates #MatchDay #ScoreUpdate #FullTime #GoalAlert #SportsNews #WorldFootball #PlayReportZA #LiveMatchTracker #InstantScores #SoccerFans #InternationalFootball #LeagueUpdates #LiveSports #FootballStats #UEFAChampionsLeague #EuropaLeague #ConferenceLeague #PremierLeague #LaLiga #SerieA #Bundesliga #Ligue1 #Eredivisie #MLS #AFCON #CAFChampionsLeague #FIFAWorldCup #UCLNight #CopaLibertadores #EuropaConferenceLeague #SaudiProLeague #CarabaoCup #FAcup
#EuroQualifiers #TodayMatches #ScoreFeed #GlobalSport`;

  return post.trim();
}

// =============================== FORMATTERS =====================================

function formatLeague(f) {
  const flag = countryToFlag(f.league.country);
  return `${flag} ${f.league.country} - ${f.league.name}`;
}

function formatScore(f) {
  if (f.goals.home === null) return "";
  return `${f.goals.home}–${f.goals.away}`;
}

function formatMinute(f, status) {
  if (status === "FT") return "FT";
  if (status === "HT") return "HT";
  if (f.fixture.status.elapsed)
    return `${f.fixture.status.elapsed}'`;
  return "";
}

function extractGoalEvents(f) {
  if (!f.events) return [];
  const arr = [];
  f.events.forEach(ev => {
    if (ev.type === "Goal" && ev.time?.elapsed) {
      if (ev.player?.name) {
        arr.push(`${ev.time.elapsed}' ${ev.player.name}`);
      } else {
        arr.push(`${ev.time.elapsed}'`);
      }
    }
  });
  return arr;
}

function extractStats(f) {
  if (!f.statistics || f.statistics.length < 2) return "";

  const H = f.statistics[0].statistics;
  const A = f.statistics[1].statistics;

  const corners = statPair(H, A, "Corner Kicks", "🚩 Corners");
  const poss = statPair(H, A, "Ball Possession", "📊 Possession");
  const sot = statPair(H, A, "Shots on Goal", "🎯 On Target");
  const sof = statPair(H, A, "Shots off Goal", "🎯 Off Target");

  return [corners, poss, sot, sof].filter(Boolean).join("\n");
}

function statPair(home, away, key, label) {
  const h = findStat(home, key);
  const a = findStat(away, key);
  if (!h || !a) return "";
  return `${label}: ${h}–${a}`;
}

// =============================== FLAGS ==========================================

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

function maybeDerby(f) {
  const A = f.teams.home.name.toLowerCase();
  const B = f.teams.away.name.toLowerCase();
  if (A.includes(B) || B.includes(A)) return "🔥 ";
  return "";
}

// =============================== HELPERS ========================================

function findStat(arr, name) {
  const s = arr.find(x => x.type === name);
  return s?.value || null;
}

async function fetchFixtures(date, apiKey) {
  const res = await fetch(`https://v3.football.api-sports.io/fixtures?date=${date}`, {
    headers: { "x-apisports-key": apiKey }
  });
  const data = await res.json();
  return data.response || [];
}

function toSA(utc) {
  return new Date(utc).toLocaleTimeString("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Johannesburg"
  });
          }
