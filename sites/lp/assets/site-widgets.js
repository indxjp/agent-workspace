/* Agent Workspace — marketing site behaviour: copy buttons, filter bars and card deep links.
   Classic script sharing globals with site.js (which loads last and wires every feature). */
'use strict';
/* global $, $$, bool, hashTarget */
/* exported initCopyButtons, initFilters, initCardDeepLinks */
var COPIED_LABEL_MS = 1400;

/* --- copy buttons: <button class="copy" data-copy="#id"> copies that element's text --- */
function initCopyButtons() {
  $$('button.copy[data-copy]').forEach(function (b) {
    b.addEventListener('click', function () {
      var src = $(b.getAttribute('data-copy'));
      if (!src || !navigator.clipboard) return;
      var text = src.innerText.replace(/^\$ /gm, '');
      navigator.clipboard.writeText(text).then(
        function () {
          var was = b.textContent;
          b.textContent = document.documentElement.lang === 'ja' ? 'コピーしました' : 'Copied';
          setTimeout(function () {
            b.textContent = was;
          }, COPIED_LABEL_MS);
        },
        function () {
          /* clipboard refused: leave the label as it was */
        },
      );
    });
  });
}

/* --- filter bars: <div class="filters" data-filter-for="#grid"> with data-filter buttons --- */
var matchesFilter = function (item, key) {
  return (
    key === 'all' ||
    (' ' + item.getAttribute('data-filter-item') + ' ').indexOf(' ' + key + ' ') !== -1
  );
};

function initFilterBar(bar) {
  var grid = $(bar.getAttribute('data-filter-for'));
  if (!grid) return;
  var items = $$('[data-filter-item]', grid);
  var empty = $('.filter-empty', grid.parentNode);
  var buttons = $$('button[data-filter]', bar);
  buttons.forEach(function (b) {
    var key = b.getAttribute('data-filter');
    var badge = document.createElement('span');
    badge.className = 'count';
    badge.textContent = String(
      items.filter(function (it) {
        return matchesFilter(it, key);
      }).length,
    );
    b.appendChild(badge);
  });
  var apply = function (key) {
    var shown = 0;
    buttons.forEach(function (b) {
      b.setAttribute('aria-pressed', bool(b.getAttribute('data-filter') === key));
    });
    items.forEach(function (it) {
      var on = matchesFilter(it, key);
      it.hidden = !on;
      if (on) {
        shown++;
        it.classList.add('in');
      }
    });
    if (empty) empty.hidden = shown !== 0;
  };
  buttons.forEach(function (b) {
    b.addEventListener('click', function () {
      apply(b.getAttribute('data-filter'));
    });
  });
  var initial = (location.hash.match(/^#for-([a-z-]+)$/) || [])[1];
  if (
    initial &&
    buttons.some(function (b) {
      return b.getAttribute('data-filter') === initial;
    })
  )
    apply(initial);
}

function initFilters() {
  $$('.filters[data-filter-for]').forEach(initFilterBar);
}

/* --- deep links to a card open its details (use-cases.html#legal-contract-review) --- */
function initCardDeepLinks() {
  var openTarget = function () {
    var el = location.hash && document.getElementById(hashTarget());
    var details = el && el.querySelector('details.more-box');
    if (details) details.open = true;
  };
  openTarget();
  window.addEventListener('hashchange', openTarget);
}
