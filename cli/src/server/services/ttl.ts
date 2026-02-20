export class TtlService {
  private timers = new Map<string, Timer>();

  start(sandboxId: string, timeoutSec: number, onExpire: () => void): void {
    this.clear(sandboxId);
    const timer = setTimeout(onExpire, timeoutSec * 1000);
    this.timers.set(sandboxId, timer);
  }

  update(sandboxId: string, timeoutSec: number, onExpire: () => void): void {
    this.start(sandboxId, timeoutSec, onExpire);
  }

  clear(sandboxId: string): void {
    const timer = this.timers.get(sandboxId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(sandboxId);
    }
  }

  clearAll(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
