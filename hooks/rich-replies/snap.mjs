// Screenshots and page checks through Chrome's DevTools protocol, no dependency (Node 22+ has WebSocket).
// Usage: node snap.mjs <url> <out.png> [--full] [--el <css>] [--css] [--wait <ms>] [--dark] [--consent] [--noads] [--hover <css>] [--click <css>]
//        [--vs <url> | --devices | --filmstrip | --og] [--cls] [--perf] [--console] [--a11y] [--tokens]
// Prints "<width>x<height>" once the picture is written, then one "<KEY> <json>" line per report
// (CSS, DIFF, CLS, PERF, CONSOLE, A11Y, OG, TOKENS). Exits 1 with the reason otherwise.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const IDLE_MS = 20000
const MAX_HEIGHT = 16000
const DEVICES = [
  { label: 'iPhone 15', width: 393, height: 852, mobile: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
  { label: 'iPad Air', width: 820, height: 1180, mobile: true, ua: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
  { label: 'Desktop', width: 1280, height: 800, mobile: false },
]
const DESKTOP = DEVICES[2]

const [url, out, ...rest] = process.argv.slice(2)
const has = name => rest.includes(`--${name}`)
const option = name => (has(name) ? rest[rest.indexOf(`--${name}`) + 1] : undefined)
const selector = option('el')
const extraWait = Number(option('wait') ?? 0)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const report = (key, value) => console.log(`${key} ${JSON.stringify(value)}`)
const host = address => new URL(address).host

// Local dev hosts run on self-signed certificates; anywhere else a bad certificate stops the capture.
const isLocal = address => /^(localhost|127\.|local[.-])|\.(local|test|localhost)$/.test(new URL(address).hostname)
const targetsAreLocal = [url, option('vs')].filter(Boolean).every(isLocal)
// One profile per run: two captures at once (a --watch and a /snap) would otherwise share Chrome's lock.
const profile = mkdtempSync(join(tmpdir(), 'rich-replies-chrome-'))
const chrome = spawn(CHROME, [
  '--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
  ...(targetsAreLocal ? ['--ignore-certificate-errors'] : []), `--user-data-dir=${profile}`, '--remote-debugging-port=0',
  '--window-size=1280,800', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })
// The profile goes once Chrome has exited (it writes to it while dying); 3 s at most, then leave it to the OS.
const quit = code => {
  const done = () => {
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {}
    process.exit(code)
  }
  chrome.once('exit', done)
  setTimeout(done, 3000)
  chrome.kill()
}
const fail = reason => {
  console.error(reason)
  quit(1)
}
setTimeout(() => fail('timeout after 120s'), 120000)

const browser = await new Promise((resolve, reject) => {
  let log = ''
  chrome.stderr.on('data', chunk => {
    log += chunk
    const found = log.match(/DevTools listening on (ws:\S+)/)
    if (found) resolve(found[1])
  })
  chrome.on('exit', () => reject(new Error('chrome exited')))
}).catch(error => fail(error.message))
const targets = await (await fetch(`http://127.0.0.1:${new URL(browser).port}/json/list`)).json()
const ws = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl)
await new Promise(resolve => ws.addEventListener('open', resolve))

let lastId = 0
const pending = new Map()
const listeners = new Set()
ws.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data)
  const call = pending.get(message.id)
  if (!call) return listeners.forEach(listen => listen(message))
  pending.delete(message.id)
  message.error ? call.reject(new Error(message.error.message)) : call.resolve(message.result)
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    pending.set(++lastId, { resolve, reject })
    ws.send(JSON.stringify({ id: lastId, method, params }))
  })
const on = (method, listen) => listeners.add(message => message.method === method && listen(message.params))
const evaluate = async (expression, isAsync = false) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: isAsync })
  if (exceptionDetails) fail(exceptionDetails.exception?.description ?? exceptionDetails.text)
  return result.value
}

