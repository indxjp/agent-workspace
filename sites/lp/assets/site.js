/* Agent Workspace — marketing site behaviour, shared by every page in sites/lp/.
   Progressive enhancement only: every page is complete without this file. Each feature
   looks for its own markup and does nothing when the page does not carry it. */
"use strict";
/* global initCopyButtons, initFilters, initCardDeepLinks, initDemo, initConfigurator, initRuntimePicker, initField, initTrace, initStage, initScrolly, initCounter */
var root = document.documentElement;
var noReveal = root.classList.contains("no-reveal");
var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
var hasObserver = "IntersectionObserver" in window;
var $ = function (sel, ctx) {
  return (ctx || document).querySelector(sel);
};
var $$ = function (sel, ctx) {
  return [].slice.call((ctx || document).querySelectorAll(sel));
};
var bool = function (on) {
  return on ? "true" : "false";
};
var hashTarget = function () {
  return decodeURIComponent(location.hash.slice(1));
};
var checkedValue = function (box, name) {
  var el = $('input[name="' + name + '"]:checked', box);
  return el ? el.value : null;
};
var checkedValues = function (box, name) {
  return $$('input[name="' + name + '"]:checked', box).map(function (el) {
    return el.value;
  });
};
var indexOfSelected = function (tabs) {
  return Math.max(
    0,
    tabs.findIndex(function (t) {
      return t.getAttribute("aria-selected") === "true";
    }),
  );
};
var esc = function (t) {
  return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
};

var STUCK_SCROLL_PX = 8;
var DESKTOP_NAV_MIN_PX = 1081;
var ANCHOR_OFFSET_PX = 80;
var REANCHOR_RETRY_MS = 250;

/* --- sticky header state --- */
function initStickyHeader() {
  var hdr = document.getElementById("site-header");
  if (!hdr) return;
  var onScroll = function () {
    hdr.classList.toggle("is-stuck", window.scrollY > STUCK_SCROLL_PX);
  };
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
}

/* --- product menu (desktop) --- */
function initProductMenus() {
  $$(".has-menu").forEach(initProductMenu);
}

function initProductMenu(item) {
  var btn = $(".nav-btn", item);
  if (!btn) return;
  var set = function (open) {
    item.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", bool(open));
  };
  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    set(!item.classList.contains("open"));
  });
  item.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      set(false);
      btn.focus();
    }
  });
  item.addEventListener("focusout", function (e) {
    if (!item.contains(e.relatedTarget)) set(false);
  });
  document.addEventListener("click", function (e) {
    if (!item.contains(e.target)) set(false);
  });
}

/* --- mobile drawer --- */
function initDrawer() {
  var toggle = $(".nav-toggle");
  var drawer = toggle && document.getElementById(toggle.getAttribute("aria-controls"));
  if (!toggle || !drawer) return;
  var isOpen = function () {
    return toggle.getAttribute("aria-expanded") === "true";
  };
  var setDrawer = function (open) {
    toggle.setAttribute("aria-expanded", bool(open));
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    drawer.classList.toggle("open", open);
  };
  toggle.addEventListener("click", function () {
    setDrawer(!isOpen());
  });
  drawer.addEventListener("click", function (e) {
    if (e.target.closest("a")) setDrawer(false);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && isOpen()) {
      setDrawer(false);
      toggle.focus();
    }
  });
  window.addEventListener("resize", function () {
    if (window.innerWidth >= DESKTOP_NAV_MIN_PX) setDrawer(false);
  });
}

/* --- scroll reveal (CSS shows everything without .js) --- */
function initReveal() {
  var revealables = $$(".reveal");
  var show = function (el) {
    el.classList.add("in");
  };
  if (reduce || noReveal || !hasObserver) {
    revealables.forEach(show);
    return;
  }
  var io = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          show(e.target);
          io.unobserve(e.target);
        }
      });
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
  );
  revealables.forEach(function (el) {
    io.observe(el);
  });
  requestAnimationFrame(function () {
    revealables.forEach(function (el) {
      if (el.getBoundingClientRect().top < window.innerHeight) show(el);
    });
  });
}

/* --- deep links: re-anchor once webfonts and layout have settled --- */
function initDeepLinkAnchor() {
  if (!location.hash) return;
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  var reanchor = function () {
    var target = document.getElementById(hashTarget());
    if (!target) return;
    var prev = root.style.scrollBehavior;
    root.style.scrollBehavior = "auto";
    window.scrollTo(0, window.scrollY + target.getBoundingClientRect().top - ANCHOR_OFFSET_PX);
    root.style.scrollBehavior = prev;
  };
  window.addEventListener("load", function () {
    reanchor();
    setTimeout(reanchor, REANCHOR_RETRY_MS);
  });
}

