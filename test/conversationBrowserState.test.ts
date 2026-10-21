import { describe, expect, it } from "vitest";
import type { DextHistorySession } from "../src/features/conversations/contracts/history.js";
import { ComposerDraftStore } from "../src/features/conversations/browser/composerController.js";
import {
  ConversationBrowser,
  MAX_CONVERSATION_VIEW_CACHE,
  conversationSignature,
  putConversationView
} from "../src/features/conversations/browser/conversationController.js";
import { OutputScrollController, type ScrollViewport } from "../src/features/conversations/browser/outputScrollController.js";

function session(id: string, updatedAt = 1, turns: number = 1): DextHistorySession {
  return {
    id, createdAt: 1, updatedAt,
    turns: Array.from({ length: turns }, (_, index) => ({ id: `${id}-${index}`, createdAt: index + 1, input: "", process: [], output: "" }))
  };
}

describe("ConversationBrowser", () => {
  it("invalidates stale switch ids and deferred renders", () => {
    const browser = new ConversationBrowser();
    const first = browser.beginSelection("a");
    expect(browser.activeId).toBe("a");
    expect(browser.acceptsHostActiveId("a", false, first)).toBe(true);
    // A host refresh without a switch id cannot undo the newer local press.
    expect(browser.acceptsHostActiveId("b", false, undefined)).toBe(false);
    expect(browser.acceptsHostActiveId("b", true, undefined)).toBe(true);
    const second = browser.beginSelection("b");
    expect(second).toBeGreaterThan(first);
    expect(browser.acceptsHostActiveId("a", false, first)).toBe(false);

    browser.setRendered("b", "sig");
    const render = browser.beginRender();
    expect(browser.isCurrentRender(render, "b")).toBe(true);
    browser.beginSelection("a");
    expect(browser.isCurrentRender(render, "b")).toBe(false);
  });

  it("signs a conversation by its newest turn", () => {
    expect(conversationSignature(session("a", 5, 1))).toBe("5:1:a-0:0");
    expect(conversationSignature(session("a", 6, 2))).toBe("6:2:a-1:0");
  });

  it("keeps only the most recently used cached conversations", () => {
    const cache = new Map<string, { signature: string; nodes: Node[]; turnIds: string[] }>();
    for (let index = 0; index < MAX_CONVERSATION_VIEW_CACHE + 2; index += 1) {
      putConversationView(cache, `session-${index}`, { signature: `${index}`, nodes: [], turnIds: [] });
    }
    expect(cache.size).toBe(MAX_CONVERSATION_VIEW_CACHE);
    expect(cache.has("session-0")).toBe(false);
    expect(cache.has(`session-${MAX_CONVERSATION_VIEW_CACHE + 1}`)).toBe(true);
  });
});

describe("ComposerDraftStore", () => {
  const attachment = (path: string) => ({ relativePath: path, webviewUri: `https://x/${path}`, name: path });

  it("keeps one draft per conversation and only saved attachments", () => {
    const drafts = new ComposerDraftStore();
    drafts.save("a", "look @.dext/attachments/a.png", [attachment(".dext/attachments/a.png"), attachment(".dext/attachments/gone.png")]);
    drafts.save("b", "b prompt", []);
    expect(drafts.draft("a")?.source).toContain("look");
    expect(drafts.draft("a")?.attachments.map((item) => item.relativePath)).toEqual([".dext/attachments/a.png"]);
    expect(drafts.draft("b")?.source).toBe("b prompt");
    expect(drafts.hasUnsent("a")).toBe(true);
  });

  it("clears only the submitted conversation and forgets closed drafts", () => {
    const drafts = new ComposerDraftStore();
    drafts.save("a", "first", []);
    drafts.save("b", "second", []);
    drafts.save("a", "", []);
    expect(drafts.hasUnsent("a")).toBe(false);
    expect(drafts.hasUnsent("b")).toBe(true);
    drafts.delete("b");
    expect(drafts.draft("b")).toBeUndefined();
    expect(drafts.hasUnsent("b")).toBe(false);
  });
});

