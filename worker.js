export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Manual force run
    if (url.searchParams.get("force") === "true") {
      return await buildAndSendPost(env, true);
    }

    return new Response("PlayReportZA autoposter is active.");
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(buildAndSendPost(env, false));
  }
};


// ---------------------------------------------------------------------------
// MAIN AUTPOSTER FUNCTION
// ---------------------------------------------------------------------------
async function buildAndSendPost(env, manual = false) {
  try {
    const apiKey = env.API_FOOTBALL_KEY;
    const fbToken = env.FB_PAGE_TOKEN;
    const pageId = env.FB_PAGE_ID;

    if (!apiKey || !fbToken || !pageId) {
      return json({ error: "Missing environment variables" }, 500);
    }

    const today = new Date().toISOString().slice(0, 10);
    const res = await fetch(
      `https://v3.football.api-sports.io/fixtures?date=${today}`,
      { headers: { "x-apisports-key": apiKey } }
    );

    const data = await res.json();
    const matches = data.response || [];

    // NEW FILTERS
    const live = [];
    const ht = [];
    const ft = [];

    for (const m of matches) {
      const status = m.fixture.status.short;

      // Extract goals & corners
      const goals = extractGoals(m);
      const corners = extractCorners(m);

      // Convert kickoff time
      const localTime = convertToSA(m.fixture.date);

      // Build entry object
      const entry = {
        league: `${m.league.country} - ${m.league.name}`,
        home: m.teams.home.name,
        away: m.teams.away.name,
        score: `${m.goals.home ?? 0}–${m.goals.away ?? 0}`,
        goals,
        corners,
        time: localTime,
      };

      if (status === "1H" || status === "2H" || status === "LIVE") {
        live.push(entry);
      } else if (status === "HT") {
        ht.push(entry);
      } else if (status === "FT") {
        ft.push(entry);
      }
    }

    // ---------------------------------------------------------------------
    // BUILD FACEBOOK POST
    // ---------------------------------------------------------------------
    const now = convertToSA(new Date().toISOString());
    let post = `⚽ *Live / HT / FT Football Update (${now})*\n\n`;

    // LIVE SECTION
    if (live.length > 0) {
      post += `🔥 *LIVE Matches*\n`;
      post += buildSection(live);
      post += `\n`;
    }

    // HALF-TIME
    if (ht.length > 0) {
      post += `⏸️ *Half-Time Matches*\n`;
      post += buildSection(ht);
      post += `\n`;
    }

    // FULL TIME AT THE BOTTOM
    if (ft.length > 0) {
      post += `🏁 *Full-Time Scores*\n`;
      post += buildSection(ft);
    }

    // ---------------------------------------------------------------------
    // SEND TO FACEBOOK
    // ---------------------------------------------------------------------
    const fbURL =
      `https://graph.facebook.com/${pageId}/feed?message=` +
      encodeURIComponent(post) +
      `&access_token=${fbToken}`;

    const fbRes = await fetch(fbURL, { method: "POST" });
    const fbData = await fbRes.json();

    if (manual) {
      return json({
        status: "POST_SENT",
        match_count: matches.length,
        posted_message_preview: post.slice(0, 250),
        facebook_result: fbData
      });
    }

    return json({ ok: true });

  } catch (err) {
    return json({ error: err.toString() }, 500);
  }
}


// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function extractGoals(m) {
  if (!m.events) return [];

  return m.events
    .filter(ev => ev.type === "Goal")
    .map(ev => `${ev.time.elapsed}'`);
}

function extractCorners(m) {
  if (!m.statistics) return null;

  const stats = m.statistics.find(team => team.statistics.some(s => s.type === "Corner Kicks"));
  if (!stats) return null;

  const home = m.statistics[0].statistics.find(s => s.type === "Corner Kicks")?.value ?? 0;
  const away = m.statistics[1].statistics.find(s => s.type === "Corner Kicks")?.value ?? 0;

  return `${home}–${away}`;
}

function convertToSA(iso) {
  return new Date(iso).toLocaleTimeString("en-ZA", {
    timeZone: "Africa/Johannesburg",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildSection(list) {
  let out = "";

  // Group by league
  const grouped = {};

  list.forEach(match => {
    if (!grouped[match.league]) grouped[match.league] = [];
    grouped[match.league].push(match);
  });

  for (const league in grouped) {
    out += `📍 *${league}*\n`;
    grouped[league].forEach(m => {
      out += `🟢 **${m.home} ${m.score} ${m.away}** (${m.time})\n`;
      if (m.goals.length > 0) out += `• Goals: ${m.goals.join(", ")}\n`;
      if (m.corners) out += `• Corners: ${m.corners}\n`;
    });
    out += `\n`;
  }

  return out;
}

function json(obj, code = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: code,
    headers: { "Content-Type": "application/json" }
  });
        }
