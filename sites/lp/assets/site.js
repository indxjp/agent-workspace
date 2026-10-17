/* Agent Workspace — marketing site behaviour, shared by every page in sites/lp/.
   Progressive enhancement only: every page is complete without this file. Each feature
   looks for its own markup and does nothing when the page does not carry it. */
(function () {
  "use strict";
  var root = document.documentElement;
  var noReveal = root.classList.contains("no-reveal");
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var $ = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function (sel, ctx) { return [].slice.call((ctx || document).querySelectorAll(sel)); };

  /* --- sticky header state --- */
  var hdr = document.getElementById("site-header");
  if (hdr) {
    var onScroll = function () { hdr.classList.toggle("is-stuck", window.scrollY > 8); };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  /* --- product menu (desktop) --- */
  $$(".has-menu").forEach(function (item) {
    var btn = $(".nav-btn", item);
    if (!btn) return;
    var set = function (open) {
      item.classList.toggle("open", open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    };
    btn.addEventListener("click", function (e) { e.stopPropagation(); set(!item.classList.contains("open")); });
    item.addEventListener("keydown", function (e) { if (e.key === "Escape") { set(false); btn.focus(); } });
    item.addEventListener("focusout", function (e) { if (!item.contains(e.relatedTarget)) set(false); });
    document.addEventListener("click", function (e) { if (!item.contains(e.target)) set(false); });
  });

  /* --- mobile drawer --- */
  var toggle = $(".nav-toggle");
  var drawer = toggle && document.getElementById(toggle.getAttribute("aria-controls"));
  if (toggle && drawer) {
    var setDrawer = function (open) {
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      drawer.classList.toggle("open", open);
    };
    toggle.addEventListener("click", function () { setDrawer(toggle.getAttribute("aria-expanded") !== "true"); });
    drawer.addEventListener("click", function (e) { if (e.target.closest("a")) setDrawer(false); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") { setDrawer(false); toggle.focus(); }
    });
    window.addEventListener("resize", function () { if (window.innerWidth > 1080) setDrawer(false); });
  }

  /* --- scroll reveal (CSS shows everything without .js) --- */
  var revealables = $$(".reveal");
  if (reduce || noReveal || !("IntersectionObserver" in window)) {
    revealables.forEach(function (el) { el.classList.add("in"); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    revealables.forEach(function (el) { io.observe(el); });
    requestAnimationFrame(function () {
      revealables.forEach(function (el) {
        if (el.getBoundingClientRect().top < window.innerHeight) el.classList.add("in");
      });
    });
  }

  /* --- deep links: re-anchor once webfonts and layout have settled --- */
  if (location.hash) {
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";
    var reanchor = function () {
      var t = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (!t) return;
      var prev = root.style.scrollBehavior;
      root.style.scrollBehavior = "auto";
      window.scrollTo(0, window.scrollY + t.getBoundingClientRect().top - 80);
      root.style.scrollBehavior = prev;
    };
    window.addEventListener("load", function () { reanchor(); setTimeout(reanchor, 250); });
  }

  /* --- tabs: any [data-tabs] container with role="tab" buttons and aria-controls panels --- */
  $$("[data-tabs]").forEach(function (box) {
    var tabs = $$('[role="tab"]', box).filter(function (t) { return t.closest("[data-tabs]") === box; });
    var panels = tabs.map(function (t) { return document.getElementById(t.getAttribute("aria-controls")); });
    if (!tabs.length || panels.some(function (p) { return !p; })) return;
    box.classList.add("js-ready");
    var vertical = box.getAttribute("data-tabs") === "vertical";
    var select = function (i, focus) {
      tabs.forEach(function (t, n) {
        var on = n === i;
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.tabIndex = on ? 0 : -1;
        panels[n].classList.toggle("on", on);
      });
      if (focus) tabs[i].focus();
    };
    var start = Math.max(0, tabs.findIndex(function (t) { return t.getAttribute("aria-selected") === "true"; }));
    select(start, false);
    /* a deep link to a panel (use-cases.html#code-contract-review) selects its tab first */
    var fromHash = function () {
      var i = panels.findIndex(function (p) { return "#" + p.id === decodeURIComponent(location.hash); });
      if (i === -1) return;
      select(i, false);
      requestAnimationFrame(function () { tabs[i].scrollIntoView({ block: "center" }); });
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    tabs.forEach(function (t, i) {
      t.addEventListener("click", function () { select(i, false); });
      t.addEventListener("keydown", function (e) {
        var k = e.key, n = null;
        var next = vertical ? "ArrowDown" : "ArrowRight", prev = vertical ? "ArrowUp" : "ArrowLeft";
        if (k === next || k === "ArrowRight" || k === "ArrowDown") n = (i + 1) % tabs.length;
        else if (k === prev || k === "ArrowLeft" || k === "ArrowUp") n = (i - 1 + tabs.length) % tabs.length;
        else if (k === "Home") n = 0;
        else if (k === "End") n = tabs.length - 1;
        if (n !== null) { e.preventDefault(); select(n, true); }
      });
    });
  });

  /* --- stack builder (home hero): every chip maps to a real setup flag of
         `npm create @indx-workspace` (packages/contracts/src/setup.ts), and the files shown are
         what packages/sdk/src/project/render.ts writes for those answers --- */
  var stack = $("[data-stack]");
  if (stack) initStack(stack);

  function initStack(box) {
    var THEMES = {
      support: { agent: "assistant", skill: "refund-policy", instructions: "You are a customer support assistant. Answer questions clearly and briefly, ..." },
      knowledge: { agent: "knowledge", skill: "cite-sources", instructions: "You answer questions from the knowledge you have been given. Point to where ..." },
      automation: { agent: "automation", skill: "", instructions: "You carry out routine tasks step by step. Say what you are about to do ...", tools: ["delivery-estimate", "orders"] },
      review: { agent: "reviewer", skill: "", instructions: "You review work for correctness and clarity. Point to each problem ..." },
      copilot: { agent: "copilot", skill: "", instructions: "You are a copilot for the people on this team. Help them draft, ..." }
    };
    /* the setup flags this builder writes: static.mjs checks each is a flag of SETUP_QUESTIONS */
    var CREATE_FLAGS = { engine: "--engine", provider: "--provider", baseUrl: "--model-base-url", theme: "--theme", tools: "--tools" };
    var KEYS = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", "azure-openai": "AZURE_OPENAI_API_KEY", "openai-compatible": "OPENAI_API_KEY" };
    /* engine capabilities: docs/sdk/site/resources/engines.mdx */
    var NO_SKILLS = { "openai-agents": true };
    var esc = function (t) { return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); };
    var cm = function (t) { return '<span class="cm">' + esc(t) + "</span>"; };
    var cmd = function (t) { return '<span class="p">$ </span>' + esc(t); };
    var str = function (t) { return '<span class="str">' + esc(t) + "</span>"; };
    var kw = function (t) { return '<span class="kw">' + t + "</span>"; };
    var ident = function (n) { return n.replace(/-([a-z0-9])/g, function (_, c) { return c.toUpperCase(); }) + "Tool"; };
    var pick = function (name) { var el = $('input[name="' + name + '"]:checked', box); return el ? el.value : ""; };
    var picks = function (name) { return $$('input[name="' + name + '"]:checked', box).map(function (el) { return el.value; }); };
    var pres = { cmd: $("#stack-cmd", box), yaml: $("#stack-yaml", box), agent: $("#stack-agent", box) };
    var note = $(".stack-note", box), copy = $(".stack-tabs .copy", box), agentTab = $("[data-stack-agent-file]", box);
    var ORIGIN = "https://agents.acme.example";
    var STEP3 = { page: "share the hosted chat page", widget: "put it on your site", react: "render it in your React app", api: "call it from your backend" };
    var STEP4 = { laptop: "production when you are ready", "single-vm": "your on-prem VM", "gcp-cloudrun": "your Google Cloud project", kubernetes: "your cluster", agentcore: "AWS" };

    function render() {
      var engine = pick("engine"), provider = pick("provider"), theme = pick("theme");
      var tools = picks("tools"), frontend = pick("frontend"), infra = pick("infra");
      var t = THEMES[theme], key = KEYS[provider], notes = [];
      var baseUrl = provider === "openai-compatible" ? "http://gpu-01.internal:8000/v1"
        : provider === "azure-openai" ? "https://acme.openai.azure.com" : "";

      var flags = ["--yes"];
      if (engine !== "claude-agent-sdk") flags.push(CREATE_FLAGS.engine + " " + engine);
      if (provider !== "anthropic") flags.push(CREATE_FLAGS.provider + " " + provider);
      if (baseUrl) flags.push(CREATE_FLAGS.baseUrl + " " + baseUrl);
      if (theme !== "support") flags.push(CREATE_FLAGS.theme + " " + theme);
      if (tools.length) flags.push(CREATE_FLAGS.tools + " " + tools.join(","));

      var L = [cm("# 1 · create the project"),
        cmd("npm create @indx-workspace@latest my-agent -- " + flags.join(" \\\n    ")),
        cm("# 2 · run it: chat, admin and API on http://127.0.0.1:3000"),
        cmd("export " + key + "=" + (provider === "anthropic" ? "sk-ant-..." : "...")),
        cmd("cd my-agent && npm run dev"),
        cm("# 3 · " + STEP3[frontend])];
      if (frontend === "page") L.push(cm("#   open the try URL from the ready screen"));
      if (frontend === "widget") L.push(esc('<script src="' + ORIGIN + '/p/s/main/widget.js" async></script>'));
      if (frontend === "react") L.push(cmd("npm install @indx-workspace/react @indx-workspace/sdk"), esc('<Chat surface="main" baseUrl="' + ORIGIN + '" />'));
      if (frontend === "api") L.push(cmd("npm install @indx-workspace/sdk"), esc("await aw.runs.start(agentId, { prompt })"));
      L.push(cm("# 4 · ship it to " + STEP4[infra]));
      var push = [cm("#   push the agents with an API key from Administration → API Keys"),
        cmd("export AGENT_WORKSPACE_URL=" + ORIGIN + " AGENT_WORKSPACE_API_KEY=..."),
        cmd("npx aw push --yes && npx aw promote --yes")].join("\n");
      if (infra === "kubernetes") {
        L.push(cm("#   in a clone of the repository"), cmd("helm upgrade --install agent-workspace ./infra/helm/agent-workspace -f values.yaml"), push);
        notes.push("Kubernetes ships as a Helm chart today; <code>aw deploy</code> covers a VM and Cloud Run.");
      } else if (infra === "agentcore") {
        L.push(cm("#   roadmap: the aws-agentcore runtime driver is named, not implemented yet"));
        notes.push("AWS AgentCore is on the roadmap. Today, run it on a VM in your VPC or on EKS with the Helm chart.");
      } else {
        L.push(cmd("npx aw deploy production --yes" + (infra === "gcp-cloudrun" ? " --infra ./infra" : "")), push);
        if (infra === "laptop") notes.push("Pick On-prem VM or Google Cloud Run to see the <code>production</code> environment it adds.");
      }
      pres.cmd.innerHTML = L.join("\n");

      var Y = [cm("# The Agent Workspace project file: what `aw dev` runs, and where."),
        cm("# No secret belongs in this file; it is meant to be committed."),
        "apiVersion: agentworkspace.dev/v2", "kind: Project", "name: my-agent"];
      if (provider !== "anthropic") {
        Y.push("models:", "  default:", "    provider: " + provider, "    credential:", "      secret: " + key);
        if (baseUrl) Y.push("    baseUrl: " + str(baseUrl));
        if (provider === "azure-openai") Y.push("    deployment: your-deployment", "    apiVersion: your-api-version");
      }
      Y.push("environments:", "  local:", "    cloud: local", "    identity:", "      bootstrapAdmin: admin@localhost.test");
      if (infra === "single-vm" || infra === "gcp-cloudrun")
        Y.push("  production:            " + cm("# you add this for `aw deploy`"), "    target: " + infra, "    url: " + str(ORIGIN));
      if (infra === "kubernetes") Y.push(cm("# production on Kubernetes: the Helm chart's values.yaml"));
      if (infra === "agentcore") Y.push(cm("# production on AWS AgentCore: roadmap"));
      pres.yaml.innerHTML = Y.join("\n");

      var all = tools.slice().sort().concat(t.tools || []);
      var A = [kw("import") + " { defineAgent" + (t.skill ? ", skill" : "") + " } " + kw("from") + " " + str("'@indx-workspace/sdk/define'") + ";"];
      if (all.length) A.push("");
      all.forEach(function (n) { A.push(kw("import") + " " + ident(n) + " " + kw("from") + " " + str("'../tools/" + n + "'") + ";"); });
      A.push("", kw("export default") + " defineAgent({",
        "  name: " + str("'" + t.agent + "'") + ",",
        "  instructions: " + str("'" + t.instructions + "'") + ",",
        "  engine: " + str("'" + engine + "'") + ",",
        "  model: " + str("'default'") + ",");
      if (all.length) A.push("  tools: [" + all.map(ident).join(", ") + "],");
      if (t.skill) A.push("  skills: [skill(" + str("'" + t.skill + "'") + ")],");
      A.push("});");
      pres.agent.innerHTML = A.join("\n");
      if (agentTab) agentTab.textContent = "agents/" + t.agent + ".ts";

      if (t.skill && NO_SKILLS[engine])
        notes.push("The OpenAI Agents SDK engine runs no skills: pick Review, Automation or Copilot, or a run is refused with <code>engine_capability_unsupported</code>.");
      if (engine === "pi") notes.push("pi takes no MCP connectors: an agent assigned one is refused.");
      note.innerHTML = notes.map(function (n) { return "<p>" + n + "</p>"; }).join("");
      note.hidden = notes.length === 0;
    }

    $$("[data-stack-tab]", box).forEach(function (tab) {
      tab.addEventListener("click", function () {
        var id = tab.getAttribute("data-stack-tab");
        $$("[data-stack-tab]", box).forEach(function (b) { b.setAttribute("aria-selected", b === tab ? "true" : "false"); });
        Object.keys(pres).forEach(function (k) { pres[k].hidden = k !== id; });
        if (copy) copy.setAttribute("data-copy", "#stack-" + id);
      });
    });
    box.addEventListener("change", render);
    render();
  }

  /* --- copy buttons: <button class="copy" data-copy="#id"> copies that element's text --- */
  $$("button.copy[data-copy]").forEach(function (b) {
    b.addEventListener("click", function () {
      var src = $(b.getAttribute("data-copy"));
      if (!src || !navigator.clipboard) return;
      var text = src.innerText.replace(/^\$ /gm, "");
      navigator.clipboard.writeText(text).then(function () {
        var was = b.textContent;
        b.textContent = "Copied";
        setTimeout(function () { b.textContent = was; }, 1400);
      }, function () { /* clipboard refused: leave the label as it was */ });
    });
  });

  /* --- filter bars: <div class="filters" data-filter-for="#grid"> with data-filter buttons --- */
  $$(".filters[data-filter-for]").forEach(function (bar) {
    var grid = $(bar.getAttribute("data-filter-for"));
    if (!grid) return;
    var items = $$("[data-filter-item]", grid);
    var empty = $(".filter-empty", grid.parentNode);
    var buttons = $$("button[data-filter]", bar);
    buttons.forEach(function (b) {
      var key = b.getAttribute("data-filter");
      var n = key === "all" ? items.length : items.filter(function (it) {
        return (" " + it.getAttribute("data-filter-item") + " ").indexOf(" " + key + " ") !== -1;
      }).length;
      var c = document.createElement("span");
      c.className = "count"; c.textContent = String(n);
      b.appendChild(c);
    });
    var apply = function (key) {
      var shown = 0;
      buttons.forEach(function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-filter") === key ? "true" : "false"); });
      items.forEach(function (it) {
        var on = key === "all" || (" " + it.getAttribute("data-filter-item") + " ").indexOf(" " + key + " ") !== -1;
        it.hidden = !on;
        if (on) { shown++; it.classList.add("in"); }
      });
      if (empty) empty.hidden = shown !== 0;
    };
    buttons.forEach(function (b) { b.addEventListener("click", function () { apply(b.getAttribute("data-filter")); }); });
    var initial = (location.hash.match(/^#for-([a-z-]+)$/) || [])[1];
    if (initial && buttons.some(function (b) { return b.getAttribute("data-filter") === initial; })) apply(initial);
  });

  /* --- deep links to a card open its details (use-cases.html#legal-contract-review) --- */
  var openTarget = function () {
    var el = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
    var box = el && el.querySelector("details.more-box");
    if (box) box.open = true;
  };
  openTarget();
  window.addEventListener("hashchange", openTarget);

  /* --- hero live demo: replays a scripted run; without JS (or with reduced motion) the
         final transcript of the first scenario is what the markup already shows --- */
  var demo = $("[data-demo]");
  if (demo) initDemo(demo);

  function initDemo(box) {
    var scenarios = $$("template[data-scenario]", box);
    var switches = $$(".demo-switch button", box);
    var stage = $(".stream", box);
    var bar = $(".demo-progress i", box);
    var runtime = $("[data-demo-runtime]", box);
    var title = $("[data-demo-title]", box);
    var meta = $(".demo-meta", box);
    if (!scenarios.length || !stage) return;
    var timers = [], current = 0, cycle = null, visible = true;

    var clear = function () { timers.forEach(clearTimeout); timers = []; };
    var at = function (ms, fn) { timers.push(setTimeout(fn, ms)); };

    var play = function (i, animate) {
      clear();
      current = i;
      var tpl = scenarios[i];
      switches.forEach(function (b, n) { b.setAttribute("aria-pressed", n === i ? "true" : "false"); });
      if (runtime) runtime.textContent = tpl.getAttribute("data-runtime");
      if (title) title.textContent = tpl.getAttribute("data-agent");
      stage.innerHTML = "";
      stage.appendChild(tpl.content.cloneNode(true));
      var steps = $$("[data-step]", stage);
      var answer = $("[data-type]", stage);
      if (meta) meta.hidden = true;
      var done = function (spin) {
        var tick = document.createElement("span");
        tick.className = "tick"; tick.textContent = "✓";
        spin.replaceWith(tick);
      };
      if (!animate) {
        steps.forEach(function (s) { s.classList.add("shown"); });
        $$(".spin", stage).forEach(done);
        if (meta) { meta.hidden = false; fillMeta(tpl); }
        if (bar) bar.style.width = "100%";
        return;
      }
      var full = answer ? answer.textContent : "";
      if (answer) answer.textContent = "";
      var t = 200;
      steps.forEach(function (s) {
        var d = parseInt(s.getAttribute("data-step"), 10) || 600;
        at(t, function () {
          s.classList.add("shown");
          var spin = $(".spin", s);
          if (spin) at(Math.max(250, d - 150), function () { done(spin); });
        });
        t += d;
      });
      if (answer) {
        var chars = full.length, per = Math.max(12, Math.min(28, 1400 / chars));
        for (var c = 1; c <= chars; c++) {
          (function (n) { at(t + n * per, function () { answer.textContent = full.slice(0, n); }); })(c);
        }
        t += chars * per;
      }
      at(t + 150, function () { if (meta) { meta.hidden = false; fillMeta(tpl); } });
      if (bar) {
        bar.style.transition = "none"; bar.style.width = "0";
        requestAnimationFrame(function () {
          requestAnimationFrame(function () { bar.style.transition = "width " + (t / 1000) + "s linear"; bar.style.width = "100%"; });
        });
      }
      at(t + 4200, function () { if (visible && cycle) play((current + 1) % scenarios.length, true); });
    };

    var fillMeta = function (tpl) {
      $$("[data-meta]", meta).forEach(function (m) { m.textContent = tpl.getAttribute("data-" + m.getAttribute("data-meta")) || ""; });
    };

    switches.forEach(function (b, i) {
      b.addEventListener("click", function () { cycle = null; play(i, !reduce); });
    });

    if (reduce) { play(0, false); return; }
    cycle = true;
    if ("IntersectionObserver" in window) {
      var started = false;
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        if (visible && !started) { started = true; play(0, true); }
        else if (visible && cycle && !timers.length) play(current, true);
      }, { threshold: 0.25 }).observe(box);
    } else play(0, true);
  }

  /* --- configurator: options compile exactly the way the Claude engine adapter does
         (packages/engine-claude-agent-sdk: compile.ts, tools.ts) --- */
  var cfg = $("[data-configurator]");
  if (cfg) initConfigurator(cfg);

  function initConfigurator(box) {
    var out = $("pre", box), checks = $(".cfg-checks", box), label = $("[data-cfg-file]", box);
    if (!out) return;
    var DENY = {
      read: ["Read", "Glob", "Grep"],
      write: ["Write", "Edit", "NotebookEdit"],
      shell: ["Bash", "BashOutput", "KillShell"],
      net: ["WebFetch", "WebSearch"]
    };
    var MODELS = {
      claude: { id: "claude-sonnet-4-5", provider: "Anthropic", note: "" },
      azure: { id: "gpt-…", provider: "Azure OpenAI", note: "your Azure deployment" },
      openai: { id: "gpt-…", provider: "OpenAI", note: "" }
    };
    var CONNECTORS = {
      ticketing: '{ type: "http", url: "https://tickets.acme.example/mcp" }',
      contracts: '{ type: "http", url: "https://intranet.acme.example/mcp" }',
      github: '{ type: "http", url: "https://api.githubcopilot.com/mcp/" }',
      filesystem: '{ type: "stdio", command: "npx", args: ["@modelcontextprotocol/server-filesystem"] }'
    };
    /* standing per docs/sdk/site/building/self-hosting.mdx "Which runtime drivers are real today" */
    var RUNTIMES = {
      local: { verified: true },
      "sandbox-runtime": { verified: true },
      docker: { verified: true },
      kubernetes: { verified: "partial" },
      "aca-sessions": { verified: false }
    };
    var prev = "";
    var esc = function (s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); };
    var str = function (s) { return '<span class="str">"' + esc(s) + '"</span>'; };
    var arr = function (xs) { return xs.length ? "[" + xs.map(str).join(", ") + "]" : "[]"; };

    var render = function () {
      var get = function (name) { var el = $('input[name="' + name + '"]:checked', box); return el ? el.value : null; };
      var all = function (name) { return $$('input[name="' + name + '"]:checked', box).map(function (el) { return el.value; }); };
      var model = get("model"), runtime = get("runtime");
      var skills = all("skill"), connectors = all("connector"), perms = all("perm");
      var deny = [];
      ["read", "write", "shell", "net"].forEach(function (p) { if (perms.indexOf(p) === -1) deny = deny.concat(DENY[p]); });
      /* the server key is the connector record's key, connector-<id>; sample ids */
      var KEY = { contracts: "connector-3f9a", ticketing: "connector-7c21", github: "connector-a14e", filesystem: "connector-0b6d" };
      var approve = connectors.slice().sort().map(function (c) { return "mcp__" + KEY[c] + "__*"; });
      var m = MODELS[model];
      var lines = [];
      lines.push('<span class="cm">// compiled for every run of this agent — you never write this by hand</span>');
      lines.push('<span class="kw">const</span> options = {');
      lines.push('  <span class="k">model</span>: ' + str(m.id) + "," + (m.note ? '  <span class="cm">// ' + esc(m.note) + "</span>" : ""));
      lines.push('  <span class="k">cwd</span>: ' + str("/workspace") + ",");
      lines.push('  <span class="k">tools</span>: { type: ' + str("preset") + ", preset: " + str("claude_code") + " },");
      lines.push('  <span class="k">allowedTools</span>: ' + arr(approve) + ",");
      lines.push('  <span class="k">disallowedTools</span>: ' + arr(deny) + ",");
      lines.push('  <span class="k">skills</span>: ' + arr(skills) + ",");
      if (connectors.length) {
        lines.push('  <span class="k">mcpServers</span>: {');
        connectors.forEach(function (c) { lines.push("    " + str(KEY[c]) + ": " + esc(CONNECTORS[c]).replace(/"([^"]*)"/g, '<span class="str">"$1"</span>') + ","); });
        lines.push("  },");
      } else lines.push('  <span class="k">mcpServers</span>: {},');
      lines.push('  <span class="k">settingSources</span>: [<span class="str">"project"</span>],      <span class="cm">// session project only, never host user state</span>');
      lines.push('  <span class="k">strictMcpConfig</span>: <span class="kw">true</span>,');
      lines.push('  <span class="k">env</span>,                     <span class="cm">// this run\'s gateway token, never a provider key</span>');
      lines.push("};");
      /* highlight the lines this change produced, then let the highlight fade */
      var before = prev ? prev.split("\n") : lines;
      out.innerHTML = lines.map(function (l) { return before.indexOf(l) === -1 ? '<span class="chg">' + l + "</span>" : l; }).join("\n");
      setTimeout(function () { $$(".chg", out).forEach(function (c) { c.classList.remove("chg"); }); }, 900);
      prev = lines.join("\n");
      if (label) label.textContent = m.provider + " · " + runtime;

      var rt = RUNTIMES[runtime], notes = [];
      if (model !== "claude") notes.push(["Compatibility mode on " + m.provider + ".", "Prompt caching is unsupported and thinking is approximated. The agent runs; behaviour may differ."]);
      if (connectors.indexOf("filesystem") !== -1) notes.push(["stdio connectors are stored but cannot run today.", "Use an MCP server over HTTP or SSE instead."]);
      if (runtime === "local") notes.push([perms.indexOf("shell") !== -1 ? "Run commands with no isolation." : "Development only.", "This machine runs agents as the control plane's own process and user: no tenant isolation."]);
      if (rt.verified === false) notes.push(["Implemented, not yet live-verified.", "The product shows this runtime disabled until a live isolation proof exists."]);
      if (rt.verified === "partial") notes.push(["Lifecycle and isolation partially verified.", "No live-cluster proof is published yet."]);
      checks.innerHTML = notes.length
        ? notes.map(function (n) { return '<div class="notice"><span class="sym">⚠</span><span><b>' + esc(n[0]) + "</b><br>" + esc(n[1]) + "</span></div>"; }).join("")
        : '<p class="ok-line">✓ No capability gaps for this combination.</p>';
    };
    box.addEventListener("change", render);
    render();
  }

  /* --- runtime picker: buttons with aria-pressed swap one detail card --- */
  $$("[data-runtime-picker]").forEach(function (box) {
    var buttons = $$("button[aria-controls]", box);
    var cards = buttons.map(function (b) { return document.getElementById(b.getAttribute("aria-controls")); });
    if (cards.some(function (c) { return !c; })) return;
    var pick = function (i) {
      buttons.forEach(function (b, n) { b.setAttribute("aria-pressed", n === i ? "true" : "false"); cards[n].hidden = n !== i; });
    };
    buttons.forEach(function (b, i) { b.addEventListener("click", function () { pick(i); }); });
    pick(Math.max(0, buttons.findIndex(function (b) { return b.getAttribute("aria-pressed") === "true"; })));
  });
  /* --- hero dot field: a slow, drifting lattice that leans toward the cursor --- */
  var field = document.getElementById("field");
  if (field && field.getContext && !reduce) initField(field);

  function initField(cv) {
    var ctx = cv.getContext("2d"), dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = 0, h = 0, pts = [], mx = -9999, my = -9999, t = 0, raf = 0, onScreen = true;
    var size = function () {
      var r = cv.getBoundingClientRect();
      w = r.width; h = r.height;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      pts = [];
      var gap = w < 700 ? 34 : 28;
      for (var y = gap / 2; y < h; y += gap) for (var x = gap / 2; x < w; x += gap) pts.push([x, y, Math.random() * 6.28]);
    };
    var draw = function () {
      t += 0.006;
      ctx.clearRect(0, 0, w, h);
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        /* only the right half and the top fade in, so the headline stays clean */
        var fade = Math.max(0, Math.min(1, (p[0] / w - 0.35) * 2.2)) * Math.max(0, 1 - p[1] / h);
        if (fade <= 0.02) continue;
        var wave = Math.sin(p[0] * 0.012 + t * 2 + p[2]) * Math.cos(p[1] * 0.014 - t);
        var dx = p[0] - mx, dy = p[1] - my, d = Math.sqrt(dx * dx + dy * dy);
        var near = d < 160 ? (1 - d / 160) : 0;
        var a = (0.1 + 0.35 * (wave * 0.5 + 0.5) + near * 0.6) * fade;
        ctx.fillStyle = near > 0.05 ? "rgba(147,177,255," + a + ")" : "rgba(220,224,240," + a * 0.7 + ")";
        var r = 0.7 + near * 1.4 + (wave > 0.6 ? 0.5 : 0);
        ctx.beginPath(); ctx.arc(p[0], p[1] + wave * 2, r, 0, 6.283); ctx.fill();
      }
      raf = onScreen ? requestAnimationFrame(draw) : 0;
    };
    size();
    window.addEventListener("resize", size);
    var host = cv.parentNode;
    host.addEventListener("pointermove", function (e) { var r = cv.getBoundingClientRect(); mx = e.clientX - r.left; my = e.clientY - r.top; });
    host.addEventListener("pointerleave", function () { mx = my = -9999; });
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (en) {
        onScreen = en[0].isIntersecting;
        if (onScreen && !raf) raf = requestAnimationFrame(draw);
      }).observe(cv);
    }
    raf = requestAnimationFrame(draw);
  }

  /* --- trace waterfall plays once it is on screen --- */
  $$(".trace[data-animate]").forEach(function (tr) {
    $$(".trace-rows li", tr).forEach(function (li, i) { li.style.setProperty("--i", String(i)); });
    if (reduce || !("IntersectionObserver" in window)) { tr.classList.add("play"); return; }
    var io2 = new IntersectionObserver(function (en) {
      if (en[0].isIntersecting) { tr.classList.add("play"); io2.disconnect(); }
    }, { threshold: 0.3 });
    io2.observe(tr);
  });

  /* --- stage: tab panel that advances by itself until someone touches it --- */
  $$("[data-stage]").forEach(function (st) {
    var tabs = $$('[role="tab"]', st);
    var period = 7000, started = 0, stopped = reduce, frame = 0;
    var current = function () { return Math.max(0, tabs.findIndex(function (t) { return t.getAttribute("aria-selected") === "true"; })); };
    var bars = tabs.map(function (t) { var b = document.createElement("span"); b.className = "prog"; t.appendChild(b); return b; });
    var tick = function () {
      if (stopped) { bars.forEach(function (b) { b.style.width = "0"; }); return; }
      var k = Math.min(1, (Date.now() - started) / period);
      bars.forEach(function (b, i) { b.style.width = i === current() ? (k * 100) + "%" : "0"; });
      if (k >= 1) { tabs[(current() + 1) % tabs.length].click(); stopped = false; started = Date.now(); }
      frame = requestAnimationFrame(tick);
    };
    var stop = function () { stopped = true; };
    tabs.forEach(function (t) { t.addEventListener("click", function (e) { if (e.isTrusted) stop(); started = Date.now(); }); });
    st.addEventListener("pointerenter", function () { if (!stopped) { stopped = true; st.dataset.paused = "1"; } });
    st.addEventListener("pointerleave", function () { if (st.dataset.paused) { delete st.dataset.paused; stopped = false; started = Date.now(); frame = requestAnimationFrame(tick); } });
    st.addEventListener("focusin", stop);
    if (stopped || !("IntersectionObserver" in window)) return;
    new IntersectionObserver(function (en) {
      if (en[0].isIntersecting && !frame) { started = Date.now(); frame = requestAnimationFrame(tick); }
    }, { threshold: 0.35 }).observe(st);
  });

  /* --- scroll-driven steps: the step nearest the middle of the screen lights up --- */
  $$("[data-scrolly]").forEach(function (box) {
    var steps = $$(".scrolly-steps li", box);
    var vis = $$("[data-step-vis]", box);
    var show = function (i) {
      steps.forEach(function (s, n) { s.classList.toggle("on", n === i); });
      vis.forEach(function (v, n) { v.classList.toggle("on", n === i); });
    };
    show(0);
    if (!("IntersectionObserver" in window)) return;
    var io3 = new IntersectionObserver(function (en) {
      en.forEach(function (e) { if (e.isIntersecting) show(steps.indexOf(e.target)); });
    }, { rootMargin: "-45% 0px -45% 0px" });
    steps.forEach(function (s) { io3.observe(s); });
  });

  /* --- numbers count up when they arrive --- */
  $$(".count[data-to]").forEach(function (el) {
    var to = parseInt(el.getAttribute("data-to"), 10);
    if (reduce || !("IntersectionObserver" in window) || !to) return;
    el.textContent = "0";
    var io4 = new IntersectionObserver(function (en) {
      if (!en[0].isIntersecting) return;
      io4.disconnect();
      var t0 = performance.now(), dur = 900;
      var step = function (now) {
        var k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
        el.textContent = String(Math.round(to * e));
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }, { threshold: 0.6 });
    io4.observe(el);
  });
})();
