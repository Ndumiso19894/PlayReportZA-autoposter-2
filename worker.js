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
      }), { status: 500 });
    }

    // SAST TIME FIX
    const nowUTC = new Date();
    const nowSAST = new Date(nowUTC.getTime() + 2 * 60 * 60 * 1000);
    const today = nowSAST.toISOString().split("T")[0];

    const url = `https://v3.football.api-sports.io/fixtures?date=${today}`;
    const apiResponse = await fetch(url, {
      headers: { "x-apisports-key": apiKey }
    });
    const data = await apiResponse.json();

    const fixtures = data.response || [];

    let liveMatches = [];
    let halfTimeMatches = [];
    let finishedMatches = [];

    const fiveHoursAgoSAST = new Date(nowSAST.getTime() - 5 * 60 * 60 * 1000);

    // PROCESS MATCHES
    for (let fx of fixtures) {
      const league = fx.league?.name || "Unknown League";
      const home = fx.teams.home.name;
      const away = fx.teams.away.name;
      const kickoffUTC = new Date(fx.fixture.date);
      const kickoffSAST = new Date(kickoffUTC.getTime() + 2 * 60 * 60 * 1000);
      const status = fx.fixture.status.short;
      const statusLong = fx.fixture.status.long;
      const goals = fx.goals;

      // Calculate live minute
      let matchMinute = null;
      if (status === "1H" || status === "2H") {
        const diffMin = Math.floor((nowSAST - kickoffSAST) / 60000);
        if (status === "2H") matchMinute = diffMin + 15; 
        else matchMinute = diffMin;
      }

      // Goal scorers
      let scorerList = [];
      if (fx.events) {
        for (let e of fx.events) {
          if (e.type === "Goal") {
            scorerList.push(`${e.player.name} (${e.time.elapsed}')`);
          }
        }
      }

      // Corners + Possession
      let corners = null;
      let possession = null;
      if (fx.statistics && fx.statistics.length >= 2) {
        const h = fx.statistics[0].statistics;
        const a = fx.statistics[1].statistics;

        let hc = h.find(s => s.type === "Corner Kicks")?.value;
        let ac = a.find(s => s.type === "Corner Kicks")?.value;
        if (hc != null && ac != null) corners = `${hc}-${ac}`;

        let hp = h.find(s => s.type === "Ball Possession")?.value;
        let ap = a.find(s => s.type === "Ball Possession")?.value;
        if (hp && ap) possession = `${hp} / ${ap}`;
      }

      // Build the match record
      const record = {
        league,
        kickoff: kickoffSAST,
        kickoffStr: kickoffSAST.toTimeString().slice(0,5),
        home,
        away,
        goalsH: goals.home,
        goalsA: goals.away,
        minute: matchMinute,
        status,
        statusLong,
        scorers: scorerList,
        corners,
        possession
      };

      if (status === "FT" || status === "AET" || status === "PEN") {
        if (kickoffSAST >= fiveHoursAgoSAST) finishedMatches.push(record);
      } else if (status === "HT") {
        halfTimeMatches.push(record);
      } else if (status === "1H" || status === "2H") {
        liveMatches.push(record);
      }
    }

    // SORTING: group by league + sort inside by kickoff
    function groupAndSort(list) {
      const groups = {};
      for (let m of list) {
        if (!groups[m.league]) groups[m.league] = [];
        groups[m.league].push(m);
      }
      for (let lg in groups) {
        groups[lg].sort((a,b) => a.kickoff - b.kickoff);
      }
      return groups;
    }

    const liveGrouped = groupAndSort(liveMatches);
    const htGrouped = groupAndSort(halfTimeMatches);
    const ftGrouped = groupAndSort(finishedMatches);

    // BUILD MESSAGE
    let message = `⚽ Live / HT / FT Football Update (${today} ${nowSAST.toTimeString().slice(0,5)})\n\n`;

    // LIVE SECTION
    if (Object.keys(liveGrouped).length > 0) {
      message += "🔥 LIVE MATCHES\n";
      for (let lg in liveGrouped) {
        message += `📍 ${lg}\n`;
        for (let m of liveGrouped[lg]) {
          message += `[LIVE ${m.minute}'] ${m.kickoffStr} | ${m.home} ${m.goalsH}–${m.goalsA} ${m.away}\n`;
          if (m.scorers.length > 0) message += `Goals: ${m.scorers.join(", ")}\n`;
          if (m.corners) message += `Corners: ${m.corners}\n`;
          if (m.possession) message += `Possession: ${m.possession}\n`;
        }
        message += "\n";
      }
    }

    // HALF TIME
    if (Object.keys(htGrouped).length > 0) {
      message += "⏸ HALF-TIME\n";
      for (let lg in htGrouped) {
        message += `📍 ${lg}\n`;
        for (let m of htGrouped[lg]) {
          message += `[HT] ${m.kickoffStr} | ${m.home} ${m.goalsH}–${m.goalsA} ${m.away}\n`;
        }
        message += "\n";
      }
    }

    // FULL TIME
    if (Object.keys(ftGrouped).length > 0) {
      message += "🏁 FULL-TIME (Last 5 hours)\n";
      for (let lg in ftGrouped) {
        message += `📍 ${lg}\n`;
        for (let m of ftGrouped[lg]) {
          message += `${m.kickoffStr} | ${m.home} ${m.goalsH}–${m.goalsA} ${m.away}\n`;
          if (m.scorers.length > 0) message += `Goals: ${m.scorers.join(", ")}\n`;
          if (m.corners) message += `Corners: ${m.corners}\n`;
          if (m.possession) message += `Possession: ${m.possession}\n`;
        }
        message += "\n";
      }
    }

    // CALL TO ACTION + TAGS
    message += "\nFollow PlayReportZA for more football updates!\n";
    message += "#Football #LiveScores #PlayReportZA #Soccer";

    // POST TO FACEBOOK
    const fbURL =
      `https://graph.facebook.com/${pageId}/feed?message=${encodeURIComponent(message)}&access_token=${fbToken}`;

    const fbRes = await fetch(fbURL, { method: "POST" });
    const fbData = await fbRes.json();

    if (manual) {
      return new Response(JSON.stringify({
        status: "POST_SENT",
        message_preview: message.slice(0, 500),
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
