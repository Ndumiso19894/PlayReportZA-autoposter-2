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
        headers: { "Content-Type": "application/json" }
      });
    }

    const today = new Date().toISOString().split("T")[0];
    const url = `https://v3.football.api-sports.io/fixtures?date=${today}`;

    const apiResponse = await fetch(url, {
      headers: { "x-apisports-key": apiKey }
    });

    const apiData = await apiResponse.json();

    const liveMatches = [];
    const htMatches = [];
    const ftMatches = [];

    for (const match of apiData.response) {
      const league = `${match.league.country} - ${match.league.name}`;
      const home = match.teams.home.name;
      const away = match.teams.away.name;
      const goalsHome = match.goals.home ?? 0;
      const goalsAway = match.goals.away ?? 0;

      // Kickoff time formatting
      const ko = new Date(match.fixture.date);
      const kickoffTime = ko.toISOString().substring(11, 16);

      // Minute + added time
      let minute = match.fixture.status.elapsed;
      if (match.fixture.status.extra) {
        minute = `${minute}+${match.fixture.status.extra}`;
      }
      if (!minute) minute = ""; 

      // Scorers
      const events = match.events || [];
      const goalEvents = events.filter(e => e.type === "Goal");
      const scorers = goalEvents.length
        ? goalEvents.map(e => `${e.player.name} ${e.time.elapsed}'`).join(", ")
        : "";

      const line = 
`${kickoffTime} | ${home} ${goalsHome}–${goalsAway} ${away} ${minute ? `(${minute}')` : ""}${scorers ? `\nGoals: ${scorers}` : ""}`;

      const status = match.fixture.status.short;

      if (status === "1H" || status === "2H") liveMatches.push({ league, line });
      else if (status === "HT") htMatches.push({ league, line });
      else if (status === "FT") ftMatches.push({ league, line });
    }

    // Group by league
    const groupByLeague = (matches) => {
      const map = {};
      for (const m of matches) {
        if (!map[m.league]) map[m.league] = [];
        map[m.league].push(m.line);
      }
      return map;
    };

    const liveGrouped = groupByLeague(liveMatches);
    const htGrouped = groupByLeague(htMatches);
    const ftGrouped = groupByLeague(ftMatches);


    // BUILD MESSAGE
    let message = `⚽ LIVE / HT / FT Football Update (${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })})\n\n`;

    // LIVE
    if (liveMatches.length > 0) {
      message += `🔥 LIVE MATCHES\n`;
      for (const league in liveGrouped) {
        message += `📍 ${league}\n`;
        liveGrouped[league].forEach(m => message += m + "\n");
        message += "\n";
      }
    }

    message += `———————————————\n`;

    // HT
    if (htMatches.length > 0) {
      message += `⏸️ HALF TIME\n`;
      for (const league in htGrouped) {
        message += `📍 ${league}\n`;
        htGrouped[league].forEach(m => message += m + "\n");
        message += "\n";
      }
    }

    message += `———————————————\n`;

    // FT
    if (ftMatches.length > 0) {
      message += `🏁 FULL TIME\n`;
      for (const league in ftGrouped) {
        message += `📍 ${league}\n`;
        ftGrouped[league].forEach(m => message += m + "\n");
        message += "\n";
      }
    }

    if (liveMatches.length + htMatches.length + ftMatches.length === 0) {
      message = "No live, HT, or FT matches at the moment.";
    }

    // POST TO FACEBOOK
    const fbURL = `https://graph.facebook.com/${pageId}/feed?message=${encodeURIComponent(message)}&access_token=${fbToken}`;
    const fbResponse = await fetch(fbURL, { method: "POST" });
    const fbData = await fbResponse.json();

    if (manual) {
      return new Response(JSON.stringify({
        status: "POST_SENT",
        match_count: liveMatches.length + htMatches.length + ftMatches.length,
        posted_message_preview: message.substring(0, 400),
        facebook_result: fbData
      }, null, 2), {
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response("Error: " + err.message, { status: 500 });
  }
                                                  }
