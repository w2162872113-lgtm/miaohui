const DEFAULT_MODEL = 'doubao-seed-2-1-lite-260915'
const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
const REQUEST_TIMEOUT_MS = 60_000
const TYPING_SECTION = `

## 对方还没说完时
如果聊天记录最下方（输入框上方）出现"对方正在输入..."，说明对方还在打字，话没说完。此时不要回复，只输出 [WAIT]`
const DEFAULT_PROMPT = `你是一个微信/企业微信自动回复助手。你会收到一张聊天窗口截图。

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

## 分寸
你代表企业对外沟通。不要调情、撒娇、开过火的玩笑；不要替公司承诺请客、送礼、打折、退款等没有依据的事情；对方辱骂或说脏话时不要跟着骂，简短回应即可。

## 输出要求
只输出要发送的回复文字，不要解释，不要加引号。`

// 宿主没有传回复风格时的兜底（旧版本宿主 / 第三方调用）
const FALLBACK_STYLE = `

## 语气
像真人在微信上聊天，口语化、简短自然，回复长短跟着客户走，不说"亲""好的呢"等客服套话，语气词和"～"不要堆。`

export const manifest = {
  id: 'volcengine-ark',
  apiVersion: 1
}

export function createProvider(context) {
  const providerConfig = context && context.providerConfig ? context.providerConfig : {}

  return {
    async *run(input) {
      const previewText = input && typeof input.previewText === 'string' ? input.previewText.trim() : ''
      if (!input || (!input.screenshot && !previewText)) {
        yield { type: 'skip' }
        return
      }

      const apiKey = providerConfig.apiKey
      if (!apiKey) {
        yield { type: 'error', error: '聊天服务缺少接口密钥' }
        return
      }

      const memorySection = buildMemorySection(input.memoryCards)
      const knowledgeSection = buildKnowledgeSection(input.knowledge)
      const chatSection = buildChatSection(input.chat)
      const extras = []
      if (knowledgeSection) extras.push('已加载知识库')
      if (memorySection) extras.push(`${input.memoryCards.length} 条团队经验`)
      yield {
        type: 'thinking',
        content: extras.length
          ? `正在分析聊天内容（${extras.join('，')}）...`
          : '正在分析聊天内容...'
      }

      try {
        const reply = await requestReply({
          screenshot: input.screenshot,
          previewText,
          apiKey,
          model: providerConfig.model || DEFAULT_MODEL,
          systemPrompt:
            (providerConfig.systemPrompt || DEFAULT_PROMPT) +
            (typeof input.style === 'string' && input.style.trim() ? input.style : FALLBACK_STYLE) +
            (input.allowWait && !previewText ? TYPING_SECTION : '') +
            chatSection +
            knowledgeSection +
            memorySection
        })

        if (input.allowWait && reply && reply.trim() === '[WAIT]') {
          yield { type: 'wait' }
          return
        }
        if (!reply || reply.trim() === '[SKIP]' || reply.trim() === '[WAIT]') {
          yield { type: 'skip' }
          return
        }

        yield { type: 'reply_text', content: reply.trim() }
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        if (context && context.host && typeof context.host.log === 'function') {
          context.host.log(`provider error: ${message}`)
        }
        yield { type: 'error', error: message || '聊天服务调用失败' }
      }
    }
  }
}

async function requestReply({ screenshot, previewText, apiKey, model, systemPrompt }) {
  const userContent = previewText
    ? `（这是回复风格测试，没有截图）客户刚发来一条消息："${previewText}"\n请直接给出你要发送的回复。`
    : [
        { type: 'image_url', image_url: { url: normalizeImageUrl(screenshot) } },
        { type: 'text', text: '请根据截图中微信聊天窗口的最新消息进行回复。' }
      ]
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ],
    thinking: { type: 'disabled' },
    stream: false
  }

  // 必须有超时：否则一次网络请求挂住，整个引擎会永远停在"正在分析聊天内容"
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let json
  try {
    const response = await fetch(`${DEFAULT_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${response.statusText}`)
    }

    json = await response.json()
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error(`回复生成超时（${REQUEST_TIMEOUT_MS / 1000}s），稍后自动重试`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
  return json && json.choices && json.choices[0] && json.choices[0].message
    ? json.choices[0].message.content || ''
    : ''
}

// 企业知识库：业务信息只能以此为准，没有的不编造
function buildKnowledgeSection(knowledge) {
  if (typeof knowledge !== 'string' || !knowledge.trim()) return ''
  return `

## 企业知识库（对外资料，回答业务问题时以此为准）
<knowledge>
${knowledge.trim()}
</knowledge>

## 使用知识库的规则
1. 客户问到产品、价格、课程、服务、政策、流程、时间地点、联系方式等业务问题时，只能依据上面的知识库回答，可以用口语化方式转述
2. 知识库里没有的业务信息，绝对不要编造或猜测，回复类似"这个我帮您确认一下，稍后回复您哈"
3. 不要提到"知识库""资料""文档"这些词，像熟悉业务的真人一样自然回答
4. 闲聊、寒暄、确认类的话不需要查知识库，正常回复即可`
}

// 当前会话信息：群聊时调整回复策略
function buildChatSection(chat) {
  if (!chat || !chat.isGroup) return ''
  const lines = [`\n\n## 当前会话\n这是群聊「${chat.name}」。群里消息气泡上方通常有发送者名字。`]
  if (chat.mentionOnly) {
    lines.push(
      chat.myName
        ? `只有当最新的消息里 @${chat.myName}（或 @所有人 并且需要我回应）时才回复；否则必须输出 [SKIP]。`
        : '只有当最新的消息明确 @ 了"我"时才回复；否则必须输出 [SKIP]。'
    )
  }
  lines.push('在群里回复要简短，针对 @ 我的那个人的问题回答。')
  return lines.join('\n')
}

// 工作记忆注入：把运行时下发的经验卡片拼成 system prompt 附加段
function buildMemorySection(memoryCards) {
  if (!Array.isArray(memoryCards) || memoryCards.length === 0) {
    return ''
  }
  const lines = memoryCards.map((card, index) => {
    const rationale = card.rationale ? `（原因：${card.rationale}）` : ''
    return `${index + 1}. 【${card.scenario}】${card.guidance}${rationale}`
  })
  return `\n\n## 团队经验（来自工作记忆，优先遵循）\n${lines.join('\n')}`
}

function normalizeImageUrl(screenshot) {
  const rawBase64 = stripBase64Prefix(screenshot)
  if (rawBase64.startsWith('http')) {
    return rawBase64
  }
  return `data:image/png;base64,${rawBase64}`
}

function stripBase64Prefix(base64) {
  const idx = String(base64).indexOf('base64,')
  return idx !== -1 ? String(base64).slice(idx + 'base64,'.length) : String(base64)
}
