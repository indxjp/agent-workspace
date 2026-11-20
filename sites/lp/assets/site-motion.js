/* Agent Workspace — marketing site behaviour: hero dot field, trace, stage, scroll steps and counters.
   Classic script sharing globals with site.js (which loads last and wires every feature). */
'use strict';
/* global $$, hasObserver, reduce, indexOfSelected */
/* exported initField, initTrace, initStage, initScrolly, initCounter */
var TWO_PI = 6.283;

/* --- hero dot field: a slow, drifting lattice that leans toward the cursor --- */
var FIELD_MAX_DPR = 2,
  NARROW_FIELD_PX = 700,
  NARROW_GAP_PX = 34,
  WIDE_GAP_PX = 28;
var POINTER_REACH_PX = 160,
  POINTER_OFF = -9999,
  FIELD_SPEED = 0.006,
  MIN_FADE = 0.02;

function layoutDots(f) {
  var r = f.cv.getBoundingClientRect();
  f.w = r.width;
  f.h = r.height;
  f.cv.width = Math.round(f.w * f.dpr);
  f.cv.height = Math.round(f.h * f.dpr);
  f.ctx.setTransform(f.dpr, 0, 0, f.dpr, 0, 0);
  f.pts = [];
  var gap = f.w < NARROW_FIELD_PX ? NARROW_GAP_PX : WIDE_GAP_PX;
  for (var y = gap / 2; y < f.h; y += gap)
    for (var x = gap / 2; x < f.w; x += gap) f.pts.push([x, y, Math.random() * 6.28]);
}

/* only the right half and the top fade in, so the headline stays clean */
function dotFade(f, p) {
  return Math.max(0, Math.min(1, (p[0] / f.w - 0.35) * 2.2)) * Math.max(0, 1 - p[1] / f.h);
}

function drawDot(f, p, fade) {
  var wave = Math.sin(p[0] * 0.012 + f.t * 2 + p[2]) * Math.cos(p[1] * 0.014 - f.t);
  var dx = p[0] - f.mx,
    dy = p[1] - f.my,
    d = Math.sqrt(dx * dx + dy * dy);
  var near = d < POINTER_REACH_PX ? 1 - d / POINTER_REACH_PX : 0;
  var a = (0.1 + 0.35 * (wave * 0.5 + 0.5) + near * 0.6) * fade;
  f.ctx.fillStyle =
    near > 0.05 ? 'rgba(147,177,255,' + a + ')' : 'rgba(220,224,240,' + a * 0.7 + ')';
  var r = 0.7 + near * 1.4 + (wave > 0.6 ? 0.5 : 0);
  f.ctx.beginPath();
  f.ctx.arc(p[0], p[1] + wave * 2, r, 0, TWO_PI);
  f.ctx.fill();
}

function drawField(f) {
  f.t += FIELD_SPEED;
  f.ctx.clearRect(0, 0, f.w, f.h);
  f.pts.forEach(function (p) {
    var fade = dotFade(f, p);
    if (fade > MIN_FADE) drawDot(f, p, fade);
  });
  f.raf = f.onScreen
    ? requestAnimationFrame(function () {
        drawField(f);
      })
    : 0;
}

function trackPointer(f) {
  var host = f.cv.parentNode;
  host.addEventListener('pointermove', function (e) {
    var r = f.cv.getBoundingClientRect();
    f.mx = e.clientX - r.left;
    f.my = e.clientY - r.top;
  });
  host.addEventListener('pointerleave', function () {
    f.mx = f.my = POINTER_OFF;
  });
}

function initField(cv) {
  var f = {
    cv: cv,
    ctx: cv.getContext('2d'),
    dpr: Math.min(window.devicePixelRatio || 1, FIELD_MAX_DPR),
    w: 0,
    h: 0,
    pts: [],
    mx: POINTER_OFF,
    my: POINTER_OFF,
    t: 0,
    raf: 0,
    onScreen: true,
  };
  layoutDots(f);
  window.addEventListener('resize', function () {
    layoutDots(f);
  });
  trackPointer(f);
  if (hasObserver) {
    new IntersectionObserver(function (en) {
      f.onScreen = en[0].isIntersecting;
      if (f.onScreen && !f.raf)
        f.raf = requestAnimationFrame(function () {
          drawField(f);
        });
    }).observe(cv);
  }
  f.raf = requestAnimationFrame(function () {
    drawField(f);
  });
}

