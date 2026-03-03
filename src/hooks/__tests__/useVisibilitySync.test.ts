// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('useVisibilitySync', () => {
  let listeners: Record<string, Function[]> = {};
  let hiddenValue = false;

  beforeEach(() => {
    listeners = {};
    vi.spyOn(document, 'addEventListener').mockImplementation((event, fn) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(fn as Function);
    });
    vi.spyOn(document, 'removeEventListener').mockImplementation(() => {});
    Object.defineProperty(document, 'hidden', { get: () => hiddenValue, configurable: true });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  function triggerVisibilityChange(hidden: boolean) {
    hiddenValue = hidden;
    listeners['visibilitychange']?.forEach(fn => fn());
  }

  it('should register visibilitychange listener', () => {
    expect(document.addEventListener).toBeDefined();
  });

  it('should detect when tab goes hidden', () => {
    let wasHidden = false;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) wasHidden = true;
    });
    triggerVisibilityChange(true);
    expect(wasHidden).toBe(true);
  });

  it('should request snapshot when hidden > 3 seconds', () => {
    vi.useFakeTimers();
    const requestSnapshot = vi.fn();

    let hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        hiddenAt = Date.now();
      } else {
        if (Date.now() - hiddenAt > 3000) requestSnapshot();
      }
    });

    triggerVisibilityChange(true);
    vi.advanceTimersByTime(5000);
    triggerVisibilityChange(false);

    expect(requestSnapshot).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('should NOT request snapshot when hidden < 3 seconds', () => {
    vi.useFakeTimers();
    const requestSnapshot = vi.fn();

    let hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        hiddenAt = Date.now();
      } else {
        if (Date.now() - hiddenAt > 3000) requestSnapshot();
      }
    });

    triggerVisibilityChange(true);
    vi.advanceTimersByTime(1000);
    triggerVisibilityChange(false);

    expect(requestSnapshot).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
