export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Manual trigger
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

    // Fetch fixtures
    const today = new Date().toISOString().split("T")[0];
    const url = `https://v3.football.api-sports.io/fixtures?date=${today}`;

    const apiResponse = await fetch(url, {
      headers: { "x-apisports-key": apiKey }
    });

    const apiData = await apiResponse.json();
    if (!apiData.response) apiData.response = [];

    // SOUTH AFRICAN TIME FIX (UTC+2)
    function toSAST(utcString) {
      let date = new Date(utcString);
      // convert UTC → SAST (+2)
      date = new Date(date.getTime() + 2 * 60 * 60 * 1000);
      return date.toISOString().slice(11, 16); // HH:MM
    }

    // Group by league
    const leagues = {};
    for (const match of apiData.response) {
      const league = match.league.name;
      if (!leagues[league]) leagues[league] = [];
      leagues[league].push(match);
    }

    // Build message
    let message = `🔥 Today’s Live Fixtures (SAST) 🔥\n\n`;

    // LIVE section
    message += `🔴 LIVE MATCHES\n`;
    let liveCount = 0;

    for (const league of Object.keys(leagues)) {
      const matches = leagues[league].filter(m =>
        m.fixture.status.short === "1H" ||
        m.fixture.status.short === "2H" ||
        m.fixture.status.short === "LIVE"
      );

      if (matches.length === 0) continue;

      message += `\n🏆 ${league}\n`;

      for (const m of matches) {
        liveCount++;

        const home = m.teams.home.name;
        const away = m.teams.away.name;

        const goalsHome = m.goals.home ?? 0;
        const goalsAway = m.goals.away ?? 0;

        // SAST kickoff time
        const kickoff = toSAST(m.fixture.date);

        // Goals with minutes if available
        let goalEvents = m.events
          ?.filter(ev => ev.type === "Goal")
          ?.map(ev => `⚽ ${ev.elapsed}'`)
          ?.join(", ");

        if (!goalEvents || goalEvents.length === 0) {
          goalEvents = "";
        }

        // Corners if available
        let corners = "";
        if (m.statistics?.length >= 2) {
          const homeStats = m.statistics[0].statistics.find(s => s.type === "Corner Kicks");
          const awayStats = m.statistics[1].statistics.find(s => s.type === "Corner Kicks");

          if (homeStats && awayStats) {
            corners = `🚩 ${homeStats.value}–${awayStats.value}`;
          }
        }

        message +=
          `LIVE🔴 ${kickoff} | ${home} ${goalsHome}–${goalsAway} ${away}\n` +
          (goalEvents ? `${goalEvents}\n` : ``) +
          (corners ? `${corners}\n` : ``);
      }
    }

    if (liveCount === 0) message += `No live matches at the moment.\n`;

    // Divider
    message += `\n━━━━━━━━━━━━━━━━━━━━\n`;

    // FULL TIME SECTION
    message += `🏁 FULL TIME (Last 5 Hours)\n`;

    let ftCount = 0;
    const now = Date.now();

    for (const league of Object.keys(leagues)) {
      const finished = leagues[league].filter(m =>
        m.fixture.status.short === "FT"
      );

      if (finished.length === 0) continue;

      // Only last 5 hours
      const last5 = finished.filter(m => {
        const end = new Date(m.fixture.date).getTime() + 2 * 60 * 60 * 1000;
        return now - end <= 5 * 60 * 60 * 1000;
      });

      if (last5.length === 0) continue;

      message += `\n🏆 ${league}\n`;

      for (const m of last5) {
        ftCount++;

        const home = m.teams.home.name;
        const away = m.teams.away.name;

        const goalsHome = m.goals.home ?? 0;
        const goalsAway = m.goals.away ?? 0;

        const kickoff = toSAST(m.fixture.date);

        message += `FT 🏁 ${kickoff} | ${home} ${goalsHome}–${goalsAway} ${away}\n`;
      }
    }

    if (ftCount === 0) message += `No recent full time results.\n`;

    // Tags + CTA
    message += `\n📢 Follow PlayReportZA for more updates!\n#LiveScores #Football #PlayReportZA`;

    // Post to Facebook
    const fbURL = `https://graph.facebook.com/${pageId}/feed?message=${encodeURIComponent(message)}&access_token=${fbToken}`;
    const fbResponse = await fetch(fbURL, { method: "POST" });
    const fbData = await fbResponse.json();

    if (manual) {
      return new Response(JSON.stringify({
        status: "POST_SENT",
        message_preview: message.slice(0, 200),
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
