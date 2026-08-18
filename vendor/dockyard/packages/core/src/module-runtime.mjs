import { EventBus } from "./events.mjs";
import { ModuleConflictError, ModuleNotFoundError, ValidationError } from "./errors.mjs";

export class ModuleRuntime {
  #modules = new Map();
  #services = new Map();

  constructor({ events = new EventBus(), logger = console } = {}) {
    this.events = events;
    this.logger = logger;
  }

  async register(module) {
    const manifest = module?.manifest;
    if (!manifest?.id || !manifest.kind) {
      throw new ValidationError("A module manifest must contain id and kind");
    }
    if (this.#modules.has(manifest.id)) throw new ModuleConflictError(manifest.id);

    const record = { module, manifest: { ...manifest }, services: new Set(), active: false };
    this.#modules.set(manifest.id, record);
    const context = this.#contextFor(record);

    try {
      if (typeof module.activate === "function") await module.activate(context);
      record.active = true;
      await this.events.emit("module/registered", { moduleId: manifest.id, manifest: { ...manifest } });
      return module;
    } catch (error) {
      this.#removeServices(record);
      this.#modules.delete(manifest.id);
      throw error;
    }
  }

  async unregister(moduleId) {
    const record = this.#modules.get(moduleId);
    if (!record) throw new ModuleNotFoundError(moduleId);
    if (typeof record.module.deactivate === "function") {
      await record.module.deactivate(this.#contextFor(record));
    }
    this.#removeServices(record);
    this.#modules.delete(moduleId);
    await this.events.emit("module/unregistered", { moduleId });
  }

  has(moduleId) {
    return this.#modules.has(moduleId);
  }

  get(moduleId) {
    const record = this.#modules.get(moduleId);
    if (!record) throw new ModuleNotFoundError(moduleId);
    return record.module;
  }

  list() {
    return [...this.#modules.values()].map(({ manifest, active }) => ({ ...manifest, active }));
  }

  registerService(name, value, ownerId) {
    if (this.#services.has(name)) {
      throw new ValidationError(`Service is already registered: ${name}`, { name });
    }
    this.#services.set(name, { value, ownerId });
    const record = this.#modules.get(ownerId);
    if (record) record.services.add(name);
  }

  getService(name) {
    const service = this.#services.get(name);
    if (!service) throw new ValidationError(`Service is not registered: ${name}`, { name });
    return service.value;
  }

  hasService(name) {
    return this.#services.has(name);
  }

  #contextFor(record) {
    return {
      moduleId: record.manifest.id,
      events: this.events,
      logger: this.logger,
      registerService: (name, value) => this.registerService(name, value, record.manifest.id),
      getService: (name) => this.getService(name),
      emit: (type, payload = {}) => this.events.emit(type, { ...payload, moduleId: record.manifest.id }),
    };
  }

  #removeServices(record) {
    for (const name of record.services) this.#services.delete(name);
    record.services.clear();
  }
}
