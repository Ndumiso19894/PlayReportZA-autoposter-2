export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const force = url.searchParams.get("force");
    if (force === "true") {
      return await runAutoposter(env, true);
    }
    return new Response("PlayReportZA autoposter is active.");
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAutoposter(env, false));
  }
};

// Convert UTC → South African Time (UTC+2)
function toSA(dateString) {
  const d = new Date(dateString);
  return new Date(d.getTime() + (2 * 60 * 60 * 1000));
}

function formatTimeSA(dateString) {
  const d = toSA(dateString);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

async function runAutoposter(env, manual = false) {
  try {
    const apiKey = env.API_FOOTBALL_KEY;
    const fbToken = env.FB_PAGE_TOKEN;
    const pageId = env.FB_PAGE_ID;

    if (!apiKey || !fbToken || !pageId) {
      return new Response("Missing environment variables", { status: 500 });
    }

    const today = new Date().toISOString().split("T")[0];

    // Fetch all fixtures for today
    const apiURL = `https://v3.football.api-sports.io/fixtures?date=${today}`;
    const res = await fetch(apiURL, {
      headers: { "x-apisports-key": apiKey }
    });
    const data = await res.json();
    if (!data.response) data.response = [];

    const now = new Date();
    const sixHoursAgo = new Date(now.getTime() - (6 * 60 * 60 * 1000));

    let liveMatches = [];
    let htMatches = [];
    let ftMatches = [];

    for (const f of data.response) {
      const status = f.fixture.status.short;
      const gameTime = toSA(f.fixture.date);

      const leagueName = `${f.league.country} - ${f.league.name}`;
      const home = f.teams.home.name;
      const away = f.teams.away.name;
      const goalsHome = f.goals.home;
      const goalsAway = f.goals.away;

      // Goal minutes + scorers
      let goalsList = [];
      if (f.events) {
        for (const e of f.events) {
          if (e.type === "Goal") {
            goalsList.push(`${e.time.elapsed}' ${e.player.name}`);
          }
        }
      }

      // Corners and possession (if available)
      let stats = {};
      if (f.statistics && f.statistics.length >= 2) {
        const homeStats = f.statistics[0].statistics;
        const awayStats = f.statistics[1].statistics;

        const corners = homeStats.find(s => s.type === "Corner Kicks")?.value;
        const cornersAway = awayStats.find(s => s.type === "Corner Kicks")?.value;

        const poss = homeStats.find(s => s.type === "Ball Possession")?.value;
        const possAway = awayStats.find(s => s.type === "Ball Possession")?.value;

        if (corners != null && cornersAway != null)
          stats.corners = `${corners}-${cornersAway}`;
        if (poss != null && possAway != null)
          stats.possession = `${poss} | ${possAway}`;
      }

      // Build match object
      const matchObj = {
        time: formatTimeSA(f.fixture.date),
        minute: f.fixture.status.elapsed ? `${f.fixture.status.elapsed}'` : "",
        league: leagueName,
        home,
        away,
        score: `${goalsHome}–${goalsAway}`,
        goalsList,
        stats
      };

      if (status === "1H" || status === "2H" || status === "ET" || status === "LIVE") {
        liveMatches.push(matchObj);
      } else if (status === "HT") {
        htMatches.push(matchObj);
      } else if (status === "FT" || status === "AET" || status === "PEN") {
        if (gameTime >= sixHoursAgo) ftMatches.push(matchObj);
      }
    }

    // Sort by time inside groups
    const sortByTime = arr => arr.sort((a, b) => a.time.localeCompare(b.time));
    sortByTime(liveMatches);
    sortByTime(htMatches);
    sortByTime(ftMatches);

    // Group by league
    function groupByLeague(matches) {
      const groups = {};
      for (const m of matches) {
        if (!groups[m.league]) groups[m.league] = [];
        groups[m.league].push(m);
      }
      return groups;
    }

    const liveGrouped = groupByLeague(liveMatches);
    const htGrouped = groupByLeague(htMatches);
    const ftGrouped = groupByLeague(ftMatches);

    // Build message
    let text = `⚽ *Today's Live Fixtures* \n\n`;

    function buildSection(title, groups, emoji) {
      let out = `\n${emoji} ${title}\n`;
      out += `──────────────────────\n`;
      for (const league in groups) {
        out += `📍 ${league}\n`;
        for (const m of groups[league]) {
          out += `${emoji === "🔴" ? "LIVE🔴" : emoji} ${m.time} | ${m.home} ${m.score} ${m.away}\n`;
          if (m.goalsList.length > 0) {
            out += `⚽ Goals: ${m.goalsList.join(", ")}\n`;
          }
          if (m.stats.corners) out += `🚩 Corners: ${m.stats.corners}\n`;
          if (m.stats.possession) out += `🔘 Possession: ${m.stats.possession}\n`;
        }
        out += `\n`;
      }
      return out;
    }

    if (liveMatches.length > 0) text += buildSection("Live Matches", liveGrouped, "🔴");
    if (htMatches.length > 0) text += buildSection("Half Time Results", htGrouped, "⏸️");
    if (ftMatches.length > 0) text += buildSection("Full Time Results (Last 6 hours)", ftGrouped, "🏁");

    text += "\n#PlayReportZA #LiveScores #SoccerUpdates";

    // Post to Facebook
    const fbURL = `https://graph.facebook.com/${pageId}/feed?message=${encodeURIComponent(text)}&access_token=${fbToken}`;
    const fbRes = await fetch(fbURL, { method: "POST" });
    const fbData = await fbRes.json();

    if (manual) {
      return new Response(JSON.stringify({
        status: "POST_SENT",
        match_count: liveMatches.length + htMatches.length + ftMatches.length,
        preview: text.slice(0, 200),
        facebook_result: fbData
      }, null, 2), {
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response("OK");

  } catch (err) {
    return new Response("ERROR: " + err.message, { status: 500 });
  }
      }