/* --- trace waterfall plays once it is on screen --- */
function initTrace(tr) {
  $$('.trace-rows li', tr).forEach(function (li, i) {
    li.style.setProperty('--i', String(i));
  });
  if (reduce || !hasObserver) {
    tr.classList.add('play');
    return;
  }
  var io = new IntersectionObserver(
    function (en) {
      if (en[0].isIntersecting) {
        tr.classList.add('play');
        io.disconnect();
      }
    },
    { threshold: 0.3 },
  );
  io.observe(tr);
}

/* --- stage: tab panel that advances by itself until someone touches it --- */
var STAGE_PERIOD_MS = 7000;

function initStage(st) {
  var tabs = $$('[role="tab"]', st);
  var s = { started: 0, stopped: reduce, frame: 0 };
  var current = function () {
    return indexOfSelected(tabs);
  };
  var bars = tabs.map(function (t) {
    var b = document.createElement('span');
    b.className = 'prog';
    t.appendChild(b);
    return b;
  });
  var restart = function () {
    s.started = Date.now();
  };
  var tick = function () {
    if (s.stopped) {
      bars.forEach(function (b) {
        b.style.width = '0';
      });
      return;
    }
    var k = Math.min(1, (Date.now() - s.started) / STAGE_PERIOD_MS);
    bars.forEach(function (b, i) {
      b.style.width = i === current() ? k * 100 + '%' : '0';
    });
    if (k >= 1) {
      tabs[(current() + 1) % tabs.length].click();
      s.stopped = false;
      restart();
    }
    s.frame = requestAnimationFrame(tick);
  };
  var stop = function () {
    s.stopped = true;
  };
  tabs.forEach(function (t) {
    t.addEventListener('click', function (e) {
      if (e.isTrusted) stop();
      restart();
    });
  });
  st.addEventListener('pointerenter', function () {
    if (!s.stopped) {
      s.stopped = true;
      st.dataset.paused = '1';
    }
  });
  st.addEventListener('pointerleave', function () {
    if (!st.dataset.paused) return;
    delete st.dataset.paused;
    s.stopped = false;
    restart();
    s.frame = requestAnimationFrame(tick);
  });
  st.addEventListener('focusin', stop);
  if (s.stopped || !hasObserver) return;
  new IntersectionObserver(
    function (en) {
      if (en[0].isIntersecting && !s.frame) {
        restart();
        s.frame = requestAnimationFrame(tick);
      }
    },
    { threshold: 0.35 },
  ).observe(st);
}

/* --- scroll-driven steps: the step nearest the middle of the screen lights up --- */
function initScrolly(box) {
  var steps = $$('.scrolly-steps li', box);
  var vis = $$('[data-step-vis]', box);
  var show = function (i) {
    steps.forEach(function (s, n) {
      s.classList.toggle('on', n === i);
    });
    vis.forEach(function (v, n) {
      v.classList.toggle('on', n === i);
    });
  };
  show(0);
  if (!hasObserver) return;
  var io = new IntersectionObserver(
    function (en) {
      en.forEach(function (e) {
        if (e.isIntersecting) show(steps.indexOf(e.target));
      });
    },
    { rootMargin: '-45% 0px -45% 0px' },
  );
  steps.forEach(function (s) {
    io.observe(s);
  });
}

/* --- numbers count up when they arrive --- */
var COUNT_UP_MS = 900;

function countUp(el, to) {
  var t0 = performance.now();
  var step = function (now) {
    var k = Math.min(1, (now - t0) / COUNT_UP_MS),
      eased = 1 - Math.pow(1 - k, 3);
    el.textContent = String(Math.round(to * eased));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function initCounter(el) {
  var to = parseInt(el.getAttribute('data-to'), 10);
  if (reduce || !hasObserver || !to) return;
  el.textContent = '0';
  var io = new IntersectionObserver(
    function (en) {
      if (!en[0].isIntersecting) return;
      io.disconnect();
      countUp(el, to);
    },
    { threshold: 0.6 },
  );
  io.observe(el);
}
