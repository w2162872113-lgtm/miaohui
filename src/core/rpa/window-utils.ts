import { screen } from 'electron'
import activeWin from 'active-win'
import { AppType } from './types'
import { captureWechatWindow } from './screenshot-utils'

const IS_WINDOWS = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'

// 包装带超时的 activeWin 调用
async function getOpenWindowsSafe(): Promise<any[]> {
  try {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('active-win getOpenWindows timeout')), 5000)
    })
    
    // 如果系统没有给权限，activeWin在某些版本可能卡死，强制5秒超时
    const windows = await Promise.race([
      activeWin.getOpenWindows(),
      timeoutPromise
    ])
    return windows as any[]
  } catch (err: any) {
    console.error('[window-utils] getOpenWindowsSafe error or timeout:', err.message)
    return []
  }
}

export function matchWechatType(name: string, appType: AppType) {
  if ((appType as string) === 'whatsapp') {
    return ['‎WhatsApp', '‎WhatsApp.app', '‎WhatsApp.exe', 'WhatsApp'].includes(name)
  }
  const wechatName =
    appType === 'wechat' ? ['微信', '微信.app', 'WeChat'] : ['企业微信', '企业微信.app']
  return wechatName.includes(name)
}

function getWechatWindow(appType: AppType, windows: any[]): any {
  let appTargetName: string[]
  let windowTitle: string[]

  if ((appType as string) === 'whatsapp') {
    appTargetName = ['‎WhatsApp', '‎WhatsApp.app', '‎WhatsApp.exe', 'WhatsApp']
    windowTitle = ['‎WhatsApp', '‎WhatsApp.app', '‎WhatsApp.exe', 'WhatsApp']
  } else {
    appTargetName =
      appType === 'wechat' ? ['微信', '微信.app', 'WeChat'] : ['企业微信', '企业微信.app']
    windowTitle = appType === 'wechat' ? ['微信', 'Weixin'] : ['企业微信']
  }

  const allWechatWindows = windows.filter((window: any) =>
    appTargetName.includes(window?.owner?.name)
  )

  if (allWechatWindows.length > 1) {
    const selected = allWechatWindows.find((window: any) => windowTitle.includes(window.title))
    return selected
  }
  if (allWechatWindows.length === 1) {
    return allWechatWindows[0]
  }
  return undefined
}

type PlatformWindow = {
  getBounds?: () => { x?: number; y?: number; width?: number; height?: number }
  bounds?: { x?: number; y?: number; width?: number; height?: number }
  [key: string]: any
}

async function getWechatWindowInWin(appType: AppType): Promise<PlatformWindow | null> {
  try {
    const { windowManager } = require('node-window-manager')
    let activeWechatWindow = windowManager.getActiveWindow()
    if (activeWechatWindow && matchWechatType(activeWechatWindow.getTitle(), appType)) {
      return activeWechatWindow
    }
    const foundWindow = windowManager.getWindows()
      ?.find((window: any) => matchWechatType(window.getTitle(), appType) && window.isVisible())
    return foundWindow || null
  } catch (err: any) {
    console.error('[window-utils] getWechatWindowInWin error:', err.message)
    return null
  }
}

async function getWechatWindowInMac(appType: AppType): Promise<PlatformWindow | null> {
  const windows = await getOpenWindowsSafe()
  if (!windows || windows.length === 0) {
    return null
  }
  return getWechatWindow(appType, windows) || null
}

function getWindowBounds(window: PlatformWindow): {
  x?: number
  y?: number
  width?: number
  height?: number
} | null {
  if (typeof window.getBounds === 'function') {
    return window.getBounds()
  }
  if (window.bounds) {
    return window.bounds
  }
  return null
}

function validateWindowBounds(bounds: { x?: number; y?: number; width?: number; height?: number } | null): bounds is { x: number; y: number; width: number; height: number } {
  if (!bounds) return false
  if (bounds.x === undefined || bounds.y === undefined || !bounds.width || !bounds.height ||
     (bounds.width && bounds.width < 100) || (bounds.height && bounds.height < 100)) {
    return false
  }
  const isVisible = bounds.width > 0 && bounds.height > 0
  return isVisible
}

