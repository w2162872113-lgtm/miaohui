// src/core/generic-channel-session.ts
// 通用 ChannelSession — 驱动 DesktopDevice，具体位置来源由设备测量后写入 LayoutCache。
//
// 设计原则：本文件只依赖 DesktopDevice 接口。所有微信特定的行为（如 layoutCache 清理、
// VLM bbox 状态同步）都封装到具体设备的 onSessionStart / onSessionStop / clearUnreadCache
// 里，使 channel session 在不同设备之间真正可复用。

import { DesktopDevice } from './device'
import { ChannelContext, ChannelSession, ProviderEvent, ProviderInput, SessionEvent } from './session-types'
import { ReplyRules, evaluateReplyRules } from './reply-rules'

export interface GenericChannelOptions {
  /** 每轮取最新的回复规则（设置里改了即时生效）；不传则不做会话过滤 */
  getReplyRules?: () => ReplyRules
}

export interface GenericChannelState {
  measuredAt: number | null
  latestChatBaseline: number | null
}

export function createInitialGenericChannelState(): GenericChannelState {
  return {
    measuredAt: null,
    latestChatBaseline: null
  }
}

export class GenericChannelSession implements ChannelSession<GenericChannelState> {
  private readonly retryDelayMs = 5000
  /** 检测到新消息后等待对方把话说完再截图 */
  private readonly messageSettleMs = 1500
  private consecutiveUnreadFailures = 0
  /** 连续因"对方正在输入"而等待的次数 */
  private typingWaits = 0
  private readonly maxTypingWaits = 5
  private readonly typingWaitMs = 3000
  /** 本轮 observe 的会话信息，等待后重新截图时沿用，避免重复识别标题栏 */
  private pendingChat: ProviderInput['chat'] | undefined

  constructor(
    private readonly device: DesktopDevice,
    private readonly options: GenericChannelOptions = {}
  ) {}

  async onStart(ctx: ChannelContext<GenericChannelState>): Promise<void> {
    this.device.setAppType(ctx.appType)
    this.device.clearChatBaseline()
    this.consecutiveUnreadFailures = 0
    this.typingWaits = 0
    this.resetState(ctx.state)
    await this.device.onSessionStart?.()
    ctx.host.enqueue({ type: 'bootstrap' })
  }

  async onStop(ctx: ChannelContext<GenericChannelState>): Promise<void> {
    this.device.clearChatBaseline()
    this.consecutiveUnreadFailures = 0
    await this.device.onSessionStop?.()
    this.resetState(ctx.state)
  }

