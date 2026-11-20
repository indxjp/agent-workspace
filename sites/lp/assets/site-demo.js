/* Agent Workspace — marketing site behaviour: hero live demo.
   Classic script sharing globals with site.js (which loads last and wires every feature). */
'use strict';
/* global $, $$, bool, hasObserver, reduce */
/* exported initDemo */
/* --- hero live demo: replays a scripted run; without JS (or with reduced motion) the
       final transcript of the first scenario is what the markup already shows --- */
var STEP_DEFAULT_MS = 600,
  STEP_LEAD_MS = 200,
  SPIN_MIN_MS = 250,
  SPIN_TAIL_MS = 150;
var TYPE_MIN_MS = 12,
  TYPE_MAX_MS = 28,
  TYPE_TOTAL_MS = 1400;
var META_DELAY_MS = 150,
  NEXT_SCENARIO_DELAY_MS = 4200,
  DEMO_VISIBLE_RATIO = 0.25;

function demoAt(d, ms, fn) {
  d.timers.push(setTimeout(fn, ms));
}

function demoClear(d) {
  d.timers.forEach(clearTimeout);
  d.timers = [];
}

function demoFillMeta(d, tpl) {
  $$('[data-meta]', d.meta).forEach(function (m) {
    m.textContent = tpl.getAttribute('data-' + m.getAttribute('data-meta')) || '';
  });
}

function demoShowMeta(d, tpl) {
  if (!d.meta) return;
  d.meta.hidden = false;
  demoFillMeta(d, tpl);
}

function demoFinishSpin(spin) {
  var tick = document.createElement('span');
  tick.className = 'tick';
  tick.textContent = '✓';
  spin.replaceWith(tick);
}

/* the settled transcript: every step shown, no animation */
function demoShowFinal(d, tpl, steps) {
  steps.forEach(function (s) {
    s.classList.add('shown');
  });
  $$('.spin', d.stage).forEach(demoFinishSpin);
  demoShowMeta(d, tpl);
  if (d.bar) d.bar.style.width = '100%';
}

/* schedules each step; returns the time the last one ends */
function demoScheduleSteps(d, steps) {
  var t = STEP_LEAD_MS;
  steps.forEach(function (s) {
    var duration = parseInt(s.getAttribute('data-step'), 10) || STEP_DEFAULT_MS;
    demoAt(d, t, function () {
      s.classList.add('shown');
      var spin = $('.spin', s);
      if (spin)
        demoAt(d, Math.max(SPIN_MIN_MS, duration - SPIN_TAIL_MS), function () {
          demoFinishSpin(spin);
        });
    });
    t += duration;
  });
  return t;
}

/* types the answer out from time `start`; returns the time it ends */
function demoScheduleTyping(d, answer, full, start) {
  var chars = full.length,
    perChar = Math.max(TYPE_MIN_MS, Math.min(TYPE_MAX_MS, TYPE_TOTAL_MS / chars));
  var typeTo = function (n) {
    demoAt(d, start + n * perChar, function () {
      answer.textContent = full.slice(0, n);
    });
  };
  for (var c = 1; c <= chars; c++) typeTo(c);
  return start + chars * perChar;
}

function demoRunProgressBar(bar, endMs) {
  bar.style.transition = 'none';
  bar.style.width = '0';
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      bar.style.transition = 'width ' + endMs / 1000 + 's linear';
      bar.style.width = '100%';
    });
  });
}

function demoPlay(d, i, animate) {
  demoClear(d);
  d.current = i;
  var tpl = d.scenarios[i];
  d.switches.forEach(function (b, n) {
    b.setAttribute('aria-pressed', bool(n === i));
  });
  if (d.runtime) d.runtime.textContent = tpl.getAttribute('data-runtime');
  if (d.title) d.title.textContent = tpl.getAttribute('data-agent');
  d.stage.innerHTML = '';
  d.stage.appendChild(tpl.content.cloneNode(true));
  var steps = $$('[data-step]', d.stage);
  var answer = $('[data-type]', d.stage);
  if (d.meta) d.meta.hidden = true;
  if (!animate) {
    demoShowFinal(d, tpl, steps);
    return;
  }
  var full = answer ? answer.textContent : '';
  if (answer) answer.textContent = '';
  var end = demoScheduleSteps(d, steps);
  if (answer) end = demoScheduleTyping(d, answer, full, end);
  demoAt(d, end + META_DELAY_MS, function () {
    demoShowMeta(d, tpl);
  });
  if (d.bar) demoRunProgressBar(d.bar, end);
  demoAt(d, end + NEXT_SCENARIO_DELAY_MS, function () {
    if (d.visible && d.cycle) demoPlay(d, (d.current + 1) % d.scenarios.length, true);
  });
}

/* plays the first scenario when the demo first scrolls into view, then resumes after leaving it */
function demoPlayWhenVisible(d, box) {
  if (!hasObserver) {
    demoPlay(d, 0, true);
    return;
  }
  var started = false;
  new IntersectionObserver(
    function (entries) {
      d.visible = entries[0].isIntersecting;
      if (d.visible && !started) {
        started = true;
        demoPlay(d, 0, true);
      } else if (d.visible && d.cycle && !d.timers.length) demoPlay(d, d.current, true);
    },
    { threshold: DEMO_VISIBLE_RATIO },
  ).observe(box);
}

function initDemo(box) {
  var d = {
    scenarios: $$('template[data-scenario]', box),
    switches: $$('.demo-switch button', box),
    stage: $('.stream', box),
    bar: $('.demo-progress i', box),
    runtime: $('[data-demo-runtime]', box),
    title: $('[data-demo-title]', box),
    meta: $('.demo-meta', box),
    timers: [],
    current: 0,
    cycle: null,
    visible: true,
  };
  if (!d.scenarios.length || !d.stage) return;
  d.switches.forEach(function (b, i) {
    b.addEventListener('click', function () {
      d.cycle = null;
      demoPlay(d, i, !reduce);
    });
  });
  if (reduce) {
    demoPlay(d, 0, false);
    return;
  }
  d.cycle = true;
  demoPlayWhenVisible(d, box);
}
