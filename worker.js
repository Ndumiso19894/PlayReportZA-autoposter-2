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
      }, null, 2), {
        status: 500,
        headers: {"Content-Type": "application/json"}
      });
    }

    const today = new Date().toISOString().slice(0, 10);

    const res = await fetch(
      `https://v3.football.api-sports.io/fixtures?date=${today}`,
      { headers: { "x-apisports-key": apiKey } }
    );

    const data = await res.json();
    const fixtures = data.response || [];

    const now = new Date();

    // Convert to local time
    const toLocal = (d) =>
      new Date(d).toLocaleString("en-GB", { timeZone: "Africa/Johannesburg" });

    // ---- FILTER FIXTURES ----
    const live = [];
    const halftime = [];
    const fulltime = [];

    for (const m of fixtures) {
      const status = m.fixture.status.short;
      const minute = m.fixture.status.elapsed;
      const kickoffUTC = m.fixture.date;
      const kickoffLocal = toLocal(kickoffUTC);

      // Basic data
      const league = `${m.league.country} - ${m.league.name}`;
      const home = m.teams.home.name;
      const away = m.teams.away.name;
      const goalsH = m.goals.home ?? 0;
      const goalsA = m.goals.away ?? 0;

      // Goals info
      const events = (m.events || [])
        .filter(e => e.type === "Goal")
        .map(e => `${e.player.name} ${e.time.elapsed}'`);

      // Stats (only if available)
      let corners = null;
      let possession = null;

      if (m.statistics && m.statistics.length >= 2) {
        const sHome = m.statistics[0]?.statistics;
        const sAway = m.statistics[1]?.statistics;

        if (sHome && sAway) {
          const cH = sHome.find(s => s.type === "Corner Kicks")?.value;
          const cA = sAway.find(s => s.type === "Corner Kicks")?.value;
          if (cH !== undefined && cA !== undefined) {
            corners = `${cH}–${cA}`;
          }

          const pH = sHome.find(s => s.type === "Ball Possession")?.value;
          const pA = sAway.find(s => s.type === "Ball Possession")?.value;
          if (pH && pA) {
            possession = `${pH} / ${pA}`;
          }
        }
      }

      const obj = {
        league,
        kickoffLocal,
        minute,
        home, away,
        goalsH, goalsA,
        events,
        corners,
        possession,
        rawKickoff: new Date(kickoffUTC)
      };

      if (status === "1H" || status === "2H" || status === "LIVE") live.push(obj);
      else if (status === "HT") halftime.push(obj);
      else if (status === "FT" || status === "AET" || status === "PEN") {
        const diffHours = (now - obj.rawKickoff) / 36e5;
        if (diffHours <= 5) fulltime.push(obj);
      }
    }

    // ---- SORT BY TIME ----
    const byTime = (a, b) => a.rawKickoff - b.rawKickoff;
    live.sort(byTime);
    halftime.sort(byTime);
    fulltime.sort(byTime);

    // ---- BUILD MESSAGE ----
    let msg = `⚽ *Live / HT / FT Football Update* (${toLocal(now).slice(12, 17)})\n\n`;

    const addSection = (title, arr) => {
      if (arr.length === 0) return;
      msg += `\n📍 *${title}*\n`;
      arr.forEach(m => {
        msg += `${m.minute ? `[${m.minute}']` : ""} `;
        msg += `${m.kickoffLocal.slice(12, 17)} | ${m.home} ${m.goalsH}–${m.goalsA} ${m.away}\n`;

        if (m.events.length) msg += `Goals: ${m.events.join(", ")}\n`;
        if (m.corners) msg += `Corners: ${m.corners}\n`;
        if (m.possession) msg += `Possession: ${m.possession}\n`;
      });
    };

    msg += `🔥 *LIVE MATCHES*\n`;
    addSection("Live Games", live);

    msg += `\n——————— FULL TIME ———————\n`;
    addSection("Full Time Results (Last 5 hrs)", fulltime);

    // ---- POST TO FACEBOOK ----
    const fbURL = 
      `https://graph.facebook.com/${pageId}/feed?message=${encodeURIComponent(msg)}&access_token=${fbToken}`;

    const fbRes = await fetch(fbURL, { method: "POST" });
    const fbData = await fbRes.json();

    if (manual) {
      return new Response(JSON.stringify({
        status: "POST_SENT",
        match_count: live.length + halftime.length + fulltime.length,
        posted_message_preview: msg.slice(0, 300),
        facebook_result: fbData
      }, null, 2), {
        headers: {"Content-Type": "application/json"}
      });
    }

    return new Response("OK", {status: 200});

  } catch (err) {
    return new Response("Error: " + err.message, { status: 500 });
  }
  }
