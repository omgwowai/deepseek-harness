/** Real official bundles + ACP transport. Only translation/recognition are simulated. */
import type {} from '@deepseek-ai/dsh-experimental-speech-to-text'
import type { SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Locator, Page } from 'playwright'
import { expect, it, vi } from 'vitest'
import { connectFreshWorkspace, expandOwningTurnProcess, writeComposerDraft } from '#host-support'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { launchAdapterWorld, root, type AdapterWorld } from './scaffold.ts'
import { required } from './required.ts'
import type { ObservedEvent } from './types.ts'

const shots = join(root, '.local/optional-input-ui', process.env.DSH_E2E_ELECTRON ? 'electron' : 'web')
const browserOptions = {
  headless: true,
  ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}),
}

async function configureAgent(host: AdapterWorld, scratch: string) {
  await host.ctx.settings.replace('dsh-acp-adapter', {
    agents: {
      'optional-ui': {
        name: 'Offline optional UI',
        command: process.execPath,
        args: [join(root, 'test/e2e/fixtures/optional-input-ui/agent.ts')],
        runtime: 'antigravity',
        env: { HOME: host.workspaceCwd, OPTIONAL_UI_GATE: scratch, OPTIONAL_UI_LOG: join(scratch, 'prompts.jsonl') },
      },
    },
  })
  await vi.waitFor(() =>
    expect(host.ctx.llm.listProviders().some((entry) => entry.id === 'acp-optional-ui')).toBe(true),
  )
  await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-optional-ui', model: 'mock-model-a' })
}
async function submit(page: Page, prompt: string) {
  await writeComposerDraft(page, page.locator('[data-composer-input]').first(), prompt)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
}
async function expandReasoning(page: Page, row: Locator) {
  await row.waitFor({ state: 'attached' })
  await expandOwningTurnProcess(page, row)
  await row.waitFor()
  if ((await row.getAttribute('data-expanded')) !== 'true') await row.locator('[data-disclosure-row]').first().click()
  await row.locator('[data-cot-translation="true"]').waitFor()
}
async function capture(host: AdapterWorld, page: Page, name: string, target: Locator) {
  mkdirSync(shots, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await host.ctx.settings.replace('ui-theme', { preference: theme })
    await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe(theme)
    for (const width of [1280, 420]) {
      await page.setViewportSize({ width, height: 900 })
      await target.scrollIntoViewIfNeeded()
      const box = required(await target.boundingBox(), 'Visible official UI')
      expect(box.x).toBeGreaterThanOrEqual(-1)
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1)
      await page.screenshot({ path: join(shots, `${name}.${theme}.${width}.png`), animations: 'disabled' })
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 })
}