describe("OutputScrollController", () => {
  function harness() {
    const frames = new Map<number, FrameRequestCallback>();
    const cancelled: number[] = [];
    let nextHandle = 1;
    const flush = (): void => {
      const pending = [...frames.entries()];
      frames.clear();
      for (const [, callback] of pending) callback(0);
    };
    const body = {
      scrollTop: 0, scrollHeight: 1000, clientHeight: 400, offsetWidth: 200, clientWidth: 190,
      getBoundingClientRect: () => ({ bottom: 400, right: 100 }),
      focus: () => undefined
    };
    const result = {
      childElementCount: 0,
      scrollTop: 0, scrollHeight: 1000, clientHeight: 400, offsetWidth: 200, clientWidth: 190,
      getBoundingClientRect: () => ({ bottom: 1000, right: 100 }),
      focus: () => undefined,
      querySelectorAll: () => [] as unknown[]
    };
    const section = {
      scrollTop: 0, scrollHeight: 0, clientHeight: 0, offsetWidth: 0, clientWidth: 0,
      getBoundingClientRect: () => ({ bottom: 400, right: 100 }),
      focus: () => undefined,
      style: { setProperty: () => undefined },
      classList: { remove: () => undefined }
    };
    const viewport = {
      body, result, section,
      jumpToLatest: { hidden: true },
      jumpToTop: { hidden: true }
    } as unknown as ScrollViewport;
    const diagnostics: string[] = [];
    const controller = new OutputScrollController({
      viewport,
      conversation: { activeId: () => "a", renderedId: () => "a" },
      canFollow: () => true,
      onDiagnostic: (message) => { diagnostics.push(message); },
      requestFrame: (callback) => {
        const handle = nextHandle++;
        frames.set(handle, callback);
        return handle;
      },
      cancelFrame: (handle) => {
        cancelled.push(handle);
        frames.delete(handle);
      }
    });
    return {
      controller, body, diagnostics, cancelled,
      frameCount: () => frames.size,
      flush
    };
  }

  it("releases following on the reader's gesture and resumes at the end", () => {
    const h = harness();
    h.body.scrollTop = 600;
    h.controller.syncJumpControls();
    expect(h.controller.following).toBe(true);
    h.controller.onWheel(-1);
    expect(h.controller.following).toBe(false);
    h.controller.measureLayout();
    h.body.scrollTop = 100;
    h.controller.onScroll();
    expect(h.controller.following).toBe(false);
    h.body.scrollTop = 600;
    h.controller.onScroll();
    expect(h.controller.following).toBe(true);
  });

  it("does not release following when the browser reports a layout change", () => {
    const h = harness();
    h.body.scrollTop = 600;
    h.controller.measureLayout();
    h.body.scrollTop = 500;
    h.body.scrollHeight = 1100;
    h.controller.onScroll();
    expect(h.controller.following).toBe(true);
  });

  it("treats a scrollbar drag against the end as a request for the newest output", () => {
    const h = harness();
    h.body.scrollTop = 100;
    expect(h.controller.beginPointerGesture({ clientX: 95 })).toBe(true);
    expect(h.controller.following).toBe(false);
    h.controller.endPointerGesture({ clientY: 400 });
    expect(h.controller.following).toBe(true);
    expect(h.body.scrollTop).toBe(600);
    // A press away from the strip is not a gesture.
    expect(h.controller.beginPointerGesture({ clientX: 10 })).toBe(false);
  });

  it("drops a queued follow frame when the conversation switches or the view is disposed", () => {
    const h = harness();
    h.controller.pin();
    expect(h.frameCount()).toBe(1);
    h.controller.beginSwitch();
    expect(h.frameCount()).toBe(0);
    h.flush();
    expect(h.body.scrollTop).toBe(0);

    h.controller.pin();
    h.controller.dispose();
    h.flush();
    expect(h.body.scrollTop).toBe(0);
  });

  it("leaves no frame behind after the last deferred scroll settles", () => {
    const h = harness();
    h.controller.followToBottom();
    h.flush();
    expect(h.body.scrollTop).toBe(600);
    expect(h.frameCount()).toBe(0);
  });
});
