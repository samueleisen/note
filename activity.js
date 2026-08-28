/**
 * ActivityTracker — Minimalist Top Ambient Strip Activity Tracker & Canvas Selector
 *
 * Default View: 30-day compact resting strip centered at top edge.
 * Expanded View (Tab): Spreads fully downward into a 365-day (1-year) calendar heatmap grid.
 */

window.ActivityTracker = (() => {
  'use strict';

  // -----------------------------------------------
  // Config
  // -----------------------------------------------
  const TOTAL_DAYS = 365;      // 1 Full Year
  const COLLAPSED_DAYS = 30;   // Compact resting view

  let _isExpanded = false;
  let _selectedDate = getTodayStr();
  let _onDateSelect = null;
  let _countsMap = {}; // In-memory map: { 'YYYY-MM-DD': count }

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

  function setActivityCounts(countsMap) {
    _countsMap = countsMap || {};
    _refresh();
  }

  function setDateCount(dateStr, count) {
    _countsMap[dateStr] = count;
    _refresh();
  }

  function setActiveDate(dateStr) {
    _selectedDate = dateStr || getTodayStr();
    _updateSelectedCell();
  }

  function getActiveDate() {
    return _selectedDate;
  }

  function isExpanded() {
    return _isExpanded;
  }

  function toggleExpand(forceState) {
    _isExpanded = typeof forceState === 'boolean' ? forceState : !_isExpanded;
    const railEl = document.getElementById('activity-widget');
    if (railEl) {
      railEl.classList.toggle('expanded', _isExpanded);
    }
    _renderGrid();
  }

  // -----------------------------------------------
  // Grid Data Builder
  // -----------------------------------------------
  function getLevel(count) {
    if (!count || count <= 0) return 0;
    if (count <= 3) return 1; // 1 to 3 notes
    if (count <= 6) return 2; // 4 to 6 notes
    if (count <= 9) return 3; // 7 to 9 notes
    return 4;                 // 10+ notes
  }

  function formatDateLabel(dateObj) {
    return dateObj.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  const ROWS_COUNT = 12;      // 12 rows of 30 days = 360 days (1 year)
  const COLS_COUNT = 30;      // 30 columns per row

  function buildGrid() {
    const today = new Date();
    const cells = [];

    if (!_isExpanded) {
      // Collapsed: single row of 30 days
      for (let c = 0; c < COLS_COUNT; c++) {
        const offsetFromToday = c - (COLS_COUNT - 2);
        cells.push(createCellData(today, offsetFromToday));
      }
    } else {
      // Expanded: 12 rows of 30 days (Row 0 = Recent 30 days, Row 1 = 30 days prior, ...)
      for (let r = 0; r < ROWS_COUNT; r++) {
        for (let c = 0; c < COLS_COUNT; c++) {
          const offsetFromToday = -(COLS_COUNT - 2) - (r * COLS_COUNT) + c;
          cells.push(createCellData(today, offsetFromToday));
        }
      }
    }

    const total = cells.reduce((sum, c) => sum + c.count, 0);
    return { cells, total };
  }

  function createCellData(today, offsetFromToday) {
    const d = new Date(today);
    d.setDate(today.getDate() + offsetFromToday);
    const dateStr = d.toISOString().slice(0, 10);

    let count = _countsMap[dateStr];
    if (typeof count !== 'number') {
      try {
        const raw = localStorage.getItem('customnote_workspace_' + dateStr);
        if (raw) {
          const parsed = JSON.parse(raw);
          count = Array.isArray(parsed.notes) ? parsed.notes.length : 0;
        } else {
          count = 0;
        }
      } catch {
        count = 0;
      }
      _countsMap[dateStr] = count;
    }

    const isToday = offsetFromToday === 0;
    const isTomorrow = offsetFromToday === 1;
    const isSelected = dateStr === _selectedDate;

    let label = count === 0 ? '' : `${count} note${count !== 1 ? 's' : ''}`;
    if (isToday) {
      label = label ? `${label} (Today)` : '(Today)';
    } else if (isTomorrow) {
      label = label ? `${label} (Tomorrow)` : '(Tomorrow)';
    }

    return {
      date: dateStr,
      formattedDate: formatDateLabel(d),
      count,
      level: getLevel(count),
      isToday,
      isTomorrow,
      isSelected,
      tip: label ? `${formatDateLabel(d)}  ·  ${label}` : formatDateLabel(d),
    };
  }

  // -----------------------------------------------
  // Rendering
  // -----------------------------------------------
  let _gridEl = null;

  function _renderGrid() {
    if (!_gridEl) return;

    const { cells } = buildGrid();

    _gridEl.className = _isExpanded ? 'activity-grid expanded' : 'activity-grid collapsed';
    _gridEl.innerHTML = '';

    cells.forEach((cell) => {
      const div = document.createElement('div');
      div.className = `ac-cell ac-l${cell.level}`;
      div.dataset.date = cell.date;

      if (cell.isToday) div.classList.add('ac-today');
      if (cell.isSelected) div.classList.add('ac-selected');
      if (cell.isTomorrow) div.classList.add('ac-tomorrow');

      let label = cell.count === 0 ? '' : `${cell.count} note${cell.count !== 1 ? 's' : ''}`;

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
    allCells.forEach((cell) => {
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
    _gridEl.addEventListener('click', (e) => {
      const cell = e.target.closest('.ac-cell');
      if (!cell || !cell.dataset.date) return;

      const targetDate = cell.dataset.date;
      _selectedDate = targetDate;
      _updateSelectedCell();

      if (_isExpanded) {
        toggleExpand(false); // Collapse when date chosen
      }

      if (_onDateSelect) {
        _onDateSelect(targetDate);
      }
    });

    _gridEl.addEventListener('mouseover', (e) => {
      const cell = e.target.closest('.ac-cell[data-tip]');
      if (!cell) return;
      tip.textContent = cell.dataset.tip;
      tip.classList.add('ac-tip-visible');
    });

    _gridEl.addEventListener('mouseout', (e) => {
      if (!e.target.closest('.ac-cell[data-tip]')) return;
      tip.classList.remove('ac-tip-visible');
    });

    _gridEl.addEventListener('mousemove', (e) => {
      tip.style.left = `${e.clientX}px`;
      tip.style.top = `${e.clientY}px`;
    });
  }

  return {
    logNoteCreated,
    logNoteDeleted,
    logNoteCount,
    setActivityCounts,
    setDateCount,
    setActiveDate,
    getActiveDate,
    getTodayStr,
    isExpanded,
    toggleExpand,
    mount,
    refresh: _refresh,
  };
})();
