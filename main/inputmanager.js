import { ContextManager } from "./context.js";

/**
 * Input Manager
 * Handles keyboard input events based on the current context.
 */

const InputManager = {
  _registry: {},
  _modeStack: [],

  on(context, code, handler) {
    this._registry[`${context}:${code}`] = handler;
  },

  off(context, code) {
    delete this._registry[`${context}:${code}`];
  },

  pushMode(handler) {
    this._modeStack.push(handler);
  },

  popMode() {
    this._modeStack.pop();
  },

  _dispatch(event) {
    const context = ContextManager.getCurrentContext();
    if (this._modeStack.length > 0) {
      if (context === "TYPING" || context === "OVERLAY") return;
      this._modeStack[this._modeStack.length - 1](event);
      return;
    }
    const handler =
      this._registry[`${context}:${event.code}`] ||
      this._registry[`*:${event.code}`];
    if (handler) handler(event);
  },
};

// Handle keydown for all presses
document.addEventListener("keydown", (e) => InputManager._dispatch(e), true);

export { InputManager };
