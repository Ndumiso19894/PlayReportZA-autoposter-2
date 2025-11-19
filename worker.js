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

  const live = {};
  const ft = {};
  const others = [];

  for (const f of fixtures) {
    const status = f.fixture.status.short;

    // FILTER ONLY LIVE + FT MATCHES
    const isLive = ["1H", "2H", "HT", "ET", "PEN", "LIVE"].includes(status);
    const isFT = ["FT", "AET", "PEN"].includes(status);

    if (!isLive && !isFT) continue; // SKIP everything else

    const league = `${f.league.country} - ${f.league.name}`;

    const saTime = toSA(f.fixture.date);

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
    let goals = [];
    if (f.events) {
      f.events.forEach((ev) => {
        if (ev.type === "Goal" && ev.time?.elapsed) {
          goals.push(`${ev.time.elapsed}'`);
        }
      });
    }
    const goalsLine = goals.length ? `⚽ Goals: ${goals.join(", ")}` : "";

    // STATS FOR LIVE ONLY
    let stats = "";
    if (isLive && f.statistics?.length > 1) {
      const homeStats = f.statistics[0].statistics;
      const awayStats = f.statistics[1].statistics;

      const cornersHome = findStat(homeStats, "Corner Kicks");
      const cornersAway = findStat(awayStats, "Corner Kicks");
      const posHome = findStat(homeStats, "Ball Possession");
      const posAway = findStat(awayStats, "Ball Possession");

      const corners =
        cornersHome && cornersAway ? `🚩 Corners: ${cornersHome}–${cornersAway}` : "";
      const possession =
        posHome && posAway ? `📊 Possession: ${posHome}–${posAway}` : "";

      stats = [corners, possession].filter(Boolean).join("\n");
    }

    const line =
      `⏱ ${saTime} | ${f.teams.home.name} ${score} ${f.teams.away.name}` +
      (minute ? ` (${minute})` : "") +
      (goalsLine ? `\n${goalsLine}` : "") +
      (stats && isLive ? `\n${stats}` : "");

    // GROUPING
    if (isLive) {
      if (!live[league]) live[league] = [];
      live[league].push({ time: saTime, text: line });
    } else if (isFT) {
      if (!ft[league]) ft[league] = [];
      ft[league].push({ time: saTime, text: line.replace(/\n.*/g, "") });
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
  if (Object.keys(live).length > 0) {
    post += `\n🔴 Live Matches\n`;
    for (const league of Object.keys(live)) {
      if (live[league].length === 0) continue;
      const sorted = live[league].sort((a, b) => a.time.localeCompare(b.time));
      post += `\n📍 ${league}\n${sorted.map((m) => m.text).join("\n")}\n`;
    }
  }

  // CHANNEL BREAK MESSAGE
  post += `\n━━━━━━━━━━━━━━━━━━━━\n📣 Follow PlayReportZA for instant live score updates!Please follow the page and like👍❤️\n━━━━━━━━━━━━━━━━━━━━\n`;

  // FT RESULTS
  if (Object.keys(ft).length > 0) {
    post += `\n🟢 Full-Time Results\n`;
    for (const league of Object.keys(ft)) {
      if (ft[league].length === 0) continue;
      const sorted = ft[league].sort((a, b) => a.time.localeCompare(b.time));
      post += `\n📍 ${league}\n${sorted.map((m) => m.text).join("\n")}\n`;
    }
  }

  // OTHERS
  if (others.length > 0) {
    post += `\n📦 *Others*\n${others.join("\n")}\n`;
  }

  // HASHTAGS
  post += `\n#LiveScores #Football #SoccerLive #ScoreUpdate #Matchday #FTResults #LiveMatchTracker #GlobalFootball #SportsUpdates #PlayReportZA`;

  return post.trim();
}

// ----------------- HELPERS --------------------

function toSA(utc) {
  return new Date(utc).toLocaleTimeString("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Johannesburg"
  });
}

function findStat(arr, name) {
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
