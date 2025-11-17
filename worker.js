export default {
    async scheduled(event, env, ctx) {
        ctx.waitUntil(run(env));
    },

    async fetch(request, env) {
        return new Response(JSON.stringify(await run(env), null, 2), {
            headers: { "Content-Type": "application/json" }
        });
    }
};

const CONTINENTS = {
    "Europe": ["UEFA", "Russia", "Turkey", "Portugal", "England", "Spain", "Italy", "Germany"],
    "Africa": ["CAF", "Ghana", "Guinea", "Congo-DR", "Egypt"],
    "Asia": ["AFC", "Qatar"],
    "North America": ["CONCACAF", "Guatemala"],
    "South America": ["CONMEBOL", "Brazil"],
    "World": ["World", "International"]
};

async function run(env) {
    const apiKey = env.API_FOOTBALL_KEY;
    const fbToken = env.FB_PAGE_TOKEN;
    const pageId = env.FB_PAGE_ID;

    if (!apiKey || !fbToken || !pageId) {
        return { error: "Missing environment variables" };
    }

    // Fetch live + HT + FT matches (Today)
    const url = `https://v3.football.api-sports.io/fixtures?date=${getToday()}`;
    const res = await fetch(url, { headers: { "x-apisports-key": apiKey } });
    const data = await res.json();

    if (!data.response?.length) return { status: "NO_MATCHES" };

    let matches = data.response;

    // Filter only live, HT or FT with goals
    matches = matches.filter(m =>
        ["1H", "HT", "2H", "ET", "BT", "P", "FT"].includes(m.fixture.status.short)
    );

    // Group by continent → country → league
    let grouped = groupMatches(matches);

    // Create Post
    const postText = buildPost(grouped);

    // Send to Facebook
    const fbRes = await sendToFacebook(pageId, fbToken, postText);

    return {
        status: "POST_SENT",
        post_preview: postText.substring(0, 500),
        facebook_result: fbRes
    };
}

function getToday() {
    const d = new Date();
    return d.toISOString().slice(0, 10);
}

function groupMatches(matches) {
    let result = {};

    for (const c of Object.keys(CONTINENTS)) result[c] = {};

    for (const m of matches) {
        const country = m.league.country || "World";
        const league = m.league.name;
        const continent = findContinent(country);

        if (!result[continent][country]) result[continent][country] = {};
        if (!result[continent][country][league]) result[continent][country][league] = [];

        result[continent][country][league].push(m);
    }

    return result;
}

function findContinent(country) {
    for (const [continent, list] of Object.entries(CONTINENTS)) {
        if (list.includes(country)) return continent;
    }
    return "World";
}

function buildPost(grouped) {
    let out = "";
    const now = new Date().toISOString().slice(0, 16).replace("T", " ");

    out += `⚽ Live / HT / FT Football Update\n(${now})\n\n`;

    for (const [continent, countries] of Object.entries(grouped)) {
        if (!Object.keys(countries).length) continue;

        out += `🌍 **${continent}**\n`;

        for (const [country, leagues] of Object.entries(countries)) {
            out += `\n📍 ${country}\n`;

            for (const [league, games] of Object.entries(leagues)) {
                out += `🏆 ${league}\n`;

                // Sort games by kick-off time
                games.sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));

                for (const m of games) {
                    const status = translateStatus(m.fixture.status.short);
                    const time = formatKickoff(m.fixture.date);
                    const home = m.teams.home.name;
                    const away = m.teams.away.name;
                    const hs = m.goals.home ?? 0;
                    const as = m.goals.away ?? 0;

                    out += `${status} ${time} | ${home} ${hs}–${as} ${away}\n`;

                    // Goals if available
                    if (m.events) {
                        const goals = m.events
                            .filter(e => e.type === "Goal")
                            .map(e => `${e.time.elapsed}'`)
                            .join(", ");

                        if (goals.length > 0) out += `Goals: ${goals}\n`;
                    }

                    // Only show corners / possession if available
                    if (m.statistics) {
                        const stats = parseStats(m.statistics);
                        if (stats.corners) out += `Corners: ${stats.corners}\n`;
                        if (stats.possession) out += `Possession: ${stats.possession}\n`;
                    }

                    out += `\n`;
                }
            }
        }

        out += `\n`;
    }

    return out.trim();
}

function translateStatus(s) {
    if (s === "FT") return "🏁 FT";
    if (s === "HT") return "⏸️ HT";
    if (s === "1H" || s === "2H" || s === "ET") return "🔴 LIVE";
    return "⌛";
}

function formatKickoff(dateStr) {
    const d = new Date(dateStr);
    return d.toISOString().slice(11, 16); // HH:MM local to API time
}

function parseStats(statsArr) {
    let out = {};

    for (const t of statsArr) {
        for (const s of t.statistics) {
            if (s.type === "Corner Kicks" && s.value !== null)
                out.corners = out.corners
                    ? `${out.corners.split("–")[0]}–${s.value}`
                    : `${s.value}–`;

            if (s.type === "Ball Possession" && s.value !== null)
                out.possession = out.possession
                    ? `${out.possession.split("–")[0]}–${s.value}`
                    : `${s.value}–`;
        }
    }

    // Final formatting cleanup
    if (out.corners && out.corners.endsWith("–"))
        out.corners = out.corners.replace("–", "");
    if (out.possession && out.possession.endsWith("–"))
        out.possession = out.possession.replace("–", "");

    return out;
}

async function sendToFacebook(pageId, token, message) {
    const url = `https://graph.facebook.com/${pageId}/feed`;
    const params = new URLSearchParams({ message, access_token: token });

    const res = await fetch(url, {
        method: "POST",
        body: params
    });

    return await res.json();
  }
