const STORAGE_KEY = 'spider-dialog-positions-v2';

function readPositions() {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function writePositions(positions) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(positions));
  } catch {
    // Storage can be disabled (private browsing, embedded contexts, etc.).
  }
}

export function makeDialogDraggable(panel, handle = panel) {
  if (!panel || !handle) return () => {};
  const dragTarget = panel.closest?.('[data-dialog-shell]') || panel;
  const key = dragTarget.id || panel.id || 'dialog';
  const positions = readPositions();
  const saved = positions[key];
  if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
    dragTarget.style.left = `${Math.max(0, Math.min(100, saved.left))}%`;
    dragTarget.style.top = `${Math.max(0, Math.min(100, saved.top))}%`;
  }

  let drag = null;
  const onPointerMove = (event) => {
    if (!drag) return;
    const app = dragTarget.parentElement;
    const rect = app.getBoundingClientRect();
    const panelRect = dragTarget.getBoundingClientRect();
    const maxLeft = Math.max(0, rect.width - panelRect.width);
    const maxTop = Math.max(0, rect.height - panelRect.height);
    const left = Math.max(0, Math.min(maxLeft, event.clientX - rect.left - drag.offsetX));
    const top = Math.max(0, Math.min(maxTop, event.clientY - rect.top - drag.offsetY));
    dragTarget.style.left = `${(left / rect.width) * 100}%`;
    dragTarget.style.top = `${(top / rect.height) * 100}%`;
  };
  const stop = () => {
    if (!drag) return;
    const rect = dragTarget.parentElement.getBoundingClientRect();
    const panelRect = dragTarget.getBoundingClientRect();
    positions[key] = {
      left: ((panelRect.left - rect.left) / rect.width) * 100,
      top: ((panelRect.top - rect.top) / rect.height) * 100,
    };
    writePositions(positions);
    drag = null;
    handle.classList.remove('is-dragging');
  };
  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    const panelRect = panel.getBoundingClientRect();
    drag = { offsetX: event.clientX - panelRect.left, offsetY: event.clientY - panelRect.top };
    handle.classList.add('is-dragging');
    handle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };
  handle.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('pointermove', onPointerMove);
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);
  return () => {
    handle.removeEventListener('pointerdown', onPointerDown);
    handle.removeEventListener('pointermove', onPointerMove);
    handle.removeEventListener('pointerup', stop);
    handle.removeEventListener('pointercancel', stop);
  };
}
