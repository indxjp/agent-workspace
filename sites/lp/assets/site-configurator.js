/* Agent Workspace — marketing site behaviour: configurator and runtime picker.
   Classic script sharing globals with site.js (which loads last and wires every feature). */
'use strict';
/* global $, $$, bool, esc, checkedValue, checkedValues */
/* exported initConfigurator, initRuntimePicker */
var CHANGE_HIGHLIGHT_MS = 900;

/* --- configurator: options compile exactly the way the Claude engine adapter does
       (packages/engine-claude-agent-sdk: compile.ts, tools.ts) --- */
var DENY = {
  read: ['Read', 'Glob', 'Grep'],
  write: ['Write', 'Edit', 'NotebookEdit'],
  shell: ['Bash', 'BashOutput', 'KillShell'],
  net: ['WebFetch', 'WebSearch'],
};
var PERMISSIONS = ['read', 'write', 'shell', 'net'];
var MODELS = {
  claude: { id: 'claude-sonnet-4-5', provider: 'Anthropic', note: '' },
  azure: { id: 'gpt-…', provider: 'Azure OpenAI', note: 'your Azure deployment' },
  openai: { id: 'gpt-…', provider: 'OpenAI', note: '' },
};
var CONNECTORS = {
  ticketing: '{ type: "http", url: "https://tickets.acme.example/mcp" }',
  contracts: '{ type: "http", url: "https://intranet.acme.example/mcp" }',
  github: '{ type: "http", url: "https://api.githubcopilot.com/mcp/" }',
  filesystem:
    '{ type: "stdio", command: "npx", args: ["@modelcontextprotocol/server-filesystem"] }',
};
/* the server key is the connector record's key, connector-<id>; sample ids */
var CONNECTOR_KEYS = {
  contracts: 'connector-3f9a',
  ticketing: 'connector-7c21',
  github: 'connector-a14e',
  filesystem: 'connector-0b6d',
};
/* standing per docs/sdk/site/building/self-hosting.mdx "Which runtime drivers are real today" */
var RUNTIMES = {
  local: { verified: true },
  'sandbox-runtime': { verified: true },
  docker: { verified: true },
  kubernetes: { verified: 'partial' },
  'aca-sessions': { verified: false },
};

var quoted = function (s) {
  return '<span class="str">"' + esc(s) + '"</span>';
};
var quotedList = function (xs) {
  return xs.length ? '[' + xs.map(quoted).join(', ') + ']' : '[]';
};
var optKey = function (name) {
  return '  <span class="k">' + name + '</span>';
};

function connectorLines(connectors) {
  if (!connectors.length) return [optKey('mcpServers') + ': {},'];
  var servers = connectors.map(function (c) {
    return (
      '    ' +
      quoted(CONNECTOR_KEYS[c]) +
      ': ' +
      esc(CONNECTORS[c]).replace(/"([^"]*)"/g, '<span class="str">"$1"</span>') +
      ','
    );
  });
  return [optKey('mcpServers') + ': {'].concat(servers, ['  },']);
}

function optionLines(sel) {
  var denied = [];
  PERMISSIONS.forEach(function (p) {
    if (sel.perms.indexOf(p) === -1) denied = denied.concat(DENY[p]);
  });
  var approved = sel.connectors
    .slice()
    .sort()
    .map(function (c) {
      return 'mcp__' + CONNECTOR_KEYS[c] + '__*';
    });
  var m = sel.model;
  return [
    '<span class="cm">// compiled for every run of this agent — you never write this by hand</span>',
    '<span class="kw">const</span> options = {',
    optKey('model') +
      ': ' +
      quoted(m.id) +
      ',' +
      (m.note ? '  <span class="cm">// ' + esc(m.note) + '</span>' : ''),
    optKey('cwd') + ': ' + quoted('/workspace') + ',',
    optKey('tools') +
      ': { type: ' +
      quoted('preset') +
      ', preset: ' +
      quoted('claude_code') +
      ' },',
    optKey('allowedTools') + ': ' + quotedList(approved) + ',',
    optKey('disallowedTools') + ': ' + quotedList(denied) + ',',
    optKey('skills') + ': ' + quotedList(sel.skills) + ',',
  ].concat(connectorLines(sel.connectors), [
    optKey('settingSources') +
      ': [<span class="str">"project"</span>],      <span class="cm">// session project only, never host user state</span>',
    optKey('strictMcpConfig') + ': <span class="kw">true</span>,',
    optKey('env') +
      ',                     <span class="cm">// this run\'s gateway token, never a provider key</span>',
    '};',
  ]);
}