// Headless Chrome says so in its user agent, and some sites answer it differently: drop the word.
const { userAgent } = await send('Browser.getVersion')
const desktopUa = userAgent.replace('HeadlessChrome', 'Chrome')
await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Log.enable')
// Timings and weights mean a first visit: the reused profile's cache would make them look free.
if (['perf', 'filmstrip', 'cls'].some(has)) await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Page.setLifecycleEventsEnabled', { enabled: true })
// Layout shifts and the LCP element, recorded from the first byte of every page.
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__rr = { cls: 0, shifts: [], lcp: null }
    const name = node => node ? node.nodeName.toLowerCase() + (node.id ? '#' + node.id : '') + (node.classList?.length ? '.' + [...node.classList].slice(0, 2).join('.') : '') : '?'
    new PerformanceObserver(list => { for (const entry of list.getEntries()) {
      if (entry.hadRecentInput) continue
      __rr.cls += entry.value
      for (const source of entry.sources ?? []) {
        const box = source.currentRect
        __rr.shifts.push({ value: entry.value, at: Math.round(entry.startTime), node: name(source.node), x: box.x + scrollX, y: box.y + scrollY, width: box.width, height: box.height })
      }
    } }).observe({ type: 'layout-shift', buffered: true })
    new PerformanceObserver(list => { const entry = list.getEntries().at(-1); const box = entry.element?.getBoundingClientRect()
      __rr.lcp = { at: Math.round(entry.startTime), node: name(entry.element), box: box && { x: box.x + scrollX, y: box.y + scrollY, width: box.width, height: box.height } }
    }).observe({ type: 'largest-contentful-paint', buffered: true })`,
})

// What the page logged and fetched, for --console and --perf.
const logs = []
const requests = new Map()
on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => logs.push({ level: 'error', text: (d.exception?.description ?? d.text).split('\n')[0], url: d.url ?? '', line: (d.lineNumber ?? 0) + 1 }))
on('Runtime.consoleAPICalled', ({ type, args, stackTrace }) => {
  if (type !== 'error' && type !== 'warning') return
  const frame = stackTrace?.callFrames?.[0]
  logs.push({ level: type === 'warning' ? 'warning' : 'error', text: args.map(arg => arg.value ?? arg.description ?? '').join(' ').split('\n')[0], url: frame?.url ?? '', line: (frame?.lineNumber ?? 0) + 1 })
})
on('Log.entryAdded', ({ entry }) => entry.level === 'error' && entry.source !== 'network' && logs.push({ level: 'error', text: entry.text.split('\n')[0], url: entry.url ?? '', line: (entry.lineNumber ?? 0) + 1 }))
on('Network.requestWillBeSent', ({ requestId, request }) => requests.set(requestId, { url: request.url, status: 0, bytes: 0 }))
on('Network.responseReceived', ({ requestId, response }) => {
  const request = requests.get(requestId)
  if (request) request.status = response.status
})
on('Network.loadingFinished', ({ requestId, encodedDataLength }) => {
  const request = requests.get(requestId)
  if (request) request.bytes = encodedDataLength
})
on('Network.loadingFailed', ({ requestId, errorText, canceled }) => {
  const request = requests.get(requestId)
  if (request && !canceled) request.failed = errorText
})

let viewport = DESKTOP
// "Loaded" = the navigation's networkIdle (no request for 500 ms), at most IDLE_MS. onFrame runs while it loads.
async function open(address, device = DESKTOP, onFrame) {
  viewport = device
  await send('Emulation.setDeviceMetricsOverride', { width: device.width, height: device.height, deviceScaleFactor: 1, mobile: device.mobile })
  await send('Emulation.setUserAgentOverride', { userAgent: device.ua ?? desktopUa })
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: has('dark') ? 'dark' : 'light' }] })
  let loader
  let isIdle = false
  const idle = new Promise(resolve => on('Page.lifecycleEvent', ({ name, loaderId }) => name === 'networkIdle' && loaderId === loader && resolve()))
  const startedAt = Date.now()
  const navigation = await send('Page.navigate', { url: address }).catch(error => fail(`${address}: ${error.message}`))
  if (navigation.errorText) fail(`${address}: ${navigation.errorText}`)
  loader = navigation.loaderId
  const loaded = Promise.race([idle, sleep(IDLE_MS)]).then(() => (isIdle = true))
  if (onFrame) while (!isIdle) await Promise.all([onFrame(Date.now() - startedAt), sleep(400)])
  await loaded
  // The cookie wall covers every page on a first visit: accept it like a reader would (ads then load), unless --consent.
  if (!has('consent') && (await acceptCookies())) await sleep(3000)
  if (extraWait > 0) await sleep(extraWait)
  if (has('noads')) await hideAds()
  await interact()
}

// --noads: ad slots rotate creatives on every load, so a --vs diff would be mostly ads; blank them (keeping their space).
const hideAds = () =>
  evaluate(`(() => {
    const site = location.hostname.split('.').slice(-2).join('.')
    const slots = document.querySelectorAll('[id^="google_ads"], [id*="div-gpt"], ins.adsbygoogle, [data-google-query-id], [class*="ad-slot"], [id^="taboola"], [class*="taboola"]')
    const frames = [...document.querySelectorAll('iframe')].filter(f => { try { return !new URL(f.src, location.href).hostname.endsWith(site) } catch { return true } })
    for (const el of [...slots, ...frames]) el.style.setProperty('visibility', 'hidden', 'important')
  })()`)

const acceptCookies = () =>
  evaluate(`(() => {
    const known = document.querySelector('#didomi-notice-agree-button, #onetrust-accept-btn-handler, #axeptio_btn_acceptAll, .fc-cta-consent, [data-testid=uc-accept-all-button]')
    const byText = [...document.querySelectorAll('button, a[role=button]')].find(el => /^(accept(er)?( all| tout| les cookies| cookies)?|tout accepter|j'accepte|agree)$/i.test(el.textContent.trim()))
    const button = known ?? byText
    button?.click()
    return Boolean(button)
  })()`)

// --hover / --click: the real mouse, at the element's center, then a beat for transitions.
async function interact() {
  const target = option('hover') ?? option('click')
  if (!target) return
  const center = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(target)})
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const box = el.getBoundingClientRect()
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
  })()`)
  if (!center) fail(`no element for ${target}`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...center })
  if (has('click')) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...center, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...center, button: 'left', clickCount: 1 })
  }
  await sleep(600)
}

