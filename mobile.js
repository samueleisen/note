/**
 * MobileManager — Dedicated Mobile Zen Mode & Touch Engine for CustomNote
 * 
 * Handles:
 * - Locked to Today's Canvas
 * - Top-Right Ambient Mode Dot (⚪ Read-Only / ⚫ Edit Mode)
 * - Screen-wide Double-Tap Gesture to toggle mode
 * - 1-Finger Smooth Panning (in Read Mode) & 2-Finger Pinch-to-Zoom
 * - ContentEditable locking & Mobile Note Sizing
 */

window.MobileManager = (() => {
  'use strict';

  const MOBILE_BREAKPOINT = 768;
  const DRAG_THRESHOLD = 6;
  const DOUBLE_TAP_DELAY = 320;
  const DOUBLE_TAP_MAX_DIST = 45;

  let _callbacks = {
    createNote: () => {},
    panBy: () => {},
    zoomAt: () => {},
    screenToWorld: (x, y) => ({ x, y }),
    saveState: () => {},
    clearActiveNote: () => {},
  };

  let _isEditMode = false;
  let _modeDotEl = null;
  let _viewportEl = null;

  // Touch tracking state
  const _touchState = {
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    hasMoved: false,
    isPanning: false,
    initialPinchDist: 0,
    initialScale: 1.0,
    pinchMid: { x: 0, y: 0 },
    lastCanvasTapTime: 0,
    lastCanvasTapPos: { x: 0, y: 0 },
    singleTapTimer: null,
  };

  function isMobile() {
    return window.innerWidth <= MOBILE_BREAKPOINT;
  }

  function isEditMode() {
    return _isEditMode;
  }

  // -------------------------------------------------------------
  // Mode Toggle (⚪ Read Mode <-> ⚫ Edit Mode)
  // -------------------------------------------------------------
  function toggleMode(forceMode) {
    _isEditMode = typeof forceMode === 'boolean' ? forceMode : !_isEditMode;

    if (_modeDotEl) {
      _modeDotEl.classList.toggle('edit-mode', _isEditMode);
      _modeDotEl.setAttribute(
        'title',
        _isEditMode ? 'Edit Mode (Double-tap anywhere to lock)' : 'Read Mode (Double-tap anywhere to edit)'
      );
    }

    document.body.classList.toggle('mobile-read-mode', !_isEditMode);

    // Update contenteditable for all notes on mobile
    document.querySelectorAll('.note-body').forEach((bodyEl) => {
      if (!isMobile()) {
        bodyEl.setAttribute('contenteditable', 'true');
      } else {
        bodyEl.setAttribute('contenteditable', _isEditMode ? 'true' : 'false');
      }
    });

    if (!_isEditMode) {
      _callbacks.clearActiveNote();
      document.activeElement?.blur();
    }
  }

  // -------------------------------------------------------------
  // Touch & Gesture Handling
  // -------------------------------------------------------------
  function onTouchStart(e) {
    if (!isMobile()) return;

    if (e.touches.length === 1) {
      const touch = e.touches[0];
      _touchState.startX = touch.clientX;
      _touchState.startY = touch.clientY;
      _touchState.lastX = touch.clientX;
      _touchState.lastY = touch.clientY;
      _touchState.hasMoved = false;

      const isOverHeader = Boolean(e.target.closest('.note-header'));
      const isOverNote = Boolean(e.target.closest('.note-card'));
      const isOverModalOrHud = Boolean(
        e.target.closest('.modal-card') ||
        e.target.closest('.ambient-hud') ||
        e.target.closest('#mobile-mode-dot')
      );

      // If touching note header, allow note dragging instead of canvas pan
      if (isOverModalOrHud || isOverHeader) return;

      // In Read Mode, any swipe on canvas (even starting on a note body) pans effortlessly
      if (!_isEditMode) {
        _touchState.isPanning = true;
      } else if (!isOverNote) {
        // In Edit Mode, swiping outside notes pans canvas
        _touchState.isPanning = true;
      }
    } else if (e.touches.length === 2) {
      // 2-Finger Pinch-to-Zoom
      _touchState.isPanning = false;
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      _touchState.initialPinchDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      _touchState.pinchMid = {
        x: (t1.clientX + t2.clientX) / 2,
        y: (t1.clientY + t2.clientY) / 2,
      };
    }
  }

  function onTouchMove(e) {
    if (!isMobile()) return;

    if (e.touches.length === 1 && _touchState.isPanning) {
      const touch = e.touches[0];
      const dx = touch.clientX - _touchState.lastX;
      const dy = touch.clientY - _touchState.lastY;
      const totalDist = Math.hypot(touch.clientX - _touchState.startX, touch.clientY - _touchState.startY);

      if (totalDist > DRAG_THRESHOLD) {
        _touchState.hasMoved = true;
        if (e.cancelable) e.preventDefault();
        _callbacks.panBy(dx, dy);
        _touchState.lastX = touch.clientX;
        _touchState.lastY = touch.clientY;
      }
    } else if (e.touches.length === 2 && _touchState.initialPinchDist > 0) {
      if (e.cancelable) e.preventDefault();
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const currentDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const factor = currentDist / _touchState.initialPinchDist;

      if (Math.abs(factor - 1.0) > 0.01) {
        const mid = _touchState.pinchMid;
        _callbacks.zoomAt(mid.x, mid.y, factor > 1 ? 1.04 : 0.96);
        _touchState.initialPinchDist = currentDist;
      }
    }
  }

  function onTouchEnd(e) {
    if (!isMobile()) return;

    if (_touchState.isPanning) {
      _touchState.isPanning = false;
    }

    if (e.touches.length === 0) {
      _touchState.initialPinchDist = 0;

      // Handle stationary taps (Double-tap toggle & single-tap note creation)
      if (!_touchState.hasMoved) {
        const touch = e.changedTouches[0];
        const targetEl = document.elementFromPoint(touch.clientX, touch.clientY) || e.target;
        handleTap(touch.clientX, touch.clientY, targetEl);
      }
    }
  }

  function handleTap(clientX, clientY, targetEl) {
    // If user tapped directly on the top-right mode dot
    if (targetEl && targetEl.closest('#mobile-mode-dot')) {
      toggleMode();
      return;
    }

    // Ignore taps inside existing notes, modals, or settings button
    if (
      targetEl &&
      (targetEl.closest('.note-card') ||
        targetEl.closest('.modal-card') ||
        targetEl.closest('.ambient-hud'))
    ) {
      return;
    }

    const now = Date.now();
    const timeSinceLast = now - _touchState.lastCanvasTapTime;
    const dist = Math.hypot(clientX - _touchState.lastCanvasTapPos.x, clientY - _touchState.lastCanvasTapPos.y);

    if (timeSinceLast < DOUBLE_TAP_DELAY && dist < DOUBLE_TAP_MAX_DIST) {
      // --- SCREEN-WIDE DOUBLE TAP DETECTED ---
      clearTimeout(_touchState.singleTapTimer);
      _touchState.singleTapTimer = null;
      _touchState.lastCanvasTapTime = 0;
      toggleMode();
    } else {
      // --- FIRST TAP ---
      _touchState.lastCanvasTapTime = now;
      _touchState.lastCanvasTapPos = { x: clientX, y: clientY };

      if (_isEditMode) {
        // In Edit Mode: wait slightly to ensure it's not a double-tap before creating note
        clearTimeout(_touchState.singleTapTimer);
        _touchState.singleTapTimer = setTimeout(() => {
          if (isMobile() && _isEditMode) {
            const worldPos = _callbacks.screenToWorld(clientX, clientY);
            const noteWidth = Math.min(window.innerWidth - 32, 320);
            _callbacks.createNote(Math.round(worldPos.x), Math.round(worldPos.y), { width: noteWidth });
          }
          _touchState.singleTapTimer = null;
        }, 260);
      }
    }
  }

  // -------------------------------------------------------------
  // Initialization & Mounting
  // -------------------------------------------------------------
  function init(callbacks) {
    if (callbacks && typeof callbacks === 'object') {
      Object.assign(_callbacks, callbacks);
    }

    _modeDotEl = document.getElementById('mobile-mode-dot');
    _viewportEl = document.getElementById('viewport');

    if (_viewportEl) {
      _viewportEl.addEventListener('touchstart', onTouchStart, { passive: false });
      _viewportEl.addEventListener('touchmove', onTouchMove, { passive: false });
      _viewportEl.addEventListener('touchend', onTouchEnd, { passive: false });
    }

    if (_modeDotEl) {
      _modeDotEl.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMode();
      });
    }

    // Default state on mobile
    if (isMobile()) {
      toggleMode(false); // Start in Read Mode with white dot
    }

    // Viewport resize adaptation
    window.addEventListener('resize', () => {
      if (isMobile()) {
        toggleMode(_isEditMode);
      } else {
        document.body.classList.remove('mobile-read-mode');
        document.querySelectorAll('.note-body').forEach((b) => b.setAttribute('contenteditable', 'true'));
      }
    });
  }

  return {
    init,
    isMobile,
    isEditMode,
    toggleMode,
  };
})();