it('uses the official CoT renderer for ACP streaming, originals, durable translations and cancellation', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-acp-cot-'))
  const calls: { text: string; target: string; credentials: boolean }[] = []
  const errors: unknown[] = []
  const held = new Set<ServerResponse>()
  let cancelledRequest = false
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://fixture.invalid')
      expect(url.pathname).toBe('/bing')
      expect(request.method).toBe('POST')
      expect(url.searchParams.get('isEnterpriseClient')).toBe('false')
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!Array.isArray(body) || body.length !== 1 || typeof body[0] !== 'string')
        throw new Error('Expected one Bing text fragment')
      const text = body[0],
        target = url.searchParams.get('to') ?? ''
      calls.push({
        text,
        target,
        credentials: request.headers.authorization !== undefined || request.headers.cookie !== undefined,
      })
      if (text === 'Cancel paragraph.') {
        held.add(response)
        response.once('close', () => {
          held.delete(response)
          cancelledRequest = true
        })
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify([{ translations: [{ text: `译文：${text}`, to: target }] }]))
    })().catch((error: unknown) => {
      errors.push(error)
      if (!response.destroyed) {
        response.writeHead(500)
        response.end()
      }
    })
  })
  let host: AdapterWorld | undefined, browser: TestBrowser | undefined, page: Page | undefined
  const events: ObservedEvent[] = []
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected loopback translator')
    const endpoint = `http://127.0.0.1:${address.port}/bing`
    host = await launchAdapterWorld({
      optionalBundles: ['cot-translation-bundle'],
      extraPatches: [
        `- id: translator\n  config: ${JSON.stringify({ googleEndpoint: endpoint, bingEndpoint: endpoint, timeoutMs: 120_000 })}\n`,
        '- id: cot-translation\n  config:\n    provider: bing\n    targetLanguage: zh\n',
      ],
    })
    host.ctx.on('session/event', (session, event) => events.push({ sessionId: session.id, ...event }))
    await configureAgent(host, scratch)
    browser = await launchBrowser(browserOptions)
    page = await newEnglishPage(browser)
    page.on('pageerror', (error) => errors.push(error))
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    const settled = host.whenTurnSettled(30_000)
    void settled.catch(() => {})
    await submit(page, 'COT_STREAM')
    let row = page.locator('[data-variant="think"]').last()
    await expandReasoning(page, row)
    let body = row.locator('[data-cot-translation="true"]')
    await body.getByText('译文：First paragraph.', { exact: true }).waitFor()
    expect(await body.innerText()).toContain('Unfinished tail')
    expect(calls.map((call) => call.text)).toEqual(['First paragraph.'])
    await body.getByRole('button', { name: 'View original', exact: true }).click()
    expect(await body.innerText()).toContain('First paragraph.\n\nUnfinished tail')
    expect(await body.innerText()).not.toContain('译文：')
    await body.getByRole('button', { name: 'View translation', exact: true }).click()
    writeFileSync(join(scratch, 'continue'), 'ready')
    const sessionId = await settled
    await page.getByText('COT_DONE', { exact: true }).waitFor()
    await expandReasoning(page, row)
    await expect.poll(() => body.innerText()).toContain('译文：Unfinished tail completed.')
    await expect.poll(() => body.getAttribute('data-translation-state')).toBe('ready')
    const original = 'First paragraph.\n\nUnfinished tail completed.'
    const message = required(
      events.filter((event) => event.type === 'assistant/message').findLast((event) => event.sessionId === sessionId),
    )
    expect(message.data.message.content).toEqual([
      { type: 'reasoning', text: original },
      { type: 'text', text: 'COT_DONE' },
    ])
    const requests = calls.length
    await page.reload()
    row = page.locator('[data-variant="think"]').last()
    await expandReasoning(page, row)
    body = row.locator('[data-cot-translation="true"]')
    await expect.poll(() => body.innerText()).toContain('译文：Unfinished tail completed.')
    await expect.poll(() => body.getAttribute('data-translation-state')).toBe('ready')
    expect(calls.length).toBe(requests)
    await body.getByRole('button', { name: 'View original', exact: true }).click()
    expect(await body.innerText()).toContain(original)
    await body.getByRole('button', { name: 'View translation', exact: true }).click()
    await capture(host, page, 'cot', body)
    const cancelled = host.whenTurnSettled(30_000)
    void cancelled.catch(() => {})
    await submit(page, 'COT_CANCEL')
    // Wait for the new turn's reasoning identity, not the previous expanded row.
    // ACP prompt admission returns before the first thought reaches the browser.
    const cancelRow = page.locator('[data-variant="think"]').filter({ hasText: 'Cancel paragraph.' })
    await expandReasoning(page, cancelRow)
    await expect.poll(() => held.size).toBe(1)
    await cancelRow.locator('[data-disclosure-row]').first().click()
    await expect.poll(() => cancelledRequest).toBe(true)
    await page.getByRole('button', { name: 'Stop generating', exact: true }).click()
    await cancelled
    // The official Bing adapter canonicalizes zh to its wire language zh-Hans.
    expect(calls).toEqual(
      ['First paragraph.', 'Unfinished tail completed.', 'Cancel paragraph.'].map((text) => ({
        text,
        target: 'zh-Hans',
        credentials: false,
      })),
    )
    expect(errors).toEqual([])
  } catch (error) {
    if (page) {
      mkdirSync(shots, { recursive: true })
      await page.screenshot({ path: join(shots, 'cot.failure.png') }).catch(() => {})
    }
    throw error
  } finally {
    for (const response of held) response.destroy()
    await browser?.close()
    await host?.close()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    rmSync(scratch, { recursive: true, force: true })
  }
})