// Boxes drawn over the page itself, so the picture shows what a report names.
const overlay = boxes =>
  has('vs') ? null : evaluate(`(() => {
    for (const box of ${JSON.stringify(boxes)}) {
      const el = document.createElement('div')
      el.style.cssText = 'position:absolute;z-index:2147483647;pointer-events:none;box-sizing:border-box;'
        + 'left:' + box.x + 'px;top:' + box.y + 'px;width:' + Math.max(box.width, 4) + 'px;height:' + Math.max(box.height, 4) + 'px;'
        + 'border:3px solid ' + box.color + ';background:' + box.color + '22;'
      const tag = document.createElement('span')
      tag.textContent = box.label
      tag.style.cssText = 'position:absolute;bottom:100%;left:-3px;white-space:nowrap;padding:1px 6px;font:bold 13px/18px sans-serif;color:#000;background:' + box.color
      el.appendChild(tag)
      document.documentElement.appendChild(el)
    }
  })()`)

async function capture() {
  let clip
  if (selector) {
    clip = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return null
      const box = el.getBoundingClientRect()
      return { x: box.left + scrollX, y: box.top + scrollY, width: box.width, height: box.height }
    })()`)
    if (!clip || clip.width === 0) fail(`no visible element for ${selector}`)
  } else if (has('full')) {
    const { cssContentSize } = await send('Page.getLayoutMetrics')
    clip = { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height }
  }
  if (clip) clip = { ...clip, height: Math.min(clip.height, MAX_HEIGHT), scale: 1 }
  const { data } = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) })

  return { png: data, width: Math.round(clip?.width ?? viewport.width), height: Math.round(clip?.height ?? viewport.height) }
}

// Draws a sheet on a blank page: panels placed by Node ({ png } | { diff: [a, b] } | { lines }), each under its label.
async function compose(width, height, panels) {
  await send('Emulation.setEmulatedMedia', { features: [] })
  await send('Page.navigate', { url: 'about:blank' })
  await sleep(200)
  const value = await evaluate(`(async (width, height, panels) => {
    const load = src => new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = 'data:image/png;base64,' + src })
    const images = await Promise.all(panels.map(panel => (panel.png ? load(panel.png) : null)))
    const sheet = new OffscreenCanvas(width, height)
    const ctx = sheet.getContext('2d')
    ctx.fillStyle = '#0f172a'
    ctx.fillRect(0, 0, width, height)
    // Marked panels (the two of --vs): where they differ, grouped into zones, framed and numbered on both.
    let percent = 0
    let zones = []
    const marked = panels.map((panel, n) => (panel.mark ? n : -1)).filter(n => n >= 0)
    if (marked.length === 2) {
      const [a, b] = marked.map(n => images[n])
      const w = Math.max(a.width, b.width), h = Math.max(a.height, b.height)
      const pixels = img => { const c = new OffscreenCanvas(w, h).getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, w, h); c.drawImage(img, 0, 0); return c.getImageData(0, 0, w, h).data }
      const pa = pixels(a), pb = pixels(b)
      const cell = 16, cols = Math.ceil(w / cell), rows = Math.ceil(h / cell)
      const counts = new Uint16Array(cols * rows)
      let changed = 0
      for (let i = 0; i < pa.length; i += 4) {
        if (Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]) <= 48) continue
        changed++
        const p = i / 4
        counts[Math.floor(Math.floor(p / w) / cell) * cols + Math.floor((p % w) / cell)]++
      }
      percent = (changed / (w * h)) * 100
      // Hot cells (> 2 % changed), joined with their neighbours up to one cell apart, make a zone.
      const hot = counts.map(count => (count > cell * cell * 0.02 ? 1 : 0))
      const seen = new Uint8Array(cols * rows)
      for (let start = 0; start < hot.length; start++) {
        if (!hot[start] || seen[start]) continue
        const stack = [start]
        seen[start] = 1
        let x0 = cols, y0 = rows, x1 = 0, y1 = 0, sum = 0
        while (stack.length) {
          const at = stack.pop(), cx = at % cols, cy = Math.floor(at / cols)
          sum += counts[at]
          x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy)
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            const nx = cx + dx, ny = cy + dy, next = ny * cols + nx
            if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && hot[next] && !seen[next]) { seen[next] = 1; stack.push(next) }
          }
        }
        // Re-encoded images differ by a few scattered pixels: a zone counts when it is dense enough.
        const area = (x1 - x0 + 1) * (y1 - y0 + 1) * cell * cell
        if (sum / area > 0.06) zones.push({ x: x0 * cell, y: y0 * cell, w: (x1 - x0 + 1) * cell, h: (y1 - y0 + 1) * cell })
      }
      zones = zones.sort((p, q) => p.y - q.y || p.x - q.x).slice(0, 30)
    }
    for (const [n, panel] of panels.entries()) {
      const picture = images[n]
      ctx.fillStyle = panel.color ?? '#e2e8f0'
      ctx.font = 'bold 22px sans-serif'
      ctx.fillText(panel.label, panel.x + 4, panel.y + 26)
      if (picture) ctx.drawImage(picture, panel.x, panel.y + 36, panel.w, panel.h)
      if (panel.mark && picture) {
        const scale = panel.w / picture.width
        for (const [z, zone] of zones.entries()) {
          const x = panel.x + zone.x * scale, y = panel.y + 36 + zone.y * scale
          ctx.fillStyle = 'rgba(239, 68, 68, 0.12)'
          ctx.fillRect(x, y, zone.w * scale, zone.h * scale)
          ctx.strokeStyle = '#EF4444'
          ctx.lineWidth = 3
          ctx.strokeRect(x, y, zone.w * scale, zone.h * scale)
          ctx.fillStyle = '#EF4444'
          ctx.fillRect(x - 1.5, y - 20, 24, 20)
          ctx.fillStyle = '#fff'
          ctx.font = 'bold 15px sans-serif'
          ctx.fillText(String(z + 1), x + 4, y - 5)
        }
      }
      for (const [i, line] of (panel.lines ?? []).entries()) {
        ctx.font = (i === 0 ? 'bold ' : '') + '20px sans-serif'
        ctx.fillText(line, panel.x + 4, panel.y + 70 + i * 30)
      }
    }
    const blob = await sheet.convertToBlob({ type: 'image/png' })
    const data = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(blob) })
    return { data, percent, zones: zones.length }
  })(${width}, ${height}, ${JSON.stringify(panels)})`, true)

  return { png: value.data, width, height, percent: value.percent, zones: value.zones }
}

// Panels in rows of `columns`, each scaled to `cell` px wide, a label strip above each.
function grid(shots, labels, columns, cell) {
  const gap = 16
  const panels = []
  let y = 0
  for (let row = 0; row * columns < shots.length; row++) {
    const items = shots.slice(row * columns, row * columns + columns)
    const height = Math.max(...items.map(shot => (shot.width ? Math.round((shot.height * cell) / shot.width) : 120)))
    items.forEach((shot, i) => {
      const n = row * columns + i
      panels.push({ ...shot.panel, png: shot.png, label: labels[n], x: i * (cell + gap), y, w: cell, h: shot.width ? Math.round((shot.height * cell) / shot.width) : 0 })
    })
    y += height + 36 + gap
  }

  return { width: columns * cell + (columns - 1) * gap, height: Math.min(y - gap, MAX_HEIGHT), panels }
}

// --- checks, each on the loaded page ---

// The text a reader sees in the captured region (viewport, --el box or --full page), one line per element.
async function visibleText() {
  return evaluate(`(() => {
    const el = ${JSON.stringify(selector ?? null)} && document.querySelector(${JSON.stringify(selector ?? '')})
    const box = el ? el.getBoundingClientRect() : null
    const region = ${has('full')} && !el ? null : box ? { x: box.left + scrollX, y: box.top + scrollY, w: box.width, h: box.height } : { x: scrollX, y: scrollY, w: innerWidth, h: innerHeight }
    const byParent = new Map()
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node; (node = walker.nextNode()); ) {
      const text = node.textContent.replace(/\\s+/g, ' ').trim()
      const parent = node.parentElement
      if (!text || !parent || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName)) continue
      const style = getComputedStyle(parent)
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      const r = range.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const top = r.top + scrollY, left = r.left + scrollX
      if (region && (top > region.y + region.h || top + r.height < region.y || left > region.x + region.w || left + r.width < region.x)) continue
      byParent.set(parent, ((byParent.get(parent) ?? '') + ' ' + text).trim())
    }
    const lines = []
    for (const line of byParent.values()) if (lines.at(-1) !== line) lines.push(line.slice(0, 160))
    return lines.slice(0, 400)
  })()`)
}

async function cssOf() {
  return evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    // Defaults come from the same tag in a blank iframe: what is left is what the page's CSS did.
    const frame = document.createElement('iframe')
    frame.style.display = 'none'
    document.body.appendChild(frame)
    const bare = frame.contentDocument.createElement(el.tagName)
    frame.contentDocument.body.appendChild(bare)
    const base = frame.contentWindow.getComputedStyle(bare)
    const own = getComputedStyle(el)
    const styles = {}
    // Custom properties (inherited design tokens), vendor, logical (mirror the physical ones), size-derived origins.
    const noise = /^--|^-webkit-|(^|-)(block|inline)(-|$)|^inset|-origin$/
    for (const prop of own) {
      const value = own.getPropertyValue(prop)
      if (value === base.getPropertyValue(prop) || noise.test(prop)) continue
      // Colors that only follow currentColor repeat "color".
      if (prop.endsWith('-color') && prop !== 'background-color' && value === own.color) continue
      styles[prop] = value
    }
    frame.remove()
    return styles
  })()`)
}

