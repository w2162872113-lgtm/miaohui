// src/core/rpa-device.ts
// RPADevice — DesktopDevice 的真实 RPA 实现
//
// 串联 screenshot-utils、input-utils、has-unread、vision-utils
// 所有感知和动作能力在这里汇聚

import { DesktopDevice } from './device'
import { AIClient } from './ai-client'
import { AppType } from './rpa/types'
import { BBox, bboxToCropBounds } from './rpa/vision-utils'
import { captureChatMainArea, captureWechatWindow } from './rpa/screenshot-utils'
import { ChatIdentity } from './reply-rules'
import { sendReplyAction, activeUnreadByClickAction, clickUnreadContactAction } from './rpa/input-utils'
import {
  hasUnreadMessage as hasUnreadMessageDetect,
  isChatContactUnread as isChatContactUnreadDetect,
  findUnreadContactInList,
  isContactBadgeCleared as isContactBadgeClearedDetect
} from './rpa/has-unread'
import {
  setChatBaseline as setChatBaselineFn,
  checkChatAreaDiff,
  clearChatBaseline as clearChatBaselineFn
} from './rpa/image-compare'
import {
  clearLayoutCache,
  detectUnreadArea as detectUnreadAreaFn,
  detectWechatLayout,
  getInputAreaFromCache,
  getLayoutCache,
  setLayoutCache
} from './rpa/vision-utils'
import { getWechatWindowInfo, getWindowInfo, getWindowObstruction } from './rpa/window-utils'

const IDENTIFY_CHAT_PROMPT = `这是微信/企业微信聊天窗口顶部的标题栏截图（可能包含标题下方的一行灰色小字）。
请识别当前会话的名称，并判断是群聊还是私聊。

群聊的明确特征（至少要有一条）：
- 标题后面带人数，如"(12)"
- 标题下方灰色小字提到"群"、"群主"、"成员"、"外部群"等
- 名称本身含"群"字

私聊的特征：单个人的名字，可能带"@公司名"、"外部"标签，或"部门-姓名"格式（如"交付部-杨老师"是同事私聊，不是群）

没有群聊的明确特征时，一律判为私聊。

只输出一行 JSON，不要任何解释：
{"name":"会话名称（不含人数括号）","isGroup":false,"groupEvidence":"判为群聊时写出依据原文，否则留空"}`

export class RPADevice implements DesktopDevice {
  private appType: AppType = 'wechat'
  private aiClient: AIClient | null = null

  setAppType(appType: AppType): void {
    this.appType = appType
  }

  setApiKey(apiKey: string, model?: string): void {
    if (!apiKey) return
    this.aiClient = new AIClient({ apiKey, ...(model ? { model } : {}) })
  }

  // ── 生命周期 ──
  // 旧实现里 clearLayoutCache 由 WeChatChannelSession.onStop 调用。改用 GenericChannelSession 之后，
  // 把这个微信特定的清理动作下沉到设备的 onSessionStop hook 里，让 channel session 不必感知 appType。
  onSessionStop(): void {
    clearLayoutCache(this.appType)
  }

  // ── 感知层 ──

