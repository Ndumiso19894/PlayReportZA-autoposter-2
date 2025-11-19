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

  // If ANY variable missing → return error
  if (!apiKey || !fbToken || !pageId) {
    return new Response(JSON.stringify({
      error: "Missing environment variables",
      apiKey: !!apiKey,
      fbToken: !!fbToken,
      pageId: !!pageId
    }, null, 2), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const today = new Date().toISOString().split("T")[0];
    const fixtures = await fetchFixtures(today, apiKey);

    let LIVE = {};
    let HT = {};
    let FT = {};

    for (const f of fixtures) {
      const league = `${f.league.country} - ${f.league.name}`;
      const status = f.fixture.status.short;

      if (!LIVE[league]) LIVE[league] = [];
      if (!HT[league]) HT[league] = [];
      if (!FT[league]) FT[league] = [];

      // Convert time
      const saTime = convertToSouthAfricanTime(f.fixture.date);

      // Minute indicator
      let minute = "";
      if (status === "LIVE" && f.fixture.status.elapsed) {
        minute = `${f.fixture.status.elapsed}'`;
      } else if (status === "HT") {
        minute = "HT";
      } else if (status === "FT") {
        minute = "FT";
      }

      // Score
      const goals = 
        f.goals.home !== null && f.goals.away !== null
          ? `${f.goals.home}–${f.goals.away}`
          : "";

      // GOAL MINUTES + SCORERS
      let goalsLine = "";
      if (f.events) {
        const goalEvents = f.events.filter((ev) => ev.type === "Goal");
        if (goalEvents.length > 0) {
          const gList = goalEvents.map((g) => {
            const scorer = g.player?.name || "Unknown";
            const min = g.time?.elapsed ? `${g.time.elapsed}'` : "";
            return `${scorer} ${min}`;
          });
          goalsLine = `⚽ Goals: ${gList.join(", ")}`;
        }
      }

      // STATS (Corners + Possession)
      let statsLine = "";
      if (f.statistics?.length > 0) {
        const homeStats = f.statistics[0].statistics || [];
        const awayStats = f.statistics[1].statistics || [];

        const cornersHome = findStat(homeStats, "Corner Kicks");
        const cornersAway = findStat(awayStats, "Corner Kicks");

        const posHome = findStat(homeStats, "Ball Possession");
        const posAway = findStat(awayStats, "Ball Possession");

        const corners = (cornersHome && cornersAway) 
          ? `🚩 Corners: ${cornersHome}–${cornersAway}` 
          : "";

        const possession = (posHome && posAway)
          ? `📊 Possession: ${posHome}–${posAway}`
          : "";

        statsLine = [corners, possession].filter(Boolean).join("\n");
      }

      const line =
        `⏱ ${saTime} | ${f.teams.home.name} ${goals} ${f.teams.away.name}` +
        (minute ? ` (${minute})` : "") +
        (goalsLine ? `\n${goalsLine}` : "") +
        (statsLine ? `\n${statsLine}` : "");

      // Sort into groups
      if (status === "LIVE") LIVE[league].push({ time: saTime, text: line });
      else if (status === "HT") HT[league].push({ time: saTime, text: line });
      else if (status === "FT") FT[league].push({ time: saTime, text: line });
    }

    const post = buildPost(LIVE, HT, FT);

    // Facebook POST
    const fbURL =
      `https://graph.facebook.com/${pageId}/feed?` +
      `message=${encodeURIComponent(post)}&access_token=${fbToken}`;

    const fbResponse = await fetch(fbURL, { method: "POST" });
    const fbData = await fbResponse.json();

    if (manual) {
      return new Response(JSON.stringify({
        status: "POST_SENT",
        posted_message_preview: post.slice(0, 300),
        facebook_result: fbData
      }, null, 2), {
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response("OK");
  } catch (err) {
    return new Response("Error: " + err.message, { status: 500 });
  }
}

async function fetchFixtures(date, apiKey) {
  const res = await fetch(`https://v3.football.api-sports.io/fixtures?date=${date}&live=all`, {
    headers: { "x-apisports-key": apiKey }
  });
  const data = await res.json();
  return data.response || [];
}

function findStat(stats, name) {
  const item = stats.find((s) => s.type === name);
  return item?.value || null;
}

function convertToSouthAfricanTime(utcDate) {
  return new Date(utcDate).toLocaleTimeString("en-ZA", {
    timeZone: "Africa/Johannesburg",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function buildPost(LIVE, HT, FT) {
  let post = `⚽ Today's Live Fixtures (SA Time)\n`;

  // LIVE
  if (Object.keys(LIVE).length > 0) {
    post += `\n🔴 LIVE MATCHES\n`;
    for (const league of Object.keys(LIVE)) {
      const sorted = LIVE[league].sort((a, b) => a.time.localeCompare(b.time));
      post += `\n📍 ${league}\n` + sorted.map((m) => m.text).join("\n") + "\n";
    }
  }

  // HT
  if (Object.keys(HT).length > 0) {
    post += `\n🟡 HALF-TIME\n`;
    for (const league of Object.keys(HT)) {
      const sorted = HT[league].sort((a, b) => a.time.localeCompare(b.time));
      post += `\n📍 ${league}\n` + sorted.map((m) => m.text).join("\n") + "\n";
    }
  }

  // FT
  if (Object.keys(FT).length > 0) {
    post += `\n🟢 FULL-TIME RESULTS\n`;
    for (const league of Object.keys(FT)) {
      const sorted = FT[league].sort((a, b) => a.time.localeCompare(b.time));
      post += `\n📍 ${league}\n` + sorted.map((m) => m.text).join("\n") + "\n";
    }
  }

  // CTA
  post += `\n📣 Follow PlayReportZA for more live updates!\n#football #livescores #PlayReportZA\n`;

  return post.trim();
      }