async function clsOf() {
  const { cls, shifts } = await evaluate('window.__rr')
  const seen = new Set()
  const top = shifts
    .filter(shift => shift.value > 0.0005 && !seen.has(shift.node) && seen.add(shift.node))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8)
  await overlay(top.map((shift, n) => ({ ...shift, color: '#EF4444', label: `${n + 1} · ${shift.value.toFixed(3)}` })))

  return { score: Number(cls.toFixed(3)), shifts: top.map(({ value, at, node }) => ({ value: Number(value.toFixed(3)), at, node })) }
}

async function perfOf(address) {
  const timing = await evaluate(`(() => {
    const nav = performance.getEntriesByType('navigation')[0]
    const fcp = performance.getEntriesByName('first-contentful-paint')[0]
    return { ttfb: Math.round(nav?.responseStart ?? 0), fcp: Math.round(fcp?.startTime ?? 0), load: Math.round(nav?.loadEventEnd ?? 0), lcp: window.__rr.lcp, cls: window.__rr.cls }
  })()`)
  if (timing.lcp?.box) await overlay([{ ...timing.lcp.box, color: '#22C55E', label: `LCP ${(timing.lcp.at / 1000).toFixed(1)} s` }])
  // ponytail: "third party" = another host than the page's last two labels; a public-suffix list would be exact.
  const site = host(address).split('.').slice(-2).join('.')
  const all = [...requests.values()].filter(request => request.url.startsWith('http'))
  const isThird = request => !host(request.url).endsWith(site)
  const domains = new Map()
  for (const request of all.filter(isThird)) domains.set(host(request.url), (domains.get(host(request.url)) ?? 0) + request.bytes)

  return {
    ttfb: timing.ttfb,
    fcp: timing.fcp,
    lcp: timing.lcp?.at ?? 0,
    lcpNode: timing.lcp?.node ?? '',
    load: timing.load,
    cls: Number((timing.cls ?? 0).toFixed(3)),
    requests: all.length,
    bytes: all.reduce((sum, request) => sum + request.bytes, 0),
    thirdRequests: all.filter(isThird).length,
    thirdBytes: all.filter(isThird).reduce((sum, request) => sum + request.bytes, 0),
    domains: [...domains].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, bytes]) => ({ name, bytes })),
  }
}