interface WechatWindowInfoCache {
  result: any | null
  timestamp: number
}
const WINDOW_INFO_CACHE_DURATION = 5000 // 5 seconds cache
const wechatWindowInfoCache = new Map<AppType, WechatWindowInfoCache>()
const wechatWindowInfoPendingPromises = new Map<AppType, Promise<any>>()

export async function getWechatWindowInfo(appType: AppType) {
  const cached = wechatWindowInfoCache.get(appType)
  const now = Date.now()
  if (cached && now - cached.timestamp < WINDOW_INFO_CACHE_DURATION) {
    return cached.result
  }

  const pendingPromise = wechatWindowInfoPendingPromises.get(appType)
  if (pendingPromise) return pendingPromise

  const queryPromise = (async () => {
    try {
      const wechatWindow = IS_WINDOWS ? await getWechatWindowInWin(appType) : IS_MAC ? await getWechatWindowInMac(appType) : null
      if (!wechatWindow) return null

      const bounds = getWindowBounds(wechatWindow)
      if (!validateWindowBounds(bounds)) return null

      const display = screen.getDisplayMatching({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height
      })

      const result = {
        wechatWindow,
        bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        wechatType: appType,
        display: { id: display.id, scaleFactor: display.scaleFactor, bounds: display.bounds }
      }
      wechatWindowInfoCache.set(appType, { result, timestamp: Date.now() })
      return result
    } catch (e) {
      console.error('getWechatWindowInfo error:', e)
      return null
    } finally {
      wechatWindowInfoPendingPromises.delete(appType)
    }
  })()

  wechatWindowInfoPendingPromises.set(appType, queryPromise)
  return queryPromise
}

export const getWindowInfo = async (appType: AppType = 'wechat', includeScreenshot: boolean = true) => {
  if (!includeScreenshot) {
    const result = await getWechatWindowInfo(appType)
    if (!result) return null
    return {
      wechatWindow: result.wechatWindow,
      bounds: result.bounds,
      wechatType: result.wechatType,
      scaleFactor: result.display.scaleFactor
    }
  }

  try {
    const windowCore = await getWechatWindowInfo(appType)
    if (!windowCore) return null

    const result = await captureWechatWindow(appType)
    if (!result.success || !result.screenshotBase64) return null

    return {
      wechatWindow: windowCore.wechatWindow,
      bounds: result.bounds!,
      wechatType: windowCore.wechatType,
      scaleFactor: result.display!.scaleFactor,
      screenshot: result.screenshotBase64
    }
  } catch (error) {
    console.error('getWindowInfo failure:', error)
    return null
  }
}

/**
 * 同步获取窗口信息（从内存缓存读取，不发起系统调用）
 * 前提：measureLayout 时已经调过 getWindowInfo/getWechatWindowInfo，缓存有数据
 */
export function getWindowInfoSync(appType: AppType): {
  bounds: { x: number; y: number; width: number; height: number }
  scaleFactor: number
} | null {
  const cached = wechatWindowInfoCache.get(appType)
  if (!cached?.result) return null

  return {
    bounds: cached.result.bounds,
    scaleFactor: cached.result.display?.scaleFactor || 1
  }
}

/**
 * 检查目标窗口是否被别的窗口挡住（macOS：getOpenWindows 按从前到后的层级返回）。
 *
 * 被挡住时截图会截到别的程序，点击/输入也会落到别的程序上，必须暂停。
 * - 忽略 SightFlow 自己的窗口（同一进程）
 * - 忽略很小的窗口和只盖住一点点的窗口（如系统通知横幅）
 * Windows 平台暂不检测，直接返回未遮挡。
 */
const SYSTEM_OVERLAY_OWNERS = new Set([
  'Dock', '程序坞', 'Window Server', 'WindowServer', 'SystemUIServer',
  'Control Center', '控制中心', 'Notification Center', '通知中心',
  'NotificationCenter', 'Spotlight', '聚焦', 'TextInputMenuAgent', 'Wallpaper', '墙纸'
])

