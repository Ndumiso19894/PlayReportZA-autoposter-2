export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Manual test: ?force=true
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

  // Safety check for env vars
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

  // Grouped buckets
  const live = {}; // live matches (1H, 2H, ET, PEN)
  const ht = {};   // half-time
  const ft = {};   // full-time (all day, sorted by time, no stats)

  for (const f of fixtures) {
    const statusShort = f.fixture?.status?.short || "";
    const league = `${f.league.country} - ${f.league.name}`;

    if (!live[league]) live[league] = [];
    if (!ht[league]) ht[league] = [];
    if (!ft[league]) ft[league] = [];

    const saTime = toSA(f.fixture.date);

    // Score
    const score =
      f.goals.home !== null && f.goals.away !== null
        ? `${f.goals.home}–${f.goals.away}`
        : "–";

    // Minute / status label
    let minuteLabel = "";
    if (statusShort === "HT") {
      minuteLabel = "HT";
    } else if (statusShort === "FT" || statusShort === "AET") {
      minuteLabel = "FT";
    } else if (f.fixture.status?.elapsed) {
      minuteLabel = `${f.fixture.status.elapsed}'`;
    }

    // Goal minutes (if event data available)
    let goals = [];
    if (f.events && Array.isArray(f.events)) {
      f.events.forEach((ev) => {
        if (ev.type === "Goal" && ev.time?.elapsed) {
          goals.push(`${ev.time.elapsed}'`);
        }
      });
    }
    const goalsLine = goals.length ? `⚽ Goals: ${goals.join(", ")}` : "";

    // Stats (corners + possession) – ONLY for LIVE + HT
    let stats = "";
    if (statusShort !== "FT" && statusShort !== "AET" && f.statistics?.length > 1) {
      const homeStats = f.statistics[0].statistics || [];
      const awayStats = f.statistics[1].statistics || [];

      const cH = findStat(homeStats, "Corner Kicks");
      const cA = findStat(awayStats, "Corner Kicks");

      const pH = findStat(homeStats, "Ball Possession");
      const pA = findStat(awayStats, "Ball Possession");

      const corners =
        cH && cA ? `🚩 Corners: ${cH}–${cA}` : "";
      const possession =
        pH && pA ? `📊 Possession: ${pH}–${pA}` : "";

      stats = [corners, possession].filter(Boolean).join("   ");
    }

    // Build display line in “ScoreZone-style” but clean
    // Example:
    // ◉ 61' | Team A 2–1 Team B
    //    ⚽ Goals: 12', 45'
    //    🚩 Corners: 4–3   📊 Possession: 52%–48%
    const baseLine =
      `◉ ${minuteLabel || "LIVE🔴"} | ${f.teams.home.name} ${score} ${f.teams.away.name}`;

    const extras = [];
    if (goalsLine) extras.push(goalsLine);
    if (stats) extras.push(stats);

    const fullLine =
      extras.length > 0
        ? `${baseLine}\n   ${extras.join("\n   ")}`
        : baseLine;

    // Also keep a short line for FT (no stats)
    const ftLine = `◉ FT | ${f.teams.home.name} ${score} ${f.teams.away.name}`;

    // Decide bucket
    if (isLiveStatus(statusShort)) {
      live[league].push({ time: saTime, text: fullLine });
    } else if (statusShort === "HT") {
      ht[league].push({ time: saTime, text: fullLine });
    } else if (statusShort === "FT" || statusShort === "AET") {
      ft[league].push({ time: saTime, text: ftLine });
    }
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
          posted_message_preview: post.slice(0, 300),
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

// -------------------------------------------
// Helpers
// -------------------------------------------

function buildPost(live, ht, ft) {
  const nowSA = new Date().toLocaleTimeString("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Johannesburg"
  });

  // Header like ScoreZone but in your style
  let post = `⏳ LIVE SCORE | ${nowSA} (SA Time)\n`;

  // LIVE
  if (Object.keys(live).length > 0) {
    post += `\n🔴 LIVE MATCHES\n`;
    for (const league of Object.keys(live)) {
      const sorted = live[league].sort((a, b) => a.time.localeCompare(b.time));
      post += `\n🌍 ${league}\n${sorted.map((m) => m.text).join("\n")}\n`;
    }
  }

  // HALF-TIME
  if (Object.keys(ht).length > 0) {
    post += `\n🟡 HALF-TIME\n`;
    for (const league of Object.keys(ht)) {
      const sorted = ht[league].sort((a, b) => a.time.localeCompare(b.time));
      post += `\n🌍 ${league}\n${sorted.map((m) => m.text).join("\n")}\n`;
    }
  }

  // FULL-TIME – ALL results for the day, sorted by time, NO STATS
  if (Object.keys(ft).length > 0) {
    post += `\n🟢 FULL-TIME RESULTS\n`;
    for (const league of Object.keys(ft)) {
      const sorted = ft[league].sort((a, b) => a.time.localeCompare(b.time));
      post += `\n🌍 ${league}\n${sorted.map((m) => m.text).join("\n")}\n`;
    }
  }

  // CTA + hashtags
  post += `\n📣 Follow PlayReportZA for more live updates!\n#football #livescores #PlayReportZA`;

  return post.trim();
}

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
  const res = await fetch(
    `https://v3.football.api-sports.io/fixtures?date=${date}`,
    {
      headers: { "x-apisports-key": apiKey }
    }
  );
  const data = await res.json();
  return data.response || [];
}

// Treat these as LIVE states
function isLiveStatus(short) {
  return ["1H", "2H", "ET", "PEN", "LIVE"].includes(short);
      }
