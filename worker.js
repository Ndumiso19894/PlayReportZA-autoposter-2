export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runUpdate(env));
  },

  async fetch(request, env) {
    return runUpdate(env);
  }
};

async function runUpdate(env) {
  const apiKey = env.API_FOOTBALL_KEY;
  const pageId = env.FB_PAGE_ID;
  const fbToken = env.FB_PAGE_TOKEN;

  if (!apiKey || !pageId || !fbToken) {
    return new Response(
      JSON.stringify({
        error: "Missing environment variables",
        apiKey: !!apiKey,
        fbToken: !!fbToken,
        pageId: !!pageId
      }),
      { status: 500 }
    );
  }

  const now = new Date();
  const currentDate = now.toISOString().split("T")[0];

  const url = `https://v3.football.api-sports.io/fixtures?date=${currentDate}`;
  const res = await fetch(url, {
    headers: { "x-apisports-key": apiKey }
  });

  const data = await res.json();
  if (!data.response || data.response.length === 0) {
    return new Response(JSON.stringify({ status: "NO_MATCHES" }));
  }

  const live = [];
  const fulltime = [];

  for (const match of data.response) {
    const league = `${match.league.country} – ${match.league.name}`;
    const minute = match.fixture.status.elapsed || 0;
    const status = match.fixture.status.short;

    const home = match.teams.home.name;
    const away = match.teams.away.name;
    const score = `${match.goals.home}–${match.goals.away}`;

    // stats
    const stats = match.statistics;

    let corners = "--";
    let possession = "--";

    if (stats && stats.length === 2) {
      corners = `${stats[0].statistics.find(s => s.type === "Corner Kicks")?.value ?? "-"}–${stats[1].statistics.find(s => s.type === "Corner Kicks")?.value ?? "-"}`;
      possession = `${stats[0].statistics.find(s => s.type === "Ball Possession")?.value ?? "-"}–${stats[1].statistics.find(s => s.type === "Ball Possession")?.value ?? "-"}`;
    }

    // goal minutes
    let goalMinutes = [];
    if (match.events) {
      goalMinutes = match.events
        .filter(e => e.type === "Goal")
        .map(e => `${e.time.elapsed}'`);
    }

    const goalLine = goalMinutes.length ? `Goals: ${goalMinutes.join(", ")}` : "";

    const text =
      status === "FT"
        ? `FULL-TIME | ${home} ${score} ${away}\nCorners: ${corners}\nPossession: ${possession}`
        : `🟢 ${minute}' | ${home} ${score} ${away}\n${goalLine}\nCorners: ${corners}\nPossession: ${possession}`;

    if (status === "FT") fulltime.push({ league, text });
    else live.push({ league, text });
  }

  let message = "";

  const groupBy = arr =>
    arr.reduce((acc, m) => {
      if (!acc[m.league]) acc[m.league] = [];
      acc[m.league].push(m.text);
      return acc;
    }, {});

  const liveGroups = groupBy(live);
  const ftGroups = groupBy(fulltime);

  // LIVE SECTION
  for (const league in liveGroups) {
    message += `📍 ${league}\n`;
    liveGroups[league].forEach(t => (message += t + "\n\n"));
  }

  // SEPARATOR
  if (fulltime.length > 0) {
    message += "—————————————\n";
    message += "🏁 FULL-TIME RESULTS\n";
    message += "—————————————\n\n";
  }

  // FULLTIME SECTION
  for (const league in ftGroups) {
    message += `📍 ${league}\n`;
    ftGroups[league].forEach(t => (message += t + "\n\n"));
  }

  // final FB publish
  const publishUrl = `https://graph.facebook.com/${pageId}/feed`;
  const publish = await fetch(publishUrl, {
    method: "POST",
    body: new URLSearchParams({
      message: message.trim(),
      access_token: fbToken
    })
  });

  const fbResult = await publish.json();

  return new Response(
    JSON.stringify({
      status: "POST_SENT",
      match_count: data.response.length,
      preview: message.substring(0, 200),
      facebook_result: fbResult
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}