/* --- tabs: any [data-tabs] container with role="tab" buttons and aria-controls panels --- */
function initTabs() {
  $$("[data-tabs]").forEach(initTabBox);
}

/* the tab a key press moves to, or null when the key does nothing */
function tabKeyTarget(key, index, count, vertical) {
  var nextKey = vertical ? "ArrowDown" : "ArrowRight",
    prevKey = vertical ? "ArrowUp" : "ArrowLeft";
  if (key === nextKey || key === "ArrowRight" || key === "ArrowDown") return (index + 1) % count;
  if (key === prevKey || key === "ArrowLeft" || key === "ArrowUp") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

function initTabBox(box) {
  var tabs = $$('[role="tab"]', box).filter(function (t) {
    return t.closest("[data-tabs]") === box;
  });
  var panels = tabs.map(function (t) {
    return document.getElementById(t.getAttribute("aria-controls"));
  });
  if (
    !tabs.length ||
    panels.some(function (p) {
      return !p;
    })
  )
    return;
  box.classList.add("js-ready");
  var vertical = box.getAttribute("data-tabs") === "vertical";
  var select = function (i, focus) {
    tabs.forEach(function (t, n) {
      var on = n === i;
      t.setAttribute("aria-selected", bool(on));
      t.tabIndex = on ? 0 : -1;
      panels[n].classList.toggle("on", on);
    });
    if (focus) tabs[i].focus();
  };
  select(indexOfSelected(tabs), false);
  /* a deep link to a panel (use-cases.html#code-contract-review) selects its tab first */
  var fromHash = function () {
    var i = panels.findIndex(function (p) {
      return "#" + p.id === decodeURIComponent(location.hash);
    });
    if (i === -1) return;
    select(i, false);
    requestAnimationFrame(function () {
      tabs[i].scrollIntoView({ block: "center" });
    });
  };
  fromHash();
  window.addEventListener("hashchange", fromHash);
  tabs.forEach(function (t, i) {
    t.addEventListener("click", function () {
      select(i, false);
    });
    t.addEventListener("keydown", function (e) {
      var n = tabKeyTarget(e.key, i, tabs.length, vertical);
      if (n !== null) {
        e.preventDefault();
        select(n, true);
      }
    });
  });
}

/* --- stack builder (home hero): every chip maps to a real setup flag of
       `npm create @indx-workspace` (packages/contracts/src/setup.ts), and the files shown are
       what packages/sdk/src/project/render.ts writes for those answers --- */
var THEMES = {
  support: {
    agent: "assistant",
    skill: "refund-policy",
    instructions: "You are a customer support assistant. Answer questions clearly and briefly, ...",
  },
  knowledge: {
    agent: "knowledge",
    skill: "cite-sources",
    instructions: "You answer questions from the knowledge you have been given. Point to where ...",
  },
  automation: {
    agent: "automation",
    skill: "",
    instructions: "You carry out routine tasks step by step. Say what you are about to do ...",
    tools: ["delivery-estimate", "orders"],
  },
  review: {
    agent: "reviewer",
    skill: "",
    instructions: "You review work for correctness and clarity. Point to each problem ...",
  },
  copilot: {
    agent: "copilot",
    skill: "",
    instructions: "You are a copilot for the people on this team. Help them draft, ...",
  },
};
/* the setup flags this builder writes: static.mjs checks each is a flag of SETUP_QUESTIONS */
var CREATE_FLAGS = {
  engine: "--engine",
  provider: "--provider",
  baseUrl: "--model-base-url",
  theme: "--theme",
  tools: "--tools",
};
var KEYS = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "azure-openai": "AZURE_OPENAI_API_KEY",
  "openai-compatible": "OPENAI_API_KEY",
};
var BASE_URLS = {
  "openai-compatible": "http://gpu-01.internal:8000/v1",
  "azure-openai": "https://acme.openai.azure.com",
};
var DEFAULT_ENGINE = "claude-agent-sdk",
  DEFAULT_PROVIDER = "anthropic",
  DEFAULT_THEME = "support";
/* engine capabilities: docs/sdk/site/resources/engines.mdx */
var NO_SKILLS = { "openai-agents": true };
var ORIGIN = "https://agents.acme.example";
var STEP3 = {
  page: "share the hosted chat page",
  widget: "put it on your site",
  react: "render it in your React app",
  api: "call it from your backend",
};
var STEP4 = {
  laptop: "production when you are ready",
  "single-vm": "your on-prem VM",
  "gcp-cloudrun": "your Google Cloud project",
  kubernetes: "your cluster",
  agentcore: "AWS",
};
var PUSH_AGENTS = "npx aw push --yes && npx aw promote --yes";