function consoleOf() {
  const failed = [...requests.values()]
    .filter(request => request.status >= 400 || request.failed)
    .map(request => ({ level: 'network', text: `${request.status || request.failed} ${request.url}`, url: request.url, line: 0 }))

  const counted = new Map()
  for (const entry of [...logs, ...failed]) {
    const key = `${entry.level}${entry.text}`
    counted.set(key, { ...entry, count: (counted.get(key)?.count ?? 0) + 1 })
  }

  return [...counted.values()].slice(0, 30)
}

async function a11yOf() {
  const issues = await evaluate(`(() => {
    const issues = []
    const visible = el => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden' }
    const boxOf = el => { const b = el.getBoundingClientRect(); return { x: b.left + scrollX, y: b.top + scrollY, width: b.width, height: b.height } }
    const name = el => el.nodeName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.classList.length ? '.' + [...el.classList].slice(0, 2).join('.') : '')
    for (const img of document.querySelectorAll('img:not([alt])')) if (visible(img)) issues.push({ kind: 'alt', node: name(img), text: (img.currentSrc || img.src).split('/').pop().slice(0, 60), ...boxOf(img) })
    for (const el of document.querySelectorAll('a[href], button, [role=button]')) {
      const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || [...el.querySelectorAll('img[alt]')].map(i => i.alt).join('')).trim()
      if (!label && visible(el)) issues.push({ kind: 'name', node: name(el), text: el.getAttribute('href') || '', ...boxOf(el) })
    }
    // WCAG contrast of text against the first opaque background up the tree (background images ignored).
    const rgb = value => (value.match(/[\\d.]+/g) || []).map(Number)
    const lum = ([r, g, b]) => { const f = c => (c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
    const background = el => { for (let n = el; n; n = n.parentElement) { const c = rgb(getComputedStyle(n).backgroundColor); if (c.length === 3 || c[3] > 0.9) return c.slice(0, 3) } return [255, 255, 255] }
    const seen = new Set()
    for (const el of document.querySelectorAll('p, a, span, li, h1, h2, h3, h4, h5, h6, button, label, figcaption, time')) {
      const text = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
      if (!text || !visible(el) || el.getBoundingClientRect().top > innerHeight * 3) continue
      const style = getComputedStyle(el)
      const [l1, l2] = [lum(rgb(style.color)), lum(background(el))].sort((a, b) => b - a)
      const ratio = (l1 + 0.05) / (l2 + 0.05)
      const size = parseFloat(style.fontSize)
      const isLarge = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700)
      const key = style.color + background(el)
      if (ratio < (isLarge ? 3 : 4.5) && !seen.has(key)) {
        seen.add(key)
        issues.push({ kind: 'contrast', node: name(el), text: text.slice(0, 50), ratio: Number(ratio.toFixed(2)), ...boxOf(el) })
      }
    }
    return issues.slice(0, 20)
  })()`)
  await overlay(issues.map((issue, n) => ({ ...issue, color: '#F59E0B', label: String(n + 1) })))

  return issues.map(({ kind, node, text, ratio }) => ({ kind, node, text, ...(ratio ? { ratio } : {}) }))
}

