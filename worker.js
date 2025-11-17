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
      return jsonResp({ error: "Missing environment variables" }, 500);
    }

    // SA timezone
    const saTime = (iso) =>
      new Date(iso).toLocaleString("en-ZA", {
        timeZone: "Africa/Johannesburg",
        hour: "2-digit",
        minute: "2-digit"
      });

    const today = new Date().toISOString().split("T")[0];
    const apiRes = await fetch(
      `https://v3.football.api-sports.io/fixtures?date=${today}`,
      { headers: { "x-apisports-key": apiKey } }
    );
    const apiData = await apiRes.json();

    if (!apiData.response) {
      return jsonResp({ error: "API returned no data" }, 500);
    }

    // GROUP BY LEAGUE
    const leagues = {};
    for (const m of apiData.response) {
      const leagueName = `${m.league.country} - ${m.league.name}`;
      if (!leagues[leagueName]) leagues[leagueName] = [];
      leagues[leagueName].push(m);
    }

    let liveSection = "🔥 *LIVE Matches*\n";
    let htSection = "\n⏸️ *Half Time Results*\n";
    let ftSection = "\n🏁 *Full Time Results*\n";

    let hasLive = false, hasHT = false, hasFT = false;

    for (const league of Object.keys(leagues)) {
      const matches = leagues[league];

      // SORT by kickoff
      matches.sort((a,b)=> new Date(a.fixture.date) - new Date(b.fixture.date));

      let liveBlock = "";
      let htBlock = "";
      let ftBlock = "";

      for (const m of matches) {
        const time = saTime(m.fixture.date);
        const status = m.fixture.status.short;
        
        const home = m.teams.home.name;
        const away = m.teams.away.name;
        const goalsHome = m.goals.home ?? 0;
        const goalsAway = m.goals.away ?? 0;

        // Build GOAL DETAILS
        let goalDetails = "";
        if (m.events) {
          const goals = m.events.filter(e => e.type === "Goal");
          if (goals.length > 0) {
            goalDetails = goals
              .map(g => `⚽ ${g.player.name} (${g.time.elapsed}')`)
              .join(", ");
          }
        }

        // Stats
        const stats = m.statistics?.[0]?.statistics || [];
        const corners = findStat(stats, "Corner Kicks");
        const poss = findStat(stats, "Ball Possession");

        const extraStats =
          (corners ? `🚩 Corners: ${corners}\n` : "") +
          (poss ? `📊 Possession: ${poss}\n` : "");

        // Build match line
        const line =
          `${time} | ${home} ${goalsHome}–${goalsAway} ${away}\n` +
          (goalDetails ? `${goalDetails}\n` : "") +
          extraStats;

        if (status === "1H" || status === "2H" || status === "LIVE") {
          hasLive = true;
          liveBlock += line + "\n";
        } 
        else if (status === "HT") {
          hasHT = true;
          htBlock += line + "\n";
        } 
        else if (status === "FT") {
          hasFT = true;
          ftBlock += line + "\n";
        }
      }

      if (liveBlock) liveSection += `\n📍 ${league}\n${liveBlock}`;
      if (htBlock) htSection += `\n📍 ${league}\n${htBlock}`;
      if (ftBlock) ftSection += `\n📍 ${league}\n${ftBlock}`;
    }

    let finalMessage = `⚽ *Today's Live Fixtures* (${currentSA()})\n`;

    if (hasLive) finalMessage += liveSection;
    if (hasHT) finalMessage += htSection;
    if (hasFT) finalMessage += ftSection;

    finalMessage += `\n\n👉 Follow for more updates\n#Football #LiveScores #PlayReportZA`;

    // SEND TO FACEBOOK
    const fbURL = `https://graph.facebook.com/${pageId}/feed?message=${encodeURIComponent(finalMessage)}&access_token=${fbToken}`;
    const fbResponse = await fetch(fbURL, { method: "POST" });
    const fbData = await fbResponse.json();

    if (manual) {
      return jsonResp({
        status: "POST_SENT",
        posted_message_preview: finalMessage.slice(0,300),
        facebook_result: fbData
      });
    }

    return jsonResp({ success: true });
  } catch (err) {
    return jsonResp({ error: err.message }, 500);
  }
}

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function findStat(stats, name) {
  const s = stats.find(x => x.type === name);
  return s?.value || null;
}

function currentSA() {
  return new Date().toLocaleString("en-ZA", {
    timeZone: "Africa/Johannesburg",
    hour: "2-digit",
    minute: "2-digit",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
        }
