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
  },
};

async function runAutoposter(env, manual = false) {
  try {
    const apiKey = env.API_FOOTBALL_KEY;
    const fbToken = env.FB_PAGE_TOKEN;
    const pageId = env.FB_PAGE_ID;

    if (!apiKey || !fbToken || !pageId) {
      return new Response(
        JSON.stringify({
          error: "Missing environment variables",
          apiKey: !!apiKey,
          fbToken: !!fbToken,
          pageId: !!pageId,
        }),
        { status: 500 }
      );
    }

    // Fetch live, HT, FT
    const url = `https://v3.football.api-sports.io/fixtures?live=all`;
    const res = await fetch(url, { headers: { "x-apisports-key": apiKey } });
    const data = await res.json();

    if (!data.response || data.response.length === 0) {
      return sendResponse(manual, "No live matches right now.");
    }

    const now = new Date();
    const FT_cutoff = new Date(now.getTime() - 5 * 60 * 60 * 1000);

    // Separate matches
    const LIVE = [];
    const FULLTIME = [];
    const HALFTIME = [];

    for (const match of data.response) {
      const status = match.fixture.status.short;
      const kickoff = new Date(match.fixture.date);
      const localKickoff = kickoff.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
      });

      const league = match.league.name;
      const home = match.teams.home;
      const away = match.teams.away;

      const goals = match.goals;
      const events = match.events || [];

      const goalEvents = events
        .filter((e) => e.type === "Goal")
        .map((e) => `${e.player.name} ${e.time.elapsed}'`);

      const corners =
        match.statistics?.find((s) => s.type === "Corner Kicks") || null;

      const possession =
        match.statistics?.find((s) => s.type === "Ball Possession") || null;

      const obj = {
        league,
        time: localKickoff,
        minute: match.fixture.status.elapsed || null,
        homeTeam: home.name,
        awayTeam: away.name,
        score: `${goals.home}–${goals.away}`,
        goalEvents,
        corners:
          corners && corners.value !== null
            ? corners.value
            : null,
        possession:
          possession && possession.value !== null
            ? possession.value
            : null,
      };

      if (status === "HT") HALFTIME.push(obj);
      else if (status === "FT" && kickoff >= FT_cutoff) FULLTIME.push(obj);
      else if (status !== "FT") LIVE.push(obj);
    }

    // Sort inside leagues by time
    const sortMatches = (arr) =>
      arr.sort(
        (a, b) =>
          parseInt(a.time.replace(":", "")) -
          parseInt(b.time.replace(":", ""))
      );

    sortMatches(LIVE);
    sortMatches(HALFTIME);
    sortMatches(FULLTIME);

    const groupedLive = groupByLeague(LIVE);
    const groupedHT = groupByLeague(HALFTIME);
    const groupedFT = groupByLeague(FULLTIME);

    // Build message
    let message = `⚽ **Live Football Update** (${formatTime(now)})\n\n`;

    // LIVE
    if (LIVE.length > 0) {
      for (const league in groupedLive) {
        message += `📍 *${league}*\n`;
        groupedLive[league].forEach((m) => {
          message += `🔴 ${m.time} | ${m.homeTeam} ${m.score} ${m.awayTeam}\n`;
          if (m.goalEvents.length > 0)
            message += `⚽ Goals: ${m.goalEvents.join(", ")}\n`;
          if (m.corners) message += `🏳️ Corners: ${m.corners}\n`;
          if (m.possession) message += `📊 Possession: ${m.possession}\n`;
          message += `\n`;
        });
      }
    }

    // HT Line
    if (HALFTIME.length > 0) {
      message += `=====================\n`;
      message += `⏸️ **Half Time Scores**\n\n`;
      for (const league in groupedHT) {
        message += `📍 *${league}*\n`;
        groupedHT[league].forEach((m) => {
          message += `⏸️ HT | ${m.time} | ${m.homeTeam} ${m.score} ${m.awayTeam}\n\n`;
        });
      }
    }

    // FT Line
    if (FULLTIME.length > 0) {
      message += `=====================\n`;
      message += `🏁 **Full Time Results**\n\n`;
      for (const league in groupedFT) {
        message += `📍 *${league}*\n`;
        groupedFT[league].forEach((m) => {
          message += `🏁 FT | ${m.time} | ${m.homeTeam} ${m.score} ${m.awayTeam}\n`;
          if (m.goalEvents.length > 0)
            message += `⚽ Goals: ${m.goalEvents.join(", ")}\n`;
          message += `\n`;
        });
      }
    }

    // CTA + Tags
    message += `📢 Stay updated with PlayReportZA!\n`;
    message += `#Football #LiveScores #PlayReportZA #SoccerUpdates #MatchDay`;

    // Send to Facebook
    const fbURL = `https://graph.facebook.com/${pageId}/feed?message=${encodeURIComponent(
      message
    )}&access_token=${fbToken}`;

    const fbRes = await fetch(fbURL, { method: "POST" });
    const fbData = await fbRes.json();

    if (manual) {
      return sendResponse(true, {
        status: "POST_SENT",
        fbData,
        preview: message.slice(0, 300),
      });
    }

    return new Response(JSON.stringify({ success: true }));
  } catch (err) {
    return sendResponse(manual, { error: err.toString() });
  }
}

function sendResponse(manual, msg) {
  return new Response(JSON.stringify(msg, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
}

function groupByLeague(arr) {
  return arr.reduce((acc, m) => {
    acc[m.league] = acc[m.league] || [];
    acc[m.league].push(m);
    return acc;
  }, {});
}

function formatTime(date) {
  return date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
        }
