export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Manual test: ?force=true
    if (url.searchParams.get("force") === "true") {
      const result = await runAutoposter(env, true);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Normal GET
    return new Response("PlayReportZA autoposter is active.");
  },

  async scheduled(event, env, ctx) {
    // Runs automatically by cron
    ctx.waitUntil(runAutoposter(env, false));
  }
};

async function runAutoposter(env, manual = false) {
  const apiKey  = env.API_FOOTBALL_KEY;
  const fbToken = env.FB_PAGE_TOKEN;
  const pageId  = env.FB_PAGE_ID;

  // If env vars not wired, show clear JSON
  if (!apiKey || !fbToken || !pageId) {
    return {
      error: "Missing environment variables",
      apiKey : !!apiKey,
      fbToken: !!fbToken,
      pageId : !!pageId
    };
  }

  try {
    const today = new Date().toISOString().slice(0, 10);
    const headers = { "x-apisports-key": apiKey };

    // 1) Get LIVE matches
    const liveRes = await fetch(
      "https://v3.football.api-sports.io/fixtures?live=all",
      { headers }
    );

    // 2) Get today's matches (for HT + FT)
    const dayRes = await fetch(
      `https://v3.football.api-sports.io/fixtures?date=${today}`,
      { headers }
    );

    const liveData = await liveRes.json();
    const dayData  = await dayRes.json();

    const matchesById = new Map();

    function addMatches(list, filterFn) {
      if (!list || !list.response) return;
      for (const item of list.response) {
        if (filterFn && !filterFn(item)) continue;
        const id = item.fixture?.id;
        if (!id || matchesById.has(id)) continue;
        matchesById.set(id, item);
      }
    }

    // LIVE statuses (covers 1H, HT, 2H, ET etc.)
    const liveStatuses = ["1H", "HT", "2H", "ET", "LIVE", "BT", "P"];

    addMatches(liveData, (m) =>
      liveStatuses.includes(m.fixture?.status?.short)
    );

    // Add HT + FT from today's fixtures
    addMatches(dayData, (m) =>
      ["HT", "FT"].includes(m.fixture?.status?.short)
    );

    const matches = Array.from(matchesById.values());

    if (matches.length === 0) {
      const noData = {
        status: "NO_MATCHES",
        message: "No live / HT / FT matches right now."
      };
      if (manual) return noData;
      return noData;
    }

    // Limit to avoid too many API calls for stats
    const limitedMatches = matches.slice(0, 15);

    // Enrich each match with goal minutes + corners
    const detailed = await Promise.all(
      limitedMatches.map((m) => enrichMatch(m, headers))
    );

    // Group by "Country - League"
    const groups = new Map();
    for (const m of detailed) {
      const lg  = m.league || {};
      const key = `${lg.country || "Unknown"} - ${lg.name || "Unknown League"}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }

    // SA date/time for header
    const now = new Date();
    const saNow = new Date(
      now.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" })
    );
    const dateLabel = saNow.toISOString().slice(0, 10);
    const timeLabel = saNow.toTimeString().slice(0, 5); // HH:MM

    let text = `⚽ Live / HT / FT Football Update (${dateLabel} ${timeLabel})\n\n`;

    for (const [groupName, list] of groups) {
      text += `📍 ${groupName}\n`;
      for (const m of list) {
        text += formatMatchLine(m) + "\n";
      }
      text += "\n";
    }

    text += "Powered by PlayReportZA";

    // Post to Facebook (single big post)
    const fbUrl = `https://graph.facebook.com/${pageId}/feed`;
    const body  = new URLSearchParams({
      message: text,
      access_token: fbToken
    }).toString();

    const fbRes  = await fetch(fbUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    const fbData = await fbRes.json();

    if (manual) {
      return {
        status: "POST_SENT",
        match_count: matches.length,
        posted_message_preview: text.slice(0, 500),
        facebook_result: fbData
      };
    }

    return {
      status: "POST_SENT",
      match_count: matches.length
    };

  } catch (err) {
    if (manual) {
      return { status: "ERROR", error: err.toString() };
    }
    return { status: "ERROR" };
  }
}


// --- Enrich match with goal minutes + corners ---

async function enrichMatch(item, headers) {
  const id = item.fixture?.id;

  const base = {
    id,
    league: item.league,
    teams : item.teams,
    goals : item.goals,
    fixture: item.fixture,
    statusShort: item.fixture?.status?.short
  };

  if (!id) return base;

  try {
    const [eventsRes, statsRes] = await Promise.all([
      fetch(
        `https://v3.football.api-sports.io/fixtures/events?fixture=${id}`,
        { headers }
      ),
      fetch(
        `https://v3.football.api-sports.io/fixtures/statistics?fixture=${id}`,
        { headers }
      )
    ]);

    const eventsData = await eventsRes.json();
    const statsData  = await statsRes.json();

    // Goal minutes
    const goalMinutes = [];
    if (eventsData && eventsData.response) {
      for (const ev of eventsData.response) {
        if (ev.type === "Goal") {
          const t = ev.time;
          let label = "";
          if (t?.elapsed != null) {
            label = t.elapsed.toString();
            if (t.extra != null) label += "+" + t.extra.toString();
          }
          if (label) goalMinutes.push(`${label}'`);
        }
      }
    }

    // Corners (home–away)
    let cornersHome = null;
    let cornersAway = null;

    if (statsData && statsData.response && statsData.response.length >= 2) {
      const sHome = statsData.response[0].statistics || [];
      const sAway = statsData.response[1].statistics || [];

      const findCorners = (stats) => {
        const row = stats.find((st) => st.type === "Corner Kicks");
        return row?.value ?? null;
      };

      cornersHome = findCorners(sHome);
      cornersAway = findCorners(sAway);
    }

    return {
      ...base,
      goalMinutes,
      cornersHome,
      cornersAway
    };
  } catch {
    return base; // If stats fail, still return basic info
  }
}

// --- Format one match line for the post ---

function formatMatchLine(m) {
  const home = m.teams?.home?.name || "Home";
  const away = m.teams?.away?.name || "Away";
  const hs   = m.goals?.home ?? 0;
  const as   = m.goals?.away ?? 0;

  let statusTag = "[LIVE]";
  if (m.statusShort === "FT") statusTag = "[FT]";
  else if (m.statusShort === "HT") statusTag = "[HT]";

  // Time in 17:00 format (SA)
  let timeLabel = "";
  const ts = m.fixture?.timestamp;
  if (ts) {
    const d = new Date(ts * 1000);
    try {
      const saStr = d.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Africa/Johannesburg"
      });
      timeLabel = saStr;
    } catch {
      timeLabel = d.toISOString().slice(11, 16);
    }
  }

  let line = `${statusTag} ${timeLabel} | ${home} ${hs}–${as} ${away}`;

  if (m.goalMinutes && m.goalMinutes.length) {
    line += `\nGoals: ${m.goalMinutes.join(", ")}`;
  }

  if (m.cornersHome != null && m.cornersAway != null) {
    line += `\nCorners: ${m.cornersHome}–${m.cornersAway}`;
  }

  return line;
      }
