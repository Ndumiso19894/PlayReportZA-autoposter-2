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
      JSON.stringify({
        error: "Missing environment variables",
        apiKey: !!apiKey,
        fbToken: !!fbToken,
        pageId: !!pageId
      }, null, 2),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const today = new Date().toISOString().split("T")[0];
    const fixtures = await fetchFixtures(today, apiKey);

    // GROUP BY:
    // 🔸 League
    // 🔸 Status (LIVE / HT / FT)
    const live = {};
    const ht = {};
    const ft = {};

    for (const f of fixtures) {
      const leagueName = `${f.league.country} - ${f.league.name}`;
      const status = f.fixture.status.short;

      if (!live[leagueName]) live[leagueName] = [];
      if (!ht[leagueName]) ht[leagueName] = [];
      if (!ft[leagueName]) ft[leagueName] = [];

      const saTime = convertToSouthAfricanTime(f.fixture.date);
      const currentMinute =
        status === "FT"
          ? "FT"
          : status === "HT"
          ? "HT"
          : f.fixture.status.elapsed
          ? `${f.fixture.status.elapsed}'`
          : "";

      let goals = "";
      if (f.goals.home !== null && f.goals.away !== null) {
        goals = `${f.goals.home}–${f.goals.away}`;
      }

      // GOAL MINUTES
      const goalMinutes = [];
      if (f.events) {
        f.events.forEach((ev) => {
          if (ev.type === "Goal") {
            if (ev.time && ev.time.elapsed) {
              goalMinutes.push(`${ev.time.elapsed}'`);
            }
          }
        });
      }

      const goalLine =
        goalMinutes.length > 0 ? `⚽ Goals: ${goalMinutes.join(", ")}` : "";

      // CORNERS + POSSESSION
      let statsLine = "";
      if (f.statistics?.length > 0) {
        const homeStats = f.statistics[0]?.statistics || [];
        const awayStats = f.statistics[1]?.statistics || [];

        const cornersHome = findStat(homeStats, "Corner Kicks");
        const cornersAway = findStat(awayStats, "Corner Kicks");

        const posHome = findStat(homeStats, "Ball Possession");
        const posAway = findStat(awayStats, "Ball Possession");

        const corners =
          cornersHome && cornersAway ? `🚩 Corners: ${cornersHome}–${cornersAway}` : "";

        const possession =
          posHome && posAway ? `📊 Possession: ${posHome}–${posAway}` : "";

        statsLine = [corners, possession].filter(Boolean).join("\n");
      }

      const line =
        `⏱ ${saTime} | ${f.teams.home.name} ${goals} ${f.teams.away.name}` +
        (currentMinute ? ` (${currentMinute})` : "") +
        (goalLine ? `\n${goalLine}` : "") +
        (statsLine ? `\n${statsLine}` : "");

      if (status === "LIVE") live[leagueName].push({ time: saTime, text: line });
      else if (status === "HT") ht[leagueName].push({ time: saTime, text: line });
      else if (status === "FT") ft[leagueName].push({ time: saTime, text: line });
    }

    const post = buildPost(live, ht, ft);

    const fbURL =
      `https://graph.facebook.com/${pageId}/feed?` +
      `message=${encodeURIComponent(post)}&access_token=${fbToken}`;

    const fbResponse = await fetch(fbURL, { method: "POST" });
    const fbData = await fbResponse.json();

    if (manual) {
      return new Response(
        JSON.stringify(
          {
            status: "POST_SENT",
            posted_message_preview: post.slice(0, 200),
            facebook_result: fbData
          },
          null,
          2
        ),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    console.log("Auto post result:", fbData);
    return new Response("OK");
  } catch (err) {
    return new Response("Error: " + err.message, {
      status: 500
    });
  }
}

async function fetchFixtures(date, apiKey) {
  const res = await fetch(`https://v3.football.api-sports.io/fixtures?date=${date}`, {
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
  const date = new Date(utcDate);
  return date.toLocaleTimeString("en-ZA", {
    timeZone: "Africa/Johannesburg",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function buildPost(live, ht, ft) {
  let post = `⚽ *Today's Live Fixtures* (SA Time)\n\n`;

  // LIVE FIRST
  if (Object.keys(live).length > 0) {
    post += `🔴 LIVE MATCHES\n`;
    for (const league of Object.keys(live)) {
      const sorted = live[league].sort((a, b) => a.time.localeCompare(b.time));
      post += `\n📍 ${league}\n` + sorted.map((m) => m.text).join("\n") + "\n";
    }
  }

  // HT
  if (Object.keys(ht).length > 0) {
    post += `\n🟡 HALF-TIME\n`;
    for (const league of Object.keys(ht)) {
      const sorted = ht[league].sort((a, b) => a.time.localeCompare(b.time));
      post += `\n📍 ${league}\n` + sorted.map((m) => m.text).join("\n") + "\n";
    }
  }

  // FT
  if (Object.keys(ft).length > 0) {
    post += `\n🟢 FULL-TIME RESULTS\n`;
    for (const league of Object.keys(ft)) {
      const sorted = ft[league].sort((a, b) => a.time.localeCompare(b.time));
      post += `\n📍 ${league}\n` + sorted.map((m) => m.text).join("\n") + "\n";
    }
  }

  // HASHTAGS + CTA
  post += `\n\n📣 Follow PlayReportZA for more updates!\n#Football #Livescore #PlayReportZA`;

  return post.trim();
}
