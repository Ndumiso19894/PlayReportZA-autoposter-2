export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Force test
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
  try {
    const apiKey = env.API_FOOTBALL_KEY;
    const fbToken = env.FB_PAGE_TOKEN;
    const pageId = env.FB_PAGE_ID;

    if (!apiKey || !fbToken || !pageId) {
      return new Response("Missing environment variables", { status: 500 });
    }

    // TODAY’S DATE
    const today = new Date().toISOString().split("T")[0];

    // FETCH FIXTURES
    const res = await fetch(`https://v3.football.api-sports.io/fixtures?date=${today}`, {
      headers: { "x-apisports-key": apiKey }
    });

    const data = await res.json();
    const matches = data.response || [];

    // FILTER: only LIVE, HT, FT
    const filtered = matches.filter(m =>
      ["1H", "2H", "HT", "FT"].includes(m.fixture.status.short)
    );

    if (filtered.length === 0) {
      return sendResponse(manual, "No live, halftime, or full-time matches right now.");
    }

    // BUILD POST MESSAGE
    let post = `⚽ *LIVE / HT / FT FOOTBALL UPDATES*\n\n`;

    for (const m of filtered) {
      const home = m.teams.home.name;
      const away = m.teams.away.name;

      const status = m.fixture.status.short;      // 1H, 2H, HT, FT
      const league = m.league.name;
      const country = m.league.country;

      // TIME FORMAT
      const kickoff = formatTime(m.fixture.date);

      // SCORE
      const goalsHome = m.goals.home ?? 0;
      const goalsAway = m.goals.away ?? 0;

      // CORNERS
      const cornersHome = m.statistics?.[0]?.statistics?.find(s => s.type === "Corner Kicks")?.value ?? "-";
      const cornersAway = m.statistics?.[1]?.statistics?.find(s => s.type === "Corner Kicks")?.value ?? "-";

      // GOAL MINUTES
      const events = m.events?.filter(e => e.type === "Goal") || [];
      const goalTimes = events.map(e => `${e.time.elapsed}'`).join(", ") || "None";

      post +=
`🏆 *${country} – ${league}*
⏱ Status: ${status}
🕒 Kickoff: ${kickoff}

${home} ${goalsHome}–${goalsAway} ${away}

🎯 Corners: ${cornersHome} – ${cornersAway}
🥅 Goal Times: ${goalTimes}

--------------------------------------\n`;
    }

    // FACEBOOK POST
    const fbUrl =
      `https://graph.facebook.com/${pageId}/feed?message=${encodeURIComponent(post)}&access_token=${fbToken}`;

    const fbRes = await fetch(fbUrl, { method: "POST" });
    const fbData = await fbRes.json();

    if (manual) {
      return new Response(JSON.stringify({
        status: "POST SENT",
        posted_message: post,
        facebook_result: fbData
      }, null, 2), { headers: { "Content-Type": "application/json" } });
    }

    console.log("Auto post:", fbData);

  } catch (err) {
    return new Response("Error: " + err.message, { status: 500 });
  }
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function sendResponse(manual, msg) {
  if (!manual) return new Response(msg);
  return new Response(JSON.stringify({ message: msg }, null, 2), {
    headers: { "Content-Type": "application/json" }
  });
  }
