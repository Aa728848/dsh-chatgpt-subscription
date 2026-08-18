export class EventBus {
  #handlers = new Map();

  on(type, handler) {
    if (!this.#handlers.has(type)) this.#handlers.set(type, new Set());
    this.#handlers.get(type).add(handler);
    return () => this.off(type, handler);
  }

  off(type, handler) {
    const handlers = this.#handlers.get(type);
    if (!handlers) return;
    handlers.delete(handler);
    if (handlers.size === 0) this.#handlers.delete(type);
  }

  async emit(type, payload) {
    const handlers = [...(this.#handlers.get(type) ?? [])];
    for (const handler of handlers) await handler(payload);
  }

  clear() {
    this.#handlers.clear();
  }
}
