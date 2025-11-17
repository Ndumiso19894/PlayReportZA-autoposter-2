export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.get("force") === "true") {
      return await buildPost(env, true);
    }
    return new Response("PlayReportZA autoposter is active.");
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(buildPost(env, false));
  }
};

async function buildPost(env, manual) {
  try {
    const apiKey = env.API_FOOTBALL_KEY;
    const fbToken = env.FB_PAGE_TOKEN;
    const pageId  = env.FB_PAGE_ID;

    if (!apiKey || !fbToken || !pageId) {
      return new Response("Missing environment variables");
    }

    const now    = new Date();
    const today  = now.toISOString().split("T")[0];
    const jhbTZ  = "Africa/Johannesburg";

    // Fetch live + today fixtures
    const apiURL = `https://v3.football.api-sports.io/fixtures?date=${today}`;
    const apiRes = await fetch(apiURL, {
      headers: { "x-apisports-key": apiKey }
    });
    const apiData = await apiRes.json();

    if (!apiData.response) {
      return new Response("API returned no matches");
    }

    // Group by leagues
    const leagues = {};

    for (const fx of apiData.response) {
      const fixture = fx.fixture;
      const league  = fx.league;
      const score   = fx.score;
      const stats   = fx.statistics || [];
      const goals   = fx.events?.filter(e => e.type === "Goal") || [];

      const kickoffUTC = new Date(fixture.date);
      const kickoffLocal = toLocal(kickoffUTC, jhbTZ);

      const status = fixture.status.short;
      const longStatus = fixture.status.long;

      const minutes = fixture.status.elapsed;
      const extra   = fixture.status.extra ? `+${fixture.status.extra}` : "";

      const liveMinute = minutes ? `${minutes}${extra}’` : "";

      const home = fx.teams.home.name;
      const away = fx.teams.away.name;

      const homeGoals = score.fulltime.home ?? score.halftime.home ?? score.extratime.home ?? score.penalty.home ?? 0;
      const awayGoals = score.fulltime.away ?? score.halftime.away ?? score.extratime.away ?? score.penalty.away ?? 0;

      // Build goal minutes
      let goalMinutes = "";
      if (goals.length > 0) {
        goalMinutes = goals
          .map(g => `${g.time.elapsed}${g.time.extra ? `+${g.time.extra}` : ""}’`)
          .join(", ");
      }

      // Extract possession & corners only if available
      let possession = "";
      let corners    = "";

      if (fx.statistics && fx.statistics.length > 0) {
        for (const teamStats of fx.statistics) {
          const teamName = teamStats.team.name === fx.teams.home.name ? "home" : "away";
          for (const st of teamStats.statistics) {
            if (st.type === "Ball Possession" && st.value) {
              if (teamName === "home") possession = `${st.value}`;
              else possession += ` – ${st.value}`;
            }
            if (st.type === "Corner Kicks" && st.value !== null) {
              if (teamName === "home") corners = `${st.value}`;
              else corners += ` – ${st.value}`;
            }
          }
        }
      }

      // Category LIVE / HT / FT
      let category = "";
      if (status === "1H" || status === "2H" || status === "ET" || status === "BT") {
        category = "LIVE";
      } else if (status === "HT") {
        category = "HT";
      } else if (status === "FT" || status === "AET" || status === "PEN") {
        // Only include full time if within last 5 hours
        const diff = (now - kickoffUTC) / (1000 * 60 * 60);
        if (diff > 5) continue;
        category = "FT";
      } else {
        continue;
      }

      const leagueKey = `${league.country} - ${league.name}`;
      if (!leagues[leagueKey]) leagues[leagueKey] = [];
      
      leagues[leagueKey].push({
        category,
        kickoffLocal,
        home,
        away,
        homeGoals,
        awayGoals,
        liveMinute,
        possession,
        corners,
        goalMinutes
      });
    }

    // Build post body
    let post = `⚽ *Live / HT / FT Football Update* (${now.toLocaleTimeString("en-GB", { timeZone: jhbTZ })})\n\n`;

    for (const leagueName of Object.keys(leagues).sort()) {
      post += `📍 ${leagueName}\n`;
      const matches = leagues[leagueName].sort((a,b) => a.kickoffLocal - b.kickoffLocal);

      for (const m of matches) {
        const timeShow = m.kickoffLocal.toLocaleTimeString("en-GB", { timeZone: jhbTZ, hour: "2-digit", minute: "2-digit" });

        let line = "";

        if (m.category === "LIVE") line += "🔴 LIVE ";
        if (m.category === "HT")   line += "⏸ HT ";
        if (m.category === "FT")   line += "🏁 FT ";

        line += `| ${timeShow} | ${m.home} ${m.homeGoals}–${m.awayGoals} ${m.away}`;

        if (m.liveMinute) line += ` | ${m.liveMinute}`;
        if (m.goalMinutes) line += `\nGoals: ${m.goalMinutes}`;
        if (m.corners) line += `\nCorners: ${m.corners}`;
        if (m.possession) line += `\nPossession: ${m.possession}`;

        post += line + `\n\n`;
      }

      post += `────────────────────────\n`;
    }

    // FACEBOOK POST
    const fbURL =
      `https://graph.facebook.com/${pageId}/feed?message=${encodeURIComponent(post)}&access_token=${fbToken}`;
    
    const fbResponse = await fetch(fbURL, { method: "POST" });
    const fbData     = await fbResponse.json();

    return new Response(JSON.stringify({
      status: "POST_SENT",
      league_count: Object.keys(leagues).length,
      facebook_result: fbData
    }, null, 2), {
      headers: {"Content-Type": "application/json"}
    });

  } catch (err) {
    return new Response("Error: " + err.message, { status: 500 });
  }
}

function toLocal(dateUTC, tz) {
  return new Date(dateUTC.toLocaleString("en-US", { timeZone: tz }));
  }
