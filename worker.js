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

// ============================= MAIN FUNCTION =============================

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

    const isLive = ["1H", "2H", "ET", "PEN", "LIVE"].includes(status);
    const isHT = status === "HT";
    const isFT = ["FT", "AET"].includes(status);

    if (!isLive && !isHT && !isFT) continue;

    const league = `${getFlag(f.league.country)} ${f.league.country} - ${f.league.name}`;

    const saTime = toSA(f.fixture.date);
    const score = formatScoreBoxes(f.goals.home, f.goals.away);

    const minute = isFT
      ? "FT"
      : isHT
      ? "HT"
      : f.fixture.status.elapsed
      ? `${f.fixture.status.elapsed}'`
      : "";

    // ================= GOAL MINUTES + SCORERS =================
    let goals = [];
    if (f.events) {
      f.events.forEach(ev => {
        if (ev.type === "Goal" && ev.time?.elapsed) {
          const scorer = ev.player?.name || "";
          goals.push(`⚽ ${ev.time.elapsed}' ${scorer}`);
        }
      });
    }

    const goalsLine = goals.length ? goals.join("\n") : "";

    // ================= LIVE STATS =================
    let stats = "";
    if (!isFT && f.statistics?.length > 1) {
      const home = f.statistics[0].statistics;
      const away = f.statistics[1].statistics;

      const corners = numPair(home, away, "Corner Kicks", "🚩 Corners");
      const possession = numPair(home, away, "Ball Possession", "📊 Possession");

      stats = [corners, possession].filter(Boolean).join("\n");
    }

    const derby = isDerby(f.teams.home.name, f.teams.away.name)
      ? "🔥 Derby Match"
      : "";

    const line =
      `⏱ ${saTime} | ${f.teams.home.name} ${score} ${f.teams.away.name} (${minute})` +
      (derby ? `\n${derby}` : "") +
      (goalsLine ? `\n${goalsLine}` : "") +
      (stats && !isFT ? `\n${stats}` : "");

    if (isLive) {
      if (!live[league]) live[league] = [];
      live[league].push({ time: saTime, text: line });
    } else if (isHT) {
      if (!ht[league]) ht[league] = [];
      ht[league].push({ time: saTime, text: line });
    } else if (isFT) {
      if (!ft[league]) ft[league] = [];
      ft[league].push({ time: saTime, text: line.replace(/\n.*/g, "") });
    } else {
      others.push(line);
    }
  }

  const post = buildPost(live, ht, ft, others);

  const fbURL =
    `https://graph.facebook.com/${pageId}/feed?message=${encodeURIComponent(post)}&access_token=${fbToken}`;

  const fbResponse = await fetch(fbURL, { method: "POST" });
  const fbData = await fbResponse.json();

  if (manual) {
    return new Response(JSON.stringify({
      status: "POST_SENT",
      posted_message_preview: post.slice(0, 200),
      facebook_result: fbData
    }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  return new Response("OK");
}

// ============================= BUILD POST =============================

function buildPost(live, ht, ft, others) {
  let post = `⚽ Today's Live Fixtures (SA Time)\n`;

  // LIVE
  if (Object.keys(live).length > 0) {
    post += `\n🔴 LIVE MATCHES\n`;
    for (const league of Object.keys(live)) {
      const sorted = live[league].sort((a, b) => a.time.localeCompare(b.time));
      post += `\n📍 ${league}\n${sorted.map(x => x.text).join("\n")}\n`;
    }
  }

  // HT
  if (Object.keys(ht).length > 0) {
    post += `\n🟡 HALF TIME\n`;
    for (const league of Object.keys(ht)) {
      const sorted = ht[league].sort((a, b) => a.time.localeCompare(b.time));
      post += `\n📍 ${league}\n${sorted.map(x => x.text).join("\n")}\n`;
    }
  }

  // BREAK
  post += `\n━━━━━━━━━━━━━━━━━━━━\n📣 Follow PlayReportZA for instant live score updates!\n━━━━━━━━━━━━━━━━━━━━\n`;

  // FT DESCENDING ORDER
  if (Object.keys(ft).length > 0) {
    post += `\n🟢 FULL TIME RESULTS\n`;
    for (const league of Object.keys(ft)) {
      const sorted = ft[league].sort((a, b) => b.time.localeCompare(a.time)); // DESCENDING
      post += `\n📍 ${league}\n${sorted.map(x => x.text).join("\n")}\n`;
    }
  }

  // OTHERS FALLBACK
  if (others.length > 0) {
    post += `\n📦 Others\n${others.join("\n")}\n`;
  }

  // HASHTAGS (20 mixed)
  post +=
    `\n#LiveScores #FootballUpdates #SoccerLive #PlayReportZA #GoalAlert #MatchDay #WorldFootball #SportsLive #AfricaFootball #GlobalScores #LiveMatchTracker #ScoreUpdate #FootballAction #BreakingSports #GoalScorers #FullTimeResults #HalfTimeScores #LiveFixtures #SoccerStats #DailyFootball`;

  return post.trim();
}

// ============================= HELPERS =============================

function formatScoreBoxes(h, a) {
  if (h === null || a === null) return "";
  const winner = h > a ? "home" : a > h ? "away" : "draw";

  const box = (num, type) =>
    type === "win" ? `✌️${num}❌` :
    type === "lose" ? `✌️${num}❌` :
    `🤝${num}🤝`;

  return `${box(h, winner === "home" ? "win" : winner === "away" ? "lose" : "draw")}–${box(a, winner === "away" ? "win" : winner === "home" ? "lose" : "draw")}`;
}

function numPair(h, a, field, label) {
  const v1 = h.find(x => x.type === field)?.value;
  const v2 = a.find(x => x.type === field)?.value;
  if (!v1 || !v2) return "";
  return `${label}: ${v1}–${v2}`;
}

function isDerby(h, a) {
  return h.split(" ")[0] === a.split(" ")[0];
}

function getFlag(country) {
  const map = {
    "South Africa": "🇿🇦",
    "England": "🏴",
    "France": "🇫🇷",
    "Spain": "🇪🇸",
    "Germany": "🇩🇪",
    "Italy": "🇮🇹",
    "Portugal": "🇵🇹",
    "Netherlands": "🇳🇱",
    "Argentina": "🇦🇷",
    "Brazil": "🇧🇷"
  };
  return map[country] || "🌍";
}

function toSA(utc) {
  return new Date(utc).toLocaleTimeString("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Johannesburg"
  });
}

async function fetchFixtures(date, apiKey) {
  const res = await fetch(`https://v3.football.api-sports.io/fixtures?date=${date}`, {
    headers: { "x-apisports-key": apiKey }
  });
  const data = await res.json();
  return data.response || [];
            }
