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

// ======================================================
// ⚽ MAIN AUTPOSTER
// ======================================================

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

  for (const f of fixtures) {
    const status = f.fixture.status.short;

    const isLive = ["1H", "2H", "HT", "ET", "PEN", "LIVE"].includes(status);
    const isFT = ["FT", "AET", "PEN"].includes(status);

    if (!isLive && !isFT) continue;

    const country = f.league.country || "Others";
    const league = f.league.name || "Unknown League";
    const flag = countryToFlag(country);

    const leagueKey = `${flag} ${country} - ${league}`;

    const saTime = toSA(f.fixture.date);

    // SCORE COLOR BOXES
    let scoreBox = "";
    if (f.goals.home !== null && f.goals.away !== null) {
      const h = f.goals.home;
      const a = f.goals.away;

      const homeBox =
        h > a ? `✌️ ${h}` : h < a ? ❌ ${h}` : `🤝 ${h}`;
      const awayBox =
        a > h ? `✌️ ${a}` : a < h ? `❌ ${a}` : `🤝 ${a}`;

      scoreBox = `${homeBox} - ${awayBox}`;
    }

    const minute =
      status === "FT"
        ? "FT"
        : status === "HT"
        ? "HT"
        : f.fixture.status.elapsed
        ? `${f.fixture.status.elapsed}'`
        : "";

    // Goals + scorers
    let goalLines = [];
    if (f.events) {
      f.events.forEach(ev => {
        if (ev.type === "Goal" && ev.time?.elapsed) {
          const who =
            ev.player?.name
              ? `${ev.player.name}`
              : "Unknown player";

          goalLines.push(`⚽ ${ev.time.elapsed}' — ${who}`);
        }
      });
    }
    const goalsSection = goalLines.length ? goalLines.join("\n") : "";

    // Stats (LIVE only)
    let stats = "";
    if (isLive && f.statistics?.length > 1) {
      const homeStats = f.statistics[0].statistics;
      const awayStats = f.statistics[1].statistics;

      const cH = findStat(homeStats, "Corner Kicks");
      const cA = findStat(awayStats, "Corner Kicks");
      const pH = findStat(homeStats, "Ball Possession");
      const pA = findStat(awayStats, "Ball Possession");

      const corners =
        cH && cA ? `🚩 Corners: ${cH}–${cA}` : "";
      const possession =
        pH && pA ? `📊 Possession: ${pH}–${pA}` : "";

      stats = [corners, possession].filter(Boolean).join("\n");
    }

    // FULL MATCH LINE
    const line =
      `⏱ ${saTime} • ${f.teams.home.name} ${scoreBox} ${f.teams.away.name}` +
      (minute ? ` (${minute})` : "") +
      (goalsSection ? `\n${goalsSection}` : "") +
      (stats && isLive ? `\n${stats}` : "");

    // GROUPING
    if (isLive) {
      if (!live[leagueKey]) live[leagueKey] = [];
      live[leagueKey].push({ time: saTime, text: line });
    } else if (isFT) {
      if (!ft[leagueKey]) ft[leagueKey] = [];
      ft[leagueKey].push({ time: saTime, text: line.replace(/\n.*/g, "") });
    } else {
      others.push(line);
    }
  }

  const post = buildPost(live, ft, others);

  const fbURL =
    `https://graph.facebook.com/${pageId}/feed?message=${encodeURIComponent(post)}&access_token=${fbToken}`;

  const fbResponse = await fetch(fbURL, { method: "POST" });
  const fbData = await fbResponse.json();

  if (manual) {
    return new Response(JSON.stringify({
      status: "POST_SENT",
      posted_message_preview: post.slice(0, 350),
      facebook_result: fbData
    }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  return new Response("OK");
}

// ======================================================
// POST BUILDER
// ======================================================

function buildPost(live, ft, others) {
  let post = `⚽ Today's Live Fixtures ⚽ (South African Time)\n`;

  // LIVE FIRST
  if (Object.keys(live).length > 0) {
    post += `\n🔴 LIVE MATCHES\n`;
    for (const league of Object.keys(live)) {
      if (live[league].length === 0) continue;
      const sorted = live[league].sort((a, b) => a.time.localeCompare(b.time));
      post += `\n${league}\n${sorted.map(m => m.text).join("\n")}\n`;
    }
  }

  // BREAK MESSAGE
  post += `\n━━━━━━━━━━━━━━━━━━\n📣 Follow PlayReportZA for the fastest live updates ❤️🔥\n━━━━━━━━━━━━━━━━━━\n`;

  // FULL TIME (DESCENDING)
  if (Object.keys(ft).length > 0) {
    post += `\n🟢 FULL-TIME RESULTS💯\n`;
    for (const league of Object.keys(ft)) {
      const sorted = ft[league].sort((a, b) => b.time.localeCompare(a.time)); // DESCENDING
      post += `\n${league}\n${sorted.map(m => m.text).join("\n")}\n`;
    }
  }

  // OTHERS
  if (others.length > 0) {
    post += `\n📦 *Others*\n${others.join("\n")}\n`;
  }

  // HASHTAGS
  post += `\n#LiveScores #ScoreZone #FootballUpdates #SoccerLive #MatchDay #FTResults #PlayReportZA #SportsNews #GoalUpdate #WorldwideFootball #TrendingFootball #ScoreUpdates #FootballFeed #SoccerStats #DailyFootball`;

  return post.trim();
}

// ======================================================
// HELPERS
// ======================================================

function toSA(utc) {
  return new Date(utc).toLocaleTimeString("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Johannesburg"
  });
}

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

// ======================================================
// COUNTRY FLAG DETECTOR
// ======================================================

function countryToFlag(country) {
  if (!country) return "🌍";

  const map = {
    "World": "🌍",
    "International": "🌍",
    "Europe": "🌍",
    "Africa": "🌍",
    "Asia": "🌏",
    "South America": "🌎",
    "North America": "🌎",

    "Argentina": "🇦🇷",
    "Bolivia": "🇧🇴",
    "Brazil": "🇧🇷",
    "Chile": "🇨🇱",
    "Colombia": "🇨🇴",
    "Ecuador": "🇪🇨",
    "Paraguay": "🇵🇾",
    "Peru": "🇵🇪",
    "Uruguay": "🇺🇾",
    "Venezuela": "🇻🇪",

    "England": "🇬🇧",
    "Wales": "🇬🇧",
    "Scotland": "🇬🇧",
    "Ireland": "🇮🇪",

    "France": "🇫🇷",
    "Germany": "🇩🇪",
    "Spain": "🇪🇸",
    "Portugal": "🇵🇹",
    "Italy": "🇮🇹",
    "Belgium": "🇧🇪",
    "Netherlands": "🇳🇱",
    "Sweden": "🇸🇪",
    "Norway": "🇳🇴",
    "Denmark": "🇩🇰",
    "Finland": "🇫🇮",
    "Iceland": "🇮🇸",
    "Ukraine": "🇺🇦",
    "Poland": "🇵🇱",
    "Serbia": "🇷🇸",
    "Greece": "🇬🇷",
    "Turkey": "🇹🇷",
    "Austria": "🇦🇹",
    "Czechia": "🇨🇿",
    "Romania": "🇷🇴",
    "Croatia": "🇭🇷",
    "Slovenia": "🇸🇮",

    "USA": "🇺🇸",
    "Canada": "🇨🇦",
    "Mexico": "🇲🇽",

    "Japan": "🇯🇵",
    "South Korea": "🇰🇷",

    "South Africa": "🇿🇦",
    "Nigeria": "🇳🇬",
    "Ghana": "🇬🇭",
    "Egypt": "🇪🇬",
    "Morocco": "🇲🇦",
  };

  if (map[country]) return map[country];

  for (const key of Object.keys(map)) {
    if (country.includes(key)) return map[key];
  }

  return "🌍";
        }