// Values the page's styles use, matched against its own custom properties (the design tokens it ships).
async function tokensOf() {
  return evaluate(`(() => {
    const root = getComputedStyle(document.documentElement)
    const probe = document.createElement('div')
    probe.style.display = 'none'
    document.body.appendChild(probe)
    const normalize = (prop, value) => { probe.style[prop] = ''; probe.style[prop] = value; return probe.style[prop] ? getComputedStyle(probe)[prop] : null }
    const tokens = new Map()
    // Computed style lists every custom property in scope, cross-origin stylesheets included.
    for (const name of root) if (name.startsWith('--')) tokens.set(name, root.getPropertyValue(name).trim())
    const byValue = { color: new Map(), length: new Map() }
    for (const [name, raw] of tokens) {
      const color = normalize('color', raw)
      if (color && /^(#|rgb|hsl|color\\()/.test(raw)) byValue.color.set(color, [...(byValue.color.get(color) ?? []), name])
      const length = normalize('width', raw)
      if (length && /^-?[\\d.]+(px|rem|em)$/.test(raw)) byValue.length.set(length, [...(byValue.length.get(length) ?? []), name])
    }
    const props = { color: 'color', backgroundColor: 'color', borderTopColor: 'color', fontSize: 'length', paddingTop: 'length', paddingLeft: 'length', marginTop: 'length', marginBottom: 'length', gap: 'length', borderTopLeftRadius: 'length' }
    const scope = ${JSON.stringify(selector ?? 'body')}
    const start = document.querySelector(scope)
    if (!start) return null
    const matched = new Map(), hardcoded = new Map()
    for (const el of [start, ...start.querySelectorAll('*')].slice(0, 600)) {
      const box = el.getBoundingClientRect()
      if (box.width === 0 || (scope === 'body' && box.top > innerHeight * 2)) continue
      const style = getComputedStyle(el)
      for (const [prop, kind] of Object.entries(props)) {
        const value = style[prop]
        if (!value || value === 'normal' || value === '0px' || value === 'rgba(0, 0, 0, 0)' || (prop === 'borderTopColor' && style.borderTopWidth === '0px')) continue
        if (prop !== 'color' && prop !== 'fontSize' && el !== start && value === getComputedStyle(el.parentElement)[prop]) continue
        const names = byValue[kind].get(value)
        const map = names ? matched : hardcoded
        const key = names ? value + ' = ' + names.slice(0, 2).join(' | ') : prop + ': ' + value
        map.set(key, (map.get(key) ?? 0) + 1)
      }
    }
    probe.remove()
    const top = map => [...map].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([key, count]) => ({ key, count }))
    return { tokens: tokens.size, matched: top(matched), hardcoded: top(hardcoded) }
  })()`)
}

