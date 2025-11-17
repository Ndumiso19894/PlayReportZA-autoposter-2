export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAutoposter(env));
  }
};

async function handleRequest(request, env) {
  await runAutoposter(env);
  return new Response("PlayReportZA autoposter ran successfully.");
}

async function runAutoposter(env) {
  try {
    const apiKey = env.API_FOOTBALL_KEY;
    const fbToken = env.FB_PAGE_TOKEN;
    const pageId = env.FB_PAGE_ID;

    if (!apiKey || !fbToken || !pageId) {
      return new Response(JSON.stringify({
        error: "Missing environment variables",
        apiKey,
        fbToken,
        pageId
      }), { status: 500 });
    }

    const message = `PlayReportZA autoposter test: ${new Date().toISOString()}`;

    const fbURL = `https://graph.facebook.com/${pageId}/feed?message=${encodeURIComponent(message)}&access_token=${fbToken}`;
    const fbResponse = await fetch(fbURL, { method: "POST" });

    const data = await fbResponse.json();
    console.log("Facebook response:", data);

  } catch (err) {
    return new Response("Error: " + err.message, { status: 500 });
  }
}
