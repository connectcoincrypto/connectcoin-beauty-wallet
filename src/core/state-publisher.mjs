import { performance } from 'node:perf_hooks';

/** Latest-only notifications: construct snapshots only when a publication is due. */
export class StatePublisher {
  constructor({ publish, intervalMs = 200, now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.publish = publish;
    this.intervalMs = intervalMs;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.lastPublished = null;
    this.timer = null;
    this.closed = false;
  }
  request({ immediate = false } = {}) {
    if (this.closed) return;
    const remaining = this.lastPublished === null ? 0 : this.intervalMs - (this.now() - this.lastPublished);
    if (immediate || remaining <= 0) {
      this.cancelPending();
      this.publishNow();
    } else if (this.timer === null) {
      // Retain neither events nor full wallet snapshots while the renderer is busy.
      this.timer = this.setTimer(() => {
        this.timer = null;
        this.publishNow();
      }, Math.ceil(remaining));
      this.timer.unref?.();
    }
  }
  publishNow() {
    if (this.closed) return;
    this.lastPublished = this.now();
    this.publish();
  }
  cancelPending() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
  close() {
    this.closed = true;
    this.cancelPending();
  }
}
