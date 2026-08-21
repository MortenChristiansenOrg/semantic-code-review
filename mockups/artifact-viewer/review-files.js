/* Hard-coded file membership and representative Git excerpts from
   /home/morten/code/chat-app/.semantic-review and its bound stage revisions. */
(function () {
  "use strict";

  const stageDefinitions = {
    "responsive-chat-shell": [
      {
        nodeId: "establish-application-runtime",
        classification: "configuration",
        paths: [
          ".gitignore",
          "team-chat/.eslintrc.json",
          "team-chat/.gitignore",
          "team-chat/.prettierignore",
          "team-chat/.prettierrc",
          "team-chat/app/ConvexClientProvider.tsx",
          "team-chat/components.json",
          "team-chat/components/ConvexClientProvider.tsx",
          "team-chat/convex/schema.ts",
          "team-chat/convex/tsconfig.json",
          "team-chat/eslint.config.mjs",
          "team-chat/next.config.ts",
          "team-chat/pnpm-workspace.yaml",
          "team-chat/postcss.config.mjs",
          "team-chat/tailwind.config.ts",
          "team-chat/tsconfig.json"
        ]
      },
      {
        nodeId: "establish-application-runtime",
        classification: "documentation",
        paths: [
          "team-chat/AGENTS.md",
          "team-chat/CLAUDE.md",
          "team-chat/README.md",
          "team-chat/convex/README.md"
        ]
      },
      {
        nodeId: "establish-application-runtime",
        classification: "behavior",
        paths: [
          "team-chat/app/error.tsx",
          "team-chat/components/Code.tsx",
          "team-chat/components/ThemeToggle.tsx",
          "team-chat/components/UserMenu.tsx",
          "team-chat/components/ui/button.tsx",
          "team-chat/components/ui/card.tsx",
          "team-chat/components/ui/dropdown-menu.tsx",
          "team-chat/components/ui/input.tsx",
          "team-chat/components/ui/toggle-group.tsx",
          "team-chat/components/ui/toggle.tsx",
          "team-chat/lib/utils.ts"
        ]
      },
      {
        nodeId: "establish-application-runtime",
        classification: "generated",
        paths: [
          "team-chat/convex/_generated/ai/ai-files.state.json",
          "team-chat/convex/_generated/ai/guidelines.md",
          "team-chat/convex/_generated/api.d.ts",
          "team-chat/convex/_generated/api.js",
          "team-chat/convex/_generated/dataModel.d.ts",
          "team-chat/convex/_generated/server.d.ts",
          "team-chat/convex/_generated/server.js",
          "team-chat/public/convex.svg",
          "team-chat/skills-lock.json"
        ]
      },
      {
        nodeId: "establish-application-runtime",
        classification: "dependency",
        paths: ["team-chat/package.json", "team-chat/pnpm-lock.yaml"]
      },
      {
        nodeId: "render-responsive-workspace",
        classification: "behavior",
        paths: [
          "team-chat/app/globals.css",
          "team-chat/app/layout.tsx",
          "team-chat/app/page.tsx"
        ]
      }
    ],
    "realtime-channel-messaging": [
      {
        nodeId: "model-indexed-channel-data",
        classification: "behavior",
        paths: ["team-chat/convex/schema.ts", "team-chat/convex/chat.ts"]
      },
      {
        nodeId: "model-indexed-channel-data",
        classification: "generated",
        paths: ["team-chat/convex/_generated/api.d.ts"]
      },
      {
        nodeId: "connect-reactive-conversation",
        classification: "behavior",
        paths: ["team-chat/app/page.tsx", "team-chat/app/globals.css"]
      }
    ],
    "search-presence-verification": [
      {
        nodeId: "search-persisted-conversations",
        classification: "behavior",
        paths: [
          "team-chat/convex/schema.ts",
          "team-chat/convex/chat.ts",
          "team-chat/app/page.tsx",
          "team-chat/app/globals.css"
        ]
      },
      {
        nodeId: "communicate-active-teammates",
        classification: "behavior",
        paths: ["team-chat/app/page.tsx", "team-chat/app/globals.css"]
      },
      {
        nodeId: "keep-production-fallback-clean",
        classification: "chore",
        paths: ["team-chat/app/error.tsx"]
      }
    ]
  };

  const modifiedStages = new Set([
    "realtime-channel-messaging",
    "search-presence-verification"
  ]);

  function projectFor(path) {
    return path.startsWith("team-chat/")
      ? { root: "team-chat", name: "team-chat" }
      : { root: ".", name: "Repository root" };
  }

  function buildFiles(stageId, definitions) {
    const byPath = new Map();
    definitions.forEach((definition) => definition.paths.forEach((path) => {
      if (!byPath.has(path)) {
        byPath.set(path, {
          path,
          kind: modifiedStages.has(stageId) ? "modified" : "added",
          project: projectFor(path),
          memberships: []
        });
      }
      byPath.get(path).memberships.push({
        nodeId: definition.nodeId,
        classification: definition.classification
      });
    }));
    if (stageId === "realtime-channel-messaging") {
      byPath.get("team-chat/convex/chat.ts").kind = "added";
    }
    return [...byPath.values()];
  }

  const filesByStage = Object.fromEntries(
    Object.entries(stageDefinitions).map(([stageId, definitions]) => [
      stageId,
      buildFiles(stageId, definitions)
    ])
  );

  const diffs = {
    "realtime-channel-messaging:team-chat/convex/chat.ts": {
      additions: 150,
      deletions: 0,
      lines: [
        ["hunk", "@@ -0,0 +1,150 @@"],
        ["add", "1", "import { v } from \"convex/values\";"],
        ["add", "2", ""],
        ["add", "3", "import { mutation, query } from \"./_generated/server\";"],
        ["add", "25", "export const listChannels = query({"],
        ["add", "26", "  args: {},"],
        ["add", "29", "    return await ctx.db.query(\"channels\").withIndex(\"by_order\").take(50);"],
        ["add", "43", "export const sendMessage = mutation({"],
        ["add", "51", "    const body = args.body.trim();"],
        ["add", "58", "    return await ctx.db.insert(\"messages\", {"],
        ["gap", "82 unchanged lines"],
        ["add", "149", "});"]
      ]
    },
    "realtime-channel-messaging:team-chat/app/page.tsx": {
      additions: 70,
      deletions: 34,
      lines: [
        ["hunk", "@@ -192,14 +196,41 @@ export default function Home()"],
        ["del", "192", "const [localMessages, setLocalMessages] = useState({});"],
        ["add", "196", "const [sending, setSending] = useState(false);"],
        ["add", "199", "const liveChannels = useQuery(api.chat.listChannels, {});"],
        ["add", "200", "const sendMessage = useMutation(api.chat.sendMessage);"],
        ["add", "215", "const liveMessages = useQuery("],
        ["add", "216", "  api.chat.listMessages,"],
        ["add", "217", "  activeChannelDocument ? { channelId: activeChannelDocument._id } : \"skip\","],
        ["hunk", "@@ -209,24 +240,19 @@"],
        ["del", "209", "function sendLocalMessage(event) {"],
        ["add", "240", "async function submitMessage(event) {"],
        ["add", "248", "  await sendMessage({ channelId: activeChannelDocument._id, body });"],
        ["add", "251", "  setSendError(\"Message not sent. Your draft is still here—try again.\");"]
      ]
    },
    "realtime-channel-messaging:team-chat/convex/schema.ts": {
      additions: 20,
      deletions: 0,
      lines: [
        ["hunk", "@@ -2,4 +2,24 @@"],
        ["add", "4", "export default defineSchema({"],
        ["add", "5", "  channels: defineTable({"],
        ["add", "10", "  }).index(\"by_slug\", [\"slug\"]).index(\"by_order\", [\"order\"]),"],
        ["add", "11", "  messages: defineTable({"],
        ["add", "22", "  }).index(\"by_channel_id\", [\"channelId\"]),"],
        ["add", "23", "});"]
      ]
    },
    "search-presence-verification:team-chat/convex/schema.ts": {
      additions: 6,
      deletions: 1,
      lines: [
        ["hunk", "@@ -22,4 +22,9 @@ export default defineSchema"],
        ["del", "22", "}).index(\"by_channel_id\", [\"channelId\"]),"],
        ["add", "22", "})"],
        ["add", "23", "  .index(\"by_channel_id\", [\"channelId\"])"],
        ["add", "24", "  .searchIndex(\"search_body\", {"],
        ["add", "25", "    searchField: \"body\","],
        ["add", "26", "    filterFields: [\"channelId\"],"],
        ["add", "27", "  }),"]
      ]
    },
    "search-presence-verification:team-chat/app/error.tsx": {
      additions: 3,
      deletions: 8,
      lines: [
        ["hunk", "@@ -4,5 +4,4 @@"],
        ["del", "5", "error: _error,"],
        ["hunk", "@@ -32,10 +31,7 @@"],
        ["del", "32", "<img src=\"https://chef.convex.dev/chef.svg\" alt=\"\" />"],
        ["add", "31", "<span aria-hidden=\"true\" style={{ color: \"#7657e8\", fontSize: 38 }}>"],
        ["add", "32", "  ✦"],
        ["add", "33", "</span>"]
      ]
    },
    "responsive-chat-shell:team-chat/app/page.tsx": {
      additions: 534,
      deletions: 0,
      lines: [
        ["hunk", "@@ -0,0 +1,534 @@"],
        ["add", "1", "\"use client\";"],
        ["add", "3", "import { FormEvent, useMemo, useState } from \"react\";"],
        ["add", "29", "type Channel = {"],
        ["add", "172", "export default function Home() {"],
        ["add", "193", "const [activeChannelId, setActiveChannelId] = useState(\"general\");"],
        ["gap", "334 unchanged added lines"],
        ["add", "531", "}"]
      ]
    },
    "search-presence-verification:team-chat/app/page.tsx": {
      additions: 88,
      deletions: 8,
      lines: [
        ["hunk", "@@ -196,5 +196,8 @@ export default function Home()"],
        ["add", "199", "const [searchOpen, setSearchOpen] = useState(false);"],
        ["add", "200", "const [searchTerm, setSearchTerm] = useState(\"\");"],
        ["add", "205", "const searchResults = useQuery(api.chat.searchMessages, queryArgs);"],
        ["hunk", "@@ -430,4 +448,16 @@"],
        ["add", "448", "<SearchResults results={searchResults} onSelect={openConversation} />"],
        ["gap", "62 unchanged lines"],
        ["add", "529", "<span className=\"active-now\">3 active now</span>"]
      ]
    }
  };

  window.REVIEW_FILE_DATA = { filesByStage, diffs };
})();
