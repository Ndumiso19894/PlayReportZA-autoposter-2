export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const force = url.searchParams.get("force") === "true";

    if (force) {
      const result = await buildAndPost(env, true);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response("PlayReportZA autoposter is active.");
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(buildAndPost(env, false));
  }
};

/**
 * Main logic: fetch fixtures, format post, send to Facebook.
 * If manual = true, return full JSON result for you to inspect.
 */
async function buildAndPost(env, manual) {
  const apiKey = env.API_FOOTBALL_KEY;
  const fbToken = env.FB_PAGE_TOKEN;
  const pageId = env.FB_PAGE_ID;

  if (!apiKey || !fbToken || !pageId) {
    return {
      error: "Missing environment variables",
      apiKey: !!apiKey,
      fbToken: !!fbToken,
      pageId: !!pageId
    };
  }

  try {
    // South African "now"
    const nowSa = new Date(
      new Date().toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" })
    );
    const todayStr = nowSa.toISOString().slice(0, 10);

    // Get all today's fixtures in SA timezone
    const url = `https://v3.football.api-sports.io/fixtures?date=${todayStr}&timezone=Africa/Johannesburg&live=all`;
    const res = await fetch(url, {
      headers: { "x-apisports-key": apiKey }
    });
    const data = await res.json();

    if (!data.response || !Array.isArray(data.response) || data.response.length === 0) {
      const msg = `Today's live fixtures\n\nNo live / recent matches found for ${todayStr}.\n\nFollow PlayReportZA for more football updates.\n#PlayReportZA #LiveScores #Football`;
      const fbData = await postToFacebook(pageId, fbToken, msg);
      return {
        status: "POST_SENT",
        match_count: 0,
        posted_message_preview: msg.slice(0, 200),
        facebook_result: fbData
      };
    }

    const fixtures = data.response;

    // Buckets
    const liveAndHtByLeague = new Map();  // { leagueKey -> [fixture,...] }
    const ftByLeague = new Map();         // FT in last 6 hours

    const sixHoursMs = 6 * 60 * 60 * 1000;
    const liveCodes = new Set(["1H", "2H", "ET"]);
    const htCodes = new Set(["HT"]);
    const ftCodes = new Set(["FT", "AET", "PEN"]);

    for (const item of fixtures) {
      const fixture = item.fixture || {};
      const league = item.league || {};
      const teams = item.teams || {};
      const status = fixture.status || {};
      const short = status.short || "";
      const tsSeconds = fixture.timestamp || null;

      // Build a safe league key/name/country
      const leagueName = league.name || "Others";
      const countryName = league.country || "Others";

      const leagueKey = `${countryName}__${leagueName}`;

      // SA kickoff time
      let kickoffSa = "";
      let fixtureDateSa = null;
      if (typeof fixture.date === "string") {
        const d = new Date(fixture.date);
        // interpret as SA time for formatting
        const saString = d.toLocaleString("en-ZA", {
          timeZone: "Africa/Johannesburg",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false
        });
        kickoffSa = saString;
        fixtureDateSa = new Date(
          d.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" })
        );
      } else if (typeof tsSeconds === "number") {
        const d = new Date(tsSeconds * 1000);
        const saString = d.toLocaleString("en-ZA", {
          timeZone: "Africa/Johannesburg",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false
        });
        kickoffSa = saString;
        fixtureDateSa = new Date(
          d.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" })
        );
      }

      // classify
      if (liveCodes.has(short) || htCodes.has(short)) {
        if (!liveAndHtByLeague.has(leagueKey)) {
          liveAndHtByLeague.set(leagueKey, []);
        }
        liveAndHtByLeague.get(leagueKey).push({
          item,
          leagueName,
          countryName,
          kickoffSa,
          short,
          fixtureDateSa
        });
      } else if (ftCodes.has(short) && fixtureDateSa) {
        const diff = nowSa.getTime() - fixtureDateSa.getTime();
        if (diff >= 0 && diff <= sixHoursMs) {
          if (!ftByLeague.has(leagueKey)) {
            ftByLeague.set(leagueKey, []);
          }
          ftByLeague.get(leagueKey).push({
            item,
            leagueName,
            countryName,
            kickoffSa,
            short,
            fixtureDateSa
          });
        }
      }
    }

    // Format the post
    const lines = [];
    const headerTime = nowSa
      .toLocaleString("en-ZA", {
        timeZone: "Africa/Johannesburg",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      });

    lines.push(`Today's live fixtures ⚽ (SA time ${headerTime})`);
    lines.push(""); // blank

    // --- LIVE & HT SECTION ---
    if (liveAndHtByLeague.size > 0) {
      lines.push("LIVE 🔴 & HT ⏸");
      const sortedLeagueKeys = Array.from(liveAndHtByLeague.keys()).sort();

      for (const leagueKey of sortedLeagueKeys) {
        const group = liveAndHtByLeague.get(leagueKey) || [];
        if (group.length === 0) continue;

        // sort matches inside league by kickoff time
        group.sort((a, b) => {
          if (!a.fixtureDateSa || !b.fixtureDateSa) return 0;
          return a.fixtureDateSa.getTime() - b.fixtureDateSa.getTime();
        });

        const sample = group[0];
        const leagueTitle = `${countryFlag(sample.countryName)} ${sample.countryName} – ${sample.leagueName}`;
        lines.push("");
        lines.push(leagueTitle);

        for (const g of group) {
          const m = g.item;
          const fixture = m.fixture || {};
          const teams = m.teams || {};
          const goals = m.goals || {};
          const status = fixture.status || {};
          const elapsed = status.elapsed != null ? status.elapsed : null;

          const homeName = teams.home?.name || "Home";
          const awayName = teams.away?.name || "Away";
          const homeGoals = goals.home != null ? goals.home : 0;
          const awayGoals = goals.away != null ? goals.away : 0;

          const liveLabel = liveCodes.has(g.short)
            ? `LIVE 🔴`
            : (htCodes.has(g.short) ? `HT ⏸` : "");

          // goals + scorers if events exist
          const goalsLine = buildGoalsLine(m);

          // corners & possession if stats exist
          const { cornersLine, possessionLine } = buildStatsLines(m);

          let line = "";
          if (elapsed != null && liveCodes.has(g.short)) {
            line += `[${liveLabel}] ${g.kickoffSa} | ${elapsed}' | ${homeName} ${homeGoals}–${awayGoals} ${awayName}`;
          } else if (htCodes.has(g.short)) {
            line += `[${liveLabel}] ${g.kickoffSa} | HT | ${homeName} ${homeGoals}–${awayGoals} ${awayName}`;
          } else {
            line += `${g.kickoffSa} | ${homeName} ${homeGoals}–${awayGoals} ${awayName}`;
          }

          lines.push(line);

          if (goalsLine) lines.push(goalsLine);
          if (cornersLine) lines.push(cornersLine);
          if (possessionLine) lines.push(possessionLine);
        }
      }
    } else {
      lines.push("No live / HT matches at the moment.");
    }

    // --- SEPARATOR ---
    lines.push("");
    lines.push("————————————");
    lines.push("FULL TIME ✅ (last 6 hours)");
    lines.push("");

    // --- FULL TIME SECTION ---
    if (ftByLeague.size > 0) {
      const ftLeagueKeys = Array.from(ftByLeague.keys()).sort();
      for (const leagueKey of ftLeagueKeys) {
        const group = ftByLeague.get(leagueKey) || [];
        if (group.length === 0) continue;

        group.sort((a, b) => {
          if (!a.fixtureDateSa || !b.fixtureDateSa) return 0;
          return a.fixtureDateSa.getTime() - b.fixtureDateSa.getTime();
        });

        const sample = group[0];
        const leagueTitle = `${countryFlag(sample.countryName)} ${sample.countryName} – ${sample.leagueName}`;
        lines.push(leagueTitle);

        for (const g of group) {
          const m = g.item;
          const fixture = m.fixture || {};
          const teams = m.teams || {};
          const goals = m.goals || {};

          const homeName = teams.home?.name || "Home";
          const awayName = teams.away?.name || "Away";
          const homeGoals = goals.home != null ? goals.home : 0;
          const awayGoals = goals.away != null ? goals.away : 0;

          let line = `${g.kickoffSa} | ${homeName} ${homeGoals}–${awayGoals} ${awayName}`;
          lines.push(line);

          const goalsLine = buildGoalsLine(m);
          const { cornersLine, possessionLine } = buildStatsLines(m);

          if (goalsLine) lines.push(goalsLine);
          if (cornersLine) lines.push(cornersLine);
          if (possessionLine) lines.push(possessionLine);
        }

        lines.push(""); // blank between leagues
      }
    } else {
      lines.push("No full time results in the last 6 hours.");
    }

    // --- CTA + TAGS ---
    lines.push("");
    lines.push("For more live scores and insights, follow PlayReportZA on Facebook, YouTube and our blog.");
    lines.push("#PlayReportZA #Football #LiveScores #Soccer");

    const finalMessage = lines.join("\n");

    // Send to Facebook
    const fbData = await postToFacebook(pageId, fbToken, finalMessage);

    return {
      status: "POST_SENT",
      match_count: fixtures.length,
      posted_message_preview: finalMessage.slice(0, 200),
      facebook_result: fbData
    };
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

/**
 * Build goals line with minutes + scorers if events are available.
 * If not available, returns "".
 */
function buildGoalsLine(item) {
  const events = item.events;
  if (!Array.isArray(events) || events.length === 0) return "";

  const goalEvents = events.filter(
    (e) => (e?.type === "Goal" || e?.detail === "Normal Goal" || e?.detail === "Penalty")
  );
  if (goalEvents.length === 0) return "";

  const parts = goalEvents.map((e) => {
    const minute = e.time?.elapsed != null ? `${e.time.elapsed}'` : "";
    const player = e.player?.name || "";
    const team = e.team?.name || "";
    const side = team ? ` (${team})` : "";
    return `${minute} ${player}${side}`.trim();
  });

  if (parts.length === 0) return "";
  return `Goals ⚽: ${parts.join(", ")}`;
}

/**
 * Build corners + possession lines (hide when not available).
 */
function buildStatsLines(item) {
  const stats = item.statistics;
  let cornersLine = "";
  let possessionLine = "";

  if (Array.isArray(stats) && stats.length >= 2) {
    const homeStats = stats[0]?.statistics || [];
    const awayStats = stats[1]?.statistics || [];

    const getStatVal = (arr, type) => {
      if (!Array.isArray(arr)) return null;
      const found = arr.find((s) => s?.type === type);
      return found?.value ?? null;
    };

    const homeCorners = getStatVal(homeStats, "Corner Kicks");
    const awayCorners = getStatVal(awayStats, "Corner Kicks");
    const homePoss = getStatVal(homeStats, "Ball Possession");
    const awayPoss = getStatVal(awayStats, "Ball Possession");

    if (homeCorners != null && awayCorners != null) {
      cornersLine = `Corners 🚩: ${homeCorners}–${awayCorners}`;
    }

    if (homePoss != null && awayPoss != null) {
      possessionLine = `Possession: ${homePoss} – ${awayPoss}`;
    }
  }

  return { cornersLine, possessionLine };
}

/**
 * Post message to Facebook page.
 */
async function postToFacebook(pageId, fbToken, message) {
  const fbURL = `https://graph.facebook.com/${pageId}/feed?message=${encodeURIComponent(
    message
  )}&access_token=${fbToken}`;

  const res = await fetch(fbURL, { method: "POST" });
  let data;
  try {
    data = await res.json();
  } catch {
    data = { error: "Facebook response not JSON" };
  }
  return data;
}

/**
 * Very small flag mapper – unknown countries show "Others".
 */
function countryFlag(countryName) {
  if (!countryName) return "🌍";
  const name = countryName.toLowerCase();

  if (name.includes("south africa")) return "🇿🇦";
  if (name.includes("england")) return "🏴";
  if (name.includes("spain")) return "🇪🇸";
  if (name.includes("italy")) return "🇮🇹";
  if (name.includes("germany")) return "🇩🇪";
  if (name.includes("france")) return "🇫🇷";
  if (name.includes("portugal")) return "🇵🇹";
  if (name.includes("netherlands")) return "🇳🇱";
  if (name.includes("usa") || name.includes("united states")) return "🇺🇸";
  if (name.includes("brazil")) return "🇧🇷";
  if (name.includes("argentina")) return "🇦🇷";

  // Fallback
  return "🌍";
}
