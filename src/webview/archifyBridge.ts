/**
 * Bridge injected into the renderer HTML. It is intentionally self-contained: the sandboxed
 * iframe has no access to VS Code APIs and only the parent page talks to the extension host.
 */
export function archifyViewerBridgeScript(session: string, theme: "light" | "dark"): string {
  return `(function(){
    try {
      var desired = ${JSON.stringify(theme)};
      var original = window.matchMedia ? window.matchMedia.bind(window) : null;
      function stub(matches, media) { return { matches: matches, media: media, onchange: null, addEventListener: function(){}, removeEventListener: function(){}, addListener: function(){}, removeListener: function(){}, dispatchEvent: function(){ return false; } }; }
      window.matchMedia = function (query) {
        var value = String(query);
        if (/prefers-color-scheme\\s*:\\s*light/i.test(value)) return stub(desired === "light", value);
        if (/prefers-color-scheme\\s*:\\s*dark/i.test(value)) return stub(desired === "dark", value);
        return original ? original(query) : stub(false, value);
      };
    } catch (error) {}
    var session = ${JSON.stringify(session)};
    var desiredTheme = ${JSON.stringify(theme)};
    var pendingSvg = null;
    var blobByUrl = new Map();
    var archifyToProject = {};
    var presentationBeforeFullscreen = null;
    function post(message) { try { window.parent.postMessage(Object.assign({ __dext: session }, message), "*"); } catch (error) {} }
    function themeNow() { return document.documentElement.getAttribute("data-theme"); }
    function applyTheme(next) {
      try {
        if (next === "light" || next === "dark") desiredTheme = next;
        if (desiredTheme && themeNow() !== desiredTheme && window.Archify && Archify.theme) Archify.theme.toggle();
      } catch (error) {}
    }
    var originalCreate = URL.createObjectURL;
    URL.createObjectURL = function (blob) {
      var url = originalCreate.call(URL, blob);
      try { if (blob) blobByUrl.set(url, blob); } catch (error) {}
      try {
        if (pendingSvg && blob && String(blob.type || "").indexOf("svg") >= 0) {
          var requestId = pendingSvg;
          pendingSvg = null;
          blob.text().then(function (text) { post({ type: "dext-diagram-export", requestId: requestId, format: "svg", content: text }); },
            function (error) { post({ type: "dext-diagram-export", requestId: requestId, format: "svg", error: String(error && error.message || error) }); });
        }
      } catch (error) {}
      return url;
    };
    var originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      try {
        var href = this.getAttribute("href") || "";
        var blob = blobByUrl.get(href);
        if (this.hasAttribute("download") && blob) {
          blobByUrl.delete(href);
          if (String(blob.type || "").indexOf("svg") >= 0) {
            blob.text().then(function (text) { post({ type: "dext-diagram-export", format: "svg", content: text, origin: "toolbar" }); });
            return;
          }
        }
      } catch (error) {}
      return originalClick.apply(this, arguments);
    };
    document.addEventListener("click", function (event) {
      try {
        var target = event.target && event.target.closest ? event.target.closest("[data-node-id]") : null;
        if (!target) return;
        var archifyId = target.getAttribute("data-node-id");
        if (!archifyId) return;
        post({ type: "dext-diagram-node", nodeId: archifyToProject[archifyId] || archifyId });
      } catch (error) {}
    }, true);
    window.addEventListener("message", function (event) {
      var data = event && event.data;
      if (!data || data.__dext !== session || data.type !== "dext-diagram-command") return;
      var requestId = data.requestId;
      try {
        switch (data.command) {
          case "map": archifyToProject = data.nodes || {}; post({ type: "dext-diagram-result", requestId: requestId, ok: true }); return;
          case "theme": applyTheme(data.theme); post({ type: "dext-diagram-state", requestId: requestId, theme: themeNow() }); return;
          case "fullscreen": {
            if (!window.Archify || !Archify.presentation) throw new Error("Archify presentation is unavailable");
            if (data.active) {
              if (presentationBeforeFullscreen === null) presentationBeforeFullscreen = Archify.presentation.active();
              Archify.presentation.enter();
            } else if (presentationBeforeFullscreen !== null) {
              if (presentationBeforeFullscreen) Archify.presentation.enter();
              else Archify.presentation.exit();
              presentationBeforeFullscreen = null;
            }
            break;
          }
          case "export-svg": {
            if (!window.Archify || !Archify.exportMenu) throw new Error("Archify export is unavailable");
            pendingSvg = requestId || "export";
            var button = document.querySelector('.export-menu [data-format="svg"]');
            if (!button) throw new Error("Archify SVG export control is unavailable");
            button.click();
            return;
          }
          case "search": if (!window.Archify || !Archify.finder) throw new Error("Archify finder is unavailable"); Archify.finder.open(); break;
          case "zoom-in": if (!window.Archify || !Archify.view) throw new Error("Archify view is unavailable"); Archify.view.zoomIn(); break;
          case "zoom-out": if (!window.Archify || !Archify.view) throw new Error("Archify view is unavailable"); Archify.view.zoomOut(); break;
          case "reset": if (!window.Archify || !Archify.view) throw new Error("Archify view is unavailable"); Archify.view.reset(); break;
          default: throw new Error("Unknown viewer command");
        }
        var zoomNode = document.querySelector("[data-view-percent]");
        var finder = document.getElementById("node-finder");
        post({ type: "dext-diagram-result", requestId: requestId, ok: true, theme: themeNow(), fonts: document.fonts ? document.fonts.check('13px "JetBrains Mono"') : null, archify: Boolean(window.Archify), explorerVisible: Boolean(document.querySelector(".diagram-nav")) && getComputedStyle(document.querySelector(".diagram-nav")).display !== "none", zoom: zoomNode ? zoomNode.textContent : null, searchOpen: Boolean(finder) && finder.hidden === false });
      } catch (error) {
        post({ type: "dext-diagram-result", requestId: requestId, ok: false, error: String(error && error.message || error) });
      }
    });
    function ready() {
      applyTheme();
      var finish = function () {
        var finder = document.getElementById("node-finder");
        post({
          type: "dext-diagram-ready",
          theme: themeNow(),
          archify: Boolean(window.Archify),
          fonts: document.fonts ? document.fonts.check('13px "JetBrains Mono"') : null,
          fontFaces: document.fonts ? document.fonts.size : null,
          explorerVisible: Boolean(document.querySelector(".diagram-nav")) && getComputedStyle(document.querySelector(".diagram-nav")).display !== "none",
          searchAvailable: Boolean(finder),
          zoom: (document.querySelector("[data-view-percent]") || {}).textContent || null
        });
      };
      try {
        if (document.fonts && typeof document.fonts.load === "function") document.fonts.load('13px "JetBrains Mono"').then(finish, finish);
        else finish();
      } catch (error) { finish(); }
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready);
    else ready();
  })();`;
}

export const VIEWER_COMMANDS = ["map", "theme", "fullscreen", "export-svg", "search", "zoom-in", "zoom-out", "reset"] as const;
export type ViewerCommand = typeof VIEWER_COMMANDS[number];

/** The iframe may only send bridge messages after both the source window and session token match. */
export function isTrustedViewerMessage(sourceWindow: unknown, frameWindow: unknown, data: unknown, session: string): boolean {
  if (!frameWindow || sourceWindow !== frameWindow) return false;
  if (!data || typeof data !== "object") return false;
  return (data as { __dext?: unknown }).__dext === session;
}

/** Host messages from VS Code must never originate from the sandboxed viewer or carry a bridge token. */
export function isTrustedHostMessage(sourceWindow: unknown, frameWindow: unknown, data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  if (frameWindow && sourceWindow === frameWindow) return false;
  return !(data as { __dext?: unknown }).__dext;
}

export function isViewerCommand(value: unknown): value is ViewerCommand {
  return typeof value === "string" && (VIEWER_COMMANDS as readonly string[]).includes(value);
}

