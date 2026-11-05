// src/core/rpa/has-unread.ts
// 未读消息检测 — 红点"两步走"
//
// Step 1: hasUnreadMessage — 粗检测
//   VLM 定位 chatEntranceArea → 局部 crop → 红点像素扫描 → percentage > 1%?
//
// Step 2: isChatContactUnread — 细检测
//   VLM 定位 firstContact → 局部 crop → 红点像素扫描 → percentage > 4%?
//   含边缘分析 + 自适应 crop 扩展重试

import { AIClient } from '../ai-client'
import { AppType } from './types'
import { captureWechatWindow, calculateRedDotPercentage } from './screenshot-utils'
import { getWindowInfo } from './window-utils'
import { getUnreadArea, bboxToCropBounds, BBox } from './vision-utils'

// ── Step 1: 粗检测 ──

/**
 * 检测是否有未读消息
 *
 * 流程:
 * 1. 获取 chatEntranceArea（VLM 定位/缓存）
 * 2. 局部 crop 截图
 * 3. 红点像素扫描
 * 4. percentage > 1% → 有未读
 */
export async function hasUnreadMessage(
  aiClient: AIClient,
  appType: AppType
): Promise<{
  success: boolean
  hasUnread?: boolean
  percentage?: number
  chatEntranceArea?: { bbox: BBox; coordinates: [number, number] }
  error?: string
}> {
  const THRESHOLD = 1 // 1% 红点占比阈值

  try {
    console.log('[HasUnread] Step 1: 粗检测 — 检测聊天入口红点')

    // 1. 获取未读区域
    const unreadArea = await getUnreadArea(aiClient, appType)
    if (!unreadArea.chatEntranceArea?.bbox) {
      return { success: false, error: '无法获取聊天入口区域' }
    }

    // 2. 获取窗口信息
    const windowInfo = await getWindowInfo(appType, false)
    if (!windowInfo?.bounds) {
      return { success: false, error: '获取窗口信息失败' }
    }

    // 3. bbox → crop bounds
    const cropBounds = bboxToCropBounds(
      unreadArea.chatEntranceArea.bbox,
      windowInfo.bounds
    )

    // 4. 局部截图
    const screenshotResult = await captureWechatWindow(appType, cropBounds)
    if (!screenshotResult.success || !screenshotResult.screenshotBase64) {
      return { success: false, error: screenshotResult.error || '局部截图失败' }
    }

    // 5. 红点像素扫描（只扫第一象限=右上角）
    const percentage = await calculateRedDotPercentage(
      screenshotResult.screenshotBase64,
      true // onlyFirstQuadrant
    )

    if (percentage === null) {
      return { success: false, error: '红点计算失败' }
    }

    const hasUnread = percentage > THRESHOLD

    console.log('[HasUnread] Step 1 结果:', {
      percentage: `${percentage.toFixed(2)}%`,
      threshold: `${THRESHOLD}%`,
      hasUnread
    })

    return {
      success: true,
      hasUnread,
      percentage,
      chatEntranceArea: unreadArea.chatEntranceArea
    }
  } catch (error: any) {
    console.error('[HasUnread] Step 1 失败:', error)
    return { success: false, error: error?.message || String(error) }
  }
}

// ── Step 2: 细检测 ──

/**
 * 检测当前联系人是否有未读消息（细检测）
 *
 * 流程:
 * 1. 获取 firstContact（VLM 定位/缓存）
 * 2. 局部 crop 截图（调整为正方形）
 * 3. 红点像素扫描
 * 4. 边缘分析：如果红色像素触碰 crop 边缘，扩展重试
 * 5. percentage > 4% → 有未读
 */
