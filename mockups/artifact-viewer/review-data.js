/* Hard-coded from /home/morten/code/chat-app/.semantic-review on 2026-08-19. */
window.REVIEW_DATA = {
  title: "Build a Slack-like team chat application",
  summary: "Create a polished responsive web chat with channels, real-time messages, search, and presence cues.",
  requirement: {
    id: "team-chat",
    title: "Basic web-based team chat",
    summary: "Users can navigate channels, exchange messages in real time, search message history, and understand who is active from a responsive Slack-inspired interface.",
    acceptance: [
      "The application presents a polished Slack-inspired workspace, channel navigation, message area, and mobile-friendly layout.",
      "Users can switch channels and send messages that persist and update reactively.",
      "Users can search persisted message history and inspect matching results.",
      "The interface communicates which teammates are active without requiring authentication in this local v1.",
      "Type checking, production build, and representative desktop and mobile browser acceptance paths pass."
    ]
  },
  stages: [
    {
      id: "responsive-chat-shell",
      title: "Deliver the responsive chat workspace shell",
      summary: "Scaffold the local application and replace the starter with a polished, interactive Slack-inspired workspace using representative channel and message data.",
      rationale: "A complete visual shell makes layout, navigation, density, and responsive behavior independently reviewable before live backend state is introduced.",
      nodes: [
        {
          id: "establish-application-runtime",
          title: "Establish the application runtime",
          description: "Establish the Next.js, Convex, shadcn, and pnpm runtime foundation with repeatable local configuration and generated type bindings.",
          context: [
            { type: "lesson", title: "A build configuration that did not work", body: "The scaffold's legacy pnpm build allowlist was ignored, so the runtime now uses pnpm 11's supported allowBuilds configuration." },
            { type: "evidence", title: "Foundation checks passed", body: "TypeScript and lint checks completed successfully, with only non-blocking warnings in scaffolded files." }
          ]
        },
        {
          id: "render-responsive-workspace",
          title: "Render the responsive workspace",
          description: "Render the Northstar workspace with channel navigation, representative conversations, a functional local composer, member context, and a mobile drawer.",
          context: [
            { type: "decision", title: "Build the visible shell first", body: "Responsive layout, navigation density, composer behavior, and visual hierarchy can be reviewed independently before persisted data is introduced." },
            { type: "assumption", title: "Designed for a small team", body: "The initial experience favors small product and engineering teams. Enterprise administration may require different navigation and information density." },
            { type: "evidence", title: "Desktop flow verified", body: "The full workspace rendered at 1280×800; channel switching and sending a message worked without console errors." },
            { type: "evidence", title: "Mobile flow verified", body: "At 390×844 the conversation and composer fit, and the labeled navigation opened the channel drawer over a scrim." }
          ]
        }
      ]
    },
    {
      id: "realtime-channel-messaging",
      title: "Persist channels and deliver real-time messaging",
      summary: "Model channels and messages in Convex, seed the initial workspace safely, render reactive channel timelines, and persist composer submissions.",
      rationale: "Channel navigation and message delivery form one vertical interaction loop and are the direct data prerequisite for cross-channel search.",
      nodes: [
        {
          id: "model-indexed-channel-data",
          title: "Model indexed channel data",
          description: "Model channels and messages in Convex, expose bounded indexed queries and a validated server-side send mutation, and seed the workspace idempotently.",
          context: [
            { type: "decision", title: "Use bounded reactive queries", body: "Reactive queries keep open clients current while explicit indexes and result caps prevent unbounded table scans." },
            { type: "assumption", title: "A demo author is enough for local v1", body: "Messages use a server-defined demo identity. User accounts would require verified identity and channel-membership rules." },
            { type: "risk", title: "Timelines show only recent messages", body: "Each channel initially exposes a bounded latest timeline. The channel index leaves a clear path to cursor pagination." },
            { type: "evidence", title: "Safe seeding verified", body: "Running the workspace seed twice created no duplicate records." },
            { type: "evidence", title: "Persistence verified in the browser", body: "A message sent through the composer remained visible after reloading the application." }
          ]
        },
        {
          id: "connect-reactive-conversation",
          title: "Connect the reactive conversation",
          description: "Replace browser-only messages with reactive channel data and durable sends while preserving drafts when a mutation fails.",
          context: [
            { type: "decision", title: "Use bounded reactive queries", body: "One reactive data path keeps navigation and conversations current while protecting the first release from unbounded reads." },
            { type: "assumption", title: "A demo author is enough for local v1", body: "The local-only scope deliberately postpones authentication and channel membership." },
            { type: "evidence", title: "Messaging checks passed", body: "Static checks passed and a sent message survived reload while the interaction stayed reactive." }
          ]
        }
      ]
    },
    {
      id: "search-presence-verification",
      title: "Make conversations searchable and verify the experience",
      summary: "Add persisted message search, clarify active teammate cues, and exercise the complete responsive chat acceptance paths.",
      rationale: "Search and presence complete the discovery and awareness loop after the durable messaging foundation is independently reviewable.",
      nodes: [
        {
          id: "search-persisted-conversations",
          title: "Search persisted conversations",
          description: "Index persisted message bodies, return bounded channel-aware matches, and present responsive search results that navigate directly to their conversation.",
          context: [
            { type: "decision", title: "Use bounded full-text search", body: "Native search avoids client-side scans; a twenty-result cap keeps channel enrichment predictable." },
            { type: "lesson", title: "A stale backend hid the new search", body: "The database was reachable but its code watcher had stopped. Restarting the exact watcher and invoking the query proved deployment." },
            { type: "risk", title: "The workspace is intentionally unauthenticated", body: "Any local client can read, search, and send. Identity and membership checks are required before shared deployment." },
            { type: "evidence", title: "Search verified end to end", body: "The index returned both matching messages with channel context; desktop and mobile search navigated to the correct conversations." }
          ]
        },
        {
          id: "communicate-active-teammates",
          title: "Communicate active teammates",
          description: "Surface a compact active-now signal beside channel actions while retaining the detailed local presence roster.",
          context: [
            { type: "assumption", title: "Presence is an explicit demo roster", body: "The local v1 does not imply live heartbeat state. A shared version would need authenticated presence heartbeats." },
            { type: "risk", title: "The workspace is intentionally unauthenticated", body: "The active roster is suitable for a local demo only, not a published multi-user workspace." },
            { type: "evidence", title: "Presence remained clear at both sizes", body: "The three-active cue and detailed roster stayed understandable in desktop and mobile acceptance flows." }
          ]
        },
        {
          id: "keep-production-fallback-clean",
          title: "Keep the production fallback clean",
          description: "Remove external image and unused-prop lint warnings from the application error fallback used by production builds.",
          context: [
            { type: "evidence", title: "Production gates passed cleanly", body: "TypeScript, ESLint, and the optimized production build completed without errors or warnings." }
          ]
        }
      ]
    }
  ]
};
