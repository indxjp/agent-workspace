/* ============================================================
   Agent Workspace — Control Plane UI
   Shell rendering + prototype interactions.
   No build step, no network. Open any page from the filesystem.
   ============================================================ */

(function () {
  "use strict";

  /* ---------- workspace demo context ---------- */
  var WORKSPACE = { name: "Meridian Manufacturing", plan: "Self-hosted · v0.4.2" };
  var USER = { name: "Aya Ito", role: "Owner", initials: "AI" };

  /* Active runtime driver. Spec A.3: every screen must show which driver is in force. */
  var RUNTIME = { label: "Docker · Standard Sandbox", warn: false, href: "runtimes.html" };

  var ICONS = {
    home: '<path d="M3 7.5 8 3.5l5 4V13H3z"/>',
    agents: '<rect x="2.5" y="4.5" width="11" height="8" rx="2"/><path d="M8 2.5v2M5.5 8h.01M10.5 8h.01"/>',
    files: '<path d="M2.5 4.2A1.2 1.2 0 0 1 3.7 3h2.4l1.2 1.6h4.9A1.2 1.2 0 0 1 13.4 5.8v6A1.2 1.2 0 0 1 12.2 13H3.7a1.2 1.2 0 0 1-1.2-1.2z"/>',
    skills: '<path d="M8 2.2 9.7 6l4 .4-3 2.7.9 3.9L8 11l-3.6 2 .9-3.9-3-2.7 4-.4z"/>',
    connectors: '<path d="M6.2 9.8 4.6 11.4a2.3 2.3 0 0 1-3.2-3.2L3 6.6M9.8 6.2l1.6-1.6a2.3 2.3 0 0 1 3.2 3.2L13 9.4M6 10l4-4"/>',
    runs: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.2"/>',
    models: '<path d="M8 2.5 13.5 5.6v4.8L8 13.5 2.5 10.4V5.6z"/><path d="M8 8 13.5 5.6M8 8v5.5M8 8 2.5 5.6"/>',
    users: '<circle cx="6" cy="6" r="2.4"/><path d="M1.8 13c.4-2.3 2.2-3.6 4.2-3.6S9.8 10.7 10.2 13"/><path d="M10.6 4.2a2.2 2.2 0 0 1 0 4.1M11.5 13c-.1-1.2-.4-2.2-1-3"/>',
    keys: '<circle cx="5.4" cy="8" r="2.6"/><path d="M8 8h6M12 8v2.4M10.2 8v1.8"/>',
    runtimes: '<rect x="2" y="3" width="12" height="4.2" rx="1"/><rect x="2" y="8.8" width="12" height="4.2" rx="1"/><path d="M4.4 5.1h.01M4.4 10.9h.01"/>',
    chat: '<path d="M13.5 8.6c0 2.5-2.5 4.5-5.5 4.5-.7 0-1.4-.1-2-.3L2.5 13.5l.8-2.6A4.3 4.3 0 0 1 2.5 8.6C2.5 6.1 5 4.1 8 4.1s5.5 2 5.5 4.5"/>',
    projects: '<path d="M2.5 4.6A1.1 1.1 0 0 1 3.6 3.5h2.6l1.1 1.5h5.1a1.1 1.1 0 0 1 1.1 1.1v5.3a1.1 1.1 0 0 1-1.1 1.1H3.6a1.1 1.1 0 0 1-1.1-1.1z"/><path d="M2.5 7.6h11"/>',
    share: '<circle cx="12" cy="4" r="1.8"/><circle cx="4" cy="8" r="1.8"/><circle cx="12" cy="12" r="1.8"/><path d="m5.6 7.1 4.8-2.2M5.6 8.9l4.8 2.2"/>',
    settings: '<circle cx="8" cy="8" r="2.1"/><path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6"/>',
    search: '<circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3 3"/>',
    folder: '<path d="M2.5 4.2A1.2 1.2 0 0 1 3.7 3h2.4l1.2 1.6h4.9A1.2 1.2 0 0 1 13.4 5.8v6A1.2 1.2 0 0 1 12.2 13H3.7a1.2 1.2 0 0 1-1.2-1.2z"/>',
    file: '<path d="M4 2.5h4.6L12 5.9V13a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 4 13z"/><path d="M8.5 2.6v3.3H12"/>',
    plus: '<path d="M8 3.5v9M3.5 8h9"/>',
    play: '<path d="M5.5 3.6 12 8l-6.5 4.4z"/>',
    dots: '<circle cx="3.5" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="12.5" cy="8" r="1"/>',
    upload: '<path d="M8 11V3.5M5 6.3 8 3.3l3 3"/><path d="M2.8 10.5v1.8a1.2 1.2 0 0 0 1.2 1.2h8a1.2 1.2 0 0 0 1.2-1.2v-1.8"/>',
    download: '<path d="M8 3.2v7.6M5 7.8l3 3 3-3"/><path d="M2.8 12.6h10.4"/>',
    back: '<path d="M9.5 3.5 5 8l4.5 4.5"/>',
    check: '<path d="m3.5 8.4 3 3 6-6.8"/>',
    shield: '<path d="M8 2.2 13 4v4c0 3-2.1 5-5 5.8C5.1 13 3 11 3 8V4z"/>',
    lock: '<rect x="3.6" y="7" width="8.8" height="6" rx="1.4"/><path d="M5.8 7V5.4a2.2 2.2 0 0 1 4.4 0V7"/>'
  };

  function icon(name) {
    var d = ICONS[name] || "";
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" ' +
           'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + "</svg>";
  }

  var NAV = [
    { items: [
      { id: "home",       label: "New chat",   href: "home.html",       icon: "chat" },
      { id: "projects",   label: "Projects",   href: "projects.html",   icon: "projects",   count: "3" },
      { id: "agents",     label: "Agents",     href: "agents.html",     icon: "agents",     count: "6" },
      { id: "files",      label: "Files",      href: "files.html",      icon: "files" },
      { id: "skills",     label: "Skills",     href: "skills.html",     icon: "skills",     count: "4" },
      { id: "connectors", label: "Connectors", href: "connectors.html", icon: "connectors", count: "5" },
      { id: "runs",       label: "Runs",       href: "runs.html",       icon: "runs" }
    ]},
    { label: "Administration", items: [
      { id: "models",   label: "Models",       href: "models.html",   icon: "models" },
      { id: "users",    label: "Users",        href: "users.html",    icon: "users" },
      { id: "apikeys",  label: "API Keys",     href: "api-keys.html", icon: "keys" },
      { id: "runtimes", label: "Runtimes",     href: "runtimes.html", icon: "runtimes" },
      { id: "shares",   label: "Shared links", href: "shares.html",   icon: "share" },
      { id: "settings", label: "Settings",     href: "settings.html", icon: "settings" }
    ]}
  ];

  /* Recent chats live in the sidebar as navigation, not as a feature area (spec §44). */
  var RECENT = [
    { label: "Q3 contract summary",   href: "agent-run.html" },
    { label: "Handbook: parental leave", href: "agent-run.html" },
    { label: "Invoice 8842 exception", href: "agent-run.html" },
    { label: "Draft weekly report",    href: "agent-run.html" }
  ];

  function sidebar(active) {
    var h = '<aside class="sidebar">' +
      '<div class="brand"><div class="mark">M</div><div class="ws"><b>' + WORKSPACE.name +
      '</b><span>' + WORKSPACE.plan + "</span></div></div>" +
      '<nav class="nav">';
    NAV.forEach(function (group, gi) {
      h += '<div class="group"' + (gi === 0 ? ' style="margin-top:0"' : "") + ">";
      if (group.label) h += '<div class="group-label">' + group.label + "</div>";
      group.items.forEach(function (it) {
        h += '<a href="' + it.href + '"' + (it.id === active ? ' class="active"' : "") + ">" +
             icon(it.icon) + "<span>" + it.label + "</span>" +
             (it.count ? '<span class="count">' + it.count + "</span>" : "") + "</a>";
        if (it.id === "home") {
          h += '<div class="recent">';
          RECENT.forEach(function (r) {
            h += '<a href="' + r.href + '" class="recent-item">' + r.label + "</a>";
          });
          h += '<a href="runs.html" class="recent-item more">See all</a></div>';
        }
      });
      h += "</div>";
    });
    h += "</nav>" +
      '<div class="sidebar-foot"><div class="userchip"><div class="avatar">' + USER.initials +
      '</div><div class="who"><b>' + USER.name + "</b><span>" + USER.role + "</span></div></div></div>" +
      "</aside>";
    return h;
  }

  function topbar(page) {
    var crumbs = page.crumbs || [];
    var h = '<header class="topbar"><div class="crumbs">';
    crumbs.forEach(function (c, i) {
      var last = i === crumbs.length - 1;
      var label = Array.isArray(c) ? c[0] : c;
      var href = Array.isArray(c) ? c[1] : null;
      if (i > 0) h += '<span class="sep">/</span>';
      if (href && !last) h += '<a href="' + href + '">' + label + "</a>";
      else h += last ? "<b>" + label + "</b>" : "<span>" + label + "</span>";
    });
    h += '</div><div class="spacer"></div>';
    var rt = page.runtime || RUNTIME;
    if (rt) {
      h += '<a class="runtime-chip' + (rt.warn ? " warn" : "") + '" href="' + (rt.href || "runtimes.html") +
           '" title="Runtime driver in force for this workspace"><span class="dot"></span>Runtime: ' +
           rt.label + "</a>";
    }
    h += (page.topbarExtra || "") + "</header>";
    if (page.banner) {
      h += '<div class="banner"><span>⚠</span><span>' + page.banner + "</span>" +
           '<span class="spacer"></span>' +
           (page.bannerAction || "") + "</div>";
    }
    return h;
  }

  function render() {
    var page = window.PAGE || {};
    var app = document.querySelector(".app");
    if (!app) return;
    app.insertAdjacentHTML("afterbegin", sidebar(page.nav));
    var main = app.querySelector(".main");
    if (main) main.insertAdjacentHTML("afterbegin", topbar(page));
    if (page.title) document.title = page.title + " — Agent Workspace";
  }

  /* ---------- interactions ---------- */
  function toast(msg) {
    var host = document.getElementById("toasts");
    if (!host) {
      host = document.createElement("div");
      host.id = "toasts";
      document.body.appendChild(host);
    }
    var el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(function () { el.remove(); }, 2600);
  }

  document.addEventListener("click", function (e) {
    var t = e.target;

    // tabs: <button data-tab="overview"> + <section data-panel="overview">
    var tabBtn = t.closest("[data-tab]");
    if (tabBtn) {
      var scope = tabBtn.closest("[data-tabs]") || document;
      var key = tabBtn.getAttribute("data-tab");
      scope.querySelectorAll("[data-tab]").forEach(function (b) { b.classList.toggle("active", b === tabBtn); });
      document.querySelectorAll("[data-panel]").forEach(function (p) {
        p.classList.toggle("active", p.getAttribute("data-panel") === key);
      });
      if (history.replaceState) history.replaceState(null, "", "#" + key);
      e.preventDefault();
      return;
    }

    // radio-style choices
    var choice = t.closest(".choice:not(.disabled)");
    if (choice && choice.closest(".choices")) {
      choice.closest(".choices").querySelectorAll(":scope > .choice").forEach(function (c) {
        c.classList.remove("selected");
      });
      choice.classList.add("selected");
      var reveal = choice.getAttribute("data-reveal");
      if (reveal) {
        document.querySelectorAll("[data-reveal-target]").forEach(function (el) {
          el.hidden = el.getAttribute("data-reveal-target") !== reveal;
        });
      }
    }

    // checkboxes
    var check = t.closest(".check");
    if (check && !check.classList.contains("locked")) check.classList.toggle("on");

    // toggles
    var tog = t.closest(".toggle");
    if (tog) tog.classList.toggle("on");

    // modals
    var open = t.closest("[data-modal-open]");
    if (open) {
      var m = document.getElementById(open.getAttribute("data-modal-open"));
      if (m) m.hidden = false;
      e.preventDefault();
      return;
    }
    var close = t.closest("[data-modal-close]");
    if (close) {
      var sc = close.closest(".scrim");
      if (sc) sc.hidden = true;
      e.preventDefault();
      return;
    }
    if (t.classList && t.classList.contains("scrim")) t.hidden = true;

    // toast-only demo actions
    var toaster = t.closest("[data-toast]");
    if (toaster) {
      toast(toaster.getAttribute("data-toast"));
      if (toaster.tagName === "A" && (toaster.getAttribute("href") || "#") === "#") e.preventDefault();
    }
  });

  document.addEventListener("DOMContentLoaded", function () {
    render();
    // deep-link a tab: page.html#connectors
    var hash = location.hash.replace("#", "");
    if (hash) {
      var b = document.querySelector('[data-tab="' + hash + '"]');
      if (b) b.click();
    }
  });

  window.AW = { toast: toast, icon: icon };
})();
