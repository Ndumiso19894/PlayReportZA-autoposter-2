export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.get("force") === "true") {
      return await runAutoposter(env, true);
    }
    return new Response("PlayReportZA autoposter active.");
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAutoposter(env, false));
  }
};

async function runAutoposter(env, manual = false) {
  try {
    const apiKey = env.ALL_SPORTS_API_KEY;
    const fbToken = env.FB_PAGE_TOKEN;
    const pageId = env.FB_PAGE_ID;

    if (!apiKey || !fbToken || !pageId) {
      return new Response(JSON.stringify({
        error: "Missing environment variables",
        apiKey: !!apiKey,
        fbToken: !!fbToken,
        pageId: !!pageId
      }), { status: 500 });
    }

    // SA TIME FIX — convert UTC → South Africa time (UTC+2)
    const saTime = (date) => {
      const d = new Date(date);
      d.setHours(d.getHours() + 2);
      return d;
    };

    const now = saTime(new Date());
    const today = now.toISOString().split("T")[0];

    // FETCH LIVE MATCHES
    const liveRes = await fetch(
      `https://allsportsapi2.p.rapidapi.com/api/football/livescore?timezone=Africa/Johannesburg`,
      {
        headers: {
          "x-rapidapi-key": apiKey,
          "x-rapidapi-host": "allsportsapi2.p.rapidapi.com"
        }
      }
    );

    const liveData = await liveRes.json();

    let liveMatches = liveData?.result?.map(m => formatMatch(m, saTime)) || [];

    // FETCH TODAY FIXTURES FOR FT MATCHES (LAST 6 HOURS)
    const fixturesRes = await fetch(
      `https://allsportsapi2.p.rapidapi.com/api/football/fixtures/date/${today}?timezone=Africa/Johannesburg`,
      {
        headers: {
          "x-rapidapi-key": apiKey,
          "x-rapidapi-host": "allsportsapi2.p.rapidapi.com"
        }
      }
    );

    const fixturesData = await fixturesRes.json();

    let finishedMatches = (fixturesData?.result || [])
      .filter(m => m.event_status === "Finished")
      .filter(m => {
        const endTime = saTime(m.event_date);
        return (now - endTime) / (1000 * 3600) <= 6;
      })
      .map(m => formatMatch(m, saTime));

    // GROUP BY COUNTRY + LEAGUE
    const group = (matches) => {
      const map = {};
      matches.forEach(m => {
        const key = `${m.country} - ${m.league}`;
        if (!map[key]) map[key] = [];
        map[key].push(m);
      });
      return map;
    };

    const liveGrouped = group(liveMatches);
    const ftGrouped = group(finishedMatches);

    // BUILD POST MESSAGE
    let msg = `📅 *Today's Live Fixtures* (SA Time)\n\n`;

    if (Object.keys(liveGrouped).length === 0 && Object.keys(ftGrouped).length === 0) {
      msg += "No live or recent matches found.\n\nFollow PlayReportZA for more updates.\n";
    }

    // LIVE SECTION
    for (const section in liveGrouped) {
      msg += `\n🌍 ${section}\n`;
      liveGrouped[section].sort((a, b) => a.timeValue - b.timeValue);
      liveGrouped[section].forEach(m => msg += buildMatchLine(m));
    }

    // SEPARATOR
    msg += `\n───────────────\n🟥 FULL TIME RESULTS\n───────────────\n`;

    // FULL TIME SECTION
    for (const section in ftGrouped) {
      msg += `\n🌍 ${section}\n`;
      ftGrouped[section].sort((a, b) => a.timeValue - b.timeValue);
      ftGrouped[section].forEach(m => msg += buildMatchLine(m));
    }

    // CTA + TAGS
    msg += `\nFollow PlayReportZA for more updates.\n#PlayReportZA #LiveScores #Football`;

    // POST TO FACEBOOK
    const fbURL = `https://graph.facebook.com/${pageId}/feed?message=${encodeURIComponent(msg)}&access_token=${fbToken}`;
    const fbRes = await fetch(fbURL, { method: "POST" });
    const fbData = await fbRes.json();

    if (manual) {
      return new Response(JSON.stringify({
        status: "POST_SENT",
        match_count: liveMatches.length + finishedMatches.length,
        facebook_result: fbData,
        posted_message_preview: msg.slice(0, 300)
      }, null, 2), { headers: { "Content-Type": "application/json" } });
    }

    return new Response("OK");

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }, null, 2),
      { status: 500 });
  }
}

// FORMAT MATCH
function formatMatch(m, saTime) {
  const start = saTime(m.event_date);
  const now = saTime(new Date());
  const minutesPlayed = m.event_status === "Live"
    ? `${m.event_status_info}'`
    : m.event_status === "Halftime"
      ? "HT"
      : "FT";

  const goals = m.goalscorers?.map(g => `${g.time}’ ${g.home_scorer || g.away_scorer}`).join(", ") || "";

  return {
    country: m.country_name || "Others",
    league: m.league_name,
    home: m.event_home_team,
    away: m.event_away_team,
    score: `${m.event_final_result}`,
    startTime: start.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" }),
    minute: minutesPlayed,
    goals,
    corners: m.event_corner_result || "",
    possession: m.event_possession_result || "",
    timeValue: start.getTime()
  };
}

// BUILD LINE
function buildMatchLine(m) {
  let line = `\n🔴 ${m.minute} | ${m.startTime} | ${m.home} ${m.score} ${m.away}`;

  if (m.goals) line += `\n⚽ Goals: ${m.goals}`;
  if (m.corners) line += `\n🚩 Corners: ${m.corners}`;
  if (m.possession) line += `\n📊 Possession: ${m.possession}`;

  return line + "\n";
        }
