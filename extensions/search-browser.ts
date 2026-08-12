import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // State: false = terminal only (no browser), true = open browser curator
  let openBrowser = false;

  pi.on("session_start", async (_event, ctx) => {
    // Restore state if saved
    const entries = ctx.sessionManager.getEntries();
    for (const e of entries) {
      if (e.category === "extension" && e.data?.key === "searchBrowserMode") {
        openBrowser = e.data.value === "on";
        break;
      }
    }
    ctx.ui.notify(`Search browser: ${openBrowser ? "ON" : "OFF"}`, "info");
  });

  // Intercept web_search calls and set workflow
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "web_search") {
      // If workflow not explicitly set by the model, apply our preference
      if (!event.input.workflow) {
        event.input.workflow = openBrowser ? "summary-review" : "none";
      }
    }
  });

  // Command to toggle: /search-browser [on|off|toggle]
  pi.registerCommand("search-browser", {
    description: "Toggle browser curator for web searches",
    handler: async (args, ctx) => {
      const arg = (args || "").trim().toLowerCase();

      if (arg === "on") {
        openBrowser = true;
      } else if (arg === "off") {
        openBrowser = false;
      } else {
        openBrowser = !openBrowser;
      }

      ctx.ui.notify(`Search browser: ${openBrowser ? "ON (opens curator)" : "OFF (terminal only)"}`, "info");
    },
  });
}
