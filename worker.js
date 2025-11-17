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
        error: "Missing environment variables"
      }, null, 2), { status: 500 });
    }

    const today = new Date().toISOString().slice(0, 10);
    const apiUrl = `https://v3.football.api-sports.io/fixtures?date=${today}`;

    const res = await fetch(apiUrl, {
      headers: { "x-apisports-key": apiKey }
    });

    const data = await res.json();
    if (!data.response) data.response = [];

    // 🇿🇦 Convert UTC → SAST
    const toSAST = (utc) => {
      let d = new Date(utc);
      d.setHours(d.getHours() + 2);
      return d;
    };

    // 🧩 Categorize Matches
    const liveMatches = [];
    const htMatches = [];
    const ftMatches = [];

    const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;

    data.response.forEach(m => {
      const status = m.fixture.status.short;
      const kick = toSAST(m.fixture.date);

      if (status === "FT" && (new Date(m.fixture.date).getTime() >= sixHoursAgo)) {
        ftMatches.push(m);
      } else if (status === "HT") {
        htMatches.push(m);
      } else if (["1H", "2H", "LIVE", "ET"].includes(status)) {
        liveMatches.push(m);
      }
    });

    const formatMatch = (m, tag) => {
      const kick = toSAST(m.fixture.date);
      const timeHHMM = kick.toTimeString().slice(0, 5);

      let emoji = tag === "LIVE" ? "LIVE 🔴" :
                  tag === "HT"   ? "HT ⏸️" :
                  "FT ✅";

      let goals = "";
      if (m.goals.home !== null) {
        goals = `${m.goals.home}–${m.goals.away}`;
      }

      let goalMinutes = "";
      if (m.events) {
        const g = m.events.filter(e => e.type === "Goal");
        if (g.length > 0) {
          goalMinutes = "⚽ Goals: " + g.map(x => `${x.time.elapsed}'`).join(", ");
        }
      }

      let corners = "";
      if (m.statistics && m.statistics[0]?.statistics && m.statistics[1]?.statistics) {
        const home = m.statistics[0].statistics.find(s => s.type === "Corner Kicks");
        const away = m.statistics[1].statistics.find(s => s.type === "Corner Kicks");
        if (home && away) {
          corners = `🚩 Corners: ${home.value}–${away.value}`;
        }
      }

      let poss = "";
      if (m.statistics && m.statistics[0]?.statistics && m.statistics[1]?.statistics) {
        const home = m.statistics[0].statistics.find(s => s.type === "Ball Possession");
        const away = m.statistics[1].statistics.find(s => s.type === "Ball Possession");
        if (home && away) {
          poss = `📊 Possession: ${home.value}–${away.value}`;
        }
      }

      let statsBlock = "";
      if (goalMinutes) statsBlock += goalMinutes + "\n";
      if (corners) statsBlock += corners + "\n";
      if (poss) statsBlock += poss + "\n";

      return (
        `${emoji} | ${timeHHMM} | ${m.teams.home.name} ${goals} ${m.teams.away.name}\n` +
        (statsBlock ? statsBlock.trim() + "\n" : "")
      );
    };

    // Group by leagues
    const groupByLeague = (array) => {
      const grouped = {};
      array.forEach(m => {
        const league = `${m.league.country} - ${m.league.name}`;
        if (!grouped[league]) grouped[league] = [];
        grouped[league].push(m);
      });
      Object.keys(grouped).forEach(k => {
        grouped[k].sort((a, b) =>
          new Date(a.fixture.date) - new Date(b.fixture.date)
        );
      });
      return grouped;
    };

    const liveGroups = groupByLeague(liveMatches);
    const htGroups = groupByLeague(htMatches);
    const ftGroups = groupByLeague(ftMatches);

    // Final message
    let message = `🔥 Today’s Live Fixtures (SAST)\n\n`;

    // LIVE
    message += `🔴 LIVE MATCHES\n`;
    if (liveMatches.length === 0) message += "No live matches\n";
    else {
      for (const league in liveGroups) {
        message += `📍 ${league}\n`;
        liveGroups[league].forEach(m => {
          message += formatMatch(m, "LIVE") + "\n";
        });
      }
    }

    // HT
    message += `\n⏸️ HALFTIME MATCHES\n`;
    if (htMatches.length === 0) message += "No halftime matches\n";
    else {
      for (const league in htGroups) {
        message += `📍 ${league}\n`;
        htGroups[league].forEach(m => {
          message += formatMatch(m, "HT") + "\n";
        });
      }
    }

    // FT
    message += `\n✅ FULL-TIME (Last 6 Hours)\n`;
    if (ftMatches.length === 0) message += "No recent full-time matches\n";
    else {
      for (const league in ftGroups) {
        message += `📍 ${league}\n`;
        ftGroups[league].forEach(m => {
          message += formatMatch(m, "FT") + "\n";
        });
      }
    }

    // Footer
    message += `\nFollow PlayReportZA for more updates! 📲⚽\n#Football #LiveScores #SoccerUpdates #PlayReportZA`;

    // POST TO FACEBOOK
    const fbUrl =
      `https://graph.facebook.com/${pageId}/feed?message=${encodeURIComponent(message)}&access_token=${fbToken}`;
    const fbRes = await fetch(fbUrl, { method: "POST" });
    const fbData = await fbRes.json();

    if (manual) {
      return new Response(JSON.stringify({
        status: "POST_SENT",
        match_count: liveMatches.length + htMatches.length + ftMatches.length,
        posted_message_preview: message.substring(0, 350),
        facebook_result: fbData
      }, null, 2), {
        headers: { "Content-Type": "application/json" }
      });
    }

  } catch (err) {
    return new Response("Error: " + err.message, { status: 500 });
  }
      }
