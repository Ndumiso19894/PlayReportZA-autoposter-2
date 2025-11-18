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

// ----------------------------------------------
// MAIN POST BUILDER
// ----------------------------------------------
async function buildPost(env, manual = false) {
  try {
    const apiKey = env.API_FOOTBALL_KEY;
    const fbToken = env.FB_PAGE_TOKEN;
    const pageId = env.FB_PAGE_ID;

    if (!apiKey || !fbToken || !pageId) {
      return json({ error: "Missing environment variables" });
    }

    // Fetch live + today fixtures
    const today = new Date().toISOString().slice(0, 10);
    const fixturesURL =
      `https://v3.football.api-sports.io/fixtures?date=${today}`;
    const fixturesRes = await fetch(fixturesURL, {
      headers: { "x-apisports-key": apiKey }
    });
    const fixtures = await fixturesRes.json();

    if (!fixtures.response) {
      return json({ error: "Invalid API response" });
    }

    const nowSA = convertToSA(new Date());

    let live = [];
    let fullTime = [];

    for (const match of fixtures.response) {
      const league = match.league?.name;
      const country = match.league?.country || "Others";
      const status = match.fixture.status.short;
      const start = new Date(match.fixture.date);
      const startSA = convertToSA(start);

      const minute = match.fixture.status.elapsed
        ? `${match.fixture.status.elapsed}'`
        : "";

      const home = match.teams.home.name;
      const away = match.teams.away.name;

      const goalsHome = match.goals.home ?? "-";
      const goalsAway = match.goals.away ?? "-";

      // Goal scorers
      let scorerList = "";
      if (match.events) {
        const goals = match.events.filter(e => e.type === "Goal");
        if (goals.length > 0) {
          scorerList = goals
            .map(
              g =>
                `${g.time.elapsed}' ${g.player?.name || "Unknown"} (${g.team?.name || ""})`
            )
            .join("\n");
        }
      }

      // Corners / Possession
      const stats = match.statistics?.[0]?.statistics || [];
      const stat = name =>
        stats.find(s => s.type === name)?.value || null;

      const cornersHome = stat("Corner Kicks");
      const cornersAway = stat("Corner Kicks");

      const possHome = stat("Ball Possession");
      const possAway = stat("Ball Possession");

      const flag = getFlag(country);

      const entry = {
        country,
        league,
        startSA,
        flag,
        home,
        away,
        goalsHome,
        goalsAway,
        minute,
        scorerList,
        cornersHome,
        cornersAway,
        possHome,
        possAway
      };

      // Live
      if (status === "1H" || status === "2H" || status === "ET") {
        live.push(entry);
      }

      // HT
      if (status === "HT") {
        entry.ht = true;
        live.push(entry);
      }

      // FT (last 6 hours ONLY)
      if (status === "FT" || status === "AET" || status === "PEN") {
        const diffHours =
          (nowSA - startSA) / (1000 * 60 * 60);
        if (diffHours <= 6) {
          fullTime.push(entry);
        }
      }
    }

    // Sort by time inside league
    const groupedLive = groupByLeague(live);
    const groupedFT = groupByLeague(fullTime);

    const message = buildMessage(nowSA, groupedLive, groupedFT);

    // SEND TO FACEBOOK
    const fbURL =
      `https://graph.facebook.com/${pageId}/feed?message=${encodeURIComponent(
        message
      )}&access_token=${fbToken}`;

    const fbRes = await fetch(fbURL, { method: "POST" });
    const fbJson = await fbRes.json();

    return json({
      status: "POST_SENT",
      match_count: live.length + fullTime.length,
      preview: message.slice(0, 500),
      facebook_result: fbJson
    });

  } catch (err) {
    return json({ error: err.message });
  }
}

// ----------------------------------------------
// MESSAGE BUILDER
// ----------------------------------------------
function buildMessage(nowSA, liveGroups, ftGroups) {
  let msg = `🔥 Today's Live Fixtures (SA Time)\n📅 ${formatDate(nowSA)}\n\n`;

  // LIVE MATCHES
  for (const country in liveGroups) {
    msg += `${getFlag(country)} ${country}\n`;
    for (const league in liveGroups[country]) {
      msg += `🏆 ${league}\n`;

      const matches = liveGroups[country][league].sort(
        (a, b) => a.startSA - b.startSA
      );

      for (const m of matches) {
        msg += `LIVE 🔴 ${formatTime(m.startSA)} | ${m.home} ${m.goalsHome}–${m.goalsAway} ${m.away}`;

        if (m.minute) msg += ` (${m.minute})`;

        msg += `\n`;

        if (m.scorerList) msg += `⚽ Goals:\n${m.scorerList}\n`;

        if (m.cornersHome && m.cornersAway)
          msg += `🚩 Corners: ${m.cornersHome}–${m.cornersAway}\n`;

        if (m.possHome && m.possAway)
          msg += `📊 Possession: ${m.possHome}–${m.possAway}\n`;

        msg += `\n`;
      }
    }
    msg += `\n`;
  }

  msg += `———————————————\n`;
  msg += `🏁 Full Time Results (Last 6 Hours)\n\n`;

  // FULL TIME
  for (const country in ftGroups) {
    msg += `${getFlag(country)} ${country}\n`;
    for (const league in ftGroups[country]) {
      msg += `🏆 ${league}\n`;

      const matches = ftGroups[country][league].sort(
        (a, b) => a.startSA - b.startSA
      );

      for (const m of matches) {
        msg += `FT ${formatTime(m.startSA)} | ${m.home} ${m.goalsHome}–${m.goalsAway} ${m.away}\n`;

        if (m.scorerList) msg += `⚽ Goals:\n${m.scorerList}\n`;

        msg += `\n`;
      }
    }
    msg += `\n`;
  }

  msg += `———————————————\n`;
  msg += `👍 Like, Share & Follow PlayReportZA\n`;
  msg += `#Football #LiveScores #SoccerUpdates #PSL #CAF #UEFA #FIFA\n`;

  return msg;
}

// ----------------------------------------------
// HELPERS
// ----------------------------------------------
function convertToSA(date) {
  return new Date(
    date.toLocaleString("en-US", { timeZone: "Africa/Johannesburg" })
  );
}

function formatTime(date) {
  return date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatDate(date) {
  return date.toLocaleDateString("en-GB");
}

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    headers: { "Content-Type": "application/json" }
  });
}

function groupByLeague(arr) {
  const out = {};
  for (const m of arr) {
    if (!out[m.country]) out[m.country] = {};
    if (!out[m.country][m.league]) out[m.country][m.league] = [];
    out[m.country][m.league].push(m);
  }
  return out;
}

function getFlag(country) {
  const flags = {
    Spain: "🇪🇸",
    England: "🏴",
    Italy: "🇮🇹",
    Germany: "🇩🇪",
    France: "🇫🇷",
    Portugal: "🇵🇹",
    Netherlands: "🇳🇱",
    Belgium: "🇧🇪",
    South Africa: "🇿🇦",
    USA: "🇺🇸",
    Brazil: "🇧🇷",
    Argentina: "🇦🇷",
    Others: "🌍"
  };
  return flags[country] || "🌍";
                                                 }
