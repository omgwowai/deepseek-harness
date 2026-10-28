# Slash commands and shortcuts of the native Agents

[中文](native-commands.md)

Applies to the Claude Code 2.1.296, Codex 0.162.1, and Oh My Pi 18.12.6 routes that run over their native protocols (DSH `0.2.1-rc.2`). Each route registers its command catalog as session-scoped DSH commands: type `/` to see them in the menu, and `/help` lists the current Agent's commands and how each runs. Design and boundaries: [Native reuse and compatibility boundaries](native-reuse.en.md).

Legend: ✅ answers at once, without a model call or a turn; ✅ turn is sent to the Agent as the next turn (like `/compact` before); ◐ partial; ✗ the Agent has no machine-protocol path for it.

| Command | What it does | Claude Code | Codex | Oh My Pi |
|---|---|---|---|---|
| `/btw <question>` | Side question while the main task keeps running; the answer is shown in DSH only and never enters the Agent's conversation | ✅ | ✅ (also `/side`) | ✅ |
| `/clear`, `/new` | Clear the Agent's context; a restart does not bring it back | ✅ | ✅ | ✅ |
| `/compact` | Compact the context | ✅ turn | ✅ turn | ✅ turn |
| `/rewind` | Go back to before a message: `/rewind` lists, `/rewind <n>` previews, `/rewind <n> confirm` does it; add `code` or `chat` for files or conversation only | ✅ files (checkpoints) + conversation | ✅ files (the Agent's recorded changes reversed; conflicts left alone) + conversation | ✅ conversation (continues in a session branched at that point); files: `edit` changes are reversed, files written with `write` are reported as not restorable (no prior content recorded) |
| `/goal` | Native goal mode: `/goal` shows it, `/goal <objective>` sets it, `/goal clear` drops it; `pause` / `resume` where supported | ✅ turn (the CLI's own goal) | ✅ turn (the turn stays open while Codex pursues the goal; Stop pauses it) | ✅ turn (the turn stays open while the goal runs; Stop pauses it) |
| `/plan` | Plan mode; `/plan off` restores the previous mode | ✅ native plan mode | ✅ native Plan collaboration mode | ◐ DSH text plan only (omp's interface has no plan mode) |
| `/effort [level]` | Reasoning effort, in sync with the model menu | ✅ | ✅ | ✅ |
| `/fast` | Fast mode | ◐ not offered to Claude on this route | ◐ only when the model has a Fast tier | ✅ (also `/slow`) |
| `/model` | Change the model | DSH model menu | DSH model menu | DSH model menu |
| `/status` | Session status | ✅ | ✅ (goal and limits included) | ✗ (use `/session`, ✅ turn) |
| `/context` | Context usage | ✅ | ◐ see `/status` | ✅ turn |
| `/usage`, `/cost` | Usage and cost | ✅ | ◐ see `/status` | ✅ turn |
| `/mcp` | MCP status and reconnect | ✅ | ✅ | ✅ turn |
| `/skills` | Skill list | ✅ | ✅ (enable/disable) | ✗ (skills can still be invoked) |
| `/memory` | Memory files | ✅ read-only | ✗ | ✅ turn |
| `/hooks` | Hook list | ✅ | ✅ | ✗ |
| `/tasks`, `/ps`, `/jobs` | Background tasks | ✅ `/tasks` (stop, read output) | ✅ `/ps`, `/stop` | ✅ turn `/jobs` |
| `/diff` | Uncommitted changes | ✅ | ✅ | ✗ |
| `/permissions` | Permission rules | ✅ read-only | DSH mode menu | DSH mode menu |
| `/init`, `/review` | Write the instructions file, code review | ✅ turn | ✅ turn | ✅ turn |
| `/rename` | Rename the session | ◐ inside the Agent only | ◐ same | ◐ same |
| `/help` | The current Agent's commands and how each runs | ✅ | ✅ | ✅ |
| `!command` | Run a shell command directly, without the model | ✅ | ✅ | ✅ |
| Custom, skill, and plugin commands | The Agent's own extensions | ✅ turn | ✅ turn | ✅ turn |
| `/export`, resume, fork | Session management | DSH's own | DSH's own | DSH's own |
| `/theme`, `/vim`, `/login`, … | Terminal UI and account | explained, never sent to the model | same | same |

Limits:

- While a tool-approval card is open, DSH replaces the composer with the card; answer it before typing a command.
- A blank session without any message does not show command results yet; they appear in its history after the first message.
- DSH's session log is append-only: after `/rewind` or `/clear` the rewound or cleared messages stay visible in DSH although the Agent no longer remembers them. Side effects of shell commands are never undone.
- Turns Claude Code starts on its own after a background task finishes are not shown (this needs host-side task wake support).