  /**
   * 启动时一次性 VLM 布局测量（并行执行）
   *
   * 并行调两个 VLM 检测任务:
   * 1. detectUnreadArea — chatEntranceArea + firstContact（红点检测用）
   * 2. detectWechatLayout — searchInputBox + headerArea + chatMainArea（diff/搜索用）
   *
   * 检测完成后，从 chatMainArea 反推 inputArea（纯计算，无外部调用）
   */
  async measureLayout(): Promise<{ success: boolean; error?: string }> {
    if (!this.aiClient) {
      console.error('[RPADevice] aiClient 未初始化，无法测量布局')
      return { success: false, error: 'AI Client 未初始化' }
    }

    try {
      // 提前校验应用窗口，避免大模型成本和迷惑性报错
      const windowInfo = await getWechatWindowInfo(this.appType)
      if (!windowInfo) {
        const appName = this.appType === 'wechat' ? '微信' : (this.appType === 'wework' ? '企业微信' : 'WhatsApp')
        return { success: false, error: `未找到${appName}窗口，请确保已打开且未被完全遮挡/最小化` }
      }

      console.log('[RPADevice] 开始布局测量（并行）...')

      const [unreadResult, layoutResult] = await Promise.allSettled([
        detectUnreadAreaFn(this.aiClient, this.appType),
        detectWechatLayout(this.aiClient, this.appType)
      ])

      // 检查结果
      const unreadOk = unreadResult.status === 'fulfilled' && unreadResult.value.success
      const layoutOk = layoutResult.status === 'fulfilled' && layoutResult.value.success

      console.log('[RPADevice] VLM 检测结果:', {
        detectUnreadArea: unreadOk ? '✓' : '✗',
        detectWechatLayout: layoutOk ? '✓' : '✗'
      })

      if (unreadResult.status === 'fulfilled' && unreadResult.value.success) {
        console.log('[RPADevice] 未读区域:', {
          chatEntrance: unreadResult.value.chatEntranceArea?.coordinates,
          firstContact: unreadResult.value.firstContact?.coordinates
        })
      } else {
        const error = unreadResult.status === 'rejected'
          ? unreadResult.reason
          : (unreadResult.value as any)?.error
        console.error('[RPADevice] 未读区域检测失败:', error)
      }

      if (layoutResult.status === 'fulfilled' && layoutResult.value.success) {
        console.log('[RPADevice] 主布局:', {
          searchInputBox: layoutResult.value.searchInputBox?.coordinates,
          headerArea: layoutResult.value.headerArea?.coordinates,
          chatMainArea: layoutResult.value.chatMainArea?.coordinates
        })

        // 从 chatMainArea 反推 inputArea（纯计算）
        const inputArea = getInputAreaFromCache(this.appType)
        if (inputArea) {
          console.log('[RPADevice] 输入框（反推）:', inputArea.coordinates)
        } else {
          console.warn('[RPADevice] 输入框反推失败')
        }
      } else {
        const error = layoutResult.status === 'rejected'
          ? layoutResult.reason
          : (layoutResult.value as any)?.error
        console.warn('[RPADevice] 主布局检测失败（非致命）:', error)
      }

      // 核心判定：后续截图 / diff / 发送都依赖主布局和输入框位置。
      // 未读区域可以缺失，缺失时 session 会退回当前会话 diff 轮询。
      if (!layoutOk) {
        const errorMsg =
          layoutResult.status === 'fulfilled' && !layoutResult.value.success
            ? layoutResult.value.error || '主布局检测失败'
            : '主布局检测失败'
        return { success: false, error: `布局测量失败: ${errorMsg}` }
      }

      const inputArea = getInputAreaFromCache(this.appType)
      if (!layoutResult.value.chatMainArea || !inputArea) {
        return { success: false, error: '布局测量失败: 缺少聊天区或输入框位置' }
      }

      console.log('[RPADevice] 布局测量完成 ✓')
      return { success: true }
    } catch (error: any) {
      console.error('[RPADevice] 布局测量异常:', error)
      return { success: false, error: String(error) }
    }
  }

  async screenshot(): Promise<string> {
    const image = await captureChatMainArea(this.appType)
    if (!image) {
      throw new Error('聊天区截图失败')
    }
    return image.toDataURL()
  }

  async hasUnreadMessage(): Promise<{
    hasUnread: boolean
    chatEntranceArea?: { bbox: BBox; coordinates: [number, number] }
  }> {
    if (!this.aiClient) {
      console.warn('[RPADevice] aiClient 未初始化，无法进行视觉检测')
      return { hasUnread: false }
    }

    const result = await hasUnreadMessageDetect(this.aiClient, this.appType)

    if (!result.success) {
      console.error('[RPADevice] hasUnreadMessage 失败:', result.error)
      return { hasUnread: false }
    }

    return {
      hasUnread: result.hasUnread || false,
      chatEntranceArea: result.chatEntranceArea
    }
  }

  async isChatContactUnread(): Promise<{
    isUnread: boolean
    firstContactCoords?: [number, number]
  }> {
    if (!this.aiClient) {
      console.warn('[RPADevice] aiClient 未初始化')
      return { isUnread: false }
    }

    const result = await isChatContactUnreadDetect(this.aiClient, this.appType)

    if (!result.success) {
      console.error('[RPADevice] isChatContactUnread 失败:', result.error)
      return { isUnread: false }
    }

    return {
      isUnread: result.isUnread || false,
      firstContactCoords: result.firstContact?.coordinates
    }
  }

  async findUnreadContact(): Promise<{ coordinates: [number, number]; badgeWindowY: number } | null> {
    if (!this.aiClient) return null
    return findUnreadContactInList(this.aiClient, this.appType)
  }

