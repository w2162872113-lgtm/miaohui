// src/core/ai-client.ts
// AI 客户端 — 统一封装所有大模型调用
//
// 使用火山引擎 Ark OpenAI 兼容 /chat/completions 端点 + doubao-seed-2-0-lite
// 两种用途：
//   1. 聊天回复：截图 → AI 分析 → 回复文字
//   2. VLM 视觉检测：截图 → AI 分析 → bbox/point 坐标

import { MemoryCardBrief } from './trace/trace-types'

export interface AIClientConfig {
  apiKey: string
  model: string
  baseURL: string
  systemPrompt: string
}

/** 把经验卡片拼成 system prompt 附加段（与内置 provider bundle 的格式保持一致） */
export function buildMemorySection(memoryCards?: MemoryCardBrief[]): string {
  if (!memoryCards || memoryCards.length === 0) return ''
  const lines = memoryCards.map((card, index) => {
    const rationale = card.rationale ? `（原因：${card.rationale}）` : ''
    return `${index + 1}. 【${card.scenario}】${card.guidance}${rationale}`
  })
  return `\n\n## 团队经验（来自工作记忆，优先遵循）\n${lines.join('\n')}`
}

const DEFAULT_MODEL = 'doubao-seed-2-1-lite-260915'
const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'

const REPLY_SYSTEM_PROMPT = `你是一个微信/企业微信自动回复助手。你会收到一张聊天窗口截图。

## 如何分辨谁发的消息
- 左侧、带对方头像、灰色或白色气泡 = 对方（客户）发的
- 右侧、蓝色或绿色气泡（旁边常有已读/未读小圆圈）= "我"发的
- 时间、"以下为新消息"、"对方正在输入..."等灰色小字不是消息内容

## 判断要不要回复
1. 只看聊天记录最底部：如果最后一条（或最后几条）是对方发的，就必须回复，不能输出 [SKIP]
2. 对方连发多条时，把最后一次"我"发言之后对方的所有消息合起来，用一条回复统一回应
3. 对方说"好的""谢谢""感谢""嗯嗯"这类收尾的话，礼貌简短回应一句即可（如"不客气，有问题随时找我~"）
4. 只有以下情况输出 [SKIP]：最后一条是"我"发的；最后一条是系统消息、群公告、红包、转账；截图里看不到任何聊天内容
5. 不要重复自己上一条已经说过的话

## 语气和分寸
你代表企业对外沟通：语气友好、专业、有分寸。不要调情、撒娇、开过火的玩笑；不要替公司承诺请客、送礼、打折、退款等没有依据的事情；对方辱骂或说脏话时不要跟着骂，礼貌简短回应即可。

## 输出要求
只输出要发送的回复文字，不要解释，不要加引号。回复自然、口语化，像真人对话，一般不超过 60 字。`

export class AIClient {
  private config: AIClientConfig

  constructor(config: Partial<AIClientConfig> & { apiKey: string }) {
    this.config = {
      apiKey: config.apiKey,
      model: config.model || DEFAULT_MODEL,
      baseURL: config.baseURL || DEFAULT_BASE_URL,
      systemPrompt: config.systemPrompt || REPLY_SYSTEM_PROMPT
    }
  }