var cm = function (t) {
  return '<span class="cm">' + esc(t) + "</span>";
};
var cmd = function (t) {
  return '<span class="p">$ </span>' + esc(t);
};
var str = function (t) {
  return '<span class="str">' + esc(t) + "</span>";
};
var kw = function (t) {
  return '<span class="kw">' + t + "</span>";
};
var toolIdent = function (n) {
  return (
    n.replace(/-([a-z0-9])/g, function (_, c) {
      return c.toUpperCase();
    }) + "Tool"
  );
};

function readStackChoices(box) {
  var provider = checkedValue(box, "provider") || "";
  return {
    engine: checkedValue(box, "engine") || "",
    provider: provider,
    theme: checkedValue(box, "theme") || "",
    tools: checkedValues(box, "tools"),
    frontend: checkedValue(box, "frontend") || "",
    infra: checkedValue(box, "infra") || "",
    key: KEYS[provider],
    baseUrl: BASE_URLS[provider] || "",
  };
}

function createFlags(c) {
  var flags = ["--yes"];
  if (c.engine !== DEFAULT_ENGINE) flags.push(CREATE_FLAGS.engine + " " + c.engine);
  if (c.provider !== DEFAULT_PROVIDER) flags.push(CREATE_FLAGS.provider + " " + c.provider);
  if (c.baseUrl) flags.push(CREATE_FLAGS.baseUrl + " " + c.baseUrl);
  if (c.theme !== DEFAULT_THEME) flags.push(CREATE_FLAGS.theme + " " + c.theme);
  if (c.tools.length) flags.push(CREATE_FLAGS.tools + " " + c.tools.join(","));
  return flags;
}

var FRONTEND_LINES = {
  page: function () {
    return [cm("#   open the try URL from the ready screen")];
  },
  widget: function () {
    return [esc('<script src="' + ORIGIN + '/p/s/main/widget.js" async></script>')];
  },
  react: function () {
    return [cmd("npm install @indx-workspace/react @indx-workspace/sdk"), esc('<Chat surface="main" baseUrl="' + ORIGIN + '" />')];
  },
  api: function () {
    return [cmd("npm install @indx-workspace/sdk"), esc("await aw.runs.start(agentId, { prompt })")];
  },
};

function pushLines() {
  return [
    cm("#   push the agents with an API key from Administration → API Keys"),
    cmd("export AGENT_WORKSPACE_URL=" + ORIGIN + " AGENT_WORKSPACE_API_KEY=..."),
    cmd(PUSH_AGENTS),
  ];
}

/* step 4 of the command pane: the lines and the notes for each infrastructure choice */
var INFRA_STEPS = {
  kubernetes: function () {
    return {
      lines: [
        cm("#   in a clone of the repository"),
        cmd("helm upgrade --install agent-workspace ./infra/helm/agent-workspace -f values.yaml"),
        pushLines().join("\n"),
      ],
      notes: ["Kubernetes ships as a Helm chart today; <code>aw deploy</code> covers a VM and Cloud Run."],
    };
  },
  agentcore: function () {
    return {
      lines: [cm("#   roadmap: the aws-agentcore runtime driver is named, not implemented yet")],
      notes: ["AWS AgentCore is on the roadmap. Today, run it on a VM in your VPC or on EKS with the Helm chart."],
    };
  },
};

function deployStep(infra) {
  if (INFRA_STEPS[infra]) return INFRA_STEPS[infra]();
  var infraFlag = infra === "gcp-cloudrun" ? " --infra ./infra" : "";
  return {
    lines: [cmd("npx aw deploy production --yes" + infraFlag), pushLines().join("\n")],
    notes: infra === "laptop" ? ["Pick On-prem VM or Google Cloud Run to see the <code>production</code> environment it adds."] : [],
  };
}

function commandPane(c) {
  var lines = [
    cm("# 1 · create the project"),
    cmd("npm create @indx-workspace@latest my-agent -- " + createFlags(c).join(" \\\n    ")),
    cm("# 2 · run it: chat, admin and API on http://127.0.0.1:3000"),
    cmd("export " + c.key + "=" + (c.provider === DEFAULT_PROVIDER ? "sk-ant-..." : "...")),
    cmd("cd my-agent && npm run dev"),
    cm("# 3 · " + STEP3[c.frontend]),
  ];
  lines = lines.concat(FRONTEND_LINES[c.frontend] ? FRONTEND_LINES[c.frontend]() : []);
  lines.push(cm("# 4 · ship it to " + STEP4[c.infra]));
  var deploy = deployStep(c.infra);
  return { html: lines.concat(deploy.lines).join("\n"), notes: deploy.notes };
}

function projectYamlModels(c) {
  if (c.provider === DEFAULT_PROVIDER) return [];
  var lines = ["models:", "  default:", "    provider: " + c.provider, "    credential:", "      secret: " + c.key];
  if (c.baseUrl) lines.push("    baseUrl: " + str(c.baseUrl));
  if (c.provider === "azure-openai") lines.push("    deployment: your-deployment", "    apiVersion: your-api-version");
  return lines;
}

