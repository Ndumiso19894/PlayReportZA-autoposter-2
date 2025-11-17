
addEventListener("scheduled", (event) => {
  event.waitUntil(runAutoposter());
});

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  await runAutoposter();
  return new Response("PlayReportZA autoposter ran successfully.");
}

async function runAutoposter() {
  const apiKey = API_FOOTBALL_KEY;
  const fbToken = FB_PAGE_TOKEN;
  const pageId = FB_PAGE_ID;

  if (!apiKey || !fbToken || !pageId) {
    console.log("Missing environment variables.");
    return;
  }

  try {
    const today = new Date().toISOString().split("T")[0];

    const url = `https://v3.football.api-sports.io/fixtures?date=${today}`;
    const res = await fetch(url, {
      headers: { "x-apisports-key": apiKey }
    });

    const data = await res.json();
    if (!data.response || data.response.length === 0) {
      console.log("No match data for today.");
      return;
    }

    const match = data.response[0];
    const league = match.league.name;
    const home = match.teams.home.name;
    const away = match.teams.away.name;
    const status = match.fixture.status.long;

    const message = `⚽ *Today's Match Update* ⚽
League: ${league}
Match: ${home} vs ${away}
Status: ${status}
Powered by PlayReportZA`;

    await fetch(
      `https://graph.facebook.com/${pageId}/feed?message=${encodeURIComponent(message)}&access_token=${fbToken}`,
      { method: "POST" }
    );

    console.log("Posted to Facebook:", message);

  } catch (err) {
    console.log("Autoposter error:", err);
  }
}
