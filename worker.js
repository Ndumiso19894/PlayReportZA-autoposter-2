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

  for (const f of fixtures) {
    const status = f.fixture.status.short;
    if (!["LIVE", "HT", "FT"].includes(status)) continue;

    const league = `${f.league.country} - ${f.league.name}`;

    if (!live[league]) live[league] = [];
    if (!ht[league]) ht[league] = [];
    if (!ft[league]) ft[league] = [];

    const saTime = toSA(f.fixture.date);

    const score =
      f.goals.home !== null && f.goals.away !== null
        ? `${f.goals.home}–${f.goals.away}`
        : "";

    const minute =
      status === "FT" ? "FT" :
      status === "HT" ? "HT" :
      f.fixture.status.elapsed ? `${f.fixture.status.elapsed}'` : "";

    // Goal minutes
    const goals = [];
    if (f.events) {
      f.events.forEach(ev => {
        if (ev.type === "Goal" && ev.time?.elapsed) {
          goals.push(`${ev.time.elapsed}'`);
        }
      });
    }
    const goalsLine = goals.length ? `⚽ Goals: ${goals.join(", ")}` : "";

    // Stats for LIVE + HT only
    let stats = "";
    if (status !== "FT" && f.statistics?.length >= 2) {
      const home = f.statistics[0].statistics;
      const away = f.statistics[1].statistics;

      const cH = findStat(home, "Corner Kicks");
      const cA = findStat(away, "Corner Kicks");
      const pH = findStat(home, "Ball Possession");
      const pA = findStat(away, "Ball Possession");

      const corners = cH && cA ? `🚩 Corners: ${cH}–${cA}` : "";
      const possession = pH && pA ? `📊 Possession: ${pH}–${pA}` : "";

      stats = [corners, possession].filter(Boolean).join("\n");
    }

    const line =
      `⏱️ ${saTime} | ${f.teams.home.name} ${score} ${f.teams.away.name}` +
      (minute ? ` (${minute})` : "") +
      (goalsLine ? `\n${goalsLine}` : "") +
      (stats ? `\n${stats}` : "");

    if (status === "LIVE") live[league].push({ time: saTime, text: line });
    else if (status === "HT") ht[league].push({ time: saTime, text: line });
    else if (status === "FT") ft[league].push({ time: saTime, text: line });
  }

  const post = buildPost(live, ht, ft);

  const fbURL =
    `https://graph.facebook.com/${pageId}/feed?message=${encodeURIComponent(post)}&access_token=${fbToken}`;
  const fbResponse = await fetch(fbURL, { method: "POST" });
  const fbData = await fbResponse.json();

  if (manual) {
    return new Response(JSON.stringify({
      status: "POST_SENT",
      posted_message_preview: post.slice(0, 300),
      facebook_result: fbData
    }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  return new Response("OK");
}

// -------------------------------------------

function buildPost(live, ht, ft) {
  let post = `⚽ Today's Live Fixtures (SA Time)\n`;

  // LIVE
  const liveLeagues = Object.keys(live).filter(l => live[l].length);
  if (liveLeagues.length > 0) {
    post += `\n🔴 LIVE MATCHES\n`;
    for (const league of liveLeagues) {
      const sorted = live[league].sort((a, b) => a.time.localeCompare(b.time));
      post += `\n🌍 ${league}\n${sorted.map(m => m.text).join("\n")}\n`;
    }
  }

  // HALF-TIME
  const htLeagues = Object.keys(ht).filter(l => ht[l].length);
  if (htLeagues.length > 0) {
    post += `\n🟡 HALF-TIME\n`;
    for (const league of htLeagues) {
      const sorted = ht[league].sort((a, b) => a.time.localeCompare(b.time));
      post += `\n🌍 ${league}\n${sorted.map(m => m.text).join("\n")}\n`;
    }
  }

  // FULL-TIME
  const ftLeagues = Object.keys(ft).filter(l => ft[l].length);
  if (ftLeagues.length > 0) {
    post += `\n🟢 FULL-TIME RESULTS\n`;
    for (const league of ftLeagues) {
      const sorted = ft[league].sort((a, b) => a.time.localeCompare(b.time));

      // Full-time has NO stats
      post += `\n🌍 ${league}\n${sorted
        .map(m => m.text.split("\n")[0])
        .join("\n")}\n`;
    }
  }

  post += `\n📣 Follow PlayReportZA for more updates!\n#football #livescores #PlayReportZA`;
  return post.trim();
}

function toSA(utc) {
  return new Date(utc).toLocaleTimeString("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Johannesburg"
  });
}

function findStat(arr, name) {
  const s = arr.find(x => x.type === name);
  return s?.value || null;
}

async function fetchFixtures(date, apiKey) {
  const res = await fetch(`https://v3.football.api-sports.io/fixtures?date=${date}`, {
    headers: { "x-apisports-key": apiKey }
  });
  const data = await res.json();
  return data.response || [];
}
