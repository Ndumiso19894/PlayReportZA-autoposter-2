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
      apiKey: !!apiKey, fbToken: !!fbToken, pageId: !!pageId
    }, null, 2), { status: 500 });
  }

  const today = new Date().toISOString().split("T")[0];
  const fixtures = await fetchFixtures(today, apiKey);

  const live = {};
  const ft = {};
  const others = [];

  // TIME RANGE FOR FT FILTER
  const now = new Date();
  const eightHoursAgo = new Date(now.getTime() - 8 * 60 * 60 * 1000);

  for (const f of fixtures) {
    const status = f.fixture.status.short;

    const isLive = ["1H","2H","LIVE","HT","ET","PEN"].includes(status);
    const isFT = ["FT","AET","PEN"].includes(status);

    // ignore non live/FT
    if (!isLive && !isFT) continue;

    const country = f.league.country ?? "Others";
    const league = `${flag(country)} ${country} - ${f.league.name}`;

    const utcDate = new Date(f.fixture.date);
    const saTime = toSA(utcDate);

    const score =
      f.goals.home !== null && f.goals.away !== null
        ? `${f.goals.home}–${f.goals.away}`
        : "";

    const minute =
      isFT ? "FT"
      : status === "HT" ? "HT"
      : f.fixture.status.elapsed ? `${f.fixture.status.elapsed}'`
      : "";

    // goal minutes
    const goals = [];
    if (f.events) {
      for (const ev of f.events) {
        if (ev.type === "Goal" && ev.time?.elapsed) {
          goals.push(`${ev.time.elapsed}'`);
        }
      }
    }
    const goalsLine = goals.length ? `⚽ Goals: ${goals.join(", ")}` : "";

    // stats (LIVE ONLY)
    let stats = "";
    if (isLive && f.statistics?.length > 1) {
      const H = f.statistics[0].statistics;
      const A = f.statistics[1].statistics;

      const cornersH = findStat(H, "Corner Kicks");
      const cornersA = findStat(A, "Corner Kicks");
      const posH = findStat(H, "Ball Possession");
      const posA = findStat(A, "Ball Possession");

      const c = cornersH && cornersA ? `🚩 Corners: ${cornersH}–${cornersA}` : "";
      const p = posH && posA ? `📊 Possession: ${posH}–${posA}` : "";

      stats = [c, p].filter(Boolean).join("\n");
    }

    // derby check
    const derby = isDerby(f.teams.home.name, f.teams.away.name)
      ? "🔥 Derby Match!"
      : "";

    const line =
      `${derby ? derby + "\n" : ""}` +
      `⏱ ${saTime} | ${f.teams.home.name} ${score} ${f.teams.away.name}` +
      (minute ? ` (${minute})` : "") +
      (goalsLine ? `\n${goalsLine}` : "") +
      (stats && isLive ? `\n${stats}` : "");

    if (isLive) {
      if (!live[league]) live[league] = [];
      live[league].push({ time: saTime, text: line });
    }

    if (isFT) {
      // Only last 8 hours
      if (utcDate >= eightHoursAgo) {
        if (!ft[league]) ft[league] = [];
        ft[league].push({ time: saTime, text: line.replace(/\n.*/g, "") });
      }
    }
  }

  // ❗ DO NOT POST IF NO LIVE MATCHES
  if (Object.keys(live).length === 0) {
    return new Response("No live matches - No post made.");
  }

  const post = buildPost(live, ft);

  const fbURL =
    `https://graph.facebook.com/${pageId}/feed?message=${encodeURIComponent(post)}&access_token=${fbToken}`;

  const fbRes = await fetch(fbURL, { method: "POST" });
  const fbData = await fbRes.json();

  if (manual) {
    return new Response(JSON.stringify({
      status: "POST_SENT",
      preview: post.slice(0, 250),
      facebook_result: fbData
    }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  return new Response("OK");
}

// ----------------------- POST BUILDER ------------------------

function buildPost(live, ft) {
  let post = `⚽ *Today's Live Fixtures* (SA Time)\n`;

  // LIVE MATCHES
  post += `\n🔴 LIVE MATCHES\n`;
  for (const league of Object.keys(live)) {
    const sorted = live[league].sort((a,b)=>a.time.localeCompare(b.time));
    post += `\n${league}\n${sorted.map(m=>m.text).join("\n")}\n`;
  }

  // BREAK LINE
  post += `\n━━━━━━━━━━━━━━━━━━━━\n📣 Follow PlayReportZA for instant LIVE score updates!\n━━━━━━━━━━━━━━━━━━━━\n`;

  // FULL TIME
  if (Object.keys(ft).length > 0) {
    post += `\n🟢 FULL-TIME (Last 8 Hours)\n`;
    for (const league of Object.keys(ft)) {
      const sorted = ft[league].sort((a,b)=>b.time.localeCompare(a.time)); // DESCENDING
      post += `\n${league}\n${sorted.map(m=>m.text).join("\n")}\n`;
    }
  }

  // HASHTAGS
  post += `\n#LiveScores #Football #SoccerLive #GlobalMatches #WorldFootball #GoalUpdates #InstantScores #MatchTracker #SportsUpdate #PlayReportZA #TrendingFootball #LiveFeed #SoccerFans #GoalAlert #SportsNight #MatchCentre #FootballUpdates #SoccerFeed #WorldwideFootball #ScoreZone`;

  return post.trim();
}

// ----------------- HELPERS --------------------

function toSA(date) {
  return new Date(date).toLocaleTimeString("en-ZA", {
    hour: "2-digit", minute: "2-digit",
    timeZone: "Africa/Johannesburg"
  });
}

function findStat(arr, name) {
  const s = arr.find(x => x.type === name);
  return s?.value || null;
}

function isDerby(home, away) {
  return home.includes(away.split(" ")[0])
    || away.includes(home.split(" ")[0]);
}

function flag(country) {
  return countryToFlag(country);
}

function countryToFlag(country) {
  if (!country) return "🌍";
  const map = {
    "World":"🌍","International":"🌍",
    "Africa":"🌍","Europe":"🌍","Asia":"🌏",
    "South America":"🌎","North America":"🌎",
    "Argentina":"🇦🇷","Brazil":"🇧🇷","Chile":"🇨🇱",
    "England":"🏴","France":"🇫🇷","Germany":"🇩🇪",
    "Spain":"🇪🇸","Italy":"🇮🇹","Portugal":"🇵🇹",
    "South Africa":"🇿🇦","Egypt":"🇪🇬","Nigeria":"🇳🇬",
    "USA":"🇺🇸","Canada":"🇨🇦","Japan":"🇯🇵",
    "Mexico":"🇲🇽","Uruguay":"🇺🇾","Netherlands":"🇳🇱"
  };
  if (map[country]) return map[country];
  for (const key of Object.keys(map))
    if (country.includes(key)) return map[key];
  return "🌍";
}

async function fetchFixtures(date, apiKey) {
  const res = await fetch(`https://v3.football.api-sports.io/fixtures?date=${date}`, {
    headers: { "x-apisports-key": apiKey }
  });
  const data = await res.json();
  return data.response || [];
        }
