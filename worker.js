export default {
  async fetch(request, env) {
    const API_KEY = env.API_FOOTBALL_KEY;
    const PAGE_ID = env.FB_PAGE_ID;
    const ACCESS_TOKEN = env.FB_PAGE_TOKEN;

    if (!API_KEY || !PAGE_ID || !ACCESS_TOKEN) {
      return new Response(JSON.stringify({ error: "Missing environment variables" }), { status: 500 });
    }

    // Convert to SA time zone  
    function toSA(time) {
      return new Date(time).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" });
    }

    // Format time only (HH:MM)
    function formatHM(date) {
      return new Date(date).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Africa/Johannesburg"
      });
    }

    // Fetch matches  
    async function getMatches() {
      const today = new Date().toISOString().split("T")[0];
      const url = `https://v3.football.api-sports.io/fixtures?date=${today}`;

      const r = await fetch(url, { headers: { "x-apisports-key": API_KEY } });
      const data = await r.json();
      return data.response || [];
    }

    const matches = await getMatches();

    // Separate live, HT, FT (last 6 hours)
    const now = new Date();

    const live = [];
    const halftime = [];
    const fulltime = [];

    for (const m of matches) {
      const status = m.fixture.status.short;
      const kickoff = m.fixture.date;

      if (status === "1H" || status === "2H" || status === "ET") live.push(m);
      else if (status === "HT") halftime.push(m);
      else if (status === "FT") {
        // Only show last 6 hours
        const diff = (now - new Date(kickoff)) / 3600000;
        if (diff <= 6) fulltime.push(m);
      }
    }

    // Group by league → sort by kickoff
    function groupAndSort(arr) {
      const groups = {};
      arr.forEach(m => {
        const lg = m.league.name;
        if (!groups[lg]) groups[lg] = [];
        groups[lg].push(m);
      });

      Object.keys(groups).forEach(lg => {
        groups[lg].sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));
      });

      return groups;
    }

    const G_live = groupAndSort(live);
    const G_ht = groupAndSort(halftime);
    const G_ft = groupAndSort(fulltime);

    // Format stats cleanly  
    function stats(m) {
      const S = m.statistics;
      if (!S) return "";

      const team1 = S[0]?.statistics;
      const team2 = S[1]?.statistics;

      if (!team1 || !team2) return "";

      function stat(name, emoji) {
        const a = team1.find(x => x.type === name)?.value;
        const b = team2.find(x => x.type === name)?.value;
        if (!a || !b) return "";
        return `${emoji}${a}-${b} `;
      }

      const corners = stat("Corner Kicks", "🚩");
      const possession = (() => {
        const p1 = team1.find(x => x.type === "Ball Possession")?.value;
        const p2 = team2.find(x => x.type === "Ball Possession")?.value;
        return p1 && p2 ? `📊 ${p1}-${p2}` : "";
      })();

      return `${corners}${possession}`.trim();
    }

    // Goals with minutes  
    function goals(m) {
      if (!m.events) return "";
      const g = m.events.filter(e => e.type === "Goal");
      if (g.length === 0) return "";
      return g.map(e => `⚽ ${e.time.elapsed}'`).join(" ");
    }

    // Format a single match line  
    function showMatch(m, label) {
      const home = m.teams.home.name;
      const away = m.teams.away.name;
      const score = `${m.goals.home}-${m.goals.away}`;
      const time = m.fixture.status.elapsed ? `${m.fixture.status.elapsed}'` : formatHM(m.fixture.date);
      const kickoff = formatHM(m.fixture.date);

      const g = goals(m);
      const s = stats(m);

      return (
        `${label} | ${kickoff} | ${home} ${score} ${away}\n` +
        (g ? `${g}\n` : "") +
        (s ? `${s}\n` : "")
      );
    }

    // Build full post  
    let post = `⚽ Today's Live Fixtures\n\n`;

    function section(title, grouped, label) {
      if (Object.keys(grouped).length === 0) return;
      post += `\n${title}\n`;
      for (const lg in grouped) {
        post += `\n📍 ${lg}\n`;
        grouped[lg].forEach(m => {
          post += showMatch(m, label);
        });
      }
    }

    section("🔴 LIVE MATCHES", G_live, "LIVE 🔴");
    section("⏸️ HALF-TIME MATCHES", G_ht, "HT ⏸️");
    section("🏁 FULL-TIME (Last 6h)", G_ft, "FT 🏁");

    // Add hashtags  
    post += `\n#PlayReportZA #LiveScores #FootballUpdates #SoccerLive #MatchDay`;

    // Post to Facebook  
    const fbRes = await fetch(
      `https://graph.facebook.com/${PAGE_ID}/feed?message=${encodeURIComponent(post)}&access_token=${ACCESS_TOKEN}`,
      { method: "POST" }
    );
    const fbData = await fbRes.json();

    return new Response(JSON.stringify(fbData, null, 2), { headers: { "Content-Type": "application/json" } });
  }
};
