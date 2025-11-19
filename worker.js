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

// ✔ Live status codes
const LIVE_STATUSES = ["1H", "2H", "ET", "BT", "LIVE", "INT", "P", "PEN"];

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

  // Grouping
  const live = {};
  const ht = {};
  const ft = {};

  for (const f of fixtures) {
    const league = `${f.league.country} - ${f.league.name}`;
    const status = f.fixture.status.short;

    if (!live[league]) live[league] = [];
    if (!ht[league]) ht[league] = [];
    if (!ft[league]) ft[league] = [];

    const saTime = toSA(f.fixture.date);

    const isLive = LIVE_STATUSES.includes(status);
    const isHT = status === "HT";
    const isFT = status === "FT";

    const score =
      f.goals.home !== null && f.goals.away !== null
        ? `${f.goals.home}–${f.goals.away}`
        : "–";

    const minute = f.fixture.status.elapsed
      ? `${f.fixture.status.elapsed}'`
      : isHT
      ? "HT"
      : isFT
      ? "FT"
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

    // Stats only for LIVE + HT
    let stats = "";
    if (!isFT && f.statistics?.length > 1) {
      const h = f.statistics[0].statistics || [];
      const a = f.statistics[1].statistics || [];

      const cH = findStat(h, "Corner Kicks");
      const cA = findStat(a, "Corner Kicks");

      const pH = findStat(h, "Ball Possession");
      const pA = findStat(a, "Ball Possession");

      const corners = cH && cA ? `🚩 Corners: ${cH}–${cA}` : "";
      const possession = pH && pA ? `📊 Possession: ${pH}–${pA}` : "";

      stats = [corners, possession].filter(Boolean).join("\n");
    }

    const line =
      `⏱️ ${saTime} | ${f.teams.home.name} ${score} ${f.teams.away.name}` +
      (minute ? ` (${minute})` : "") +
      (goalsLine ? `\n${goalsLine}` : "") +
      (stats ? `\n${stats}` : "");

    if (isLive) live[league].push({ time: saTime, text: line });
    else if (isHT) ht[league].push({ time: saTime, text: line });
    else if (isFT) ft[league].push({ time: saTime, text: line });
  }

  const post = buildPost(live, ht, ft);

  const fbURL =
    `https://graph.facebook.com/${pageId}/feed?` +
    `message=${encodeURIComponent(post)}&access_token=${fbToken}`;

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

// --------------------------------------------------------

function buildPost(live, ht, ft) {
  let post = `⚽ Today's Live Fixtures (SA Time)\n`;

  // LIVE
  if (Object.keys(live).length > 0) {
    post += `\n🔴 LIVE MATCHES\n`;
    for (const league of Object.keys(live)) {
      const sorted = live[league].sort((a, b) => a.time.localeCompare(b.time));
      post += `\n🌍 ${league}\n${sorted.map(m => m.text).join("\n")}\n`;
    }
  }

  // HT
  if (Object.keys(ht).length > 0) {
    post += `\n🟡 HALF-TIME\n`;
    for (const league of Object.keys(ht)) {
      const sorted = ht[league].sort((a, b) => a.time.localeCompare(b.time));
      post += `\n🌍 ${league}\n${sorted.map(m => m.text).join("\n")}\n`;
    }
  }

  // FT – all results sorted
  if (Object.keys(ft).length > 0) {
    post += `\n🟢 FULL-TIME RESULTS\n`;
    for (const league of Object.keys(ft)) {
      const sorted = ft[league].sort((a, b) => a.time.localeCompare(b.time));
      post += `\n🌍 ${league}\n${sorted
        .map(m => m.text.split("\n")[0])
        .join("\n")}\n`;
    }
  }

  // HASHTAGS
  post +=
    `\n📣 Follow PlayReportZA for more live updates!\n` +
    `#football #livescores #PlayReportZA`;

  return post.trim();
}

// --------------------------------------------------------

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
