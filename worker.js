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
  const ht = {};
  const ft = {};
  const others = [];

  for (const f of fixtures) {
    const status = f.fixture.status.short;

    const league =
      f.league?.country && f.league?.name
        ? `${f.league.country} - ${f.league.name}`
        : "Others";

    const saTime = toSA(f.fixture.date);

    const score =
      f.goals.home !== null && f.goals.away !== null
        ? `${f.goals.home}–${f.goals.away}`
        : "";

    const minute =
      status === "FT" ? "FT"
      : status === "HT" ? "HT"
      : f.fixture.status.elapsed
      ? `${f.fixture.status.elapsed}'`
      : "";

    // Goal minutes
    let goals = [];
    if (f.events) {
      f.events.forEach(ev => {
        if (ev.type === "Goal" && ev.time?.elapsed) {
          goals.push(`${ev.time.elapsed}'`);
        }
      });
    }
    const goalsLine = goals.length ? `⚽ Goals: ${goals.join(", ")}` : "";

    // Stats only for live + half-time
    let stats = "";
    if (status !== "FT" && f.statistics?.length > 1) {
      const H = f.statistics[0].statistics || [];
      const A = f.statistics[1].statistics || [];

      const corners = pairStat(H, A, "Corner Kicks", "🚩 Corners");
      const poss = pairStat(H, A, "Ball Possession", "🦶 Possession");

      stats = [corners, poss].filter(Boolean).join("\n");
    }

    const line =
      `⏱️ ${saTime} | ${f.teams.home.name} ${score} ${f.teams.away.name}` +
      (minute ? ` (${minute})` : "") +
      (goalsLine ? `\n${goalsLine}` : "") +
      (stats ? `\n${stats}` : "");

    // Put match in correct group
    if (league === "Others") others.push({ time: saTime, text: line });

    if (!live[league]) live[league] = [];
    if (!ht[league]) ht[league] = [];
    if (!ft[league]) ft[league] = [];

    if (status === "LIVE") live[league].push({ time: saTime, text: line });
    else if (status === "HT") ht[league].push({ time: saTime, text: line });
    else if (status === "FT") ft[league].push({ time: saTime, text: line });
  }

  const post = buildPost(live, ht, ft, others);

  const fbURL =
    `https://graph.facebook.com/${pageId}/feed?message=${encodeURIComponent(post)}&access_token=${fbToken}`;

  const fbResponse = await fetch(fbURL, { method: "POST" });
  const fbData = await fbResponse.json();

  if (manual) {
    return new Response(JSON.stringify({
      status: "POST_SENT",
      posted_message_preview: post.slice(0, 350),
      facebook_result: fbData
    }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  return new Response("OK");
}

// -----------------------------------------------------

function buildPost(live, ht, ft, others) {
  let post = `⚽⚽⚽ Today's Live Fixtures (SA Time)⚽⚽⚽\n`;

  // LIVE
  if (hasMatches(live) || others.length) {
    post += `\n🔴 LIVE MATCHES\n`;

    for (const league of Object.keys(live)) {
      if (live[league].length === 0) continue;

      const sorted = live[league].sort((a, b) => a.time.localeCompare(b.time));
      post += `\n📍 ${league}\n${sorted.map(m => m.text).join("\n")}\n`;
    }

    if (others.length) {
      const sorted = others.sort((a, b) => a.time.localeCompare(b.time));
      post += `\n📍 Others\n${sorted.map(m => m.text).join("\n")}\n`;
    }
  }

  // Separator paragraph
  post += `\n━━━━━━━━━━━━━━━━━━\n📣 Brought to you by PlayReportZA — Your daily football updates! Please Like and Follow! \n━━━━━━━━━━━━━━━━━━\n`;

  // HALF-TIME
  if (hasMatches(ht)) {
    post += `\n🟡 HALF-TIME😮‍💨\n`;
    for (const league of Object.keys(ht)) {
      if (ht[league].length === 0) continue;

      const sorted = ht[league].sort((a, b) => a.time.localeCompare(b.time));
      post += `\n📍 ${league}\n${sorted.map(m => m.text).join("\n")}\n`;
    }
  }

  // FULL-TIME
  if (hasMatches(ft)) {
    post += `\n🟢 FULL-TIME RESULTS\n`;
    for (const league of Object.keys(ft)) {
      if (ft[league].length === 0) continue;

      const sorted = ft[league].sort((a, b) => a.time.localeCompare(b.time));
      post += `\n📍 ${league}\n${sorted.map(m => m.text.replace(/\n.*/g, ""))}\n`;
    }
  }

  // 10 Hashtags
  post +=
    `\n#PlayReportZA #LiveScores #FootballUpdates #SoccerNews #MatchDay #Goals #AfricaFootball #EuropeFootball #TrendingSports #BreakingSports`;

  return post.trim();
}

// -----------------------------------------------------

function hasMatches(obj) {
  return Object.values(obj).some(arr => arr.length > 0);
}

function toSA(utc) {
  return new Date(utc).toLocaleTimeString("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Johannesburg"
  });
}

function pairStat(home, away, type, label) {
  const h = home.find(x => x.type === type)?.value;
  const a = away.find(x => x.type === type)?.value;
  return h && a ? `${label}: ${h}–${a}` : "";
}

async function fetchFixtures(date, apiKey) {
  const res = await fetch(`https://v3.football.api-sports.io/fixtures?date=${date}`, {
    headers: { "x-apisports-key": apiKey }
  });
  const data = await res.json();
  return data.response || [];
      }
