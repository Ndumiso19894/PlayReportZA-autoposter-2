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
  const apiKey = env.API_FOOTBALL_KEY;
  const fbToken = env.FB_PAGE_TOKEN;
  const pageId = env.FB_PAGE_ID;

  if (!apiKey || !fbToken || !pageId) {
    return new Response(JSON.stringify({
      error: "Missing environment variables",
      apiKey: !!apiKey,
      fbToken: !!fbToken,
      pageId: !!pageId
    }, null, 2), { status: 500 });
  }

  const today = new Date().toISOString().split("T")[0];
  const fixtures = await fetchFixtures(today, apiKey);

  const live = {};
  const ft = {};
  const others = [];

  for (const f of fixtures) {
    const status = f.fixture.status.short;

    const isLive = ["1H","2H","HT","ET","PEN","LIVE"].includes(status);
    const isFT = ["FT","AET","PEN"].includes(status);

    if (!isLive && !isFT) continue;

    const league = `${f.league.country} - ${f.league.name}`;
    const saTime = toSA(f.fixture.date);

    const home = f.goals.home;
    const away = f.goals.away;

    const score =
      home !== null && away !== null ? `${home}–${away}` : "";

    const minute =
      status === "FT" ? "FT" :
      status === "HT" ? "HT" :
      f.fixture.status.elapsed ? `${f.fixture.status.elapsed}'` : "";

    // Goal minutes
    let goals = [];
    if (f.events) {
      for (const ev of f.events) {
        if (ev.type === "Goal" && ev.time?.elapsed) {
          goals.push(`${ev.time.elapsed}'`);
        }
      }
    }

    const goalsLine = goals.length ? `⚽ Goals: ${goals.join(", ")}` : "";

    // Stats for LIVE only
    let stats = "";
    if (isLive && f.statistics?.length > 1) {
      const homeStats = f.statistics[0].statistics;
      const awayStats = f.statistics[1].statistics;

      const cH = findStat(homeStats, "Corner Kicks");
      const cA = findStat(awayStats, "Corner Kicks");
      const pH = findStat(homeStats, "Ball Possession");
      const pA = findStat(awayStats, "Ball Possession");

      const corners = cH && cA ? `🚩 Corners: ${cH}–${cA}` : "";
      const pos = pH && pA ? `📊 Possession: ${pH}–${pA}` : "";

      stats = [corners, pos].filter(Boolean).join("\n");
    }

    // --------------------------------------------------------
    // ★ FT SCORE COLOR BOXES ★
    // --------------------------------------------------------
    let homeBox = "", awayBox = "";

    if (isFT && home !== null && away !== null) {
      if (home > away) {
        homeBox = `🟦${home}`;
        awayBox = `🟥${away}`;
      } else if (away > home) {
        homeBox = `🟥${home}`;
        awayBox = `🟦${away}`;
      } else {
        homeBox = `⬜${home}`;
        awayBox = `⬜${away}`;
      }
    }

    const liveLine =
      `⏱ ${saTime} | ${f.teams.home.name} ${score} ${f.teams.away.name}` +
      (minute ? ` (${minute})` : "") +
      (goalsLine ? `\n${goalsLine}` : "") +
      (stats && isLive ? `\n${stats}` : "");

    const ftLine =
      `⏱ ${saTime} | ${f.teams.home.name} ${homeBox} ${awayBox} ${f.teams.away.name}` +
      (goalsLine ? `\n${goalsLine}` : "");

    if (isLive) {
      if (!live[league]) live[league] = [];
      live[league].push({ time: saTime, text: liveLine });
    } else if (isFT) {
      if (!ft[league]) ft[league] = [];
      ft[league].push({ time: saTime, text: ftLine });
    } else {
      others.push(liveLine);
    }
  }

  const post = buildPost(live, ft, others);

  const fbURL =
    `https://graph.facebook.com/${pageId}/feed?message=${encodeURIComponent(post)}&access_token=${fbToken}`;

  const fbResponse = await fetch(fbURL, { method: "POST" });
  const fbData = await fbResponse.json();

  if (manual) {
    return new Response(JSON.stringify({
      status: "POST_SENT",
      preview: post.slice(0, 300),
      facebook_result: fbData
    }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  return new Response("OK");
}

// ---------------------------------------------------

function buildPost(live, ft, others) {
  let post = `⚽ Live Matches (SAST)\n`;

  // LIVE
  if (Object.keys(live).length > 0) {
    post += `\n🔴 LIVE MATCHES\n`;
    for (const league of Object.keys(live)) {
      if (live[league].length === 0) continue;
      const sorted = live[league].sort((a,b)=>b.time.localeCompare(a.time));
      post += `\n📍 ${league}\n${sorted.map(m=>m.text).join("\n")}\n`;
    }
  }

  post += `\n━━━━━━━━━━━━━━━━━━━━\n📣 Follow PlayReportZA for instant live score updates! ❤️⚽\n━━━━━━━━━━━━━━━━━━━━\n`;

  // FULL TIME — SORT MOST RECENT FIRST
  if (Object.keys(ft).length > 0) {
    post += `\n🟢 FULL-TIME RESULTS\n`;
    for (const league of Object.keys(ft)) {
      if (ft[league].length === 0) continue;
      const sorted = ft[league].sort((a,b)=>b.time.localeCompare(a.time));
      post += `\n📍 ${league}\n${sorted.map(m=>m.text).join("\n")}\n`;
    }
  }

  post += `\n#LiveScores #Football #Soccer #Matchday #FTResults #Football #Soccer #LiveScores #MatchDay #GoalAlert #ScoreUpdate #InPlay #FootballLive 
#SoccerUpdates #FTResults #SportsNews #FootballCommunity #GlobalFootball #PSL 
#TrendingMatch #InternationalFootball #SportsHighlights #PlayReportZA #LiveMatchTracker #VarsityCup #GlobalFootball #PlayReportZA`;

  return post.trim();
}

// ---------------------------------------------------

function toSA(utc) {
  return new Date(utc).toLocaleTimeString("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Johannesburg"
  });
}

function findStat(arr, name) {
  const s = arr.find(x=>x.type === name);
  return s?.value || null;
}

async function fetchFixtures(date, apiKey) {
  const res = await fetch(`https://v3.football.api-sports.io/fixtures?date=${date}`, {
    headers: { "x-apisports-key": apiKey }
  });
  const data = await res.json();
  return data.response || [];
  }
