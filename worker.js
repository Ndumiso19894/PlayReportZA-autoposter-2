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

// MAIN FUNCTION --------------------------------------------------

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

  // 🔥 FIRST PASS
  let fixtures = await fetchFixtures(today, apiKey);

  // 🔥 SECOND PASS (re-check missing details)
  let secondPass = await fetchFixtures(today, apiKey);

  // Merge passes (fill missing scores, times, stats)
  fixtures = mergeFixtures(fixtures, secondPass);

  const grouped = groupFixtures(fixtures);

  const post = buildPost(grouped);

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

// FETCH FIXTURES -------------------------------------------------

async function fetchFixtures(date, apiKey) {
  const res = await fetch(`https://v3.football.api-sports.io/fixtures?date=${date}`, {
    headers: { "x-apisports-key": apiKey }
  });
  const json = await res.json();
  return json.response || [];
}

// SECOND-PASS MERGER ---------------------------------------------

function mergeFixtures(first, second) {
  const map = {};

  // First load
  first.forEach(f => map[f.fixture.id] = f);

  // Second pass fills in missing data
  second.forEach(f => {
    if (!map[f.fixture.id]) {
      map[f.fixture.id] = f; 
    } else {
      const old = map[f.fixture.id];

      // Missing score
      if (old.goals.home == null && f.goals.home != null) old.goals = f.goals;

      // Missing elapsed time
      if (!old.fixture.status.elapsed && f.fixture.status.elapsed)
        old.fixture.status.elapsed = f.fixture.status.elapsed;

      // Missing stats
      if ((!old.statistics || old.statistics.length === 0) && f.statistics)
        old.statistics = f.statistics;
    }
  });

  return Object.values(map);
}

// GROUP FIXTURES -------------------------------------------------

function groupFixtures(fixtures) {
  const live = {};
  const ht = {};
  const ft = {};
  const other = {};

  for (const f of fixtures) {
    const league = f.league?.name && f.league?.country
      ? `${f.league.country} - ${f.league.name}`
      : "OTHERS";

    const status = f.fixture.status.short;
    const sa = toSA(f.fixture.date);

    const score = (f.goals.home !== null && f.goals.away !== null)
      ? `${f.goals.home}–${f.goals.away}`
      : "";

    const minute = f.fixture.status.elapsed
      ? `${f.fixture.status.elapsed}'`
      : status === "HT" ? "HT" :
        status === "FT" ? "FT" : "";

    // Goals
    const goals = [];
    if (f.events) {
      f.events.forEach(ev => {
        if (ev.type === "Goal" && ev.time?.elapsed) {
          goals.push(`${ev.time.elapsed}'`);
        }
      });
    }

    const goalsLine = goals.length ? `⚽ Goals: ${goals.join(", ")}` : "";

    // Stats (LIVE + HT only)
    let stats = "";
    if (status !== "FT" && f.statistics?.length > 1) {
      const H = f.statistics[0].statistics;
      const A = f.statistics[1].statistics;

      const corners = stat(H, A, "Corner Kicks", "🚩 Corners");
      const possession = stat(H, A, "Ball Possession", "📊 Possession");

      stats = [corners, possession].filter(Boolean).join("\n");
    }

    const line =
      `⏱️ ${sa} | ${f.teams.home.name} ${score} ${f.teams.away.name}` +
      (minute ? ` (${minute})` : "") +
      (goalsLine ? `\n${goalsLine}` : "") +
      (stats ? `\n${stats}` : "");

    const pushTo = (() => {
      if (status === "LIVE") return live;
      if (status === "HT") return ht;
      if (status === "FT") return ft;
      return other;
    })();

    if (!pushTo[league]) pushTo[league] = [];
    pushTo[league].push({ time: sa, text: line });
  }

  return { live, ht, ft, other };
}

function stat(H, A, type, label) {
  const h = findStat(H, type);
  const a = findStat(A, type);
  return h && a ? `${label}: ${h}–${a}` : "";
}

function findStat(arr, name) {
  const s = arr.find(x => x.type === name);
  return s?.value || null;
}

// SA TIME --------------------------------------------------------

function toSA(utc) {
  return new Date(utc).toLocaleTimeString("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Johannesburg"
  });
}

// BUILD POST -----------------------------------------------------

function buildPost({ live, ht, ft, other }) {
  let post = `⚽ Today's Live Fixtures (SA Time)\n`;

  const addGroup = (title, group) => {
    if (Object.keys(group).length === 0) return "";

    let txt = `\n${title}\n`;
    for (const league of Object.keys(group)) {
      const sorted = group[league].sort((a, b) => a.time.localeCompare(b.time));
      txt += `\n📍 ${league}\n${sorted.map(m => m.text).join("\n")}\n`;
    }
    return txt;
  };

  post += addGroup("🔴 LIVE MATCHES", live);
  post += addGroup("🟡 HALF-TIME", ht);
  post += addGroup("🟢 FULL-TIME RESULTS", ft);
  post += addGroup("📌 OTHER MATCHES", other);

  post += `
📣 Follow PlayReportZA for more live updates!

#Football #LiveScores #ScoreZone #SoccerUpdates #WorldFootball 
#MatchDay #TodayMatches #PlayReportZA #AfricaFootball #SportsNews
`;

  return post.trim();
}