export async function isChatContactUnread(
  aiClient: AIClient,
  appType: AppType
): Promise<{
  success: boolean
  isUnread?: boolean
  percentage?: number
  firstContact?: { bbox: BBox; coordinates: [number, number] }
  error?: string
}> {
  const THRESHOLD = 4         // 4% 红点占比阈值
  const NO_RED_THRESHOLD = 0.5 // 低于此值认为没有红点
  const MAX_RETRIES = 2
  const EXPAND_STEP = 0.1     // 每次扩展 10%

  try {
    console.log('[HasUnread] Step 2: 细检测 — 检测联系人头像红点')

    // 1. 获取未读区域
    const unreadArea = await getUnreadArea(aiClient, appType)
    if (!unreadArea.firstContact?.bbox) {
      return { success: false, error: '无法获取第一个联系人区域' }
    }

    // 2. 获取窗口信息
    const windowInfo = await getWindowInfo(appType, false)
    if (!windowInfo?.bounds) {
      return { success: false, error: '获取窗口信息失败' }
    }

    const { firstContact } = unreadArea

    // 3. bbox → crop bounds（调整为正方形）
    const cropBounds = bboxToCropBounds(firstContact.bbox, windowInfo.bounds)
    cropBounds.width = cropBounds.height // 1:1 正方形

    let currentCrop = { ...cropBounds }
    let retryCount = 0
    let lastPercentage = 0

    // 4. 边缘检测 + 扩展重试循环
    while (retryCount <= MAX_RETRIES) {
      console.log(`[HasUnread] Step 2: 第 ${retryCount + 1} 次尝试`, {
        crop: currentCrop
      })

      // 局部截图
      const screenshotResult = await captureWechatWindow(appType, currentCrop)
      if (!screenshotResult.success || !screenshotResult.screenshotBase64) {
        return { success: false, error: '局部截图失败' }
      }

      // 红点像素扫描
      const percentage = await calculateRedDotPercentage(
        screenshotResult.screenshotBase64,
        true
      )

      if (percentage === null) {
        return { success: false, error: '红点计算失败' }
      }

      lastPercentage = percentage

      // 4a. 占比太低，没有红点
      if (percentage < NO_RED_THRESHOLD) {
        console.log('[HasUnread] Step 2: 红点占比过低，判定无红点', {
          percentage: `${percentage.toFixed(2)}%`
        })
        return {
          success: true,
          isUnread: false,
          percentage,
          firstContact
        }
      }

      // 4b. 超过阈值，确认有红点
      if (percentage > THRESHOLD) {
        console.log('[HasUnread] Step 2: 红点占比超过阈值，确认有红点', {
          percentage: `${percentage.toFixed(2)}%`
        })
        return {
          success: true,
          isUnread: true,
          percentage,
          firstContact
        }
      }

      // 4c. 尴尬区间 (0.5% ~ 4%)，做边缘分析
      console.log('[HasUnread] Step 2: 尴尬区间，进行边缘分析', {
        percentage: `${percentage.toFixed(2)}%`
      })

      const edgeAnalysis = await analyzeRedPixelEdge(
        screenshotResult.screenshotBase64
      )

      if (!edgeAnalysis || !edgeAnalysis.hasEdgeTouch) {
        // 无边缘触碰，用当前结果
        break
      }

      // 有边缘触碰 && 还有重试次数 → 扩展 crop
      if (retryCount < MAX_RETRIES) {
        const expandX = currentCrop.width * EXPAND_STEP
        const expandY = currentCrop.height * EXPAND_STEP

        if (edgeAnalysis.touchTop) {
          currentCrop.y -= expandY
          currentCrop.height += expandY
        }
        if (edgeAnalysis.touchRight) {
          currentCrop.width += expandX
        }
        if (edgeAnalysis.touchBottom) {
          currentCrop.height += expandY
        }
        if (edgeAnalysis.touchLeft) {
          currentCrop.x -= expandX
          currentCrop.width += expandX
        }

        console.log('[HasUnread] Step 2: 扩展 crop 区域', {
          retryCount: retryCount + 1,
          edge: edgeAnalysis,
          newCrop: currentCrop
        })
      }

      retryCount++
    }

    // 循环结束，用最终百分比判断
    const isUnread = lastPercentage > THRESHOLD

    console.log('[HasUnread] Step 2 最终结果:', {
      percentage: `${lastPercentage.toFixed(2)}%`,
      threshold: `${THRESHOLD}%`,
      isUnread,
      retryCount
    })

    return {
      success: true,
      isUnread,
      percentage: lastPercentage,
      firstContact
    }
  } catch (error: any) {
    console.error('[HasUnread] Step 2 失败:', error)
    return { success: false, error: error?.message || String(error) }
  }
}

// ── 边缘分析 ──

