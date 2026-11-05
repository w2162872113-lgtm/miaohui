// src/core/reply-rules.ts
// 回复规则 + 知识库：决定"哪些会话要回复"，以及回复时以什么资料为准。
//
// 规则在代码里确定性执行（不交给模型自由发挥）：
//   1. 先识别当前会话的名称和是否群聊（device.identifyChat，读取标题栏）
//   2. 按 只回复名单 → 不回复名单 → 群聊策略 依次判断
//   3. 不通过就直接跳过，不调用回复模型

export type GroupPolicy = 'never' | 'mention' | 'always'

export interface ReplyRules {
  /** 群聊：never=不回复（默认）；mention=只在被@时回复；always=正常回复 */
  groupPolicy: GroupPolicy
  /** 我在群里的名字，用于判断是否被@（groupPolicy=mention 时需要） */
  myName: string
  /** 不回复的会话：名称包含任一关键词即跳过 */
  blocklist: string[]
  /** 只回复的会话：非空时，只有名称包含任一关键词的会话才回复 */
  allowlist: string[]
}

export interface KnowledgeBase {
  text: string
}

export interface ChatIdentity {
  name: string
  isGroup: boolean
}

export const DEFAULT_REPLY_RULES: ReplyRules = {
  groupPolicy: 'never',
  myName: '',
  blocklist: [],
  allowlist: []
}

/** 知识库上限（字符）。2.1-lite 支持超长上下文，但越长单次回复越贵越慢。 */
export const KNOWLEDGE_MAX_CHARS = 100_000

export function normalizeReplyRules(raw: any): ReplyRules {
  const toList = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.map((s) => String(s).trim()).filter(Boolean)
      : typeof v === 'string'
        ? v.split(/[\n,，]/).map((s) => s.trim()).filter(Boolean)
        : []
  const policy = raw?.groupPolicy
  return {
    groupPolicy: policy === 'mention' || policy === 'always' ? policy : 'never',
    myName: typeof raw?.myName === 'string' ? raw.myName.trim() : '',
    blocklist: toList(raw?.blocklist),
    allowlist: toList(raw?.allowlist)
  }
}

export function normalizeKnowledge(raw: any): KnowledgeBase {
  const text = typeof raw?.text === 'string' ? raw.text : ''
  return { text: text.slice(0, KNOWLEDGE_MAX_CHARS) }
}

function matchAny(name: string, keywords: string[]): string | null {
  const lower = name.toLowerCase()
  return keywords.find((k) => lower.includes(k.toLowerCase())) ?? null
}

export type RuleVerdict =
  | { allow: true; groupMentionOnly: boolean }
  | { allow: false; reason: string }

/**
 * 根据会话身份判断是否允许回复。
 * identity 为 null（识别失败）时：设置了"只回复名单"就保守跳过，否则放行。
 */
export function evaluateReplyRules(rules: ReplyRules, identity: ChatIdentity | null): RuleVerdict {
  if (!identity) {
    if (rules.allowlist.length > 0) {
      return { allow: false, reason: '无法识别会话名称，已设置“只回复名单”，保守跳过' }
    }
    return { allow: true, groupMentionOnly: rules.groupPolicy === 'mention' }
  }

  if (rules.allowlist.length > 0 && !matchAny(identity.name, rules.allowlist)) {
    return { allow: false, reason: '不在“只回复名单”中' }
  }

  const blocked = matchAny(identity.name, rules.blocklist)
  if (blocked) {
    return { allow: false, reason: `命中“不回复名单”：${blocked}` }
  }

  if (identity.isGroup) {
    if (rules.groupPolicy === 'never') {
      return { allow: false, reason: '群聊（当前设置为群聊不回复）' }
    }
    return { allow: true, groupMentionOnly: rules.groupPolicy === 'mention' }
  }

  return { allow: true, groupMentionOnly: false }
}

// ── 回复风格（语气） ──

export type StylePreset = 'natural' | 'professional' | 'concise' | 'sales' | 'custom'

export interface ReplyStyle {
  preset: StylePreset
  /** 自定义语气描述（preset=custom 时为主，其他预设时作为补充） */
  custom: string
  /** 我的说话样例：真实发出过的回复，每行一条，模型模仿其用词、长短、标点 */
  examples: string
}

export const DEFAULT_REPLY_STYLE: ReplyStyle = {
  preset: 'natural',
  custom: '',
  examples: ''
}

export const STYLE_PRESETS: Record<Exclude<StylePreset, 'custom'>, { label: string; prompt: string }> = {
  natural: {
    label: '真人随和',
    prompt:
      '像一个靠谱、好说话的真人员工在微信上聊天：口语化、直接回答问题，语气自然不端着。不用敬语堆砌，"您"和"你"跟着客户的叫法走。'
  },
  professional: {
    label: '专业顾问',
    prompt:
      '像一位专业顾问：用"您"，表达清楚有条理，信息准确，语气稳重礼貌但不生硬，不用网络流行语和语气词。'
  },
  concise: {
    label: '简洁高效',
    prompt:
      '像一个很忙但靠谱的人回消息：能一句话说清就不说两句，只回答问题本身，几乎不用语气词和客套话，可以不用句号结尾。'
  },
  sales: {
    label: '热情销售',
    prompt:
      '像一个积极热情的销售：回答问题后自然地引导下一步（了解需求、推荐合适方案、邀约试听/到店等），但不强推、不夸大。提到的优惠、名额、价格必须来自知识库，知识库没有的不能说。'
  }
}

/** 所有语气通用的"去 AI 味"规则 */
const HUMAN_LIKE_RULES = `## 说话要像真人，不要有 AI 味
- 回复长短跟着客户走：客户只发几个字，你也简短回；客户问得详细，再说详细点
- 不要套话：不说"亲""宝子""好的呢""很高兴为您服务""请问还有什么可以帮您""希望对您有帮助"
- 语气词别堆："呀、哦、呢、啦"整条回复最多一个，"～"最多一个，不要每句都加
- 不要每次都反问或追问，客户只是确认、道谢时，简单回应即可
- 不要复述客户的问题，不要总结，不要用"首先/其次/总之"，不要用列表格式
- emoji 最多一个，或者不用`

/** 把回复风格拼成 system prompt 片段 */
export function buildStylePrompt(style: ReplyStyle): string {
  const parts: string[] = [HUMAN_LIKE_RULES]

  const presetPrompt = style.preset === 'custom' ? '' : STYLE_PRESETS[style.preset]?.prompt
  const custom = style.custom.trim()
  if (presetPrompt || custom) {
    parts.push(
      `## 语气\n${[presetPrompt, custom ? `补充要求：${custom}` : ''].filter(Boolean).join('\n')}`
    )
  }

  const examples = style.examples
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 30)
  if (examples.length) {
    parts.push(
      `## 我平时的说话样例（重点模仿其用词、句子长短、标点和语气，但不要照抄内容）\n${examples
        .map((e) => `- ${e}`)
        .join('\n')}`
    )
  }

  return `\n\n${parts.join('\n\n')}`
}

export function normalizeReplyStyle(raw: any): ReplyStyle {
  const preset: StylePreset = ['natural', 'professional', 'concise', 'sales', 'custom'].includes(
    raw?.preset
  )
    ? raw.preset
    : 'natural'
  return {
    preset,
    custom: typeof raw?.custom === 'string' ? raw.custom.slice(0, 2000) : '',
    examples: typeof raw?.examples === 'string' ? raw.examples.slice(0, 6000) : ''
  }
}
