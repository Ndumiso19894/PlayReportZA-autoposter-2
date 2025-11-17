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
        headers: {"Content-Type": "application/json"}
      });
    }

    // GET TODAY’S MATCHES
    const today = new Date().toISOString().split("T")[0];
    const apiURL = `https://v3.football.api-sports.io/fixtures?date=${today}`;

    const apiRes = await fetch(apiURL, {
      headers: { "x-apisports-key": apiKey }
    });
    const apiData = await apiRes.json();

    if (!apiData.response || apiData.response.length === 0) {
      if (manual) {
        return new Response("No matches today.", { status: 200 });
      }
      return;
    }

    const matches = apiData.response;

    // Convert times to Africa/Johannesburg
    const toSA = (utcTime) =>
      new Date(utcTime).toLocaleTimeString("en-ZA", {
        timeZone: "Africa/Johannesburg",
        hour: "2-digit",
        minute: "2-digit",
      });

    const nowSA = new Date().toLocaleTimeString("en-ZA", {
      timeZone: "Africa/Johannesburg",
      hour: "2-digit",
      minute: "2-digit",
    });

    // Group matches by league
    const groupByLeague = {};
    for (const m of matches) {
      const league = `${m.league.country} - ${m.league.name}`;
      if (!groupByLeague[league]) groupByLeague[league] = [];
      groupByLeague[league].push(m);
    }

    // Sorting inside leagues by kickoff time
    for (const league in groupByLeague) {
      groupByLeague[league].sort((a, b) =>
        new Date(a.fixture.date) - new Date(b.fixture.date)
      );
    }

    // Prepare message sections
    let liveSection = "🔥 LIVE Matches\n\n";
    let htSection = "⏸️ Half-Time Matches\n\n";
    let ftSection = "🏁 Full-Time Results (Last 5 Hours)\n\n";

    // 5-hour FT window
    const fiveHoursMs = 5 * 60 * 60 * 1000;
    const now = new Date();

    for (const league in groupByLeague) {
      const leagueMatches = groupByLeague[league];

      let leagueLive = "";
      let leagueHT = "";
      let leagueFT = "";

      for (const m of leagueMatches) {
        const home = m.teams.home.name;
        const away = m.teams.away.name;
        const goals = m.goals;
        const score = `${goals.home}–${goals.away}`;
        const kickoff = toSA(m.fixture.date);
        const status = m.fixture.status.short; // LIVE, HT, FT, etc.
        const elapsed = m.fixture.status.elapsed || 0;

        // Goals with minutes if available
        let goalsInfo = "";
        if (m.events) {
          const goalEvents = m.events.filter(e => e.type === "Goal");
          if (goalEvents.length > 0) {
            const formatted = goalEvents
              .map(e => `${e.time.elapsed}' ${e.player.name}`)
              .join(", ");
            goalsInfo = `Goals: ${formatted}\n`;
          }
        }

        // Corners + Possession only if available
        let statsLine = "";
        if (m.statistics && m.statistics.length >= 2) {
          const homeStats = m.statistics[0].statistics;
          const awayStats = m.statistics[1].statistics;

          // Corners
          const cHome = homeStats.find(s => s.type === "Corner Kicks")?.value;
          const cAway = awayStats.find(s => s.type === "Corner Kicks")?.value;

          // Possession
          const pHome = homeStats.find(s => s.type === "Ball Possession")?.value;
          const pAway = awayStats.find(s => s.type === "Ball Possession")?.value;

          const corners = (cHome !== undefined && cAway !== undefined) ? `Corners: ${cHome}–${cAway}\n` : "";
          const poss = (pHome && pAway) ? `Possession: ${pHome}–${pAway}\n` : "";

          statsLine = corners + poss;
        }

        const line =
          `[${status}] ${kickoff} | ${home} ${score} ${away}\n` +
          (goalsInfo ? goalsInfo : "") +
          (statsLine ? statsLine : "") +
          `\n`;

        if (status === "LIVE") leagueLive += line;
        else if (status === "HT") leagueHT += line;
        else if (status === "FT") {
          const ended = new Date(m.fixture.date);
          if (now - ended <= fiveHoursMs) leagueFT += line;
        }
      }

      if (leagueLive) liveSection += `📍 ${league}\n${leagueLive}\n`;
      if (leagueHT) htSection += `📍 ${league}\n${leagueHT}\n`;
      if (leagueFT) ftSection += `📍 ${league}\n${leagueFT}\n`;
    }

    // Final message
    const finalMessage =
      `⚽ Live / HT / FT Update (${today}, ${nowSA})\n\n` +
      liveSection +
      "━━━━━━━━━━━━━━\n" +
      htSection +
      "━━━━━━━━━━━━━━\n" +
      ftSection;

    // POST TO FACEBOOK
    const fbURL = `https://graph.facebook.com/${pageId}/feed?message=${encodeURIComponent(finalMessage)}&access_token=${fbToken}`;
    const fbResp = await fetch(fbURL, { method: "POST" });
    const fbData = await fbResp.json();

    if (manual) {
      return new Response(JSON.stringify({
        status: "POST_SENT",
        posted_message_preview: finalMessage.slice(0, 350),
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