interface EdgeAnalysis {
  touchTop: boolean
  touchRight: boolean
  touchBottom: boolean
  touchLeft: boolean
  hasEdgeTouch: boolean
}

/**
 * 分析红色像素的边缘分布
 * 如果红色像素触碰了 crop 的边缘，说明红点可能被截断了
 */
async function analyzeRedPixelEdge(
  base64Image: string
): Promise<EdgeAnalysis | null> {
  try {
    const { Jimp, intToRGBA } = await import('jimp')
    const buffer = Buffer.from(
      base64Image.replace(/^data:image\/\w+;base64,/, ''),
      'base64'
    )
    const image = await Jimp.read(buffer)
    const { width, height } = image.bitmap

    if (width === 0 || height === 0) return null

    const EDGE_MARGIN = 2 // 边缘判定距离（像素）
    let touchTop = false
    let touchRight = false
    let touchBottom = false
    let touchLeft = false

    // 只扫第一象限（右上角）的红色像素
    const centerX = width / 2
    const centerY = height / 2

    for (let x = Math.floor(centerX); x < width; x++) {
      for (let y = 0; y < Math.floor(centerY); y++) {
        const rgba = intToRGBA(image.getPixelColor(x, y))
        const { r, g, b, a } = rgba

        if (a > 128 && r > 150 && r > g * 1.5 && r > b * 1.5) {
          // 是红色像素，检查是否在边缘
          if (y < EDGE_MARGIN) touchTop = true
          if (x >= width - EDGE_MARGIN) touchRight = true
          if (y >= Math.floor(centerY) - EDGE_MARGIN) touchBottom = true
          if (x < Math.floor(centerX) + EDGE_MARGIN) touchLeft = true
        }
      }
    }

    return {
      touchTop,
      touchRight,
      touchBottom,
      touchLeft,
      hasEdgeTouch: touchTop || touchRight || touchBottom || touchLeft
    }
  } catch (error) {
    console.error('[HasUnread] 边缘分析失败:', error)
    return null
  }
}

// ── 在会话列表中定位"真正带红点"的那一行 ──
//
// 旧逻辑固定点击会话列表第一行，当未读会话不在第一行（例如上面有置顶会话）时，
// 会打开错误的会话并把回复发给错误的人。这里改为：沿头像列向下扫描整个会话列表，
// 找到最上面一个"头像右上角红点"，返回那一行的屏幕坐标。

export interface UnreadContactLocation {
  /** 该行头像中心的屏幕坐标（macOS 逻辑像素 / Windows 物理像素，与点击坐标系一致） */
  coordinates: [number, number]
  /** 红点中心相对窗口顶部的 y（逻辑像素），用于点击后复核 */
  badgeWindowY: number
}

const IS_WINDOWS_PLATFORM = process.platform === 'win32'

function isRedPixel(r: number, g: number, b: number, a: number): boolean {
  return a > 128 && r > 150 && r > g * 1.5 && r > b * 1.5
}

/**
 * 扫描会话列表头像列，返回所有红点（按从上到下排序），坐标为相对窗口的逻辑像素 y。
 */
