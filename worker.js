export default {
  // --- 1. CRON TRIGGER (Automated 8 AM Report) ---
  async scheduled(event, env, ctx) {
    const { results } = await env.DB.prepare("SELECT theme, sentiment, urgency FROM feedback WHERE created_at > datetime('now', '-24 hours')").all();
    if (!results || results.length === 0) return;

    const total = results.length;
    const negative = results.filter(r => r.sentiment === 'Negative').length;
    
    // Simple HTML Report
    const html = `
      <div style="margin-bottom:10px;"><b>📅 Daily Briefing (${new Date().toISOString().split('T')[0]})</b></div>
      <p><b>Summary:</b> Processed ${total} items today. ${negative} were negative.</p>
    `;

    try {
      await env.DB.prepare("INSERT INTO daily_reports (date, content) VALUES (datetime('now'), ?)").bind(html).run();
    } catch (e) { console.error("Cron Error", e); }
  },

  // --- 2. MAIN WORKER LOGIC ---
  async fetch(request, env) {
    const url = new URL(request.url);

    // A. DB SETUP
    if (url.pathname === "/init") {
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY, source TEXT, content TEXT, theme TEXT, sentiment TEXT, urgency INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS daily_reports (id INTEGER PRIMARY KEY, date DATETIME DEFAULT CURRENT_TIMESTAMP, content TEXT);
      `).run();
      return new Response("Tables Created", { status: 200 });
    }

    // B. SEED & RESET
    if (url.pathname === "/reset") {
      await env.DB.prepare("DELETE FROM feedback").run();
      await env.DB.prepare("DELETE FROM daily_reports").run();
      return new Response("Reset Done", { status: 302, headers: { 'Location': '/' } });
    }
    if (url.pathname === "/seed") {
      await env.DB.prepare(`
        INSERT INTO feedback (source, content, created_at) VALUES 
        ('App Store', 'The app is too slow on login.', datetime('now', '-6 days')),
        ('Twitter', 'Love the new UI! So clean.', datetime('now', '-5 days')),
        ('Support Ticket', 'I cannot find the logout button.', datetime('now', '-4 days')),
        ('Email', 'Keep crashing on iOS 17.', datetime('now', '-3 days')),
        ('App Store', 'Best update ever, very fast.', datetime('now', '-2 days')),
        ('Twitter', 'Why did you move the search bar?', datetime('now', '-1 day')),
        ('Email', 'Login page is broken on Chrome.', datetime('now', '-1 day')),
        ('Support Ticket', 'Billing page is confusing.', datetime('now')),
        ('Twitter', 'Dark mode is not working.', datetime('now', '-12 hours')),
        ('Email', 'Where is my invoice?', datetime('now', '-2 days')),
        ('App Store', 'FaceID is broken.', datetime('now', '-4 days')),
        ('Support Ticket', 'Cannot update profile picture.', datetime('now', '-5 days'))
      `).run();
      return new Response("Seeded", { status: 302, headers: { 'Location': '/' } });
    }

    // C. PROCESS
    if (url.pathname === "/process") {
      const { results } = await env.DB.prepare("SELECT * FROM feedback").all(); 
      for (const item of results) {
        try {
          const response = await env.AI.run("@cf/meta/llama-3-8b-instruct", {
            messages: [{ role: "system", content: "Classify. JSON only. Rules: theme: [Bugs, Performance, UI/UX, Features, Billing], sentiment: [Positive, Neutral, Negative], urgency: 1-5" }, { role: "user", content: item.content }]
          });
          const jsonMatch = (response.response || JSON.stringify(response)).match(/\{[\s\S]*\}/);
          let analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : { theme: 'general', sentiment: 'Neutral', urgency: 1 };
          
          let s = (analysis.sentiment || 'Neutral');
          let u = parseInt(analysis.urgency) || 1;
          
          if (s === 'Positive') u = 1;        
          if (s === 'Neutral') u = 2;         
          if (s === 'Negative' && u < 3) u = 3; 

          await env.DB.prepare("UPDATE feedback SET theme=?, sentiment=?, urgency=? WHERE id=?").bind(analysis.theme?.toLowerCase() || 'general', s, u, item.id).run();
        } catch (e) {}
      }
      return new Response("Processed", { status: 302, headers: { 'Location': '/' } });
    }

    // D. REPORT (UPDATED: STRATEGIC & UNIFORM)
    if (url.pathname === "/report") {
      const { results } = await env.DB.prepare("SELECT theme, sentiment, urgency FROM feedback").all();
      if (!results.length) return new Response("No data", { status: 500 });
      
      const themes = [...new Set(results.map(r => r.theme))].join(', ');
      
      const prompt = `
        You are a Strategic Product Lead. Analyze ${results.length} feedback items. Themes: ${themes}.
        
        Output ONLY raw HTML. No markdown. No introductory text.
        Use strictly the following structure. Do not deviate.
        
        <div class="header">📈 Strategic Product Pulse</div>
        
        <div class="section-title">EXECUTIVE ASSESSMENT</div>
        <p class="content-text">[One concise, professional sentence summarizing the current product health and user sentiment.]</p>

        <div class="section-title">STRATEGIC ANALYSIS BY THEME</div>
        <ul>
          <li><b>[Theme Name]:</b> [Strategic insight (e.g. "Critical friction point", "Stable", "High Growth")]</li>
          (Repeat for top themes)
        </ul>

        <div class="section-title">PRIORITY ACTION PLAN</div>
        <ul>
          <li><b>P0 (Immediate):</b> [Highest urgency item]</li>
          <li><b>P1 (Next Sprint):</b> [Secondary priority]</li>
          <li><b>P2 (Watchlist):</b> [Item to monitor]</li>
        </ul>
      `;
      const response = await env.AI.run("@cf/meta/llama-3-8b-instruct", { messages: [{ role: "user", content: prompt }] });
      return new Response(response.response);
    }

    // E. CHAT
    if (url.pathname === "/chat") {
      const q = new URL(request.url).searchParams.get("q");
      const { results } = await env.DB.prepare("SELECT content, theme, sentiment FROM feedback ORDER BY created_at DESC LIMIT 30").all();
      const prompt = `Data: ${JSON.stringify(results)}. Question: "${q}". Answer strictly based on data. Be concise.`;
      const response = await env.AI.run("@cf/meta/llama-3-8b-instruct", { messages: [{ role: "user", content: prompt }] });
      return new Response(response.response);
    }

    // F. RENDER UI
    const { results } = await env.DB.prepare("SELECT * FROM feedback ORDER BY created_at DESC").all();
    const reports = await env.DB.prepare("SELECT * FROM daily_reports ORDER BY date DESC LIMIT 5").all();
    
    // Stats & Chart Data
    const total = results.length;
    const negative = results.filter(r => r.sentiment === 'Negative').length;
    const avgUrgency = total > 0 ? (results.reduce((acc, r) => acc + (Number(r.urgency)||0), 0) / total).toFixed(1) : "0.0";
    
    const trendData = {};
    const themeCounts = {};
    const uniqueThemes = new Set();
    const uniqueChannels = new Set();
    const uniqueDates = new Set();

    results.forEach(r => {
      const d = r.created_at ? r.created_at.slice(5, 10) : 'N/A';
      if (!trendData[d]) trendData[d] = { count: 0, sum: 0 };
      trendData[d].count++;
      trendData[d].sum += (Number(r.urgency)||1);
      
      if(r.theme) {
          let t = r.theme.toLowerCase();
          themeCounts[t] = (themeCounts[t]||0)+1;
          uniqueThemes.add(t);
      }
      if(r.source) uniqueChannels.add(r.source);
      if(r.created_at) uniqueDates.add(r.created_at.slice(0,10));
    });
    const sortedDates = Object.keys(trendData).sort();

    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@1/css/pico.min.css">
      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      <style>
        body.container { max-width: 1200px; padding-top: 1rem; padding-bottom: 5rem; background: #f8f9fa; }
        
        /* METRICS */
        .metric-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0; background: #fff; border-radius: 8px; border: 1px solid #eee; margin-bottom: 1.5rem; height: 70px; overflow: hidden; }
        .metric-item { text-align: center; border-right: 1px solid #eee; display: flex; flex-direction: column; justify-content: center; }
        .metric-val { font-size: 1.4rem; font-weight: 800; color: #2c3e50; line-height: 1; }
        .metric-lbl { font-size: 0.65rem; color: #95a5a6; text-transform: uppercase; font-weight: 700; margin-top: 2px; }
        .text-red { color: #e74c3c; }

        /* CHARTS */
        .analytics-grid { display: grid; grid-template-columns: 2fr 1fr; gap: 20px; margin-bottom: 1.5rem; align-items: start; }
        .chart-card { background: #fff; padding: 15px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); border: 1px solid #eee; }
        .chart-container { height: 250px; position: relative; width: 100%; }
        
        /* AI SUMMARY (UPDATED FOR UNIFORM FONT) */
        .summary-card { 
            background-color: #e6f6ff; 
            border: 1px solid #d0e8f5; 
            border-radius: 8px; 
            padding: 24px; 
            margin-bottom: 20px; 
            color: #2c3e50; 
            display: none; 
            font-size: 14px; /* BASE FONT SIZE FOR EVERYTHING */
        }
        .summary-card .header { 
            font-size: 14px; /* Same size */
            font-weight: 800; /* Bolder to distinguish */
            margin-bottom: 12px; 
            display: flex; 
            align-items: center; 
            gap: 8px; 
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .summary-card .section-title { 
            font-size: 14px; /* Same size */
            font-weight: 700; 
            display: block; 
            margin-bottom: 6px; 
            margin-top: 16px; 
            text-transform: uppercase;
            color: #34495e;
        }
        .summary-card ul { margin: 0; padding-left: 20px; margin-bottom: 12px; }
        .summary-card li { margin-bottom: 4px; font-size: 14px; line-height: 1.5; }
        .summary-card p { font-size: 14px; line-height: 1.5; margin-bottom: 12px; }

        /* TABLE STYLES */
        .data-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; table-layout: fixed; } 
        .data-table th { text-align: left; padding: 10px; background: #f8f9fa; border-bottom: 2px solid #eee; vertical-align: bottom; color: #7f8c8d; font-weight:bold; }
        .data-table td { padding: 12px 10px; border-bottom: 1px solid #eee; vertical-align: middle; word-wrap: break-word; }
        
        /* FILTER INPUTS */
        .table-filter { 
            width: 100%; 
            padding: 4px; 
            margin-top: 5px; 
            border: 1px solid #ddd; 
            border-radius: 4px; 
            font-size: 0.75rem; 
            box-sizing: border-box; 
        }

        .source-tag { font-size: 0.7em; padding: 3px 8px; border-radius: 12px; font-weight: 700; text-transform: uppercase; color: white; display: inline-block; letter-spacing: 0.5px; }
        .src-twitter { background: #1da1f2; }
        .src-email { background: #f1c40f; color: black; }
        .src-app-store { background: #2c3e50; }
        .src-support-ticket { background: #e67e22; }

        .theme-tag { background: #ecf0f1; color: #2c3e50; padding: 2px 8px; border-radius: 4px; font-size: 0.8em; text-transform: capitalize; border: 1px solid #bdc3c7; }
        .sentiment-positive { color: #2ecc71; font-weight: bold; }
        .sentiment-negative { color: #e74c3c; font-weight: bold; }
        .sentiment-neutral { color: #95a5a6; font-weight: bold; }

        /* HEADER & CONTROL BAR */
        .control-bar { 
            display: flex; 
            justify-content: space-between; 
            align-items: center; 
            margin-bottom: 20px; 
            background: #fff;
            padding: 15px;
            border-radius: 8px;
            border: 1px solid #eee;
            flex-wrap: wrap;
            gap: 10px;
        }
        .btn-group { display: flex; gap: 10px; }
        
        /* NEW SEARCH BAR STYLES */
        .search-section {
            margin-bottom: 20px;
        }
        .search-input {
            width: 100%;
            padding: 10px 15px;
            border: 1px solid #ccc;
            border-radius: 8px;
            font-size: 0.9rem;
            background-color: #fff;
            box-shadow: 0 2px 4px rgba(0,0,0,0.05);
        }

        /* CHAT WIDGET */
        .chat-widget { position: fixed; bottom: 20px; right: 20px; width: 350px; z-index: 1000; }
        .chat-toggle { background: #2c3e50; color: white; border: none; border-radius: 50px; padding: 12px 20px; font-weight: bold; cursor: pointer; box-shadow: 0 4px 10px rgba(0,0,0,0.2); float: right; }
        .chat-window { display: none; background: white; border: 1px solid #ccc; border-radius: 10px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); overflow: hidden; margin-bottom: 10px; }
        .chat-body { height: 300px; overflow-y: auto; padding: 15px; background: #f8f9fa; font-size: 0.9rem; }
        .msg-user { background: #3498db; color: white; padding: 8px 12px; border-radius: 15px 15px 0 15px; margin-bottom: 8px; align-self: flex-end; max-width: 80%; margin-left: auto; display: block; width: fit-content; }
        .msg-ai { background: #ecf0f1; color: #2c3e50; padding: 8px 12px; border-radius: 15px 15px 15px 0; margin-bottom: 8px; max-width: 80%; display: block; width: fit-content; }

    </style>
      <script>
        function applyFilters() {
          const dateF = document.getElementById('f_date').value;
          const chanF = document.getElementById('f_chan').value;
          const searchF = document.getElementById('main_search').value.toLowerCase(); // Updated ID
          const themeF = document.getElementById('f_theme').value.toLowerCase();
          const sentF = document.getElementById('f_sent').value;
          const urgF = document.getElementById('f_urg').value; 

          document.querySelectorAll('tbody tr').forEach(row => {
            const r_date = row.getAttribute('data-date');
            const r_chan = row.getAttribute('data-chan');
            const r_content = row.querySelector('.row-content').innerText.toLowerCase(); 
            const r_theme = row.getAttribute('data-theme').toLowerCase();
            const r_sent = row.getAttribute('data-sent');
            const r_urg = row.getAttribute('data-urg');
            
            const show = (dateF==='All'||r_date===dateF) && 
                         (chanF==='All'||r_chan===chanF) && 
                         (r_content.includes(searchF)) && 
                         (themeF==='all'||r_theme===themeF) && 
                         (sentF==='All'||r_sent===sentF) &&
                         (urgF==='All'||r_urg===urgF);
                         
            row.style.display = show ? '' : 'none';
          });
        }
      </script>
    </head>
    <body class="container">
      
      <hgroup style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 1rem;">
        <h2 style="margin:0;">Feedback Intelligence</h2>
        <div style="font-size:0.8rem;">
            <a href="#" onclick="document.getElementById('tab-dash').style.display='block';document.getElementById('tab-brief').style.display='none'">Dashboard</a> | 
            <a href="#" onclick="document.getElementById('tab-dash').style.display='none';document.getElementById('tab-brief').style.display='block'">Daily Briefings</a>
        </div>
      </hgroup>

      <div class="control-bar">
         <div class="btn-group">
            <a href="/reset" role="button" class="contrast outline" style="font-size:0.8rem; padding: 8px 16px;">1. Reset</a>
            <a href="/seed" role="button" class="secondary outline" style="font-size:0.8rem; padding: 8px 16px;">2. Seed Data</a>
            <a href="/process" role="button" class="primary" style="font-size:0.8rem; padding: 8px 16px;">3. Run AI Classify</a>
         </div>
         <button onclick="generateReport(this)" class="primary" style="font-size:0.8rem; padding: 8px 16px; width:auto;">📝 Generate Executive Report</button>
      </div>

      <div id="tab-dash">
        <div id="report-output" class="summary-card"></div>

        <div class="metric-grid">
            <div class="metric-item"><div class="metric-val">${total}</div><div class="metric-lbl">Total</div></div>
            <div class="metric-item"><div class="metric-val text-red">${negative}</div><div class="metric-lbl">Negative</div></div>
            <div class="metric-item"><div class="metric-val">${avgUrgency}</div><div class="metric-lbl">Avg Urgency</div></div>
        </div>

        <div class="analytics-grid">
            <div class="chart-card">
                <div style="font-size:0.8rem; font-weight:bold; color:#7f8c8d; margin-bottom:10px;">INCIDENT VELOCITY</div>
                <div class="chart-container"><canvas id="trendChart"></canvas></div>
            </div>
            <div class="chart-card">
                <div style="font-size:0.8rem; font-weight:bold; color:#7f8c8d; margin-bottom:10px;">TOP THEMES</div>
                <div class="chart-container"><canvas id="themeChart"></canvas></div>
            </div>
        </div>

        <div class="search-section">
            <input type="text" id="main_search" class="search-input" placeholder="🔍 Search feedback content..." onkeyup="applyFilters()">
        </div>

        <div class="chart-card" style="padding:0; overflow-x:auto;">
            <table class="data-table">
                <thead>
                    <tr>
                        <th style="width:12%">
                            Date
                            <select id="f_date" class="table-filter" onchange="applyFilters()"><option value="All">All</option>${Array.from(uniqueDates).sort().map(d=>`<option value="${d}">${d}</option>`).join('')}</select>
                        </th>
                        <th style="width:14%">
                            Source
                            <select id="f_chan" class="table-filter" onchange="applyFilters()"><option value="All">All</option>${Array.from(uniqueChannels).sort().map(c=>`<option value="${c}">${c}</option>`).join('')}</select>
                        </th>
                        <th style="width:30%; vertical-align:top; padding-bottom:0;">
                            Content
                            <div style="height: 31px; margin-top: 5px;"></div> </th>
                        <th style="width:17%">
                            Theme
                            <select id="f_theme" class="table-filter" onchange="applyFilters()"><option value="All">All</option>${Array.from(uniqueThemes).sort().map(t=>`<option value="${t}">${t}</option>`).join('')}</select>
                        </th>
                        <th style="width:15%">
                            Sentiment
                            <select id="f_sent" class="table-filter" onchange="applyFilters()"><option value="All">All</option><option value="Positive">Positive</option><option value="Negative">Negative</option><option value="Neutral">Neutral</option></select>
                        </th>
                        <th style="width:12%; text-align:center">
                            Urgency
                            <select id="f_urg" class="table-filter" onchange="applyFilters()"><option value="All">All</option><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option><option value="5">5</option></select>
                        </th>
                    </tr>
                </thead>
                <tbody>
                ${results.map(r => {
                    const sourceClass = 'src-' + (r.source || 'email').toLowerCase().replace(/\s+/g, '-');
                    return `
                    <tr data-date="${r.created_at?.slice(0,10)}" data-chan="${r.source}" data-theme="${r.theme}" data-sent="${r.sentiment}" data-urg="${r.urgency}">
                        <td>${r.created_at?.slice(5,10)}</td>
                        <td><span class="source-tag ${sourceClass}">${r.source}</span></td>
                        <td class="row-content">${r.content}</td>
                        <td><span class="theme-tag">${r.theme||'-'}</span></td>
                        <td class="sentiment-${(r.sentiment||'').toLowerCase()}">${r.sentiment||'-'}</td>
                        <td style="text-align:center"><strong>${r.urgency||'-'}</strong></td>
                    </tr>`;
                }).join('')}
                </tbody>
            </table>
        </div>
      </div>

      <div id="tab-brief" style="display:none;">
        <h3>🗄️ Automated Daily Briefings</h3>
        <p>Generated automatically every day at 8:00 AM.</p>
        ${reports.results.map(r => `<div style="background:#fff; border-left:4px solid #2ecc71; padding:15px; margin-bottom:10px; box-shadow:0 1px 3px rgba(0,0,0,0.05);">${r.content}</div>`).join('')}
      </div>

      <div class="chat-widget">
        <div class="chat-window" id="chatWindow">
          <div style="background:#34495e; color:white; padding:10px; display:flex; justify-content:space-between;">
            <span>💬 Ask Your Data</span><span style="cursor:pointer" onclick="toggleChat()">✕</span>
          </div>
          <div class="chat-body" id="chatBody"><div class="msg-ai">Hi! Ask me about the feedback trends.</div></div>
          <div style="padding:10px; border-top:1px solid #eee; display:flex;">
            <input type="text" id="chatInput" style="margin-bottom:0;" placeholder="Ask a question..." onkeypress="if(event.key==='Enter') sendMsg()">
          </div>
        </div>
        <button class="chat-toggle" onclick="toggleChat()">✨ AI Chat</button>
      </div>

      <script>
        // REPORT (UPDATED: Strip out unwanted pre-amble)
        async function generateReport(btn) {
            btn.setAttribute('aria-busy', 'true');
            const res = await fetch('/report');
            let html = await res.text();
            
            // CLEAN UP: Remove "Here is the..." if AI adds it despite prompt
            html = html.replace(/Here is the analysis.*?HTML:/i, '');
            html = html.replace(/\`\`\`html/g, '').replace(/\`\`\`/g, '');
            
            document.getElementById('report-output').innerHTML = html;
            document.getElementById('report-output').style.display = 'block';
            btn.setAttribute('aria-busy', 'false');
        }

        // CHAT
        function toggleChat() { 
            const w = document.getElementById('chatWindow'); 
            w.style.display = w.style.display === 'block' ? 'none' : 'block'; 
        }
        async function sendMsg() {
            const inp = document.getElementById('chatInput');
            const txt = inp.value.trim();
            if(!txt) return;
            const body = document.getElementById('chatBody');
            body.innerHTML += '<div class="msg-user">'+txt+'</div>';
            inp.value = '';
            body.innerHTML += '<div class="msg-ai">...</div>';
            body.scrollTop = body.scrollHeight;
            try {
                const res = await fetch('/chat?q='+encodeURIComponent(txt));
                const ans = await res.text();
                body.lastChild.innerText = ans;
            } catch(e) { body.lastChild.innerText = "Error"; }
            body.scrollTop = body.scrollHeight;
        }

        // CHARTS
        new Chart(document.getElementById('trendChart'), {
            type: 'bar',
            data: {
                labels: [${sortedDates.map(d=>`'${d}'`).join(',')}],
                datasets: [
                    { label: 'Volume', data: [${sortedDates.map(d=>trendData[d].count).join(',')}], backgroundColor: '#2980b9', order: 1, borderRadius: 4 },
                    { type: 'line', label: 'Urgency', data: [${sortedDates.map(d=>(trendData[d].sum/trendData[d].count).toFixed(1)).join(',')}], borderColor: '#c0392b', borderWidth: 3, tension: 0.4, yAxisID: 'y1', order: 0, pointBackgroundColor: '#c0392b' }
                ]
            },
            options: { responsive:true, maintainAspectRatio:false, scales: { x:{grid:{display:false}}, y:{beginAtZero:true, title:{display:true, text:'Volume'}}, y1:{position:'right', beginAtZero:true, max:5, grid:{display:false}, title:{display:true, text:'Urgency Score'}} } }
        });

        const tLabs = [${Object.keys(themeCounts).map(k=>`'${k}'`).join(',')}];
        const tDat = [${Object.values(themeCounts).join(',')}];
        
        const colorPalette = ['#9b59b6', '#e74c3c', '#34495e', '#16a085', '#f1c40f', '#2980b9', '#d35400', '#7f8c8d'];
        const bgColors = tLabs.map((_, i) => colorPalette[i % colorPalette.length]);

        new Chart(document.getElementById('themeChart'), {
            type: 'bar',
            data: { labels: tLabs, datasets: [{ data: tDat, backgroundColor: bgColors, borderRadius: 4 }] },
            options: { indexAxis: 'y', maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{x:{grid:{display:false}}} }
        });
      </script>
    </body>
    </html>
    `;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
};
