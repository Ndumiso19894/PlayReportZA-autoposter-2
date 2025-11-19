export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Manual testing: ?force=true
    if (url.searchParams.get("force") === "true") {
      return await runAutoposter(env, true);
    }

    return new Response("PlayReportZA autoposter is active.");
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAutoposter(env, false));
  }
};

// MAIN FUNCTION
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
    }, null, 2), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const today = new Date().toISOString().split("T")[0];
    const fixtures = await fetchFixtures(today, apiKey);

    const live = {};
    const ht = {};
    const ft = {};

    // Organize fixtures
    for (const f of fixtures) {
      const league = `${f.league.country} - ${f.league.name}`;
      const status = f.fixture.status.short;

      if (!live[league]) live[league] = [];
      if (!ht[league]) ht[league] = [];
      if (!ft[league]) ft[league] = [];

      const saTime = convertToSA(f.fixture.date);
      const minute = f.fixture.status.elapsed
        ? `${f.fixture.status.elapsed}'`
        : status === "HT"
        ? "HT"
        : status === "FT"
        ? "FT"
        : "";

      const score =
        f.goals.home !== null && f.goals.away !== null
          ? `${f.goals.home}–${f.goals.away}`
          : "";

      // GOALS MINUTES
      const goalMinutes = [];
      if (f.events) {
        f.events.forEach((ev) => {
          if (ev.type === "Goal" && ev.time?.elapsed) {
            goalMinutes.push(`${ev.time.elapsed}'`);
          }
        });
      }

      const goalLine =
        goalMinutes.length > 0 ? `⚽ Goals: ${goalMinutes.join(", ")}` : "";

      // Corners + Possession
      let stats = "";
      if (f.statistics?.length > 0) {
        const h = f.statistics[0]?.statistics || [];
        const a = f.statistics[1]?.statistics || [];

        const cornersH = findStat(h, "Corner Kicks");
        const cornersA = findStat(a, "Corner Kicks");

        const posH = findStat(h, "Ball Possession");
        const posA = findStat(a, "Ball Possession");

        if (cornersH && cornersA) stats += `🚩 Corners: ${cornersH}–${cornersA}\n`;
        if (posH && posA) stats += `📊 Possession: ${posH}–${posA}`;
      }

      const line =
        `${saTime} | ${f.teams.home.name} ${score} ${f.teams.away.name}` +
        (minute ? ` (${minute})` : "") +
        (goalLine ? `\n${goalLine}` : "") +
        (stats ? `\n${stats}` : "");

      if (status === "LIVE") live[league].push({ time: saTime, text: line });
      else if (status === "HT") ht[league].push({ time: saTime, text: line });
      else if (status === "FT") ft[league].push({ time: saTime, text: line });
    }

    // Build Post
    const post = buildPost(live, ht, ft);

    const fbURL =
      `https://graph.facebook.com/${pageId}/feed?message=${encodeURIComponent(post)}&access_token=${fbToken}`;

    const fbResponse = await fetch(fbURL, { method: "POST" });
    const fbData = await fbResponse.json();

    if (manual) {
      return new Response(JSON.stringify({
        status: "POST_SENT",
        posted_message_preview: post.slice(0, 200),
        facebook_result: fbData
      }, null, 2), { headers: { "Content-Type": "application/json" }});
    }

    console.log("Posted:", fbData);
    return new Response("OK");
  } catch (err) {
    return new Response("Error: " + err.message, { status: 500 });
  }
}

// Fetch fixtures
async function fetchFixtures(date, apiKey) {
  const res = await fetch(`https://v3.football.api-sports.io/fixtures?date=${date}`, {
    headers: { "x-apisports-key": apiKey }
  });
  const data = await res.json();
  return data.response || [];
}

// Stats finder
function findStat(arr, key) {
  const item = arr.find((s) => s.type === key);
  return item?.value || null;
}

// Convert to South African time
function convertToSA(utc) {
  return new Date(utc).toLocaleTimeString("en-ZA", {
    timeZone: "Africa/Johannesburg",
    hour: "2-digit",
    minute: "2-digit"
  });
}

// Build final Facebook post
function buildPost(live, ht, ft) {
  let post = `⚽ Today's Live Fixtures (SA Time)\n\n`;

  if (Object.keys(live).length > 0) {
    post += `🔴 LIVE MATCHES\n`;
    for (const league of Object.keys(live)) {
      const sorted = live[league].sort((a, b) => a.time.localeCompare(b.time));
      post += `\n📍 ${league}\n` + sorted.map((g) => g.text).join("\n") + "\n";
    }
  }

  if (Object.keys(ht).length > 0) {
    post += `\n🟡 HALF-TIME\n`;
    for (const league of Object.keys(ht)) {
      const sorted = ht[league].sort((a, b) => a.time.localeCompare(b.time));
      post += `\n📍 ${league}\n` + sorted.map((g) => g.text).join("\n") + "\n";
    }
  }

  if (Object.keys(ft).length > 0) {
    post += `\n🟢 FULL-TIME RESULTS\n`;
    for (const league of Object.keys(ft)) {
      const sorted = ft[league].sort((a, b) => a.time.localeCompare(b.time));
      post += `\n📍 ${league}\n` + sorted.map((g) => g.text).join("\n") + "\n";
    }
  }

  post += `\n\n📣 Follow PlayReportZA for more updates!\n#PlayReportZA #Football #Livescore`;

  return post.trim();
        }