  /**
   * 读取会话标题栏（聊天记录区上方那一条），识别会话名称和是否群聊。
   * 只截很小的一条区域，模型调用快、费用低。
   */
  async checkObstruction(): Promise<{ obstructed: boolean; by?: string; missing?: boolean }> {
    return getWindowObstruction(this.appType)
  }

  async identifyChat(): Promise<ChatIdentity | null> {
    if (!this.aiClient) return null
    try {
      const layout = getLayoutCache(this.appType)
      const chatBbox = layout?.chatMainArea?.bbox
      const windowInfo = await getWindowInfo(this.appType, false)
      if (!chatBbox || !windowInfo?.bounds) return null

      const chat = bboxToCropBounds(chatBbox, windowInfo.bounds)
      // 标题栏 = 聊天记录区正上方、从窗口顶部到聊天区顶部的横条
      const header = {
        x: chat.x,
        y: 0,
        width: chat.width,
        // 多截一点，确保包含标题下方那行灰色小字（群聊会写"外部群""群主"等，是最可靠的群聊依据）
        height: Math.max(chat.y + 18, 48)
      }
      const shot = await captureWechatWindow(this.appType, header)
      if (!shot.success || !shot.screenshotBase64) return null

      const text = await this.aiClient.detectVision(IDENTIFY_CHAT_PROMPT, shot.screenshotBase64)
      const match = text.match(/\{[\s\S]*\}/)
      if (!match) {
        console.warn('[RPADevice] identifyChat 无法解析:', text.slice(0, 200))
        return null
      }
      const parsed = JSON.parse(match[0])
      const name = typeof parsed.name === 'string' ? parsed.name.trim() : ''
      if (!name) return null
      // 判为群聊必须给出依据，否则按私聊处理（避免把"交付部-杨老师"这类私聊误判成群而漏回）
      const evidence = typeof parsed.groupEvidence === 'string' ? parsed.groupEvidence.trim() : ''
      const isGroup = parsed.isGroup === true && (evidence.length > 0 || /群|\(\d+\)|（\d+）/.test(name))
      const identity: ChatIdentity = { name, isGroup }
      console.log('[RPADevice] 当前会话:', identity, evidence ? `依据: ${evidence}` : '')
      return identity
    } catch (error) {
      console.error('[RPADevice] identifyChat 失败:', error)
      return null
    }
  }

  async isContactBadgeCleared(badgeWindowY: number): Promise<boolean> {
    if (!this.aiClient) return false
    return isContactBadgeClearedDetect(this.aiClient, this.appType, badgeWindowY)
  }

  /**
   * 清除未读区域的 VLM 坐标缓存（chatEntranceArea + firstContact）
   * 连续检测失败时调用：强制下次 isChatContactUnread / hasUnreadMessage 重新 VLM 定位
   */
  clearUnreadCache(): void {
    const cache = getLayoutCache(this.appType)
    if (cache) {
      cache.chatEntranceArea = null
      cache.firstContact = null
      setLayoutCache(this.appType, cache)
      console.log('[RPADevice] 已清除未读区域缓存')
    }
  }

  // ── chatMainArea Diff 检测 ──

  async setChatBaseline(): Promise<boolean> {
    return setChatBaselineFn(this.appType)
  }

  async hasChatAreaChanged(): Promise<{ hasDiff: boolean; hasBaseline: boolean }> {
    return checkChatAreaDiff(this.appType)
  }

  clearChatBaseline(): void {
    clearChatBaselineFn()
  }

  // ── 动作层 ──

  async sendMessage(text: string): Promise<void> {
    const success = await sendReplyAction(this.appType, text)
    if (!success) {
      throw new Error('发送消息失败')
    }
  }

  /**
   * 点击红点区域激活未读消息（视觉路线）
   * 微信场景双击，企业微信场景单击
   */
  async activeUnreadByClick(coordinates: [number, number]): Promise<void> {
    await activeUnreadByClickAction(coordinates, this.appType)
  }

  /**
   * 点击联系人列表中的第一个联系人
   */
  async clickUnreadContact(coordinates: [number, number]): Promise<void> {
    await clickUnreadContactAction(coordinates)
  }

  async clickAt(x: number, y: number): Promise<void> {
    await clickUnreadContactAction([x, y])
  }
}
