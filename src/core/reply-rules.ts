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