// The share card X, Slack or Facebook would draw from the page's meta tags, rendered for real.
async function ogOf() {
  const meta = await evaluate(`(() => {
    const get = (...names) => { for (const n of names) { const el = document.querySelector('meta[property="' + n + '"], meta[name="' + n + '"]'); if (el?.content) return el.content } return '' }
    return {
      title: get('og:title', 'twitter:title') || document.title,
      description: get('og:description', 'twitter:description', 'description'),
      image: get('og:image', 'twitter:image'),
      site: get('og:site_name'),
      card: get('twitter:card'),
      canonical: document.querySelector('link[rel=canonical]')?.href ?? '',
      missing: ['og:title', 'og:description', 'og:image', 'og:url', 'og:type', 'twitter:card', 'description'].filter(n => !get(n)),
    }
  })()`)
  const escape = text => text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const html = `<html><head><meta charset="utf-8"></head><body style="margin:0;padding:24px;background:#15202b;font-family:-apple-system,sans-serif">
    <div id="card" style="width:560px;border:1px solid #38444d;border-radius:16px;overflow:hidden;background:#192734">
      ${meta.image ? `<img src="${escape(meta.image)}" style="display:block;width:560px;height:294px;object-fit:cover">` : '<div style="height:294px;background:#38444d;color:#8899a6;display:flex;align-items:center;justify-content:center">no og:image</div>'}
      <div style="padding:12px 14px;color:#fff">
        <div style="color:#8899a6;font-size:14px">${escape(host(meta.canonical || url))}</div>
        <div style="font-size:16px;font-weight:600;margin:4px 0">${escape(meta.title)}</div>
        <div style="color:#8899a6;font-size:14px;max-height:40px;overflow:hidden">${escape(meta.description)}</div>
      </div>
    </div></body></html>`
  await send('Emulation.setDeviceMetricsOverride', { width: 640, height: 600, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `data:text/html;base64,${Buffer.from(html).toString('base64')}` })
  await sleep(2500)
  const box = await evaluate(`(() => { const b = document.getElementById('card').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height } })()`)
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 1 } })

  return { meta, shot: { png: data, width: Math.round(box.width), height: Math.round(box.height) } }
}

