export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const force = url.searchParams.get("force") === "true";
    return await generateReport(env, force);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(generateReport(env, false));
  }
};

async function generateReport(env, manual = false) {
  try {
    const apiKey = env.API_FOOTBALL_KEY;
    const fbToken = env.FB_PAGE_TOKEN;
    const pageId  = env.FB_PAGE_ID;

    if (!apiKey || !fbToken || !pageId) {
      return json({ error: "Missing environment variables" });
    }

    // South African time (UTC+2)
    const now = new Date();
    const saTime = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const today = saTime.toISOString().split("T")[0];

    // Fetch all matches for today
    const liveURL = `https://v3.football.api-sports.io/fixtures?date=${today}`;
    const apiRes = await fetch(liveURL, { headers: { "x-apisports-key": apiKey } });
    const apiData = await apiRes.json();

    if (!apiData.response) return json({ error: "API returned empty" });

    let live = [];
    let ht   = [];
    let ft   = [];

    for (const m of apiData.response) {

      const leagueName = `${m.country.name} - ${m.league.name}`;
      const home = m.teams.home.name;
      const away = m.teams.away.name;
      const score = `${m.goals.home}–${m.goals.away}`;

      // Convert match time to SA time & get match minute
      const matchTime = new Date(m.fixture.date);
      const matchSATime = new Date(matchTime.getTime() + 2 * 60 * 60 * 1000);

      const elapsed = m.fixture.status.elapsed ? `${m.fixture.status.elapsed}'` : "";

      // Goals + minutes + scorers
      let goalEvents = [];
      if (m.events) {
        for (const e of m.events) {
          if (e.type === "Goal") {
            goalEvents.push(
              `${e.time.elapsed}' ${e.player.name || "Unknown"} (${e.team.name})`
            );
          }
        }
      }
      const goalText = goalEvents.length > 0 ? `⚽ Goals:\n- ${goalEvents.join("\n- ")}` : "";

      // Corners
      let corners = "";
      if (m.statistics && m.statistics.length >= 2) {
        const sHome = m.statistics[0].statistics.find(s => s.type === "Corner Kicks");
        const sAway = m.statistics[1].statistics.find(s => s.type === "Corner Kicks");
        if (sHome && sAway) {
          corners = `🚩 Corners: ${sHome.value}–${sAway.value}`;
        }
      }

      // Possession
      let poss = "";
      if (m.statistics && m.statistics.length >= 2) {
        const pHome = m.statistics[0].statistics.find(s => s.type === "Ball Possession");
        const pAway = m.statistics[1].statistics.find(s => s.type === "Ball Possession");
        if (pHome && pAway && pHome.value && pAway.value) {
          poss = `🔵 Possession: ${pHome.value}–${pAway.value}`;
        }
      }

      // Compose match text
      const base =
        `${formatSA(matchSATime)} | ${home} ${score} ${away}\n` +
        (elapsed ? `⏱ ${elapsed}\n` : "") +
        (goalText ? `${goalText}\n` : "") +
        (corners ? `${corners}\n` : "") +
        (poss ? `${poss}\n` : "");

      // Categorize by status
      if (m.fixture.status.short === "FT") {
        const hoursSinceEnd = (saTime - matchSATime) / (1000 * 60 * 60);
        if (hoursSinceEnd <= 6) ft.push({ league: leagueName, time: matchSATime, text: base });
      } else if (m.fixture.status.short === "HT") {
        ht.push({ league: leagueName, time: matchSATime, text: base });
      } else if (m.fixture.status.short === "1H" || m.fixture.status.short === "2H" || m.fixture.status.short === "LIVE") {
        live.push({ league: leagueName, time: matchSATime, text: base });
      }
    }

    // Group by league, sort by time
    const groupSort = list => {
      const map = {};
      for (const m of list) {
        if (!map[m.league]) map[m.league] = [];
        map[m.league].push(m);
      }
      for (const l in map) {
        map[l].sort((a,b) => a.time - b.time);
      }
      return map;
    };

    const liveGrouped = groupSort(live);
    const htGrouped   = groupSort(ht);
    const ftGrouped   = groupSort(ft);

    // Build message
    let msg = `⚽ *Today's Live Fixtures* 🇿🇦\n\n`;

    // LIVE 🔴
    if (live.length > 0) {
      msg += `🔴 LIVE MATCHES\n`;
      for (const league in liveGrouped) {
        msg += `\n📍 ${league}\n`;
        liveGrouped[league].forEach(m => msg += m.text + `\n`);
      }
      msg += `\n──────────────────────\n`;
    }

    // HT
    if (ht.length > 0) {
      msg += `⏸ HALF-TIME\n`;
      for (const league in htGrouped) {
        msg += `\n📍 ${league}\n`;
        htGrouped[league].forEach(m => msg += m.text + `\n`);
      }
      msg += `\n──────────────────────\n`;
    }

    // FT ✓
    if (ft.length > 0) {
      msg += `✓ FULL-TIME (Last 6 Hours)\n`;
      for (const league in ftGrouped) {
        msg += `\n📍 ${league}\n`;
        ftGrouped[league].forEach(m => msg += m.text + `\n`);
      }
    }

    // Bottom hashtags
    msg += `\n#PlayReportZA #LiveScores #FootballUpdates #SoccerStats #MatchCentre\n`;

    // Post to Facebook
    const fbURL = `https://graph.facebook.com/${pageId}/feed?message=${encodeURIComponent(msg)}&access_token=${fbToken}`;
    const fbRes = await fetch(fbURL, { method: "POST" });
    const fbData = await fbRes.json();

    if (manual) {
      return json({
        status: "POST_SENT",
        match_count: live.length + ht.length + ft.length,
        facebook_result: fbData
      });
    }

    return json({ ok: true });

  } catch (err) {
    return json({ error: err.message });
  }
}

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), { headers: { "Content-Type": "application/json" } });
}

function formatSA(d) {
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
        }