  async onEvent(event: SessionEvent, ctx: ChannelContext<GenericChannelState>): Promise<void> {
    this.device.setAppType(ctx.appType)

    switch (event.type) {
      case 'bootstrap': {
        ctx.host.log('thinking', '正在识别聊天窗口布局...')
        const measureStart = Date.now()
        const result = await this.device.measureLayout()

        if (!result.success) {
          ctx.host.log('error', `${result.error || '界面识别失败'}，引擎无法启动`)
          ctx.host.trace({
            phase: 'observe',
            summary: '识别聊天窗口布局',
            action: { kind: 'measure' },
            outcome: {
              status: 'fail',
              detail: result.error || '界面识别失败',
              latencyMs: Date.now() - measureStart
            }
          })
          await ctx.host.stopSession('bootstrap_failed')
          return
        }

        ctx.state.measuredAt = Date.now()
        ctx.host.log('thinking', '聊天窗口识别完成')
        ctx.host.trace({
          phase: 'observe',
          summary: '识别聊天窗口布局',
          action: { kind: 'measure' },
          outcome: { status: 'ok', latencyMs: Date.now() - measureStart }
        })
        ctx.host.enqueue({ type: 'observe_chat' })
        break
      }

      case 'observe_chat': {
        if (await this.pauseIfObstructed(ctx)) break

        // ── 回复规则：先确认"这个会话该不该回"，不该回就不调用回复模型 ──
        let chat: ProviderInput['chat'] = this.typingWaits > 0 ? this.pendingChat : undefined
        const rules = this.options.getReplyRules?.()
        if (this.typingWaits === 0 && rules && this.device.identifyChat) {
          const identity = await this.device.identifyChat()
          const verdict = evaluateReplyRules(rules, identity)
          if (!verdict.allow) {
            const who = identity ? `「${identity.name}」` : '当前会话'
            ctx.host.log('skip', `已按回复规则跳过${who}：${verdict.reason}`)
            ctx.host.trace({
              phase: 'think',
              summary: `按回复规则跳过${who}`,
              outcome: { status: 'skip', detail: verdict.reason }
            })
            await this.device.setChatBaseline()
            ctx.state.latestChatBaseline = Date.now()
            ctx.host.enqueue({ type: 'check_unread' })
            break
          }
          if (identity) {
            chat = {
              name: identity.name,
              isGroup: identity.isGroup,
              mentionOnly: verdict.groupMentionOnly && identity.isGroup,
              myName: rules.myName || undefined
            }
            ctx.host.log(
              'thinking',
              `当前会话：${identity.name}${identity.isGroup ? '（群聊' + (chat.mentionOnly ? '，仅被@时回复）' : '）') : ''}`
            )
          }
        }

        const screenshot = await this.device.screenshot()
        ctx.host.trace({
          phase: 'observe',
          summary: '截取当前聊天窗口',
          screenshotBase64: screenshot
        })
        this.pendingChat = chat
        void this.forwardProviderEvents(screenshot, ctx, chat)
        break
      }

      case 'provider.thinking':
        ctx.host.log('thinking', event.content)
        ctx.host.trace({
          phase: 'think',
          summary: event.content,
          reasoning: { content: event.content }
        })
        break

      case 'provider.reply_text': {
        this.typingWaits = 0
        const sendStart = Date.now()
        await this.device.sendMessage(event.content)
        ctx.host.log('reply', event.content)
        ctx.host.trace({
          phase: 'act',
          summary: '发送回复',
          action: { kind: 'send', payload: event.content },
          outcome: { status: 'ok', latencyMs: Date.now() - sendStart }
        })
        await this.device.setChatBaseline()
        ctx.state.latestChatBaseline = Date.now()
        ctx.host.enqueue({ type: 'check_unread' })
        break
      }

      case 'provider.wait':
        this.typingWaits += 1
        ctx.host.log('thinking', `对方正在输入，等对方说完再回复（${this.typingWaits}/${this.maxTypingWaits}）`)
        ctx.host.schedule({ type: 'observe_chat' }, this.typingWaitMs)
        break

      case 'provider.skip':
        this.typingWaits = 0
        ctx.host.log('skip', '本轮无需回复')
        ctx.host.trace({
          phase: 'think',
          summary: '判断本轮无需回复',
          outcome: { status: 'skip' }
        })
        await this.device.setChatBaseline()
        ctx.state.latestChatBaseline = Date.now()
        ctx.host.enqueue({ type: 'check_unread' })
        break

      case 'provider.error':
        this.typingWaits = 0
        ctx.host.log('error', `回复服务异常：${event.error}`)
        ctx.host.trace({
          phase: 'think',
          summary: '回复服务异常',
          outcome: { status: 'fail', detail: event.error }
        })
        ctx.host.enqueue({
          type: 'wait_retry',
          reason: 'provider_error',
          delayMs: this.retryDelayMs
        })
        break

      case 'check_unread': {
        if (await this.pauseIfObstructed(ctx)) break

        const diffResult = await this.device.hasChatAreaChanged()
        if (diffResult.hasDiff) {
          // 对方常常连发几条：稍等一下再截图，避免只看到一半就回复/误判
          await this.sleep(this.messageSettleMs)
          ctx.host.log('thinking', '检测到当前对话有新消息')
          ctx.host.trace({
            phase: 'verify',
            summary: '检测到当前对话有新消息',
            outcome: { status: 'ok' }
          })
          ctx.host.enqueue({ type: 'observe_chat' })
          break
        }

        const unreadResult = await this.device.hasUnreadMessage()
        if (!unreadResult.hasUnread) {
          ctx.host.enqueue({
            type: 'wait_retry',
            reason: 'no_unread',
            delayMs: this.retryDelayMs
          })
          break
        }

        const chatEntranceCoords = unreadResult.chatEntranceArea?.coordinates
        if (!chatEntranceCoords) {
          ctx.host.log('error', '检测到未读消息，但未找到聊天入口位置')
          ctx.host.enqueue({
            type: 'wait_retry',
            reason: 'missing_chat_entrance',
            delayMs: this.retryDelayMs
          })
          break
        }

        ctx.host.log('thinking', '检测到未读消息，正在尝试打开会话')
        ctx.host.trace({
          phase: 'act',
          summary: '点击未读会话入口',
          action: { kind: 'click', target: chatEntranceCoords },
          outcome: { status: 'ok' }
        })
        await this.device.activeUnreadByClick(chatEntranceCoords)
        await this.sleep(150 + Math.random() * 100)

        const openResult = this.device.findUnreadContact
          ? await this.openUnreadContactByBadge(ctx)
          : await this.tryOpenUnreadConversation(ctx)
        if (openResult === 'opened' || openResult === 'opened_current') {
          if (openResult === 'opened') await this.sleep(this.messageSettleMs)
          ctx.host.enqueue({ type: 'observe_chat' })
          break
        }

        ctx.host.enqueue({
          type: 'wait_retry',
          reason: openResult,
          delayMs: this.retryDelayMs
        })
        break
      }

      case 'wait_retry':
        ctx.host.log('skip', '等待下一轮未读检测')
        ctx.host.schedule(
          event.reason === 'provider_error' ? { type: 'observe_chat' } : { type: 'check_unread' },
          event.delayMs ?? this.retryDelayMs
        )
        break
    }
  }

