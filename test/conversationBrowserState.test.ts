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
  interface TurnState {
    current?: HTMLElement;
    previous?: HTMLElement;
    next?: HTMLElement;
    activated: HTMLElement[];
  }

  function harness(state: Partial<TurnState> = {}) {
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
      getBoundingClientRect: () => ({ top: 0, bottom: 400, right: 100 }),
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
    const jumpToLatest = { hidden: true };
    const jumpToPrevTurn = { hidden: true };
    const jumpToNextTurn = { hidden: true };
    const jumpToTop = { hidden: true };
    const viewport = {
      body, result, section,
      jumpToLatest, jumpToPrevTurn, jumpToNextTurn, jumpToTop
    } as unknown as ScrollViewport;
    const diagnostics: string[] = [];
    const navigation: TurnState = { activated: [], ...state };
    const controller = new OutputScrollController({
      viewport,
      conversation: { activeId: () => "a", renderedId: () => "a" },
      canFollow: () => true,
      currentTurn: () => navigation.current,
      adjacentTurn: (offset) => (offset < 0 ? navigation.previous : navigation.next),
      activateTurn: (turn) => { navigation.activated.push(turn); },
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
    // A rendered turn moves up the port exactly as far as the port scrolls, so
    // its document offset stays at the supplied top in this fixture.
    const turnAt = (top: number): HTMLElement =>
      ({
        getBoundingClientRect: () => ({
          top: top - body.scrollTop,
          bottom: top + 200 - body.scrollTop
        })
      } as unknown as HTMLElement);
    return {
      controller, body, diagnostics, cancelled, navigation, turnAt,
      jumpToPrevTurn, jumpToNextTurn, jumpToTop,
      frameCount: () => frames.size,
      flush
    };
  }

  it("returns to the current turn before stepping to the previous one", () => {
    const h = harness();
    h.navigation.current = h.turnAt(250);
    h.navigation.previous = h.turnAt(0);
    h.body.scrollTop = 600;
    h.controller.syncJumpControls();
    expect(h.jumpToPrevTurn.hidden).toBe(false);

    // The first press restores the current exchange without leaving it.
    h.controller.jumpToPreviousTurn();
    expect(h.body.scrollTop).toBe(250);
    expect(h.navigation.activated).toEqual([]);
    expect(h.controller.following).toBe(false);
    // Arriving at the title must not hide the persistent control.
    expect(h.jumpToPrevTurn.hidden).toBe(false);

    // The second press steps to the earlier exchange and reveals it.
    h.controller.jumpToPreviousTurn();
    expect(h.navigation.activated).toEqual([h.navigation.previous]);
    expect(h.body.scrollTop).toBe(0);
  });

  it("steps forward and reveals the next exchange", () => {
    const h = harness();
    h.navigation.current = h.turnAt(100);
    h.navigation.next = h.turnAt(400);
    h.body.scrollTop = 100;
    h.controller.syncJumpControls();
    expect(h.jumpToNextTurn.hidden).toBe(false);

    h.controller.jumpToNextTurn();
    expect(h.navigation.activated).toEqual([h.navigation.next]);
    expect(h.body.scrollTop).toBe(400);
    expect(h.controller.following).toBe(false);
    // The control stays available at its target, unlike the old single jump.
    expect(h.jumpToNextTurn.hidden).toBe(false);
  });

  it("returns to the current exchange before stepping forward when it is below the port", () => {
    const h = harness();
    h.navigation.current = h.turnAt(500);
    h.navigation.next = h.turnAt(900);
    // At the very top of the transcript the open exchange is entirely below
    // the port. Pressing next must reveal it instead of activating a turn far
    // below the reader's current position.
    h.body.scrollTop = 0;
    h.controller.jumpToNextTurn();
    expect(h.body.scrollTop).toBe(500);
    expect(h.navigation.activated).toEqual([]);
    expect(h.controller.following).toBe(false);

    // With the exchange now visible, the next press steps forward.
    h.controller.jumpToNextTurn();
    expect(h.navigation.activated).toEqual([h.navigation.next]);
    expect(h.body.scrollTop).toBe(600);
  });

  it("returns to a current exchange that scrolled above the port", () => {
    const h = harness();
    h.navigation.current = h.turnAt(100);
    h.navigation.next = h.turnAt(700);
    h.body.scrollTop = 600;
    h.controller.jumpToNextTurn();
    expect(h.body.scrollTop).toBe(100);
    expect(h.navigation.activated).toEqual([]);
  });

  it("realigns a visible exchange to its title before stepping forward", () => {
    const h = harness();
    h.navigation.current = h.turnAt(300);
    h.navigation.next = h.turnAt(700);
    // The exchange's body fills the port but its title is above the top edge.
    // Next mirrors prev: the first press brings the title back into view.
    h.body.scrollTop = 100;
    h.controller.jumpToNextTurn();
    expect(h.navigation.activated).toEqual([]);
    expect(h.body.scrollTop).toBe(300);

    // Aligned at its title, the next press steps forward.
    h.controller.jumpToNextTurn();
    expect(h.navigation.activated).toEqual([h.navigation.next]);
    expect(h.body.scrollTop).toBe(600);
  });

  it("hides an empty direction while its exchange is on screen", () => {
    const h = harness();
    h.navigation.current = h.turnAt(250);
    h.body.scrollTop = 250;
    h.controller.syncJumpControls();
    expect(h.jumpToPrevTurn.hidden).toBe(true);
    expect(h.jumpToNextTurn.hidden).toBe(true);

    h.navigation.previous = h.turnAt(0);
    h.navigation.next = h.turnAt(500);
    h.controller.syncJumpControls();
    expect(h.jumpToPrevTurn.hidden).toBe(false);
    expect(h.jumpToNextTurn.hidden).toBe(false);
  });

  it("keeps the next control available to return to a last exchange that scrolled away", () => {
    const h = harness();
    h.navigation.current = h.turnAt(900);
    h.body.scrollTop = 0;
    h.controller.syncJumpControls();
    // The last exchange is below the port, so the forward control still has a
    // job: bring the reader back to the conversation they left open.
    expect(h.jumpToNextTurn.hidden).toBe(false);

    h.controller.jumpToNextTurn();
    expect(h.body.scrollTop).toBe(600);
    expect(h.navigation.activated).toEqual([]);

    // Back at the visible last exchange there is nowhere further to step.
    h.controller.syncJumpControls();
    expect(h.jumpToNextTurn.hidden).toBe(true);
  });

  it("keeps the previous control available to return to a first exchange that scrolled away", () => {
    const h = harness();
    h.navigation.current = h.turnAt(0);
    h.body.scrollTop = 600;
    h.controller.syncJumpControls();
    // There is no earlier exchange, but the only turn's title is above the
    // port, so the backward control still has a job.
    expect(h.jumpToPrevTurn.hidden).toBe(false);

    h.controller.jumpToPreviousTurn();
    expect(h.body.scrollTop).toBe(0);
    expect(h.navigation.activated).toEqual([]);
    // Aligned at its title, the first exchange has nowhere further back to go.
    expect(h.jumpToPrevTurn.hidden).toBe(true);
  });

  it("ignores previous-turn requests when no turn is rendered", () => {
    const h = harness();
    h.body.scrollTop = 120;
    h.controller.syncJumpControls();
    expect(h.jumpToPrevTurn.hidden).toBe(true);
    expect(h.jumpToNextTurn.hidden).toBe(true);
    h.controller.jumpToPreviousTurn();
    h.controller.jumpToNextTurn();
    expect(h.body.scrollTop).toBe(120);
  });

  it("clamps a next-turn title that cannot reach the top edge", () => {
    const h = harness();
    h.navigation.current = h.turnAt(0);
    h.navigation.next = h.turnAt(900);
    // The turn ends 400px below its title, shorter than the port, so the
    // furthest reachable position is the port's current end.
    h.body.scrollTop = 0;
    h.controller.jumpToNextTurn();
    expect(h.body.scrollTop).toBe(600);
  });

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