// Electron's helper does not forward media flags. Keep this virtual-device test web-only.
it.skipIf(Boolean(process.env.DSH_E2E_ELECTRON))(
  'dictates through the official composer, protects drafts, cancels and coexists with ACP permission questions',
  async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'dsh-acp-voice-'))
    let host: AdapterWorld | undefined, browser: TestBrowser | undefined, page: Page | undefined
    const errors: unknown[] = []
    let transcriptions = 0,
      aborted = 0,
      hold = false
    let release: (() => void) | undefined
    const events: ObservedEvent[] = []
    const prompts = () =>
      existsSync(join(scratch, 'prompts.jsonl'))
        ? readFileSync(join(scratch, 'prompts.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { text: string; blocks: { type: string }[] })
        : []
    try {
      host = await launchAdapterWorld({
        optionalBundles: ['voice-input-bundle'],
        extraPatches: [
          '- id: speech-to-text-sensevoice\n  disabled: true\n',
          '- id: speech-to-text\n  config:\n    defaultProvider: voice-acp-fixture\n',
        ],
      })
      host.ctx.on('session/event', (session, event) => events.push({ sessionId: session.id, ...event }))
      await host.ctx.plugin({
        inject: ['speechToText'],
        apply(ctx) {
          ctx.effect(() =>
            ctx.speechToText.register({
              info: {
                id: 'voice-acp-fixture' as SpeechProviderId,
                name: 'Offline recognizer',
                location: 'host-local',
                languages: ['auto'],
              },
              async transcribe(input, signal) {
                transcriptions++
                expect(Buffer.from(input.audio).subarray(0, 4).toString()).toBe('RIFF')
                expect(input.audio.byteLength).toBeGreaterThan(44)
                expect(input.language).toBe('auto')
                if (hold)
                  await new Promise<void>((resolve, reject) => {
                    release = resolve
                    signal.addEventListener(
                      'abort',
                      () => {
                        aborted++
                        reject(signal.reason)
                      },
                      { once: true },
                    )
                  })
                signal.throwIfAborted()
                return { text: 'reviewed voice text', audioSeconds: 0.3, inferenceSeconds: 0.01 }
              },
            }),
          )
        },
      })
      await configureAgent(host, scratch)
      browser = await launchBrowser({
        ...browserOptions,
        args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
      })
      page = await newEnglishPage(browser)
      page.on('pageerror', (error) => errors.push(error))
      await page.addInitScript(() => {
        const holder = window as Window & { optionalVoiceStreams?: MediaStream[] }
        holder.optionalVoiceStreams = []
        const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          const stream = await acquire(constraints)
          holder.optionalVoiceStreams!.push(stream)
          return stream
        }
      })
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)
      const input = page.locator('[data-composer-input]').first()
      const mic = page.getByRole('button', { name: 'Start recording', exact: true })
      const record = async () => {
        await mic.click()
        await required(page).locator('[data-voice-activity="recording"]').waitFor()
      }
      const stop = async () => {
        // A bounded interval collects virtual microphone audio; this is not a readiness wait.
        await required(page).waitForTimeout(300)
        await required(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click()
      }
      const streamsEnded = () =>
        required(page).evaluate(() =>
          (window as Window & { optionalVoiceStreams?: MediaStream[] }).optionalVoiceStreams!.every((stream) =>
            stream.getTracks().every((track) => track.readyState === 'ended'),
          ),
        )
      await writeComposerDraft(page, input, 'Please ')
      await record()
      await capture(host, page, 'voice-recording', page.locator('[data-composer-card]').first())
      await page.locator('[data-voice-activity]').getByRole('button', { name: 'Cancel', exact: true }).click()
      await mic.waitFor()
      await expect.poll(streamsEnded).toBe(true)
      expect(transcriptions).toBe(0)
      expect(await input.innerText()).toBe('Please ')
      expect(prompts()).toEqual([])
      await record()
      await stop()
      await expect.poll(() => input.innerText()).toBe('Please reviewed voice text')
      expect(transcriptions).toBe(1)
      expect(prompts()).toEqual([])
      expect(events.filter((event) => event.type === 'user/message')).toEqual([])
      await expect.poll(streamsEnded).toBe(true)
      await capture(host, page, 'voice-reviewed', page.locator('[data-composer-card]').first())
      const sent = host.whenTurnSettled(30_000)
      void sent.catch(() => {})
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      await sent
      await page.getByText('VOICE_DONE', { exact: true }).waitFor()
      expect(prompts()).toHaveLength(1)
      expect(prompts()[0]?.text).toContain('Please reviewed voice text')
      expect(prompts()[0]?.blocks.every((block) => block.type === 'text')).toBe(true)
      // Abort an in-flight recognition without sending or replacing the current draft.
      hold = true
      await writeComposerDraft(page, input, 'Keep this draft')
      await record()
      await stop()
      await expect.poll(() => transcriptions).toBe(2)
      await page.locator('[data-voice-activity]').getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect.poll(() => aborted).toBe(1)
      release?.()
      await mic.waitFor()
      expect(await input.innerText()).toBe('Keep this draft')
      expect(prompts()).toHaveLength(1)
      // A concurrent edit preserves the draft until the explicit native Insert text action.
      await record()
      await stop()
      await expect.poll(() => transcriptions).toBe(3)
      await writeComposerDraft(page, input, 'Edited draft ')
      required(release, 'Pending recognition')()
      await page.getByRole('button', { name: 'Insert text', exact: true }).waitFor()
      expect(await input.innerText()).toBe('Edited draft ')
      await page.getByRole('button', { name: 'Insert text', exact: true }).click()
      await expect.poll(() => input.innerText()).toBe('Edited draft reviewed voice text')
      expect(prompts()).toHaveLength(1)
      hold = false
      const questionSettled = host.whenTurnSettled(30_000)
      void questionSettled.catch(() => {})
      await submit(page, 'OPTIONAL_UI_PERMISSION')
      const question = page.locator('section[data-question-key]')
      await question.waitFor()
      // Native layout retains its normal composer DOM while the question owns
      // the visible seat. Check interaction rather than requiring DOM removal.
      expect(await input.isVisible()).toBe(false)
      expect(await mic.isVisible()).toBe(false)
      expect(await question.locator('textarea, input[type="text"], [contenteditable="true"]').count()).toBe(0)
      const choice = question.getByRole('radio', { name: 'ALPHA', exact: true })
      await choice.click()
      await expect.poll(() => choice.getAttribute('aria-checked')).toBe('true')
      expect(transcriptions).toBe(3)
      expect(prompts()).toHaveLength(2)
      await capture(host, page, 'voice-permission', question)
      await question.getByRole('button', { name: /^(Cancel|取消请求)$/ }).click()
      await questionSettled
      await mic.waitFor()
      await record()
      await stop()
      await expect.poll(() => input.innerText()).toBe('reviewed voice text')
      expect(prompts()).toHaveLength(2)
      await expect.poll(streamsEnded).toBe(true)
      expect(errors).toEqual([])
    } catch (error) {
      if (page) {
        mkdirSync(shots, { recursive: true })
        await page.screenshot({ path: join(shots, 'voice.failure.png') }).catch(() => {})
      }
      throw error
    } finally {
      release?.()
      await browser?.close()
      await host?.close()
      rmSync(scratch, { recursive: true, force: true })
    }
  },
)
