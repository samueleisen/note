import {
  auth,
  database,
  googleProvider,
  ref,
  set,
  get,
  onValue,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from './firebase-config.js';

// --- Constants & Config ---
const STORAGE_KEY_NOTES = 'customnote_notes_v1';
const STORAGE_KEY_VIEW = 'customnote_viewport_v1';
const STORAGE_KEY_SETTINGS = 'customnote_settings_v1';
const STORAGE_KEY_DRAWINGS = 'customnote_drawings_v1';

const MIN_SCALE = 0.2;
const MAX_SCALE = 3.5;
const DRAG_THRESHOLD = 5; // Pixels to distinguish click vs drag

// --- State ---
const state = {
  currentUser: null,
  activeDate: getTodayStr(),
  panX: 0,
  panY: 0,
  scale: 1.0,
  settings: {
    showFormatBar: true,
  },
  notes: new Map(), // id -> note data object
  activeNoteId: null,
  selectedNoteId: null,
  zIndexCounter: 10,
  isPanning: false,
  panStart: { x: 0, y: 0 },
  spacePressed: false,
  activeTool: 'select', // 'select' | 'pencil' | 'line' | 'eraser'
  drawings: [], // Array of stroke objects: { id, type, d, points, x1, y1, x2, y2, color, strokeWidth }
  undoStack: [], // Array of undo actions: { type: 'add'|'erase', stroke }
  isDrawing: false,
  currentStroke: null,
};

function getTodayStr() {
  return new Date().toISOString().slice(0, 10);
}

function getCutoffDateStr() {
  const d = new Date();
  d.setDate(d.getDate() - 98); // 100-day window: (100 - 2) = 98 days ago
  return d.toISOString().slice(0, 10);
}

  function workspaceKey(dateStr) {
    return `customnote_workspace_${dateStr}`;
  }

  function hasAnyWorkspaces() {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('customnote_workspace_')) {
        return true;
      }
    }
    return false;
  }

  // --- DOM Elements ---
  const viewport = document.getElementById('viewport');
  const canvasWorld = document.getElementById('canvas-world');
  const drawingsLayer = document.getElementById('drawings-layer');
  const notesLayer = document.getElementById('notes-layer');
  const gridLayer = document.getElementById('grid-layer');
  const zoomBadge = document.getElementById('zoom-badge');
  const settingsBtn = document.getElementById('settings-btn');
  const shortcutsHelpBtn = document.getElementById('shortcuts-help-btn');
  const shortcutsModal = document.getElementById('shortcuts-modal');
  const closeModalBtn = document.getElementById('close-modal-btn');
  const settingsModal = document.getElementById('settings-modal');
  const closeSettingsBtn = document.getElementById('close-settings-btn');
  const toggleFormatBarInput = document.getElementById('toggle-format-bar');
  const floatingFormatBar = document.getElementById('floating-format-bar');
  const btnFontDec = document.getElementById('btn-font-dec');
  const btnFontInc = document.getElementById('btn-font-inc');
  const fontSizeDisplay = document.getElementById('font-size-display');
  const imageFileInput = document.getElementById('image-file-input');

  // Auth DOM Elements
  const googleLoginBtn = document.getElementById('google-login-btn');
  const googleLogoutBtn = document.getElementById('google-logout-btn');
  const authLoggedOut = document.getElementById('auth-logged-out');
  const authLoggedIn = document.getElementById('auth-logged-in');
  const userAvatar = document.getElementById('user-avatar');
  const userName = document.getElementById('user-name');
  const userEmail = document.getElementById('user-email');
  const syncStatus = document.getElementById('sync-status');

  let targetImageNoteId = null;
  let targetImageRange = null;

  let zoomBadgeTimeout = null;
  let saveDebounceTimer = null;
  let cloudSaveDebounceTimer = null;
  let isHydratingFromCloud = false;
  let _activeCloudListener = null; // Unsubscribe handle for the live onValue listener

  // ==========================================
  // Coordinate Transformations
  // ==========================================
  function screenToWorld(clientX, clientY) {
    return {
      x: (clientX - state.panX) / state.scale,
      y: (clientY - state.panY) / state.scale,
    };
  }

  function worldToScreen(worldX, worldY) {
    return {
      x: worldX * state.scale + state.panX,
      y: worldY * state.scale + state.panY,
    };
  }

  function updateTransform() {
    canvasWorld.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.scale})`;
    renderGrid();
    debounceSave();
  }

  function showZoomBadge() {
    zoomBadge.textContent = `${Math.round(state.scale * 100)}%`;
    zoomBadge.classList.add('visible');
    clearTimeout(zoomBadgeTimeout);
    zoomBadgeTimeout = setTimeout(() => {
      zoomBadge.classList.remove('visible');
    }, 1200);
  }

  function zoomAt(clientX, clientY, factor) {
    const prevScale = state.scale;
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prevScale * factor));
    if (newScale === prevScale) return;

    const worldPos = screenToWorld(clientX, clientY);
    state.scale = newScale;
    state.panX = clientX - worldPos.x * newScale;
    state.panY = clientY - worldPos.y * newScale;

    updateTransform();
    showZoomBadge();
  }

  function resetView() {
    state.scale = 1.0;
    // Center around origin or first note
    if (state.notes.size > 0) {
      const firstNote = state.notes.values().next().value;
      state.panX = window.innerWidth / 2 - (firstNote.x + (firstNote.width || 280) / 2);
      state.panY = window.innerHeight / 2 - (firstNote.y + 100);
    } else {
      state.panX = window.innerWidth / 2 - 200;
      state.panY = window.innerHeight / 2 - 150;
    }
    updateTransform();
    showZoomBadge();
  }

  // ==========================================
  // Grid Layer Rendering (GPU-Accelerated & Adaptive LOD)
  // ==========================================
  function renderGrid() {
    const baseGridSize = 28;
    let step = baseGridSize * state.scale;

    // Adaptive Level-of-Detail (LOD):
    // Prevents rendering millions of dense dots when zoomed out, maintaining 120fps/144fps smoothness
    while (step < 16) {
      step *= 2;
    }
    while (step > 64) {
      step /= 2;
    }

    const offsetX = ((state.panX % step) + step) % step;
    const offsetY = ((state.panY % step) + step) % step;

    gridLayer.style.backgroundSize = `${step}px ${step}px`;
    gridLayer.style.backgroundPosition = `${offsetX}px ${offsetY}px`;
  }

  // ==========================================
  // Note Card Lifecycle & Management
  // ==========================================
  function generateId() {
    return 'note_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
  }

  function createNote(x, y, options = {}) {
    const id = options.id || generateId();
    const isMobile = window.MobileManager?.isMobile();
    const defaultWidth = isMobile ? Math.min(window.innerWidth - 32, 320) : 300;
    const width = options.width || defaultWidth;
    const noteX = Math.round(x);
    const noteY = Math.round(y);
    const content = options.content || '';
    const zIndex = options.zIndex || ++state.zIndexCounter;

    const noteData = {
      id,
      x: noteX,
      y: noteY,
      width,
      content,
      zIndex,
    };

    state.notes.set(id, noteData);
    renderNoteElement(noteData);

    if (options.focus !== false && (!isMobile || window.MobileManager?.isEditMode())) {
      setTimeout(() => {
        focusNote(id);
      }, 10);
    }

    // Activity hook (remove if detaching ActivityTracker)
    if (options.focus !== false) window.ActivityTracker?.logNoteCreated(state.activeDate);

    debounceSave();
    return noteData;
  }

  function renderNoteElement(noteData) {
    let noteEl = document.getElementById(noteData.id);
    if (!noteEl) {
      noteEl = document.createElement('div');
      noteEl.id = noteData.id;
      noteEl.className = 'note-card';
      const isEditable = !window.MobileManager?.isMobile() || window.MobileManager?.isEditMode();
      noteEl.innerHTML = `
        <div class="note-header">
          <div class="note-drag-handle" title="Drag to move note">
            <span></span><span></span><span></span>
          </div>
          <div class="note-actions">
            <button class="note-action-btn delete-btn" title="Delete note (Del)" aria-label="Delete note">
              <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>
        <div class="note-body" contenteditable="${isEditable}" spellcheck="false" data-placeholder="Type something here...">${noteData.content}</div>
        <div class="note-resizer" title="Resize note"></div>
      `;

      notesLayer.appendChild(noteEl);
      bindNoteEvents(noteEl, noteData.id);
    }

    noteEl.style.left = `${noteData.x}px`;
    noteEl.style.top = `${noteData.y}px`;
    noteEl.style.width = `${noteData.width}px`;
    noteEl.style.zIndex = noteData.zIndex;
  }

  function focusNote(id) {
    const noteEl = document.getElementById(id);
    if (!noteEl) return;

    // Bring note to top
    const noteData = state.notes.get(id);
    if (noteData) {
      noteData.zIndex = ++state.zIndexCounter;
      noteEl.style.zIndex = noteData.zIndex;
    }

    // Set active
    setActiveNote(id);

    const bodyEl = noteEl.querySelector('.note-body');
    bodyEl.focus();

    // Place caret at end
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(bodyEl);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function setActiveNote(id) {
    state.activeNoteId = id;
    state.selectedNoteId = id;
    document.querySelectorAll('.note-card').forEach((el) => {
      if (el.id === id) {
        el.classList.add('focused');
      } else {
        el.classList.remove('focused', 'selected');
      }
    });
  }

  function clearActiveNote() {
    state.activeNoteId = null;
    state.selectedNoteId = null;
    document.querySelectorAll('.note-card').forEach((el) => {
      el.classList.remove('focused', 'selected');
    });
    hideFloatingFormatBar();
  }

  function deleteNote(id, isUndoable = true) {
    const noteData = state.notes.get(id);
    if (noteData && isUndoable) {
      const noteEl = document.getElementById(id);
      if (noteEl) {
        const bodyEl = noteEl.querySelector('.note-body');
        if (bodyEl) noteData.content = bodyEl.innerHTML;
      }
      state.undoStack.push({ type: 'delete_note', note: { ...noteData } });
    }

    const noteEl = document.getElementById(id);
    if (noteEl) {
      noteEl.remove();
    }
    state.notes.delete(id);
    if (state.activeNoteId === id) state.activeNoteId = null;
    if (state.selectedNoteId === id) state.selectedNoteId = null;
    hideFloatingFormatBar();
    // Activity hook (remove if detaching ActivityTracker)
    window.ActivityTracker?.logNoteDeleted(state.activeDate);
    debounceSave();
  }

  // ==========================================
  // Note Event Binding (Drag, Resize, Edit, Markdown)
  // ==========================================
  function bindNoteEvents(noteEl, id) {
    const headerEl = noteEl.querySelector('.note-header');
    const deleteBtn = noteEl.querySelector('.delete-btn');
    const bodyEl = noteEl.querySelector('.note-body');
    const resizerEl = noteEl.querySelector('.note-resizer');

    // Delete Button
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteNote(id);
    });

    // Focus & Selection
    noteEl.addEventListener('mousedown', (e) => {
      if (window.MobileManager?.isMobile() && !window.MobileManager?.isEditMode()) {
        return; // Allow selecting text in read-only mode without active focus ring
      }
      e.stopPropagation();
      const noteData = state.notes.get(id);
      if (noteData) {
        noteData.zIndex = ++state.zIndexCounter;
        noteEl.style.zIndex = noteData.zIndex;
      }
      setActiveNote(id);
    });

    // --- Drag Note (Mouse + Touch Support) ---
    function startDraggingNote(clientX, clientY) {
      const noteData = state.notes.get(id);
      if (!noteData) return;

      const startMouseX = clientX;
      const startMouseY = clientY;
      const startX = noteData.x;
      const startY = noteData.y;

      document.body.style.cursor = 'grabbing';

      function onMove(currentX, currentY) {
        const dx = (currentX - startMouseX) / state.scale;
        const dy = (currentY - startMouseY) / state.scale;

        noteData.x = Math.round(startX + dx);
        noteData.y = Math.round(startY + dy);
        noteEl.style.left = `${noteData.x}px`;
        noteEl.style.top = `${noteData.y}px`;
      }

      function onMouseMove(moveEvent) {
        onMove(moveEvent.clientX, moveEvent.clientY);
      }

      function onTouchMove(moveEvent) {
        if (moveEvent.touches && moveEvent.touches[0]) {
          if (moveEvent.cancelable) moveEvent.preventDefault();
          onMove(moveEvent.touches[0].clientX, moveEvent.touches[0].clientY);
        }
      }

      function onEnd() {
        document.body.style.cursor = '';
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onEnd);
        window.removeEventListener('touchmove', onTouchMove);
        window.removeEventListener('touchend', onEnd);
        debounceSave();
      }

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onEnd);
      window.addEventListener('touchmove', onTouchMove, { passive: false });
      window.addEventListener('touchend', onEnd);
    }

    headerEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('.note-actions')) return;
      e.preventDefault();
      e.stopPropagation();
      startDraggingNote(e.clientX, e.clientY);
    });

    headerEl.addEventListener('touchstart', (e) => {
      if (e.target.closest('.note-actions')) return;
      if (e.touches && e.touches.length === 1) {
        e.stopPropagation();
        const touch = e.touches[0];
        startDraggingNote(touch.clientX, touch.clientY);
      }
    }, { passive: false });

    // --- Resize Note ---
    resizerEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      const noteData = state.notes.get(id);
      if (!noteData) return;

      const startMouseX = e.clientX;
      const startWidth = noteEl.offsetWidth;

      function onResizeMove(moveEvent) {
        const dx = (moveEvent.clientX - startMouseX) / state.scale;
        const newWidth = Math.max(160, Math.round(startWidth + dx));
        noteData.width = newWidth;
        noteEl.style.width = `${newWidth}px`;
      }

      function onResizeUp() {
        window.removeEventListener('mousemove', onResizeMove);
        window.removeEventListener('mouseup', onResizeUp);
        debounceSave();
      }

      window.addEventListener('mousemove', onResizeMove);
      window.addEventListener('mouseup', onResizeUp);
    });

    // --- Content Changes & Input ---
    bodyEl.addEventListener('input', () => {
      checkSlashCommands(bodyEl, id);
      const noteData = state.notes.get(id);
      if (noteData) {
        noteData.content = bodyEl.innerHTML;
        debounceSave();
      }
    });

    bodyEl.addEventListener('keyup', () => {
      checkSlashCommands(bodyEl, id);
    });

    // Checkbox toggling inside note body
    bodyEl.addEventListener('click', (e) => {
      const checkbox = e.target.closest('.todo-checkbox');
      if (checkbox) {
        e.stopPropagation();
        const row = checkbox.closest('.todo-row');
        if (row) {
          if (checkbox.checked) {
            row.classList.add('completed');
            checkbox.setAttribute('checked', 'checked');
          } else {
            row.classList.remove('completed');
            checkbox.removeAttribute('checked');
          }
          const noteData = state.notes.get(id);
          if (noteData) {
            noteData.content = bodyEl.innerHTML;
            debounceSave();
          }
        }
      }
    });

    // Blur empty cleanup
    bodyEl.addEventListener('blur', (e) => {
      setTimeout(() => {
        // If focus moved to format bar or another element in the same note, don't delete
        if (noteEl.contains(document.activeElement)) return;

        const text = bodyEl.innerText.trim();
        const hasCheckbox = bodyEl.querySelector('.todo-checkbox');
        const hasMedia = bodyEl.querySelector('img, pre, table');
        if (!text && !hasCheckbox && !hasMedia && state.notes.get(id)) {
          // If note is completely empty and unfocused, clean it up cleanly
          deleteNote(id);
        }
      }, 250);
    });
  }

  // ==========================================
  // Slash Commands (\img, \check)
  // ==========================================
  function checkSlashCommands(bodyEl, id) {
    const selection = window.getSelection();
    if (!selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return;

    const text = node.textContent;
    const offset = range.startOffset;
    const textBefore = text.substring(0, offset);

    // 1. \img command -> Direct image file picker
    if (textBefore.endsWith('\\img') || textBefore.endsWith('\\img ')) {
      const isSpace = textBefore.endsWith('\\img ');
      const removeLen = isSpace ? 5 : 4;
      const newText = textBefore.substring(0, offset - removeLen) + text.substring(offset);
      node.textContent = newText;

      targetImageNoteId = id;
      const newRange = document.createRange();
      const newOffset = Math.max(0, offset - removeLen);
      newRange.setStart(node, Math.min(newOffset, node.textContent.length));
      newRange.collapse(true);
      targetImageRange = newRange;

      const noteData = state.notes.get(id);
      if (noteData) {
        noteData.content = bodyEl.innerHTML;
        debounceSave();
      }

      // Immediately launch native file picker
      if (imageFileInput) {
        imageFileInput.click();
      }
    }
    // 2. \check command -> Insert interactive checkbox / checkmark item
    else if (textBefore.endsWith('\\check') || textBefore.endsWith('\\check ')) {
      const isSpace = textBefore.endsWith('\\check ');
      const removeLen = isSpace ? 7 : 6;
      const newText = textBefore.substring(0, offset - removeLen) + text.substring(offset);
      node.textContent = newText;

      // Position caret right at the deletion point
      const newRange = document.createRange();
      const newOffset = Math.max(0, offset - removeLen);
      newRange.setStart(node, Math.min(newOffset, node.textContent.length));
      newRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(newRange);

      insertTodoItemAtSelection();

      const noteData = state.notes.get(id);
      if (noteData) {
        noteData.content = bodyEl.innerHTML;
        debounceSave();
      }
    }
  }

  async function processAndInsertImage(file, noteId) {
    if (!file || !file.type.startsWith('image/')) return;

    const targetId = noteId || targetImageNoteId || state.activeNoteId;
    if (!targetId) return;

    const noteEl = document.getElementById(targetId);
    if (!noteEl) return;

    const bodyEl = noteEl.querySelector('.note-body');
    bodyEl.focus();

    // 1. Create immediate local object URL for instant thumbnail preview
    const previewUrl = URL.createObjectURL(file);

    const imgEl = document.createElement('img');
    imgEl.src = previewUrl;
    imgEl.alt = 'Note Image';
    imgEl.className = 'note-img uploading';

    // Insert at caret if saved range exists, or append to note
    if (targetImageRange && bodyEl.contains(targetImageRange.commonAncestorContainer)) {
      targetImageRange.insertNode(imgEl);
      const p = document.createElement('p');
      p.innerHTML = '<br>';
      imgEl.after(p);
      targetImageRange = null;
    } else {
      bodyEl.appendChild(imgEl);
      const p = document.createElement('p');
      p.innerHTML = '<br>';
      bodyEl.appendChild(p);
    }

    // 2. Upload to Cloudinary in background
    try {
      if (typeof uploadToCloudinary === 'function') {
        const uploadResult = await uploadToCloudinary(file);
        if (uploadResult && uploadResult.url) {
          imgEl.src = uploadResult.url;
          imgEl.classList.remove('uploading');
          URL.revokeObjectURL(previewUrl);

          const noteData = state.notes.get(targetId);
          if (noteData) {
            noteData.content = bodyEl.innerHTML;
            debounceSave();
          }
          return;
        }
      }
      throw new Error('Cloudinary upload function not available');
    } catch (err) {
      console.warn('Cloudinary upload failed, falling back to local compressed image:', err);
      compressAndFallbackImage(file, imgEl, previewUrl, targetId, bodyEl);
    }
  }

  function compressAndFallbackImage(file, imgEl, previewUrl, targetId, bodyEl) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const rawDataUrl = e.target.result;
      const img = new Image();
      img.onload = () => {
        const maxDim = 2048;
        let width = img.width;
        let height = img.height;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        const finalDataUrl = (file.type === 'image/gif')
          ? rawDataUrl
          : (file.type === 'image/png' ? canvas.toDataURL('image/png') : canvas.toDataURL('image/webp', 0.85));

        imgEl.src = finalDataUrl;
        imgEl.classList.remove('uploading');
        URL.revokeObjectURL(previewUrl);

        const noteData = state.notes.get(targetId);
        if (noteData) {
          noteData.content = bodyEl.innerHTML;
          debounceSave();
        }
      };
      img.src = rawDataUrl;
    };
    reader.readAsDataURL(file);
  }

  function insertTodoItemAtSelection() {
    const todoHtml = `<div class="todo-row"><input type="checkbox" class="todo-checkbox"><span class="todo-text"></span></div>`;
    document.execCommand('insertHTML', false, todoHtml);

    // Focus inside newly inserted todo-text span
    const selection = window.getSelection();
    if (selection.rangeCount > 0) {
      const parent = selection.anchorNode.parentElement;
      const todoText = parent.querySelector('.todo-text') || (parent.classList.contains('todo-text') ? parent : null);
      if (todoText) {
        const range = document.createRange();
        range.selectNodeContents(todoText);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  }

  // ==========================================
  // Reversible Block Formatting (Quotes, Headings, Lists)
  // ==========================================
  function toggleBlockFormat(targetTag) {
    targetTag = targetTag.toLowerCase();
    const selection = window.getSelection();
    if (!selection.rangeCount) return;

    const range = selection.getRangeAt(0);
    let container = range.commonAncestorContainer;
    if (container.nodeType === Node.TEXT_NODE) {
      container = container.parentElement;
    }

    const noteBody = container.closest('.note-body');
    if (!noteBody) return;

    const existingBlock = container.closest(targetTag);

    if (existingBlock && noteBody.contains(existingBlock)) {
      // Already inside this block -> Reverse / Toggle OFF to normal paragraph
      const p = document.createElement('p');
      while (existingBlock.firstChild) {
        p.appendChild(existingBlock.firstChild);
      }
      if (!p.hasChildNodes()) {
        p.innerHTML = '<br>';
      }
      existingBlock.replaceWith(p);

      // Re-select contents of newly converted paragraph
      const newRange = document.createRange();
      newRange.selectNodeContents(p);
      selection.removeAllRanges();
      selection.addRange(newRange);
    } else {
      // Not inside this block -> Toggle ON
      document.execCommand('formatBlock', false, targetTag);
    }
  }

  // ==========================================
  // Floating Format Bar
  // ==========================================
  function updateFloatingFormatBar() {
    // Check if floating format bar is disabled in settings
    if (!state.settings.showFormatBar) {
      hideFloatingFormatBar();
      return;
    }

    const selection = window.getSelection();
    if (!selection.rangeCount || selection.isCollapsed) {
      hideFloatingFormatBar();
      return;
    }

    const selectedText = selection.toString().trim();
    if (!selectedText) {
      hideFloatingFormatBar();
      return;
    }

    // Check if selection is within a note-body
    const range = selection.getRangeAt(0);
    let container = range.commonAncestorContainer;
    if (container.nodeType === Node.TEXT_NODE) {
      container = container.parentElement;
    }
    const noteBody = container.closest('.note-body');

    if (!noteBody) {
      hideFloatingFormatBar();
      return;
    }

    // Update active highlight states on buttons
    floatingFormatBar.querySelectorAll('button').forEach((btn) => {
      const cmd = btn.dataset.cmd;
      const val = btn.dataset.val;
      let isActive = false;
      if (cmd === 'formatBlock' && val) {
        isActive = !!container.closest(val);
      } else if (cmd === 'bold') {
        isActive = document.queryCommandState('bold');
      } else if (cmd === 'italic') {
        isActive = document.queryCommandState('italic');
      } else if (cmd === 'underline') {
        isActive = document.queryCommandState('underline');
      } else if (cmd === 'insertUnorderedList') {
        isActive = document.queryCommandState('insertUnorderedList') || !!container.closest('ul');
      }
      btn.classList.toggle('active', isActive);
    });

    if (fontSizeDisplay) {
      fontSizeDisplay.textContent = getSelectedFontSize();
    }

    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      hideFloatingFormatBar();
      return;
    }

    floatingFormatBar.style.left = `${rect.left + rect.width / 2}px`;
    floatingFormatBar.style.top = `${rect.top}px`;
    floatingFormatBar.classList.remove('hidden');
  }

  function hideFloatingFormatBar() {
    floatingFormatBar.classList.add('hidden');
  }

  function getSelectedFontSize() {
    const selection = window.getSelection();
    if (!selection.rangeCount || selection.isCollapsed) return 15;
    const range = selection.getRangeAt(0);
    let node = range.startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    if (!node) return 15;
    const computed = window.getComputedStyle(node).fontSize;
    return parseInt(computed, 10) || 15;
  }

  function changeFontSize(delta) {
    const selection = window.getSelection();
    if (!selection.rangeCount || selection.isCollapsed) return;

    const currentSize = getSelectedFontSize();
    const newSize = Math.max(10, Math.min(72, currentSize + delta));

    const range = selection.getRangeAt(0);
    let container = range.commonAncestorContainer;
    if (container.nodeType === Node.TEXT_NODE) container = container.parentElement;

    if (container && container.tagName === 'SPAN' && container.classList.contains('custom-font-size') && range.toString() === container.textContent) {
      container.style.fontSize = `${newSize}px`;
    } else {
      const span = document.createElement('span');
      span.className = 'custom-font-size';
      span.style.fontSize = `${newSize}px`;
      try {
        const fragment = range.extractContents();
        span.appendChild(fragment);
        range.insertNode(span);
      } catch (err) {
        console.warn('Fallback font size application', err);
      }
      const newRange = document.createRange();
      newRange.selectNodeContents(span);
      selection.removeAllRanges();
      selection.addRange(newRange);
    }

    if (fontSizeDisplay) fontSizeDisplay.textContent = newSize;

    if (state.activeNoteId) {
      const noteEl = document.getElementById(state.activeNoteId);
      if (noteEl) {
        const noteData = state.notes.get(state.activeNoteId);
        if (noteData) {
          noteData.content = noteEl.querySelector('.note-body').innerHTML;
          debounceSave();
        }
      }
    }
  }

  // Handle format bar buttons
  floatingFormatBar.addEventListener('mousedown', (e) => {
    e.preventDefault(); // Prevent losing text selection
    const btn = e.target.closest('button');
    if (!btn) return;

    if (btn.id === 'btn-font-dec') {
      changeFontSize(-2);
      return;
    }
    if (btn.id === 'btn-font-inc') {
      changeFontSize(2);
      return;
    }

    const cmd = btn.dataset.cmd;
    const val = btn.dataset.val || null;
    if (cmd === 'formatBlock' && val) {
      toggleBlockFormat(val);
    } else if (cmd) {
      document.execCommand(cmd, false, val);
    }

    if (state.activeNoteId) {
      const noteEl = document.getElementById(state.activeNoteId);
      if (noteEl) {
        const noteData = state.notes.get(state.activeNoteId);
        if (noteData) {
          noteData.content = noteEl.querySelector('.note-body').innerHTML;
          debounceSave();
        }
      }
    }
    updateFloatingFormatBar();
  });

  document.addEventListener('selectionchange', () => {
    updateFloatingFormatBar();
  });

  // ==========================================
  // Vector Drawing Engine (Pencil, Line, Eraser)
  // ==========================================
  function setTool(toolName) {
    state.activeTool = toolName;

    // Update viewport class for cursor styling
    viewport.classList.remove('tool-pencil', 'tool-line', 'tool-eraser');
    if (toolName !== 'select') {
      viewport.classList.add(`tool-${toolName}`);
    }

    // Update tool dock buttons
    document.querySelectorAll('.tool-btn[data-tool]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tool === toolName);
    });
  }

  function pointsToSvgPath(points) {
    if (!points || points.length === 0) return '';
    if (points.length === 1) return `M ${points[0].x} ${points[0].y} L ${points[0].x + 0.1} ${points[0].y + 0.1}`;
    
    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length - 1; i++) {
      const xc = Math.round((points[i].x + points[i + 1].x) / 2);
      const yc = Math.round((points[i].y + points[i + 1].y) / 2);
      d += ` Q ${points[i].x} ${points[i].y}, ${xc} ${yc}`;
    }
    const last = points[points.length - 1];
    d += ` L ${last.x} ${last.y}`;
    return d;
  }

  function renderStrokeElement(stroke) {
    if (!drawingsLayer) return null;
    let el = document.getElementById(stroke.id);
    if (!el) {
      if (stroke.type === 'line') {
        el = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      } else {
        el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      }
      el.id = stroke.id;
      el.classList.add('drawing-stroke');
      drawingsLayer.appendChild(el);

      el.addEventListener('mousedown', (e) => {
        if (state.activeTool === 'eraser') {
          e.stopPropagation();
          eraseStroke(stroke.id);
        }
      });
      el.addEventListener('mouseenter', () => {
        if (state.activeTool === 'eraser' && isPointerDownOnCanvas) {
          eraseStroke(stroke.id);
        }
      });
    }

    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', stroke.color || 'rgba(241, 245, 249, 0.85)');
    el.setAttribute('stroke-width', stroke.strokeWidth || '2.5');
    el.setAttribute('stroke-linecap', 'round');
    el.setAttribute('stroke-linejoin', 'round');

    if (stroke.type === 'line') {
      el.setAttribute('x1', stroke.x1);
      el.setAttribute('y1', stroke.y1);
      el.setAttribute('x2', stroke.x2);
      el.setAttribute('y2', stroke.y2);
    } else {
      el.setAttribute('d', stroke.d);
    }
    return el;
  }

  function renderAllDrawings() {
    if (!drawingsLayer) return;
    drawingsLayer.innerHTML = '';
    state.drawings.forEach((stroke) => renderStrokeElement(stroke));
  }

  function eraseStroke(id) {
    const index = state.drawings.findIndex((s) => s.id === id);
    if (index !== -1) {
      const removed = state.drawings.splice(index, 1)[0];
      const el = document.getElementById(id);
      if (el) el.remove();
      state.undoStack.push({ type: 'erase', stroke: removed });
      debounceSave();
    }
  }

  function undoLastAction() {
    if (!state.undoStack.length) {
      if (state.drawings.length) {
        const removed = state.drawings.pop();
        const el = document.getElementById(removed.id);
        if (el) el.remove();
        debounceSave();
      }
      return;
    }
    const action = state.undoStack.pop();
    if (action.type === 'add') {
      const index = state.drawings.findIndex((s) => s.id === action.stroke.id);
      if (index !== -1) {
        state.drawings.splice(index, 1);
        const el = document.getElementById(action.stroke.id);
        if (el) el.remove();
      }
    } else if (action.type === 'erase') {
      state.drawings.push(action.stroke);
      renderStrokeElement(action.stroke);
    } else if (action.type === 'delete_note') {
      const noteData = action.note;
      state.notes.set(noteData.id, noteData);
      renderNoteElement(noteData);
      window.ActivityTracker?.logNoteCreated(state.activeDate);
      setTimeout(() => focusNote(noteData.id), 10);
    }
    debounceSave();
  }

  // ==========================================
  // Viewport & Canvas Interactions (Pan, Zoom & Draw)
  // ==========================================
  let isPointerDownOnCanvas = false;
  let pointerDownPos = { x: 0, y: 0 };
  let lastMousePos = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

  viewport.addEventListener('mousedown', (e) => {
    // Check if clicked directly on viewport or canvas background or drawings layer
    if (
      e.target !== viewport &&
      e.target !== gridLayer &&
      e.target !== canvasWorld &&
      e.target !== notesLayer &&
      e.target !== drawingsLayer &&
      !e.target.classList.contains('drawing-stroke')
    ) {
      return;
    }

    // In Pencil mode: start drawing path
    if (state.activeTool === 'pencil' && e.button === 0) {
      isPointerDownOnCanvas = true;
      state.isDrawing = true;
      const worldPos = screenToWorld(e.clientX, e.clientY);
      const strokeId = 'stroke_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
      const initPt = { x: Math.round(worldPos.x), y: Math.round(worldPos.y) };
      state.currentStroke = {
        id: strokeId,
        type: 'path',
        points: [initPt],
        d: pointsToSvgPath([initPt]),
        color: 'rgba(241, 245, 249, 0.85)',
        strokeWidth: 2.5,
      };
      renderStrokeElement(state.currentStroke);
      return;
    }

    // In Line mode: start straight line
    if (state.activeTool === 'line' && e.button === 0) {
      isPointerDownOnCanvas = true;
      state.isDrawing = true;
      const worldPos = screenToWorld(e.clientX, e.clientY);
      const strokeId = 'stroke_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
      const wx = Math.round(worldPos.x);
      const wy = Math.round(worldPos.y);
      state.currentStroke = {
        id: strokeId,
        type: 'line',
        x1: wx,
        y1: wy,
        x2: wx,
        y2: wy,
        color: 'rgba(241, 245, 249, 0.85)',
        strokeWidth: 2.5,
      };
      renderStrokeElement(state.currentStroke);
      return;
    }

    // In Eraser mode:
    if (state.activeTool === 'eraser' && e.button === 0) {
      isPointerDownOnCanvas = true;
      if (e.target.classList.contains('drawing-stroke')) {
        eraseStroke(e.target.id);
      }
      return;
    }

    // Default Select / Pan mode
    if (e.button === 0) {
      isPointerDownOnCanvas = true;
      pointerDownPos = { x: e.clientX, y: e.clientY };
      clearActiveNote();
    }
  });

  window.addEventListener('mousemove', (e) => {
    lastMousePos.x = e.clientX;
    lastMousePos.y = e.clientY;

    if (state.isDrawing && state.currentStroke) {
      const worldPos = screenToWorld(e.clientX, e.clientY);
      if (state.currentStroke.type === 'path') {
        state.currentStroke.points.push({ x: Math.round(worldPos.x), y: Math.round(worldPos.y) });
        state.currentStroke.d = pointsToSvgPath(state.currentStroke.points);
        renderStrokeElement(state.currentStroke);
      } else if (state.currentStroke.type === 'line') {
        state.currentStroke.x2 = Math.round(worldPos.x);
        state.currentStroke.y2 = Math.round(worldPos.y);
        renderStrokeElement(state.currentStroke);
      }
      return;
    }

    if (state.activeTool === 'eraser' && isPointerDownOnCanvas) {
      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (target && target.classList.contains('drawing-stroke')) {
        eraseStroke(target.id);
      }
      return;
    }

    if (state.isPanning) {
      e.preventDefault();
      const dx = e.clientX - state.panStart.x;
      const dy = e.clientY - state.panStart.y;
      state.panX += dx;
      state.panY += dy;
      state.panStart = { x: e.clientX, y: e.clientY };
      updateTransform();
      return;
    }

    if (isPointerDownOnCanvas && state.activeTool === 'select') {
      const dist = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
      if (dist > DRAG_THRESHOLD) {
        // Turn into pan seamlessly
        startPanning(e.clientX, e.clientY);
      }
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (state.isDrawing && state.currentStroke) {
      state.drawings.push(state.currentStroke);
      state.undoStack.push({ type: 'add', stroke: state.currentStroke });
      state.isDrawing = false;
      state.currentStroke = null;
      debounceSave();
    }

    if (state.isPanning) {
      stopPanning();
    }
    if (isPointerDownOnCanvas) {
      isPointerDownOnCanvas = false;
    }
  });

  function startPanning(clientX, clientY) {
    state.isPanning = true;
    state.panStart = { x: clientX, y: clientY };
    viewport.classList.add('panning');
  }

  function stopPanning() {
    state.isPanning = false;
    viewport.classList.remove('panning');
    debounceSave();
  }

  // Wheel Zoom & Pan
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();

    // Zooming if Ctrl key is pressed or trackpad pinch
    if (e.ctrlKey || e.metaKey) {
      const zoomFactor = e.deltaY < 0 ? 1.08 : 0.92;
      zoomAt(e.clientX, e.clientY, zoomFactor);
    } else {
      // Pan canvas with 2-finger trackpad or wheel
      if (e.shiftKey) {
        state.panX -= e.deltaY;
      } else {
        state.panX -= e.deltaX;
        state.panY -= e.deltaY;
      }
      updateTransform();
    }
  }, { passive: false });

  // Keyboard Navigation & Shortcuts
  window.addEventListener('keydown', (e) => {
    // Tool hotkeys: P (pencil), L (line), E (eraser), V (select)
    if (!isEditingText(e) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        setTool('pencil');
        return;
      }
      if (e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        setTool('line');
        return;
      }
      if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        setTool('eraser');
        return;
      }
      if (e.key === 'v' || e.key === 'V') {
        e.preventDefault();
        setTool('select');
        return;
      }
      // Jump to today's active canvas: T
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        switchToDate(getTodayStr());
        return;
      }
    }

    // Ctrl + Z: Undo last stroke (when not typing in an editable field)
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !isEditingText(e)) {
      e.preventDefault();
      undoLastAction();
      return;
    }

    // Spacebar to create note at current cursor placement (when not typing in an editable field)
    if (e.code === 'Space' && !isEditingText(e)) {
      e.preventDefault();
      const worldPos = screenToWorld(lastMousePos.x, lastMousePos.y);
      createNote(Math.round(worldPos.x), Math.round(worldPos.y));
      return;
    }

    // Escape: exit drawing tool or deselect note or close modals
    if (e.key === 'Escape') {
      if (state.activeTool !== 'select') {
        setTool('select');
        return;
      }
      if (!settingsModal.classList.contains('hidden')) {
        toggleSettingsModal(false);
      } else if (!shortcutsModal.classList.contains('hidden')) {
        toggleShortcutsModal(false);
      } else if (state.activeNoteId) {
        document.activeElement?.blur();
        const noteEl = document.getElementById(state.activeNoteId);
        if (noteEl) {
          noteEl.classList.remove('focused');
          noteEl.classList.add('selected');
        }
      }
    }

    // Delete / Backspace note when selected (and not currently editing inside note body)
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedNoteId && !isEditingText(e)) {
      e.preventDefault();
      deleteNote(state.selectedNoteId);
    }

    // Reset view: Ctrl + 0
    if ((e.ctrlKey || e.metaKey) && e.key === '0') {
      e.preventDefault();
      resetView();
    }

    // Font resize shortcuts: Ctrl + [ / Ctrl + ]
    if ((e.ctrlKey || e.metaKey) && e.key === '[') {
      const selection = window.getSelection();
      if (selection.rangeCount && !selection.isCollapsed && isEditingText(e)) {
        e.preventDefault();
        changeFontSize(-2);
        updateFloatingFormatBar();
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === ']') {
      const selection = window.getSelection();
      if (selection.rangeCount && !selection.isCollapsed && isEditingText(e)) {
        e.preventDefault();
        changeFontSize(2);
        updateFloatingFormatBar();
      }
    }

    // Shortcuts modal: ? (Shift + /)
    if (e.key === '?' && !isEditingText(e)) {
      e.preventDefault();
      toggleShortcutsModal();
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      state.spacePressed = false;
      if (!state.isPanning) {
        viewport.classList.remove('panning');
      }
    }
  });

  function isEditingText(e) {
    const target = e.target;
    return target && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
  }

  // ==========================================
  // Settings Modal
  // ==========================================
  function toggleSettingsModal(show) {
    const isHidden = settingsModal.classList.contains('hidden');
    const shouldShow = typeof show === 'boolean' ? show : isHidden;
    if (shouldShow) {
      settingsModal.classList.remove('hidden');
      toggleShortcutsModal(false);
    } else {
      settingsModal.classList.add('hidden');
    }
  }

  settingsBtn.addEventListener('click', () => toggleSettingsModal(true));
  closeSettingsBtn.addEventListener('click', () => toggleSettingsModal(false));
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
      toggleSettingsModal(false);
    }
  });

  if (toggleFormatBarInput) {
    toggleFormatBarInput.addEventListener('change', (e) => {
      state.settings.showFormatBar = e.target.checked;
      if (!state.settings.showFormatBar) {
        hideFloatingFormatBar();
      }
      saveSettings();
    });
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(state.settings));
  }

  // ==========================================
  // Shortcuts Modal
  // ==========================================
  function toggleShortcutsModal(show) {
    const isHidden = shortcutsModal.classList.contains('hidden');
    const shouldShow = typeof show === 'boolean' ? show : isHidden;
    if (shouldShow) {
      shortcutsModal.classList.remove('hidden');
      toggleSettingsModal(false);
    } else {
      shortcutsModal.classList.add('hidden');
    }
  }

  shortcutsHelpBtn.addEventListener('click', () => toggleShortcutsModal(true));
  closeModalBtn.addEventListener('click', () => toggleShortcutsModal(false));
  shortcutsModal.addEventListener('click', (e) => {
    if (e.target === shortcutsModal) {
      toggleShortcutsModal(false);
    }
  });

  // ==========================================
  // Persistence (LocalStorage & Firebase Realtime Cloud Sync)
  // ==========================================
  function updateSyncStatus(status) {
    if (!syncStatus) return;
    if (status === 'syncing') {
      syncStatus.textContent = '● Saving to cloud...';
      syncStatus.className = 'sync-status syncing';
    } else if (status === 'synced') {
      syncStatus.textContent = '● Cloud Synced';
      syncStatus.className = 'sync-status';
    } else if (status === 'error') {
      syncStatus.textContent = '● Sync error (saved locally)';
      syncStatus.className = 'sync-status error';
    } else if (status === 'offline') {
      syncStatus.textContent = '● Local only';
      syncStatus.className = 'sync-status';
    }
  }

  function debounceSave() {
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = setTimeout(saveToStorage, 300);
  }

  function saveToStorage(dateStr) {
    const targetDate = dateStr || state.activeDate || getTodayStr();
    const notesArray = Array.from(state.notes.values()).map((note) => ({
      id: note.id,
      x: note.x,
      y: note.y,
      width: note.width,
      content: note.content,
      zIndex: note.zIndex,
    }));

    const viewportData = {
      panX: state.panX,
      panY: state.panY,
      scale: state.scale,
    };

    const workspaceData = {
      date: targetDate,
      notes: notesArray,
      drawings: state.drawings,
      viewport: viewportData,
      updatedAt: Date.now(),
    };

    // 1. Instant local write
    localStorage.setItem(workspaceKey(targetDate), JSON.stringify(workspaceData));

    // 2. Keep Activity Tracker heatmap synced
    if (window.ActivityTracker) {
      window.ActivityTracker.refresh();
    }

    // 3. Push to cloud ONLY if we have real content OR if cloud is already empty.
    // Never push 0 notes to cloud while cloud may have data we haven't loaded yet.
    if (state.currentUser && !isHydratingFromCloud && notesArray.length > 0) {
      debounceCloudSave(targetDate, workspaceData);
    }
  }

  function debounceCloudSave(dateStr, workspaceData) {
    if (!state.currentUser) return;
    updateSyncStatus('syncing');
    clearTimeout(cloudSaveDebounceTimer);
    cloudSaveDebounceTimer = setTimeout(async () => {
      if (!state.currentUser) return;
      const uid = state.currentUser.uid;
      try {
        const workspaceRef = ref(database, `users/${uid}/workspaces/${dateStr}`);
        // Only save notes, drawings, and updatedAt to Firebase (viewport is local-only)
        const cloudPayload = {
          date: dateStr,
          notes: workspaceData.notes || [],
          drawings: workspaceData.drawings || [],
          updatedAt: workspaceData.updatedAt || Date.now(),
        };
        await set(workspaceRef, cloudPayload);
        updateSyncStatus('synced');
      } catch (err) {
        console.error('Firebase cloud save error:', err);
        updateSyncStatus('error');
      }
    }, 600);
  }

  function switchToDate(dateStr) {
    if (!dateStr || state.activeDate === dateStr) return;
    clearTimeout(saveDebounceTimer);
    clearTimeout(cloudSaveDebounceTimer);
    saveToStorage(state.activeDate);
    loadFromStorage(dateStr);
  }

  // ==========================================
  // Automatic 100-Day Expiration & Pruning
  // ==========================================
  async function pruneExpiredWorkspaces() {
    const cutoffDate = getCutoffDateStr();

    // 1. Purge from LocalStorage
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('customnote_workspace_')) {
        const dateStr = key.replace('customnote_workspace_', '');
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr) && dateStr < cutoffDate) {
          keysToRemove.push(key);
        }
      }
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k));

    // 2. Purge from Firebase Realtime Database if signed in
    if (state.currentUser) {
      const uid = state.currentUser.uid;
      try {
        const workspacesRef = ref(database, `users/${uid}/workspaces`);
        const snapshot = await get(workspacesRef);
        if (snapshot.exists()) {
          const cloudWorkspaces = snapshot.val();
          for (const dateKey of Object.keys(cloudWorkspaces)) {
            if (/^\d{4}-\d{2}-\d{2}$/.test(dateKey) && dateKey < cutoffDate) {
              const expiredRef = ref(database, `users/${uid}/workspaces/${dateKey}`);
              await set(expiredRef, null); // Deletes expired node from Firebase
            }
          }
        }
      } catch (err) {
        console.error('Error pruning expired cloud workspaces:', err);
      }
    }

    if (keysToRemove.length > 0 && window.ActivityTracker) {
      window.ActivityTracker.refresh();
    }
  }

  function createDefaultWelcomeNotes() {
    const cx = window.innerWidth / 2 - 150;
    const cy = window.innerHeight / 2 - 100;
    createNote(cx, cy, {
      content: '<div>Welcome to <b>CustomNote</b>!</div><div><br></div><div>Double-click or press <b>Space</b> to create a new thought.</div>',
      focus: false,
    });
  }

  function loadFromStorage(dateStr) {
    const targetDate = dateStr || state.activeDate || getTodayStr();
    state.activeDate = targetDate;

    // 1. Load Settings (Global)
    const savedSettings = localStorage.getItem(STORAGE_KEY_SETTINGS);
    if (savedSettings) {
      try {
        state.settings = Object.assign({ showFormatBar: true }, JSON.parse(savedSettings));
      } catch (err) {
        console.error('Error loading settings', err);
      }
    }
    if (toggleFormatBarInput) {
      toggleFormatBarInput.checked = state.settings.showFormatBar !== false;
    }

    // 2. Clean up legacy single-canvas keys
    localStorage.removeItem(STORAGE_KEY_NOTES);
    localStorage.removeItem(STORAGE_KEY_DRAWINGS);
    localStorage.removeItem(STORAGE_KEY_VIEW);

    // 3. Clear current canvas DOM & state
    notesLayer.innerHTML = '';
    state.notes.clear();
    state.activeNoteId = null;
    state.selectedNoteId = null;
    state.drawings = [];
    state.undoStack = [];
    if (drawingsLayer) drawingsLayer.innerHTML = '';

    // 4. Load local workspace first (instant response)
    const rawWorkspace = localStorage.getItem(workspaceKey(targetDate));
    let workspace = null;
    if (rawWorkspace) {
      try {
        workspace = JSON.parse(rawWorkspace);
      } catch (err) {
        console.error('Error loading workspace for date ' + targetDate, err);
      }
    }

    if (workspace) {
      applyWorkspaceData(workspace);
    } else {
      // Empty fresh canvas for this date
      state.panX = window.innerWidth / 2 - 200;
      state.panY = window.innerHeight / 2 - 150;
      state.scale = 1.0;

      // Welcome notes only if first ever visit on today and not logged in
      const todayStr = getTodayStr();
      if (targetDate === todayStr && !hasAnyWorkspaces() && !state.currentUser) {
        createDefaultWelcomeNotes();
      }
    }

    updateTransform();
    window.ActivityTracker?.setActiveDate(targetDate);

    // 5. Attach real-time cloud listener if user is logged in
    if (state.currentUser) {
      attachCloudListener(targetDate);
    }
  }

  // ==========================================
  // Cloud-First Real-Time Sync (onValue)
  // ==========================================
  function attachCloudListener(dateStr) {
    // Detach any previous listener
    if (_activeCloudListener) {
      _activeCloudListener();
      _activeCloudListener = null;
    }

    if (!state.currentUser) return;
    const uid = state.currentUser.uid;
    const workspaceRef = ref(database, `users/${uid}/workspaces/${dateStr}`);

    _activeCloudListener = onValue(workspaceRef, (snapshot) => {
      if (isHydratingFromCloud) return;

      if (snapshot.exists()) {
        const cloudData = snapshot.val();
        const cloudNoteCount = Array.isArray(cloudData.notes) ? cloudData.notes.length : 0;
        const localNoteCount = state.notes.size;

        // Cloud-First: always apply if cloud has more notes, or if cloud is newer
        const rawLocal = localStorage.getItem(workspaceKey(dateStr));
        let localData = null;
        if (rawLocal) { try { localData = JSON.parse(rawLocal); } catch {} }
        const cloudTime = cloudData.updatedAt || 0;
        const localTime = localData ? (localData.updatedAt || 0) : 0;

        const cloudWins =
          cloudNoteCount > localNoteCount ||  // Cloud has more notes → always trust cloud
          cloudTime > localTime ||             // Cloud is newer → trust cloud
          !localData;                          // No local cache at all

        if (cloudWins) {
          const mergedLocal = Object.assign({}, cloudData, {
            viewport: localData?.viewport || { panX: state.panX, panY: state.panY, scale: state.scale }
          });
          localStorage.setItem(workspaceKey(dateStr), JSON.stringify(mergedLocal));

          if (state.activeDate === dateStr) {
            isHydratingFromCloud = true;
            applyWorkspaceData(mergedLocal, true);
            updateTransform();
            isHydratingFromCloud = false;
          }
          window.ActivityTracker?.refresh();
          updateSyncStatus('synced');
        }
      } else {
        // Cloud has nothing yet — push our local notes if we have any
        if (state.notes.size > 0 && state.activeDate === dateStr) {
          saveToStorage(dateStr);
        }
      }
    }, (err) => {
      console.error('Cloud listener error:', err);
      updateSyncStatus('error');
    });
  }

  function applyWorkspaceData(workspace, preserveViewport = false) {
    if (!workspace) return;

    // Viewport (only set if not preserving current device's viewport)
    if (!preserveViewport && workspace.viewport) {
      state.panX = typeof workspace.viewport.panX === 'number' ? workspace.viewport.panX : 0;
      state.panY = typeof workspace.viewport.panY === 'number' ? workspace.viewport.panY : 0;
      state.scale = typeof workspace.viewport.scale === 'number'
        ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, workspace.viewport.scale))
        : 1.0;
    }

    // Drawings
    if (Array.isArray(workspace.drawings)) {
      state.drawings = workspace.drawings;
      renderAllDrawings();
    } else {
      state.drawings = [];
      renderAllDrawings();
    }

    // Notes (Direct instantiation without debounce saving side-effects)
    notesLayer.innerHTML = '';
    state.notes.clear();
    state.activeNoteId = null;
    state.selectedNoteId = null;

    if (Array.isArray(workspace.notes) && workspace.notes.length > 0) {
      let maxZ = 10;
      workspace.notes.forEach((note) => {
        maxZ = Math.max(maxZ, note.zIndex || 10);
        const noteData = {
          id: note.id || generateId(),
          x: typeof note.x === 'number' ? note.x : 100,
          y: typeof note.y === 'number' ? note.y : 100,
          width: typeof note.width === 'number' ? note.width : 300,
          content: note.content || '',
          zIndex: note.zIndex || 10,
        };
        state.notes.set(noteData.id, noteData);
        renderNoteElement(noteData);
      });
      state.zIndexCounter = maxZ;
    }
  }

  async function syncCloudWorkspace(dateStr) {
    if (!state.currentUser) return;
    const uid = state.currentUser.uid;
    try {
      const workspaceRef = ref(database, `users/${uid}/workspaces/${dateStr}`);
      const snapshot = await get(workspaceRef);

      if (snapshot.exists()) {
        const cloudData = snapshot.val();
        const rawLocal = localStorage.getItem(workspaceKey(dateStr));
        let localData = null;
        if (rawLocal) {
          try { localData = JSON.parse(rawLocal); } catch {}
        }

        const cloudTime = cloudData.updatedAt || 0;
        const localTime = localData ? (localData.updatedAt || 0) : 0;

        // If cloud is newer or local is empty, update local & render
        if (cloudTime > localTime || !localData) {
          const mergedLocal = Object.assign({}, cloudData, {
            viewport: localData?.viewport || { panX: window.innerWidth / 2 - 200, panY: window.innerHeight / 2 - 150, scale: 1.0 }
          });
          localStorage.setItem(workspaceKey(dateStr), JSON.stringify(mergedLocal));

          if (state.activeDate === dateStr) {
            isHydratingFromCloud = true;
            applyWorkspaceData(mergedLocal, true); // Preserve device viewport
            updateTransform();
            isHydratingFromCloud = false;
          }
          if (window.ActivityTracker) {
            window.ActivityTracker.refresh();
          }
        } else if (localTime > cloudTime && localData) {
          // Local is newer: push to cloud
          debounceCloudSave(dateStr, localData);
        }
        updateSyncStatus('synced');
      } else {
        // Cloud has no workspace for this date yet. If local has notes, push local to cloud!
        const rawLocal = localStorage.getItem(workspaceKey(dateStr));
        if (rawLocal) {
          try {
            const localData = JSON.parse(rawLocal);
            if (localData && localData.notes && localData.notes.length > 0) {
              debounceCloudSave(dateStr, localData);
            }
          } catch {}
        }
      }
    } catch (err) {
      console.error('Cloud sync error for date ' + dateStr, err);
      updateSyncStatus('error');
    }
  }

  // ==========================================
  // Image Events (Direct File Picker & Paste)
  // ==========================================
  if (imageFileInput) {
    imageFileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        processAndInsertImage(e.target.files[0], targetImageNoteId);
        imageFileInput.value = '';
      }
    });
  }

  // Paste image handler (supports pasting directly into canvas/note)
  window.addEventListener('paste', (e) => {
    const items = (e.clipboardData || window.clipboardData)?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile();
        if (file) {
          e.preventDefault();
          processAndInsertImage(file, targetImageNoteId || state.activeNoteId);
          break;
        }
      }
    }
  });

  // Tool Dock Buttons
  document.querySelectorAll('.tool-btn[data-tool]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.activeElement?.blur();
      setTool(btn.dataset.tool);
    });
  });

  const undoBtn = document.getElementById('undo-btn');
  if (undoBtn) {
    undoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      undoLastAction();
    });
  }

  // ==========================================
  // Firebase Authentication & Session
  // ==========================================
  function setupAuth() {
    if (googleLoginBtn) {
      googleLoginBtn.addEventListener('click', async () => {
        try {
          googleLoginBtn.disabled = true;
          await signInWithPopup(auth, googleProvider);
        } catch (err) {
          console.error('Google Sign-In error:', err);
        } finally {
          if (googleLoginBtn) {
            googleLoginBtn.disabled = false;
          }
        }
      });
    }

    if (googleLogoutBtn) {
      googleLogoutBtn.addEventListener('click', async () => {
        try {
          await signOut(auth);
          updateSyncStatus('offline');
        } catch (err) {
          console.error('Sign-Out error:', err);
        }
      });
    }

    onAuthStateChanged(auth, async (user) => {
      state.currentUser = user;
      updateAuthUI(user);

      if (user) {
        updateSyncStatus('syncing');
        try {
          // 1. Fetch all user workspaces from cloud to hydrate local storage & activity strip
          const workspacesRef = ref(database, `users/${user.uid}/workspaces`);
          const snap = await get(workspacesRef);

          if (snap.exists()) {
            const allWorkspaces = snap.val();
            for (const [dateKey, ws] of Object.entries(allWorkspaces)) {
              if (ws && typeof ws === 'object') {
                const rawLocal = localStorage.getItem(workspaceKey(dateKey));
                let localData = null;
                if (rawLocal) {
                  try { localData = JSON.parse(rawLocal); } catch {}
                }
                const cloudTime = ws.updatedAt || 0;
                const localTime = localData ? (localData.updatedAt || 0) : 0;
                // Cloud-First: always trust cloud if it has more notes or is newer
                const cloudNoteCount = Array.isArray(ws.notes) ? ws.notes.length : 0;
                const localNoteCount = Array.isArray(localData?.notes) ? localData.notes.length : 0;
                if (cloudNoteCount >= localNoteCount || cloudTime >= localTime || !localData) {
                  const mergedLocal = Object.assign({}, ws, {
                    viewport: localData?.viewport || { panX: window.innerWidth / 2 - 200, panY: window.innerHeight / 2 - 150, scale: 1.0 }
                  });
                  localStorage.setItem(workspaceKey(dateKey), JSON.stringify(mergedLocal));
                }
              }
            }
          }

          // 2. Refresh activity strip and attach real-time live listener for active date
          window.ActivityTracker?.refresh();
          attachCloudListener(state.activeDate); // live real-time sync replaces one-shot syncCloudWorkspace
          await pruneExpiredWorkspaces();
          updateSyncStatus('synced');
        } catch (err) {
          console.error('Initial user cloud hydration error:', err);
          updateSyncStatus('error');
        }
      } else {
        // Signed out — detach live listener
        if (_activeCloudListener) {
          _activeCloudListener();
          _activeCloudListener = null;
        }
        updateSyncStatus('offline');
      }
    });
  }

  function updateAuthUI(user) {
    if (!authLoggedOut || !authLoggedIn) return;

    if (user) {
      authLoggedOut.classList.add('hidden');
      authLoggedIn.classList.remove('hidden');

      if (userAvatar) {
        userAvatar.src = user.photoURL || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="%236366f1"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/></svg>';
      }
      if (userName) {
        userName.textContent = user.displayName || 'Google User';
      }
      if (userEmail) {
        userEmail.textContent = user.email || '';
      }
    } else {
      authLoggedOut.classList.remove('hidden');
      authLoggedIn.classList.add('hidden');
    }
  }

  // ==========================================
  // Initialization
  // ==========================================
  function init() {
    loadFromStorage(getTodayStr());
    setupAuth();
    pruneExpiredWorkspaces();

    // Activity Tracker mount with date select callback
    window.ActivityTracker?.mount((selectedDate) => {
      if (!window.MobileManager?.isMobile()) {
        switchToDate(selectedDate);
      }
    });

    // Initialize Mobile Manager
    window.MobileManager?.init({
      createNote: (x, y, opts) => createNote(x, y, opts),
      panBy: (dx, dy) => {
        state.panX += dx;
        state.panY += dy;
        updateTransform();
      },
      zoomAt: (x, y, factor) => zoomAt(x, y, factor),
      screenToWorld: (x, y) => screenToWorld(x, y),
      saveState: () => debounceSave(),
      clearActiveNote: () => clearActiveNote(),
    });
  }

  init();