// --- run ---

const layouts = ['vs', 'devices', 'filmstrip', 'og'].filter(has)
if (layouts.length > 1) fail(`one of --vs, --devices, --filmstrip, --og at a time (got ${layouts.join(', ')})`)
let shot
const reports = []

// Checks read the page before any overlay; overlays land before the picture.
async function checks(address) {
  const found = []
  if (selector && has('css')) found.push(['CSS', await cssOf()])
  if (has('tokens')) found.push(['TOKENS', await tokensOf()])
  if (has('console')) found.push(['CONSOLE', consoleOf()])
  if (has('perf')) found.push(['PERF', await perfOf(address)])
  if (has('cls')) found.push(['CLS', await clsOf()])
  if (has('a11y')) found.push(['A11Y', await a11yOf()])
  reports.push(...found)
  return found
}

// One page of a --vs pair, with fresh logs: its text, its checks (not yet reported) and its picture.
async function side(address) {
  logs.length = 0
  requests.clear()
  await open(address)
  const text = await visibleText()
  const found = await checks(address)
  reports.length -= found.length
  return { text, found, shot: await capture() }
}

if (has('vs')) {
  // Two columns: − the first page (red label), + the second (green), the zones that differ framed on both.
  const other = option('vs')
  const a = await side(url)
  const b = await side(other)
  const hosts = [host(url), host(other)]
  const cell = Math.min(1280, Math.max(a.shot.width, b.shot.width))
  const layout = grid([{ ...a.shot, panel: { mark: true, color: '#F87171' } }, { ...b.shot, panel: { mark: true, color: '#4ADE80' } }], [`− ${hosts[0]}`, `+ ${hosts[1]}`], 2, cell)
  shot = await compose(layout.width, layout.height, layout.panels)
  reports.push(['DIFF', { percent: Number(shot.percent.toFixed(2)), zones: shot.zones, hosts }])
  reports.push(['TEXT', { pair: [a.text, b.text], hosts }])
  for (const [n, [key, value]] of a.found.entries()) reports.push([key, { pair: [value, b.found[n][1]], hosts }])
} else if (has('devices')) {
  const shots = []
  for (const device of DEVICES) {
    await open(url, device)
    shots.push(await capture())
  }
  await checks(url)
  // Same height for all: phones stay narrow, the desktop wide.
  const height = 800
  let x = 0
  const panels = shots.map((one, n) => {
    const w = Math.round((one.width * Math.min(height, one.height)) / one.height)
    const panel = { png: one.png, label: `${DEVICES[n].label} · ${DEVICES[n].width}px`, x, y: 0, w, h: Math.min(height, one.height) }
    x += w + 16
    return panel
  })
  shot = await compose(x - 16, height + 36, panels)
} else if (has('filmstrip')) {
  const frames = []
  await open(url, DESKTOP, async at => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' }).catch(() => ({}))
    if (data && frames.length < 15) frames.push({ png: data, width: 1280, height: 800, at })
  })
  await checks(url)
  const picked = frames.length > 10 ? frames.filter((_, n) => n % Math.ceil(frames.length / 10) === 0) : frames
  const layout = grid(picked, picked.map(frame => `${(frame.at / 1000).toFixed(1)} s`), 5, 320)
  shot = await compose(layout.width, layout.height, layout.panels)
} else {
  await open(url)
  await checks(url)
  if (has('og')) {
    const og = await ogOf()
    reports.push(['OG', og.meta])
    shot = og.shot
  } else {
    shot = await capture()
  }
}

writeFileSync(out, Buffer.from(shot.png, 'base64'))
console.log(`${shot.width}x${shot.height}`)
for (const [key, value] of reports) report(key, value)
quit(0)
