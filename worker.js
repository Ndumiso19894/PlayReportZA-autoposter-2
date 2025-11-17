export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Manual test trigger for phone
    if (url.searchParams.get("force") === "true") {
      return await runAutoposter(env, true);
    }

    return new Response("PlayReportZA autoposter is active.");
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAutoposter(env, false));
  }
};

// MAIN FUNCTION
async function runAutoposter(env, manual = false) {
  try {
    const apiKey = env.API_FOOTBALL_KEY;
    const fbToken = env.FB_PAGE_TOKEN;
    const pageId = env.FB_PAGE_ID;

    // Validate environment variables
    if (!apiKey || !fbToken || !pageId) {
      return new Response(JSON.stringify({
        error: "Missing environment variables",
        apiKey: !!apiKey,
        fbToken: !!fbToken,
        pageId: !!pageId
      }, null, 2), {
        status: 500,
        headers: {"Content-Type": "application/json"}
      });
    }

    // 1. Fetch today's fixtures
    const today = new Date().toISOString().split("T")[0];
    const url = `https://v3.football.api-sports.io/fixtures?date=${today}`;

    const apiResponse = await fetch(url, {
      headers: { "x-apisports-key": apiKey }
    });

    const apiData = await apiResponse.json();

    let message;

    if (!apiData.response || apiData.response.length === 0) {
      message = `No football matches found today (${today}).`;
    } else {
      const match = apiData.response[0];
      message =
        `⚽ Daily Football Update\n` +
        `Match: ${match.teams.home.name} vs ${match.teams.away.name}\n` +
        `League: ${match.league.name}\n` +
        `Kickoff: ${match.fixture.date}\n\n` +
        `Powered by PlayReportZA`;
    }

    // 2. Post to Facebook
    const fbURL = `https://graph.facebook.com/${pageId}/feed?message=${encodeURIComponent(message)}&access_token=${fbToken}`;
    const fbResponse = await fetch(fbURL, { method: "POST" });
    const fbData = await fbResponse.json();

    // Return full result to browser when manually triggered
    if (manual) {
      return new Response(JSON.stringify({
        status: "POST SENT",
        posted_message: message,
        facebook_result: fbData
      }, null, 2), {
        headers: {"Content-Type": "application/json"}
      });
    }

    // For cron runs, just log
    console.log("Auto-posted:", fbData);

    return new Response(JSON.stringify({success: true}), {
      headers: {"Content-Type": "application/json"}
    });

  } catch (err) {
    return new Response("Error: " + err.message, { status: 500 });
  }
}