function projectYamlProduction(infra) {
  if (infra === "single-vm" || infra === "gcp-cloudrun")
    return ["  production:            " + cm("# you add this for `aw deploy`"), "    target: " + infra, "    url: " + str(ORIGIN)];
  if (infra === "kubernetes") return [cm("# production on Kubernetes: the Helm chart's values.yaml")];
  if (infra === "agentcore") return [cm("# production on AWS AgentCore: roadmap")];
  return [];
}

function projectYaml(c) {
  return [
    cm("# The Agent Workspace project file: what `aw dev` runs, and where."),
    cm("# No secret belongs in this file; it is meant to be committed."),
    "apiVersion: agentworkspace.dev/v2",
    "kind: Project",
    "name: my-agent",
  ]
    .concat(
      projectYamlModels(c),
      ["environments:", "  local:", "    cloud: local", "    identity:", "      bootstrapAdmin: admin@localhost.test"],
      projectYamlProduction(c.infra),
    )
    .join("\n");
}

function agentFile(c, theme) {
  var tools = c.tools
    .slice()
    .sort()
    .concat(theme.tools || []);
  var lines = [kw("import") + " { defineAgent" + (theme.skill ? ", skill" : "") + " } " + kw("from") + " " + str("'@indx-workspace/sdk/define'") + ";"];
  if (tools.length) lines.push("");
  tools.forEach(function (n) {
    lines.push(kw("import") + " " + toolIdent(n) + " " + kw("from") + " " + str("'../tools/" + n + "'") + ";");
  });
  lines.push(
    "",
    kw("export default") + " defineAgent({",
    "  name: " + str("'" + theme.agent + "'") + ",",
    "  instructions: " + str("'" + theme.instructions + "'") + ",",
    "  engine: " + str("'" + c.engine + "'") + ",",
    "  model: " + str("'default'") + ",",
  );
  if (tools.length) lines.push("  tools: [" + tools.map(toolIdent).join(", ") + "],");
  if (theme.skill) lines.push("  skills: [skill(" + str("'" + theme.skill + "'") + ")],");
  lines.push("});");
  return lines.join("\n");
}

function engineNotes(c, theme) {
  var notes = [];
  if (theme.skill && NO_SKILLS[c.engine])
    notes.push(
      "The OpenAI Agents SDK engine runs no skills: pick Review, Automation or Copilot, or a run is refused with <code>engine_capability_unsupported</code>.",
    );
  if (c.engine === "pi") notes.push("pi takes no MCP connectors: an agent assigned one is refused.");
  return notes;
}

function initStack(box) {
  var pres = {
    cmd: $("#stack-cmd", box),
    yaml: $("#stack-yaml", box),
    agent: $("#stack-agent", box),
  };
  var note = $(".stack-note", box),
    copy = $(".stack-tabs .copy", box),
    agentTab = $("[data-stack-agent-file]", box);

  var render = function () {
    var c = readStackChoices(box),
      theme = THEMES[c.theme];
    var command = commandPane(c);
    pres.cmd.innerHTML = command.html;
    pres.yaml.innerHTML = projectYaml(c);
    pres.agent.innerHTML = agentFile(c, theme);
    if (agentTab) agentTab.textContent = "agents/" + theme.agent + ".ts";
    var notes = command.notes.concat(engineNotes(c, theme));
    note.innerHTML = notes
      .map(function (n) {
        return "<p>" + n + "</p>";
      })
      .join("");
    note.hidden = notes.length === 0;
  };

  $$("[data-stack-tab]", box).forEach(function (tab) {
    tab.addEventListener("click", function () {
      var id = tab.getAttribute("data-stack-tab");
      $$("[data-stack-tab]", box).forEach(function (b) {
        b.setAttribute("aria-selected", bool(b === tab));
      });
      Object.keys(pres).forEach(function (k) {
        pres[k].hidden = k !== id;
      });
      if (copy) copy.setAttribute("data-copy", "#stack-" + id);
    });
  });
  box.addEventListener("change", render);
  render();
}

/* --- wire every feature to the markup the page carries --- */
var onEach = function (selector, init) {
  $$(selector).forEach(init);
};
var field = document.getElementById("field");

initStickyHeader();
initProductMenus();
initDrawer();
initReveal();
initDeepLinkAnchor();
initTabs();
onEach("[data-stack]", initStack);
initCopyButtons();
initFilters();
initCardDeepLinks();
onEach("[data-demo]", initDemo);
onEach("[data-configurator]", initConfigurator);
onEach("[data-runtime-picker]", initRuntimePicker);
if (field && field.getContext && !reduce) initField(field);
onEach(".trace[data-animate]", initTrace);
onEach("[data-stage]", initStage);
onEach("[data-scrolly]", initScrolly);
onEach(".count[data-to]", initCounter);