/* the capability gaps of one combination, as [headline, detail] pairs */
function capabilityGaps(sel) {
  var gaps = [],
    rt = RUNTIMES[sel.runtime];
  if (sel.modelName !== 'claude')
    gaps.push([
      'Compatibility mode on ' + sel.model.provider + '.',
      'Prompt caching is unsupported and thinking is approximated. The agent runs; behaviour may differ.',
    ]);
  if (sel.connectors.indexOf('filesystem') !== -1)
    gaps.push([
      'stdio connectors are stored but cannot run today.',
      'Use an MCP server over HTTP or SSE instead.',
    ]);
  if (sel.runtime === 'local')
    gaps.push([
      sel.perms.indexOf('shell') !== -1 ? 'Run commands with no isolation.' : 'Development only.',
      "This machine runs agents as the control plane's own process and user: no tenant isolation.",
    ]);
  if (rt.verified === false)
    gaps.push([
      'Implemented, not yet live-verified.',
      'The product shows this runtime disabled until a live isolation proof exists.',
    ]);
  if (rt.verified === 'partial')
    gaps.push([
      'Lifecycle and isolation partially verified.',
      'No live-cluster proof is published yet.',
    ]);
  return gaps;
}

function gapsHtml(gaps) {
  if (!gaps.length) return '<p class="ok-line">✓ No capability gaps for this combination.</p>';
  return gaps
    .map(function (n) {
      return (
        '<div class="notice"><span class="sym">⚠</span><span><b>' +
        esc(n[0]) +
        '</b><br>' +
        esc(n[1]) +
        '</span></div>'
      );
    })
    .join('');
}

function readConfiguratorSelection(box) {
  var modelName = checkedValue(box, 'model');
  return {
    modelName: modelName,
    model: MODELS[modelName],
    runtime: checkedValue(box, 'runtime'),
    skills: checkedValues(box, 'skill'),
    connectors: checkedValues(box, 'connector'),
    perms: checkedValues(box, 'perm'),
  };
}

function initConfigurator(box) {
  var out = $('pre', box),
    checks = $('.cfg-checks', box),
    label = $('[data-cfg-file]', box);
  if (!out) return;
  var prev = '';
  var render = function () {
    var sel = readConfiguratorSelection(box);
    var lines = optionLines(sel);
    /* highlight the lines this change produced, then let the highlight fade */
    var before = prev ? prev.split('\n') : lines;
    out.innerHTML = lines
      .map(function (l) {
        return before.indexOf(l) === -1 ? '<span class="chg">' + l + '</span>' : l;
      })
      .join('\n');
    setTimeout(function () {
      $$('.chg', out).forEach(function (c) {
        c.classList.remove('chg');
      });
    }, CHANGE_HIGHLIGHT_MS);
    prev = lines.join('\n');
    if (label) label.textContent = sel.model.provider + ' · ' + sel.runtime;
    checks.innerHTML = gapsHtml(capabilityGaps(sel));
  };
  box.addEventListener('change', render);
  render();
}

/* --- runtime picker: buttons with aria-pressed swap one detail card --- */
function initRuntimePicker(box) {
  var buttons = $$('button[aria-controls]', box);
  var cards = buttons.map(function (b) {
    return document.getElementById(b.getAttribute('aria-controls'));
  });
  if (
    cards.some(function (c) {
      return !c;
    })
  )
    return;
  var pick = function (i) {
    buttons.forEach(function (b, n) {
      b.setAttribute('aria-pressed', bool(n === i));
      cards[n].hidden = n !== i;
    });
  };
  buttons.forEach(function (b, i) {
    b.addEventListener('click', function () {
      pick(i);
    });
  });
  pick(
    Math.max(
      0,
      buttons.findIndex(function (b) {
        return b.getAttribute('aria-pressed') === 'true';
      }),
    ),
  );
}
