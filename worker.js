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

const CONTINENT_MAP = {
  "Europe": ["UEFA", "European", "Euro", "Europe"],
  "Africa": ["CAF", "Africa", "African"],
  "Asia": ["AFC", "Asia", "Asian"],
  "South America": ["CONMEBOL", "South America", "Sudamericana"],
  "North America": ["CONCACAF", "North America", "USA", "Mexico"],
  "Oceania": ["Oceania", "OFC"],
};

function getContinent(league) {
  const name = league.name + " " + league.country;
  for (const continent in CONTINENT_MAP) {
    if (CONTINENT_MAP[continent].some(word => name.includes(word))) {
      return continent;
    }
  }
  return "International";
}

function formatTimeToLocal(utcDate) {
  const date = new Date(utcDate);
  const local = date.toLocaleString("en-ZA", { 
    timeZone: "Africa/Johannesburg",
    hour: "2-digit", minute: "2-digit"
  });
  return local;
}

async function runAutoposter(env, manual = false) {
  try {
    const apiKey = env.API_FOOTBALL_KEY;
    const fbToken = env.FB_PAGE_TOKEN;
    const pageId = env.FB_PAGE_ID;

    if (!apiKey || !fbToken || !pageId) {
      return new Response(JSON.stringify({
        error: "Missing environment variables"
      }, null, 2), { status: 500 });
    }

    const today = new Date().toISOString().split("T")[0];
    const url = `https://v3.football.api-sports.io/fixtures?date=${today}`;

    const res = await fetch(url, {
      headers: { "x-apisports-key": apiKey }
    });
    const data = await res.json();

    const live = [];
    const halftime = [];
    const fulltime = [];

    for (const m of data.response) {
      const continent = getContinent(m.league);
      const kickoff = formatTimeToLocal(m.fixture.date);

      let goals = "";
      if (m.goals.home != null && m.goals.away != null) {
        goals = `${m.goals.home}–${m.goals.away}`;
      }

      let goalEvents = "";
      if (m.events) {
        const scored = m.events.filter(e => e.type === "Goal");
        if (scored.length > 0) {
          goalEvents = "Goals: " + 
            scored.map(g => `${g.time.elapsed}'`).join(", ");
        }
      }

      const corners = m.statistics?.find(x => x.type === "Corners") || null;
      const cornersStr = corners ? `Corners: ${corners.home}–${corners.away}` : "";

      const minute = m.fixture.status.elapsed
        ? `${m.fixture.status.elapsed}'` 
        : "";

      let block = `📍 *${continent}*  
${m.league.name}  
${m.teams.home.name} ${goals} ${m.teams.away.name}  
Kickoff: ${kickoff}  
${minute ? "⏱ " + minute : ""}  
${goalEvents ? goalEvents : ""}  
${cornersStr ? cornersStr : ""}`;

      if (m.fixture.status.short === "FT") fulltime.push(block);
      else if (m.fixture.status.short === "HT") halftime.push(block);
      else if (m.fixture.status.short === "1H" || m.fixture.status.short === "2H" || m.fixture.status.short === "LIVE")
        live.push(block);
    }

    let message = `⚽ *Live Football Update (${formatTimeToLocal(new Date())})*\n\n`;

    if (live.length) {
      message += `🔥 *LIVE MATCHES* 🔥\n${live.join("\n\n")}\n\n`;
    }

    if (halftime.length) {
      message += `⏳ *HALF-TIME SCORES* ⏳\n${halftime.join("\n\n")}\n\n`;
    }

    if (fulltime.length) {
      message += `🏁 *FULL-TIME RESULTS* 🏁\n${fulltime.join("\n\n")}\n\n`;
    }

    const fbURL = `https://graph.facebook.com/${pageId}/feed?message=${encodeURIComponent(message)}&access_token=${fbToken}`;
    const fbResponse = await fetch(fbURL, { method: "POST" });
    const fbData = await fbResponse.json();

    if (manual) {
      return new Response(JSON.stringify({
        status: "POST_SENT",
        match_count: data.response.length,
        posted_message_preview: message.slice(0, 300),
        facebook_result: fbData
      }, null, 2), {
        headers: { "Content-Type": "application/json" }
      });
    }

    console.log("AUTO POST:", fbData);
    return new Response("OK");

  } catch (err) {
    return new Response("Error: " + err.message, { status: 500 });
  }
             }
