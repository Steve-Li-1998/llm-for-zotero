/**
 * The fake DOM the panel-render tests build their trees in.
 *
 * Zotero's chrome document is not available under mocha, so the render code is
 * handed this stand-in: enough of `Document` and `Element` for the builders to
 * append children, set classes, attributes and dataset entries, and enough
 * lookup helpers (`findByClass`, `findAllByClass`) for a test to assert the
 * structure that came out. It lives here because more than one test file
 * renders panel DOM.
 */

class FakeClassList {
  private readonly classes = new Set<string>();

  add(...classes: string[]) {
    for (const cls of classes) {
      if (cls) this.classes.add(cls);
    }
  }

  contains(cls: string): boolean {
    return this.classes.has(cls);
  }

  remove(...classes: string[]) {
    for (const cls of classes) this.classes.delete(cls);
  }

  toggle(cls: string, force?: boolean): boolean {
    const enabled = force === undefined ? !this.classes.has(cls) : force;
    if (enabled) this.classes.add(cls);
    else this.classes.delete(cls);
    return enabled;
  }

  toString(): string {
    return Array.from(this.classes).join(" ");
  }
}

class FakeStyleDeclaration {
  [key: string]: string | ((name: string, value: string) => void);

  setProperty(name: string, value: string): void {
    this[name] = value;
  }
}

export class FakeElement {
  public readonly classList = new FakeClassList();
  public readonly dataset: Record<string, string | undefined> = {};
  public readonly children: FakeElement[] = [];
  public id = "";
  public textContent = "";
  public type = "";
  public title = "";
  public disabled = false;
  public attributes: Record<string, string> = {};
  public style = new FakeStyleDeclaration();
  public offsetHeight = 0;
  public scrollHeight = 0;
  public offsetTop = 0;
  public offsetWidth = 0;
  private copyableChildren: FakeElement[] = [];
  private html = "";
  private listeners = new Map<string, Array<(event: any) => void>>();

  public parentElement: FakeElement | null = null;
  get childNodes() {
    return this.children;
  }
  get nodeType() {
    return 1;
  }
  get nodeName() {
    return this.tagName.toUpperCase();
  }
  get nextSibling(): FakeElement | null {
    const siblings = this.parentElement?.children || [];
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  get isConnected() {
    return false;
  }
  remove() {
    this.parentElement?.removeChild(this);
  }
  removeChild(child: FakeElement) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentElement = null;
    return child;
  }
  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }
  hasAttribute(name: string) {
    return name in this.attributes;
  }
  removeAttribute(name: string) {
    delete this.attributes[name];
  }
  constructor(public readonly tagName = "div") {
    const attributes = this.attributes;
    Object.defineProperty(attributes, Symbol.iterator, {
      value: function* () {
        for (const [name, value] of Object.entries(attributes))
          yield { name, value };
      },
    });
  }

  set className(value: string) {
    this.classList.add(...value.split(/\s+/).filter(Boolean));
  }

  get className(): string {
    return this.classList.toString();
  }

  set innerHTML(value: string) {
    this.html = value;
    this.copyableChildren = value.includes("llm-copyable")
      ? [new FakeCopyableElement()]
      : [];
  }

  get innerHTML(): string {
    return this.html;
  }

  get firstChild(): FakeElement | null {
    return this.children[0] || null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (selector === ".llm-copyable[data-llm-copy-source]") {
      return [
        ...this.copyableChildren,
        ...this.findAllByClass("llm-copyable").filter(
          (element) => element.dataset.llmCopySource !== undefined,
        ),
      ];
    }
    if (selector === ".llm-codeblock-shell") {
      return this.findAllByClass("llm-codeblock-shell");
    }
    return [];
  }

  querySelector(selector: string): FakeElement | null {
    if (selector === ":scope > .llm-render-copy-btn") {
      return (
        this.children.find((child) =>
          child.classList.contains("llm-render-copy-btn"),
        ) || null
      );
    }
    if (selector === ":scope .llm-codeblock-shell") {
      return this.findByClass("llm-codeblock-shell");
    }
    if (selector.startsWith(".")) return this.findByClass(selector.slice(1));
    if (selector === "summary") return this.findAllByTag("summary")[0] || null;
    return null;
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) || []).filter((fn) => fn !== listener),
    );
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const existing = this.listeners.get(type) || [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  dispatchFakeEvent(type: string): {
    defaultPrevented: boolean;
    propagationStopped: boolean;
    immediatePropagationStopped: boolean;
  } {
    const event = {
      defaultPrevented: false,
      propagationStopped: false,
      immediatePropagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
      stopImmediatePropagation() {
        this.immediatePropagationStopped = true;
      },
    };
    for (const listener of this.listeners.get(type) || []) {
      listener(event);
    }
    return event;
  }

  async dispatchFakeEventAsync(type: string): Promise<{
    defaultPrevented: boolean;
    propagationStopped: boolean;
    immediatePropagationStopped: boolean;
  }> {
    const event = {
      defaultPrevented: false,
      propagationStopped: false,
      immediatePropagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
      stopImmediatePropagation() {
        this.immediatePropagationStopped = true;
      },
    };
    await Promise.all(
      (this.listeners.get(type) || []).map((listener) => listener(event)),
    );
    return event;
  }

  contains(node: unknown): boolean {
    return this.children.includes(node as FakeElement);
  }

  insertBefore(child: FakeElement, before: FakeElement | null): FakeElement {
    if (child === before) return child;
    child.remove();
    const index = before ? this.children.indexOf(before) : -1;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    child.parentElement = this;
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  append(...children: FakeElement[]): void {
    for (const child of children) this.appendChild(child);
  }

  appendChild(child: FakeElement): FakeElement {
    return this.insertBefore(child, null);
  }

  replaceChildren(...children: FakeElement[]): void {
    for (const child of [...this.children]) this.removeChild(child);
    this.append(...children);
  }

  focus(): void {}

  findByClass(className: string): FakeElement | null {
    if (this.classList.contains(className)) return this;
    for (const child of this.children) {
      const match = child.findByClass(className);
      if (match) return match;
    }
    return null;
  }

  findAllByClass(className: string): FakeElement[] {
    const matches = this.classList.contains(className) ? [this] : [];
    for (const child of this.children) {
      matches.push(...child.findAllByClass(className));
    }
    return matches;
  }

  findAllByTag(tagName: string): FakeElement[] {
    const normalized = tagName.toLowerCase();
    const matches = this.tagName.toLowerCase() === normalized ? [this] : [];
    for (const child of this.children) {
      matches.push(...child.findAllByTag(normalized));
    }
    return matches;
  }

  getCopyableChildren(): FakeElement[] {
    return this.copyableChildren;
  }
}

class FakeCopyableElement extends FakeElement {
  constructor() {
    super("span");
    this.className = "llm-copyable llm-copyable-math";
    this.dataset.llmCopySource = "$$r(x)=g(Vx)$$";
  }
}

export class ThrowingTemplateElement extends FakeElement {
  public readonly content = {
    querySelectorAll: () => [],
  };

  set innerHTML(_value: string) {
    throw new Error("template parser unavailable");
  }

  get innerHTML(): string {
    return "";
  }
}

export const fakeDocument = {
  createElement: (tagName: string) => new FakeElement(tagName),
  createElementNS: (_namespace: string, tagName: string) =>
    new FakeElement(tagName),
  querySelectorAll: () => [],
} as unknown as Document;

export function collectFakeText(
  element: FakeElement | null | undefined,
): string {
  if (!element) return "";
  return [element.textContent, ...element.children.map(collectFakeText)].join(
    "",
  );
}