export async function getWindowObstruction(
  appType: AppType
): Promise<{ obstructed: boolean; by?: string; missing?: boolean }> {
  if (IS_WINDOWS) return getWindowObstructionWin(appType)
  if (!IS_MAC) return { obstructed: false }
  const windows = await getOpenWindowsSafe()
  if (!windows.length) return { obstructed: false } // 拿不到窗口列表时不阻断

  const target = getWechatWindow(appType, windows)
  if (!target?.bounds) return { obstructed: true, missing: true }

  const t = target.bounds
  const targetArea = t.width * t.height
  const OVERLAP_RATIO = 0.08 // 盖住超过 8% 视为被挡住

  for (const w of windows) {
    if (w === target) break // 目标窗口之后的都在它下面
    if (!w?.bounds) continue
    if (w.owner?.processId === process.pid) continue // 本程序自己的窗口
    if (SYSTEM_OVERLAY_OWNERS.has(w.owner?.name)) continue // 程序坞、菜单栏、通知等系统层
    if (w.owner?.processId && w.owner.processId === target.owner?.processId) continue // 企业微信自己的弹窗/资料卡
    if (w.bounds.width < 80 || w.bounds.height < 80) continue

    const ox = Math.max(0, Math.min(t.x + t.width, w.bounds.x + w.bounds.width) - Math.max(t.x, w.bounds.x))
    const oy = Math.max(0, Math.min(t.y + t.height, w.bounds.y + w.bounds.height) - Math.max(t.y, w.bounds.y))
    if ((ox * oy) / targetArea > OVERLAP_RATIO) {
      console.log('[window-utils] 目标窗口被遮挡:', {
        by: w.owner?.name,
        title: (w.title || '').slice(0, 40),
        bounds: w.bounds,
        target: t
      })
      return { obstructed: true, by: w.owner?.name || w.title || '其他窗口' }
    }
  }
  return { obstructed: false }
}

/**
 * Windows：拿不到完整的窗口层级，退而检查"当前前台窗口"。
 * 前台窗口一定在最上层；如果它不是企业微信/SightFlow，且盖住了企业微信窗口的一部分，就视为被挡住。
 */
async function getWindowObstructionWin(
  appType: AppType
): Promise<{ obstructed: boolean; by?: string; missing?: boolean }> {
  try {
    const target = (await getWechatWindowInWin(appType)) as any
    if (!target) return { obstructed: true, missing: true }
    if (typeof target.isWindow === 'function' && !target.isWindow()) {
      return { obstructed: true, missing: true }
    }
    const t = target.getBounds?.()
    if (!t?.width || !t?.height) return { obstructed: true, missing: true }
    // 最小化的窗口在 Windows 上通常坐标为 -32000
    if ((t.x ?? 0) <= -30000 || (t.y ?? 0) <= -30000) return { obstructed: true, missing: true }

    const { windowManager } = require('node-window-manager')
    const active = windowManager.getActiveWindow()
    if (!active) return { obstructed: false }
    if (active.id === target.id) return { obstructed: false }
    if (active.processId === process.pid || active.processId === target.processId) {
      return { obstructed: false }
    }

    const w = active.getBounds?.()
    if (!w?.width || !w?.height) return { obstructed: false }
    const ox = Math.max(0, Math.min(t.x + t.width, w.x + w.width) - Math.max(t.x, w.x))
    const oy = Math.max(0, Math.min(t.y + t.height, w.y + w.height) - Math.max(t.y, w.y))
    if ((ox * oy) / (t.width * t.height) > 0.08) {
      let by = ''
      try {
        by = active.getTitle?.() || ''
      } catch {
        // ignore
      }
      console.log('[window-utils] (Windows) 目标窗口被前台窗口遮挡:', { by, bounds: w, target: t })
      return { obstructed: true, by: by || '其他窗口' }
    }
    return { obstructed: false }
  } catch (error: any) {
    console.error('[window-utils] getWindowObstructionWin 失败:', error?.message)
    return { obstructed: false } // 检测失败不阻断，避免误停
  }
}
