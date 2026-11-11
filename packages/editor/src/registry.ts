import type { BlockDefinition } from './types.js';

const NAME_PATTERN = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

export class BlockRegistry {
  readonly #blocks = new Map<string, BlockDefinition>();

  register(definition: BlockDefinition): this {
    if (!NAME_PATTERN.test(definition.name)) {
      throw new Error(`Invalid block name "${definition.name}": use "namespace/name" in lower case`);
    }
    if (this.#blocks.has(definition.name)) {
      throw new Error(`Block "${definition.name}" is already registered`);
    }
    this.#blocks.set(definition.name, definition);
    return this;
  }

  has(name: string): boolean {
    return this.#blocks.has(name);
  }

  get(name: string): BlockDefinition | undefined {
    return this.#blocks.get(name);
  }

  list(): BlockDefinition[] {
    return [...this.#blocks.values()];
  }
}