async function scanContactListBadges(
  aiClient: AIClient,
  appType: AppType
): Promise<{
  badges: number[]
  avatar: { x: number; y: number; width: number; height: number }
  windowBounds: { x: number; y: number; width: number; height: number }
  scaleFactor: number
  firstContactCoords: [number, number]
} | null> {
  const unreadArea = await getUnreadArea(aiClient, appType)
  if (!unreadArea.firstContact?.bbox) return null

  const windowInfo = await getWindowInfo(appType, false)
  if (!windowInfo?.bounds) return null
  const windowBounds = windowInfo.bounds
  const scaleFactor = windowInfo.scaleFactor || 1

  const avatar = bboxToCropBounds(unreadArea.firstContact.bbox, windowBounds)
  avatar.width = avatar.height // 头像是正方形

  // 竖条：覆盖头像右半边 + 角标溢出部分，从第一行头像上方一点一直到窗口底部
  const strip = {
    x: avatar.x + avatar.width * 0.45,
    y: Math.max(0, avatar.y - avatar.height * 0.5),
    width: avatar.width * 0.85,
    height: 0
  }
  strip.height = windowBounds.height - strip.y - 4
  if (strip.height <= avatar.height) return null

  const shot = await captureWechatWindow(appType, strip)
  if (!shot.success || !shot.screenshotBase64) return null

  const { Jimp, intToRGBA } = await import('jimp')
  const pngBuffer = Buffer.from(
    shot.screenshotBase64.replace(/^data:image\/\w+;base64,/, ''),
    'base64'
  )
  const image = await Jimp.read(pngBuffer)
  const { width, height } = image.bitmap
  const pxPerPt = height / strip.height

  // 每一行像素里的红色像素数
  const rowRed: number[] = new Array(height).fill(0)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const { r, g, b, a } = intToRGBA(image.getPixelColor(x, y))
      if (isRedPixel(r, g, b, a)) rowRed[y]++
    }
  }

  // 连续的"红色行"聚成一个候选红点
  const minRowRed = Math.max(2, Math.round(2 * pxPerPt))
  const minBadgeH = 6 * pxPerPt // 红点至少 ~6pt 高
  const maxBadgeH = avatar.height * 0.75 * pxPerPt // 比头像小得多；更大的红色块多半是头像图案
  const badges: number[] = []
  let start = -1
  for (let y = 0; y <= height; y++) {
    const isRedRow = y < height && rowRed[y] >= minRowRed
    if (isRedRow && start < 0) start = y
    if (!isRedRow && start >= 0) {
      const h = y - start
      if (h >= minBadgeH && h <= maxBadgeH) {
        const centerPx = (start + y) / 2
        badges.push(strip.y + centerPx / pxPerPt)
      }
      start = -1
    }
  }

  return {
    badges,
    avatar,
    windowBounds,
    scaleFactor,
    firstContactCoords: unreadArea.firstContact.coordinates
  }
}

/**
 * 找到会话列表中最上面一个带未读红点的会话。
 * 找不到返回 null（例如未读消息就在当前打开的会话里，列表里不显示红点）。
 */
export async function findUnreadContactInList(
  aiClient: AIClient,
  appType: AppType
): Promise<UnreadContactLocation | null> {
  try {
    const scan = await scanContactListBadges(aiClient, appType)
    if (!scan) {
      console.warn('[HasUnread] 会话列表扫描失败')
      return null
    }
    console.log('[HasUnread] 会话列表红点扫描:', {
      badgeYs: scan.badges.map((y) => Math.round(y)),
      avatarH: Math.round(scan.avatar.height),
      avatar: scan.avatar
    })
    if (scan.badges.length === 0) return null

    const badgeY = scan.badges[0]
    // 红点在头像右上角：头像中心大约在红点下方 0.35 个头像高度
    const rowCenterWindowY = badgeY + scan.avatar.height * 0.35
    const logicalY = scan.windowBounds.y + rowCenterWindowY
    const logicalX = scan.firstContactCoords[0] / (IS_WINDOWS_PLATFORM ? scan.scaleFactor : 1)

    const coordinates: [number, number] = IS_WINDOWS_PLATFORM
      ? [Math.round(logicalX * scan.scaleFactor), Math.round(logicalY * scan.scaleFactor)]
      : [Math.round(logicalX), Math.round(logicalY)]

    return { coordinates, badgeWindowY: badgeY }
  } catch (error) {
    console.error('[HasUnread] findUnreadContactInList 失败:', error)
    return null
  }
}

/**
 * 点击会话后复核：原来那个红点是否已经消失（= 这个会话确实被打开了）。
 */
export async function isContactBadgeCleared(
  aiClient: AIClient,
  appType: AppType,
  badgeWindowY: number
): Promise<boolean> {
  try {
    const scan = await scanContactListBadges(aiClient, appType)
    if (!scan) return false
    const tolerance = scan.avatar.height * 0.5
    const stillThere = scan.badges.some((y) => Math.abs(y - badgeWindowY) < tolerance)
    console.log('[HasUnread] 点击后复核红点:', {
      target: Math.round(badgeWindowY),
      badgeYs: scan.badges.map((y) => Math.round(y)),
      cleared: !stillThere
    })
    return !stillThere
  } catch (error) {
    console.error('[HasUnread] isContactBadgeCleared 失败:', error)
    return false
  }
}