  private async forwardProviderEvents(
    screenshot: string,
    ctx: ChannelContext<GenericChannelState>,
    chat?: ProviderInput['chat']
  ): Promise<void> {
    try {
      for await (const event of ctx.host.runProvider({
        screenshot,
        appType: ctx.appType,
        allowWait: this.typingWaits < this.maxTypingWaits,
        ...(chat ? { chat, currentContact: chat.name } : {})
      })) {
        if (!ctx.host.isRunning()) break

        const sessionEvent = this.mapProviderEvent(event)
        if (sessionEvent) {
          ctx.host.enqueue(sessionEvent)
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.host.enqueue({ type: 'provider.error', error: message })
    }
  }

  private mapProviderEvent(event: ProviderEvent): SessionEvent | null {
    switch (event.type) {
      case 'thinking':
        return { type: 'provider.thinking', content: event.content }
      case 'reply_text':
        return { type: 'provider.reply_text', content: event.content }
      case 'skip':
        return { type: 'provider.skip' }
      case 'wait':
        return { type: 'provider.wait' }
      case 'error':
        return { type: 'provider.error', error: event.error }
      default:
        return null
    }
  }

  private resetState(state: GenericChannelState): void {
    state.measuredAt = null
    state.latestChatBaseline = null
  }

  /**
   * 按"真正带红点的那一行"打开未读会话，并在点击后复核红点已消失。
   * 复核不通过就不回复，宁可漏一轮也不把消息发错人。
   */
  private async openUnreadContactByBadge(
    ctx: ChannelContext<GenericChannelState>
  ): Promise<'opened' | 'opened_current' | 'contact_not_ready'> {
    const target = await this.device.findUnreadContact!()

    if (!target) {
      // 列表里没有带红点的会话：新消息多半就在当前打开的会话里（当前会话不显示红点）
      await this.sleep(800)
      const diff = await this.device.hasChatAreaChanged()
      if (diff.hasDiff) {
        ctx.host.log('thinking', '新消息在当前会话中，直接读取')
        await this.sleep(this.messageSettleMs)
        return 'opened_current'
      }
      ctx.host.log('skip', '会话列表中未找到带红点的会话，等待下一轮')
      return 'contact_not_ready'
    }

    ctx.host.log('thinking', '正在打开未读会话')
    ctx.host.trace({
      phase: 'act',
      summary: '打开未读会话',
      action: { kind: 'click', target: target.coordinates },
      outcome: { status: 'ok' }
    })
    await this.device.clickUnreadContact(target.coordinates)
    await this.sleep(700 + Math.random() * 300)

    const cleared = this.device.isContactBadgeCleared
      ? await this.device.isContactBadgeCleared(target.badgeWindowY)
      : true
    if (!cleared) {
      ctx.host.log('skip', '点击后该会话红点未消失，无法确认打开的是正确会话，本轮不回复')
      ctx.host.trace({
        phase: 'verify',
        summary: '打开未读会话复核失败',
        outcome: { status: 'fail', detail: '点击后红点未消失' }
      })
      return 'contact_not_ready'
    }

    this.device.clearChatBaseline()
    ctx.state.latestChatBaseline = null
    return 'opened'
  }

  private async tryOpenUnreadConversation(
    ctx: ChannelContext<GenericChannelState>
  ): Promise<'opened' | 'contact_not_ready'> {
    let contactResult = await this.device.isChatContactUnread()

    if (!contactResult.isUnread) {
      ctx.host.log('thinking', '当前会话没有新消息，正在重新检测...')
      await this.sleep(1000)

      const recheckResult = await this.device.hasUnreadMessage()
      const recheckCoords = recheckResult.chatEntranceArea?.coordinates

      if (!recheckResult.hasUnread || !recheckCoords) {
        ctx.host.log('skip', '重新检测后无未读消息，等待下一轮')
        return 'contact_not_ready'
      }

      ctx.host.log('thinking', '仍检测到未读消息，正在再次尝试打开会话')
      await this.device.activeUnreadByClick(recheckCoords)
      await this.sleep(500)
      contactResult = await this.device.isChatContactUnread()
    }

    if (!contactResult.isUnread) {
      this.consecutiveUnreadFailures += 1

      if (this.consecutiveUnreadFailures >= 3) {
        ctx.host.log(
          'thinking',
          `连续 ${this.consecutiveUnreadFailures} 次检测失败，正在重置未读识别状态`
        )
        this.device.clearUnreadCache()
        this.consecutiveUnreadFailures = 0
        await this.sleep(500)

        contactResult = await this.device.isChatContactUnread()
        if (!contactResult.isUnread) {
          ctx.host.log('thinking', '重置后仍未成功，正在再次尝试打开会话')
          const retryUnread = await this.device.hasUnreadMessage()
          const retryCoords = retryUnread.chatEntranceArea?.coordinates

          if (!retryUnread.hasUnread || !retryCoords) {
            ctx.host.log('skip', '重置后仍未找到可用会话入口，等待下一轮')
            return 'contact_not_ready'
          }

          await this.device.activeUnreadByClick(retryCoords)
          await this.sleep(500)
          contactResult = await this.device.isChatContactUnread()

          if (!contactResult.isUnread) {
            ctx.host.log('skip', '最终检测仍失败，放弃当前轮未读切换')
            return 'contact_not_ready'
          }
        }
      } else {
        ctx.host.log(
          'skip',
          `会话切换检测失败（第 ${this.consecutiveUnreadFailures} 次），等待下一轮`
        )
        return 'contact_not_ready'
      }
    }

    this.consecutiveUnreadFailures = 0

    if (!contactResult.firstContactCoords) {
      ctx.host.log('skip', '未找到联系人位置，等待下一轮')
      return 'contact_not_ready'
    }

    ctx.host.log('thinking', '正在打开未读会话')
    ctx.host.trace({
      phase: 'act',
      summary: '打开未读会话',
      action: { kind: 'click', target: contactResult.firstContactCoords },
      outcome: { status: 'ok' }
    })
    await this.device.clickUnreadContact(contactResult.firstContactCoords)
    await this.sleep(500 + Math.random() * 300)
    this.device.clearChatBaseline()
    ctx.state.latestChatBaseline = null
    return 'opened'
  }

  private lastObstructionLog = ''

  /**
   * 目标窗口被挡住时暂停本轮（不截图、不点击、不输入），稍后再检查。
   * 同样的提示只打印一次，避免刷屏。
   */
  private async pauseIfObstructed(ctx: ChannelContext<GenericChannelState>): Promise<boolean> {
    const result = await this.device.checkObstruction?.()
    if (!result?.obstructed) {
      if (this.lastObstructionLog) {
        ctx.host.log('thinking', '窗口已恢复可见，继续工作')
        this.lastObstructionLog = ''
      }
      return false
    }
    const message = result.missing
      ? '找不到聊天窗口（可能被最小化或关闭），已暂停'
      : `聊天窗口被「${result.by}」挡住，已暂停，移开后自动继续`
    if (message !== this.lastObstructionLog) {
      ctx.host.log('skip', message)
      this.lastObstructionLog = message
    }
    this.typingWaits = 0
    ctx.host.schedule({ type: 'check_unread' }, this.retryDelayMs)
    return true
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