  /**
   * 发送截图给 AI，获取聊天回复
   * memoryCards: 运行时注入的经验卡片（工作记忆），拼入 system prompt
   */
  async getReply(screenshotBase64: string, memoryCards?: MemoryCardBrief[]): Promise<string | null> {
    const startTime = Date.now()
    try {
      console.log('[AIClient] getReply 开始...')
      const replyText = await this.callVision(
        this.config.systemPrompt + buildMemorySection(memoryCards),
        '请根据截图中微信聊天窗口的最新消息进行回复。',
        screenshotBase64
      )

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      console.log(`[AIClient] getReply 完成 (${elapsed}s):`, replyText?.slice(0, 100))

      if (!replyText || replyText.trim() === '[SKIP]') {
        return null
      }

      return replyText.trim()
    } catch (error: any) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      console.error(`[AIClient] 聊天回复失败 (${elapsed}s):`, error?.message || error)
      throw error
    }
  }

  /**
   * VLM 视觉检测 — 发送截图 + prompt，获取 bbox/point 文本
   * 供 vision-utils.ts 调用
   */
  async detectVision(prompt: string, screenshotBase64: string): Promise<string> {
    return await this.callVision(
      '你是一个视觉分析专家。请严格按照用户要求的格式输出检测结果。',
      prompt,
      screenshotBase64
    )
  }

  /**
   * 纯文本调用（不带图片）— 用于 testConnection 等
   */
  async callText(userMessage: string): Promise<string> {
    const data = await this.callAPI([
      { role: 'user', content: userMessage }
    ])
    return this.extractText(data)
  }

  /**
   * 测试 API 连接
   */
  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.callText('你好，请回复"连接成功"。')
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  }

  updateConfig(config: Partial<AIClientConfig>): void {
    Object.assign(this.config, config)
  }

  getApiKey(): string {
    return this.config.apiKey
  }

  // ── 内部方法 ──

  /**
   * 视觉调用：system prompt + 用户文本 + 图片
   */
  private async callVision(
    systemPrompt: string,
    userText: string,
    imageBase64: string
  ): Promise<string> {
    const rawBase64 = this.stripBase64Prefix(imageBase64)
    const imageUrl = rawBase64.startsWith('http')
      ? rawBase64
      : `data:image/png;base64,${rawBase64}`

    const data = await this.callAPI([
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageUrl } },
          { type: 'text', text: userText }
        ]
      }
    ])

    return this.extractText(data)
  }

  /**
   * 底层 HTTP 调用 — OpenAI 兼容 /chat/completions 端点
   * thinking 字段是火山方舟对标 OpenAI Responses API 的扩展参数，
   * 在非火山供应商上会被忽略，放在这里不影响兼容性
   */
  private async callAPI(messages: any[]): Promise<any> {
    const url = `${this.config.baseURL}/chat/completions`
    const TIMEOUT_MS = 90_000 // 90 秒超时（2.1-lite 布局识别较慢）
    const callStart = Date.now()

    // 计算 payload 大小（粗略，不重复序列化）
    const bodyStr = JSON.stringify({
      model: this.config.model,
      messages,
      thinking: { type: 'disabled' },
      stream: false
    })
    const bodySizeKB = (bodyStr.length / 1024).toFixed(0)
    console.log(
      `[AIClient] callAPI 开始 | model=${this.config.model} | payload=${bodySizeKB}KB | timeout=${TIMEOUT_MS / 1000}s`
    )

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: bodyStr,
        signal: controller.signal
      })

      const fetchElapsed = ((Date.now() - callStart) / 1000).toFixed(1)
      console.log(`[AIClient] 收到响应 status=${response.status} (${fetchElapsed}s)`)

      if (!response.ok) {
        const errorText = await response.text()
        console.error(`[AIClient] API 错误: ${response.status}`, errorText)
        throw new Error(`API request failed: ${response.status} - ${errorText.slice(0, 200)}`)
      }

      const json = await response.json()
      const totalElapsed = ((Date.now() - callStart) / 1000).toFixed(1)
      console.log(`[AIClient] 解析完成 (${totalElapsed}s)`)
      return json
    } catch (error: any) {
      const elapsed = ((Date.now() - callStart) / 1000).toFixed(1)
      if (error?.name === 'AbortError') {
        console.error(`[AIClient] ⏱ 超时！已等待 ${elapsed}s，上限 ${TIMEOUT_MS / 1000}s`)
        throw new Error(`AI API 请求超时 (${TIMEOUT_MS / 1000}s)`)
      }
      console.error(`[AIClient] 请求异常 (${elapsed}s):`, error?.message)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 从 OpenAI 兼容 /chat/completions 返回值中提取文本
   * 格式: { choices: [{ message: { role, content: string } }] }
   */
  private extractText(responseData: any): string {
    const content = responseData?.choices?.[0]?.message?.content
    if (typeof content === 'string' && content.length > 0) {
      return content
    }
    console.warn('[AIClient] 无法解析回复格式:', JSON.stringify(responseData).slice(0, 500))
    return ''
  }

  private stripBase64Prefix(base64: string): string {
    const idx = base64.indexOf('base64,')
    return idx !== -1 ? base64.slice(idx + 'base64,'.length) : base64
  }
}
