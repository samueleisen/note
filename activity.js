/**
 * ActivityTracker — Minimalist Top Ambient Strip Activity Tracker & Canvas Selector
 *
 * Configurable linear activity strip (100 days) along the top edge.
 * Each cell serves as a visual activity heatmap and date-canvas selector.
 */

window.ActivityTracker = (() => {
  'use strict';

  // -----------------------------------------------
  // Config
  // -----------------------------------------------
  const DAYS_COUNT = 100; // Easily configurable: any number of days

  let _selectedDate = getTodayStr();
  let _onDateSelect = null;

  function getTodayStr() {
    return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
  }

  // -----------------------------------------------
  // Public API (Hooks for app.js)
  // -----------------------------------------------
  function logNoteCreated() {
    _refresh();
  }

  function logNoteDeleted() {
    _refresh();
  }

  function logNoteCount() {
    _refresh();
  }

  function setActiveDate(dateStr) {
    _selectedDate = dateStr || getTodayStr();
    _updateSelectedCell();
  }

  function getActiveDate() {
    return _selectedDate;
  }

  // -----------------------------------------------
  // Grid Data Builder
  // -----------------------------------------------
  function getLevel(count) {
    if (!count) return 0;
    if (count <= 2) return 1;
    if (count <= 5) return 2;
    return 3;
  }

  function formatDateLabel(dateObj) {
    return dateObj.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  }

  function buildGrid() {
    const today = new Date();

    const cells = [];

    // Chronological order: index (DAYS_COUNT - 2) is today, (DAYS_COUNT - 1) is tomorrow
    for (let k = 0; k < DAYS_COUNT; k++) {
      const offsetFromToday = k - (DAYS_COUNT - 2);
      const d = new Date(today);
      d.setDate(today.getDate() + offsetFromToday);
      const dateStr = d.toISOString().slice(0, 10);

      // Direct count from unified date workspace
      let count = 0;
      try {
        const ws = localStorage.getItem('customnote_workspace_' + dateStr);
        if (ws) {
          const parsed = JSON.parse(ws);
          count = Array.isArray(parsed.notes) ? parsed.notes.length : 0;
        }
      } catch {
        count = 0;
      }

      const isToday = offsetFromToday === 0;
      const isTomorrow = offsetFromToday === 1;
      const isSelected = dateStr === _selectedDate;

      cells.push({
        date: dateStr,
        formattedDate: formatDateLabel(d),
        count,
        level: getLevel(count),
        isToday,
        isTomorrow,
        isSelected,
      });
    }

    const total = cells.reduce((sum, c) => sum + c.count, 0);

    return { cells, total };
  }

  // -----------------------------------------------
  // Rendering
  // -----------------------------------------------
  let _gridEl = null;

  function _renderGrid() {
    if (!_gridEl) return;

    const { cells } = buildGrid();

    _gridEl.innerHTML = '';
    cells.forEach(cell => {
      const div = document.createElement('div');
      div.className = `ac-cell ac-l${cell.level}`;
      div.dataset.date = cell.date;

      if (cell.isToday) div.classList.add('ac-today');
      if (cell.isSelected) div.classList.add('ac-selected');
      if (cell.isTomorrow) div.classList.add('ac-tomorrow');

      let label = cell.count === 0
        ? ''
        : `${cell.count} note${cell.count !== 1 ? 's' : ''}`;

      if (cell.isToday) {
        label = label ? `${label} (Today)` : '(Today)';
      } else if (cell.isTomorrow) {
        label = label ? `${label} (Tomorrow)` : '(Tomorrow)';
      }

      div.dataset.tip = label ? `${cell.formattedDate}  ·  ${label}` : cell.formattedDate;

      _gridEl.appendChild(div);
    });
  }

  function _updateSelectedCell() {
    if (!_gridEl) return;
    const allCells = _gridEl.querySelectorAll('.ac-cell');
    allCells.forEach(cell => {
      cell.classList.toggle('ac-selected', cell.dataset.date === _selectedDate);
    });
  }

  function _refresh() {
    _renderGrid();
  }

  // -----------------------------------------------
  // Mount
  // -----------------------------------------------
  function mount(onDateSelectCallback) {
    _gridEl = document.getElementById('activity-grid');
    if (!_gridEl) return;

    if (typeof onDateSelectCallback === 'function') {
      _onDateSelect = onDateSelectCallback;
    }

    _renderGrid();

    // Tooltip: reuse a single element
    let tip = document.getElementById('ac-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'ac-tip';
      document.body.appendChild(tip);
    }

    // Cell Click -> Date selection
    _gridEl.addEventListener('click', e => {
      const cell = e.target.closest('.ac-cell');
      if (!cell || !cell.dataset.date) return;

      const targetDate = cell.dataset.date;
      _selectedDate = targetDate;
      _updateSelectedCell();

      if (_onDateSelect) {
        _onDateSelect(targetDate);
      }
    });

    _gridEl.addEventListener('mouseover', e => {
      const cell = e.target.closest('.ac-cell[data-tip]');
      if (!cell) return;
      tip.textContent = cell.dataset.tip;
      tip.classList.add('ac-tip-visible');
    });

    _gridEl.addEventListener('mouseout', e => {
      if (!e.target.closest('.ac-cell[data-tip]')) return;
      tip.classList.remove('ac-tip-visible');
    });

    _gridEl.addEventListener('mousemove', e => {
      tip.style.left = `${e.clientX}px`;
      tip.style.top = `${e.clientY}px`;
    });
  }

  return {
    logNoteCreated,
    logNoteDeleted,
    logNoteCount,
    setActiveDate,
    getActiveDate,
    getTodayStr,
    mount,
    refresh: _refresh,
  };
})();
