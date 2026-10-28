/**
 * `/side` = `/btw` (side question): the bookkeeping of the ephemeral fork Codex answers it in.
 *
 * The transport (`codex.ts`) drives the protocol: `thread/fork {ephemeral}` → `thread/inject_items` (the boundary
 * prompt) → `turn/start` on the fork → … → `turn/interrupt` (only when the turn is still running) +
 * `thread/unsubscribe`. This module collects what the fork says while that happens and turns it into the DSH
 * command result. Nothing here ever reaches the main thread's projection or token accounting: the notifications of
 * the side thread are routed to a {@link CodexSideRun} and nowhere else.
 */
import { asRecord, messageOf, readString, type JsonRecord } from './codex-json.ts'
import { readableServiceErrorMessage } from './codex-projection.ts'
import type { NativeCommandResult } from './contract.ts'

/** TUI refusal: nothing to fork yet (`thread/fork` fails for a thread without a first turn). */
export const SIDE_NOT_STARTED_MESSAGE =
  "'/side' is unavailable until the current conversation has started. Send a message first, then try /side again."
/** TUI refusal: a code review is running. */
export const SIDE_REVIEW_RUNNING_MESSAGE = "'/side' is unavailable while code review is running."
export const SIDE_USAGE_MESSAGE = 'Usage: /btw <question>'
/** One side run at a time, as in the TUI (which answers "A side conversation is already open"). */
export const SIDE_ALREADY_RUNNING_MESSAGE = 'A side question is already running. Wait for its answer before asking another.'

/** What a failed `thread/fork` means to the user. */
export function sideStartFailure(error: unknown): string {
  const text = messageOf(error)
  if (text.includes('no rollout found for thread id') || text.includes('includeTurns is unavailable before first user message')) {
    return SIDE_NOT_STARTED_MESSAGE
  }
  return `Failed to start side conversation: ${text}`
}

interface SideMessage {
  text: string
  phase: string | undefined
}

/** What a finished (or abandoned) side turn left behind. */
export interface CodexSideOutcome {
  /** `completed`, `interrupted` or `failed`; `undefined` when the turn never completed. */
  readonly status: string | undefined
  readonly answer: string
  readonly error: string | undefined
  /** What the fork asked for and was refused, in a few words each. */
  readonly declined: readonly string[]
}

/** The notifications and requests of one side thread, collected until its turn completes. */
export class CodexSideRun {
  /** Set as soon as the fork answered; every notification of this thread belongs to this run. */
  threadId: string | undefined
  turnId: string | undefined

  private readonly messages = new Map<string, SideMessage>()
  private readonly completions = new Map<string, JsonRecord>()
  private readonly declined = new Set<string>()
  private completedTurn: JsonRecord | undefined
  private errorMessage: string | undefined
  private readonly settled = Promise.withResolvers<void>()

  constructor() {
    // A run can fail (the process exits) before anything awaits it.
    this.settled.promise.catch(() => undefined)
  }

  /** Resolves when the side turn completed; rejects when the transport can no longer finish it. */
  get done(): Promise<void> {
    return this.settled.promise
  }

  /** The side turn reached a terminal state. */
  get completed(): boolean {
    return this.completedTurn !== undefined
  }

  /** The turn id comes from the `turn/start` response or from `turn/started`, whichever is first. */
  identify(turnId: string): void {
    if (this.turnId !== undefined) return
    this.turnId = turnId
    // The turn may have completed before its id was known.
    const early = this.completions.get(turnId)
    if (early !== undefined) this.complete(early)
  }

  fail(error: Error): void {
    this.settled.reject(error)
  }

  /** The fork asked for something nobody can approve: `what` says what, in a few words. */
  decline(what: string | undefined): void {
    this.declined.add(what ?? 'do something that needs approval')
  }

  handle(method: string, params: JsonRecord): void {
    switch (method) {
      case 'turn/started': {
        const turnId = readString(asRecord(params['turn']), 'id')
        if (turnId !== undefined) this.identify(turnId)
        return
      }
      case 'turn/completed': {
        const turn = asRecord(params['turn'])
        const turnId = readString(turn, 'id')
        if (turn === undefined || turnId === undefined) return
        this.completions.set(turnId, turn)
        if (this.turnId === turnId) this.complete(turn)
        return
      }
      case 'item/agentMessage/delta': {
        const itemId = readString(params, 'itemId')
        const delta = readString(params, 'delta')
        if (itemId !== undefined && delta !== undefined) this.message(itemId).text += delta
        return
      }
      case 'item/started':
      case 'item/completed': {
        const item = asRecord(params['item'])
        const id = readString(item, 'id')
        if (readString(item, 'type') !== 'agentMessage' || id === undefined) return
        const message = this.message(id)
        message.phase = readString(item, 'phase') ?? message.phase
        // The finished item is authoritative; the deltas only make up for an item that never completes.
        const text = readString(item, 'text')
        if (method === 'item/completed' && text !== undefined && text !== '') message.text = text
        return
      }
      case 'error': {
        if (params['willRetry'] === true) return
        this.errorMessage = readString(asRecord(params['error']), 'message') ?? this.errorMessage
        return
      }
      default:
        return
    }
  }

  outcome(): CodexSideOutcome {
    const all = [...this.messages.values()]
    const finals = all.filter((message) => message.phase === 'final_answer')
    const answer = (finals.length > 0 ? finals : all)
      .map((message) => message.text.trim())
      .filter((text) => text !== '')
      .join('\n\n')
    const turnError = readString(asRecord(this.completedTurn?.['error']), 'message')
    return {
      status: readString(this.completedTurn, 'status'),
      answer,
      error: this.errorMessage ?? turnError,
      declined: [...this.declined],
    }
  }

  private message(itemId: string): SideMessage {
    let message = this.messages.get(itemId)
    if (message === undefined) {
      message = { text: '', phase: undefined }
      this.messages.set(itemId, message)
    }
    return message
  }

  private complete(turn: JsonRecord): void {
    this.completedTurn = turn
    this.settled.resolve()
  }
}

/** The command result for a side run that has ended (the run's `outcome()`), with the refusals it met. */
export function sideCommandResult(outcome: CodexSideOutcome): NativeCommandResult {
  const note =
    outcome.declined.length === 0
      ? ''
      : `\n\n_Side questions cannot approve actions. Declined: ${outcome.declined.join(', ')}._`
  if (outcome.status === 'completed' && outcome.answer !== '') return { kind: 'success', text: `${outcome.answer}${note}` }
  const reason =
    outcome.status === 'interrupted'
      ? 'The side conversation was interrupted.'
      : outcome.error !== undefined
        ? readableServiceErrorMessage(outcome.error)
        : outcome.status === 'completed'
          ? 'The side conversation finished without an answer.'
          : 'The side conversation failed.'
  return { kind: 'error', text: `${reason}${note}` }
}
