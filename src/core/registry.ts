import type {
  CallableDefinition,
  MethodSource,
  RegisteredCallable
} from "./types.js";

const SOURCE_PRIORITY: Record<MethodSource, number> = {
  builtin: 0,
  global: 1,
  project: 2
};

export class MethodRegistry {
  private readonly methods = new Map<string, RegisteredCallable>();

  register(definition: CallableDefinition, source: MethodSource): void {
    const current = this.methods.get(definition.id);
    if (current && SOURCE_PRIORITY[current.source] > SOURCE_PRIORITY[source]) {
      return;
    }
    this.methods.set(definition.id, { ...definition, source });
  }

  registerMany(definitions: readonly CallableDefinition[], source: MethodSource): void {
    for (const definition of definitions) {
      this.register(definition, source);
    }
  }

  get(id: string): RegisteredCallable | undefined {
    return this.methods.get(id);
  }

  list(): RegisteredCallable[] {
    return [...this.methods.values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    );
  }

  clearExternal(): void {
    for (const [id, method] of this.methods) {
      if (method.source !== "builtin") {
        this.methods.delete(id);
      }
    }
  }
}
