// Header 快照/注入：**已全站**。
//
// 两次放开：2026-08-11 去掉客户端灰度开关（原先注册 URL 带 `?hs=1` 才生效，见下），
// 2026-08-31 删掉路由白名单（原先只在 /my/dashboard、/my/settings/preference、
// /my/wallet/** 上抓与注入）⇒ capture 与注入现在覆盖所有装了本 loader 的路由。
// 要收回范围只能走服务端：把 server 的 pwaLoad 指回 `cache-control-load@0.0.10.js`
// （带白名单的那一版）并部署。
//
// 关于那个被删掉的客户端灰度开关（`?hs=1`）：
// 它只认当前页面 URL，而真实多页导航会以不带 query 的 URL 重新注册 ⇒ 模块在下一页
// 自己关掉；注入恰好发生在 navigation 上，所以它从来就只能覆盖「落地的那一页」，
// 跨页测试必须给每个 URL 都带参数。真灰度必须服务端驱动（Apollo → server 下发对应 loader），
// 客户端 opt-in 支撑不了（服务端看不见、没法按比例放量、没法随时全局关）。
//
// 注册 URL 从此**恒定不变** ⇒ 不再因为开关翻转而反复触发 SW 更新。
// 回滚：server 把 pwaLoad 指回旧 loader 并部署即可。

if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('/pwa-api-cache@0.0.15.js', {
      scope: '/',
    })
    .then(registration => {
      if (registration.installing) {
        console.log('Service worker installing')
      } else if (registration.waiting) {
        console.log('Service worker installed')
      } else if (registration.active) {
        console.log('Service worker active')
      }
    })
    .catch(error => {
      console.error(`Service worker registration failed: ${error}`)
    })
  const pickData = res => {
    if (res.success) {
      return res.data
    }
  }
  const keyPickDataObject = {
    userBaseInfo: pickData,
    prefreUserConfig: pickData,
    userProfile: pickData,
    userUserInfo: pickData,
    useUserPayFiatListCurrency: res => {
      const result = pickData(res)
      return result ? result.fiatList : undefined
    },
    businessKeys: res => {
      const result = pickData(res)
      return result
        ? {
            keys: result.restriction.keys,
            allowedKeys: result.restriction.allowedKeys,
          }
        : undefined
    },
    useMarginAccountExist: pickData,
    profile: pickData,
    useTodoList: pickData,
    useUserComplianceStatus: res => {
      const result = pickData(res)
      return result ? result.userComplianceStatus : undefined
    },
    useUserExtraInfo: pickData,
    useUserFuturesAccountInfo: pickData,
    useUserKycStatusInfo: pickData,
    accountUserQuoteAssetGet: res => {
      const result = pickData(res)
      return result ? result.configValue || 'BTC' : undefined
    },
    userTaskChallengeList: pickData,
    userTradeStatus: pickData,
    'useLanguageList--': res => {
      const data = pickData(res)
      if (!data) {
        return undefined
      }
      const language = {}
      data.match.forEach(item => {
        language[item.target] = item.name
      })
      return Object.entries(language).sort((a, b) => a[0].localeCompare(b[0]))
    },
  }
  const dataDeepMatch = (oldData, newData) => {
    if (typeof oldData !== typeof newData) {
      return false
    }
    if (typeof oldData === 'object' && oldData !== null && newData !== null) {
      return Object.keys(oldData).every(key => dataDeepMatch(oldData[key], newData[key]))
    }
    return oldData === newData
  }

  navigator.serviceWorker.addEventListener('message', event => {
    // 带 type 的是新协议消息（如 HEADER_SNAPSHOT_RESULT），由各自的监听处理。
    // 老的数据同步消息形如 {cacheKey, payload}，没有 type。
    // 少了这个守卫，任何未知消息都会让 keyPickDataObject[undefined] 取到 undefined
    // 后被当函数调用而抛 TypeError。
    if (event.data && event.data.type) return
    const { cacheKey, payload } = event.data
    const pickDataFunction = keyPickDataObject[cacheKey]
    const pickedData = pickDataFunction(payload)

    // 璇锋眰澶辫触鍩嬬偣
    if (typeof pickedData === 'undefined') {
      __COMMON_WIDGET_CACHE_STORE__.track('ComponentShow', {
        pageName: 'sync_data_picked_data_undefined',
        elementId: cacheKey,
      })
      return
    }

    // 缂撳瓨澶辫触鍩嬬偣
    if (typeof __COMMON_WIDGET_CACHE_STORE__.state[cacheKey] === 'undefined') {
      __COMMON_WIDGET_CACHE_STORE__.setState(cacheKey, pickedData)
      __COMMON_WIDGET_CACHE_STORE__.track('ComponentShow', {
        pageName: 'sync_data_state_undefined',
        elementId: cacheKey,
      })
      return
    }
    // object match
    if (!dataDeepMatch(__COMMON_WIDGET_CACHE_STORE__.state[cacheKey], pickedData)) {
      __COMMON_WIDGET_CACHE_STORE__.setState(cacheKey, pickedData)
      __COMMON_WIDGET_CACHE_STORE__.track('ComponentShow', {
        pageName: 'sync_data_object_noMatch',
        elementId: cacheKey,
      })
      return
    }
    __COMMON_WIDGET_CACHE_STORE__.track('ComponentShow', {
      pageName: 'keep_data',
      elementId: cacheKey,
    })
  })
}

/* ============================================================================
 * Header 菜单 DOM 快照 · capture + 上报
 *
 * 分工：
 *   组件侧  menus 稳定后向 window 抛 'common-widget:header-menus-stable'
 *           （src/ui/Header/index.tsx 的 HEADER_MENUS_STABLE_EVENT，改名要两边同步）
 *   本文件  收到事件 → 捕获菜单 DOM → postMessage 给 SW
 *   SW 侧   接收并落 Cache Storage（尚未实现，见文末说明）
 *
 * 性能纪律（捕获与 postMessage 都不能挤占主线程）：
 *   - 全部推到 requestIdleCallback，不在事件回调里同步做
 *   - 同一时刻只排一个任务（scheduled 闸），事件抖动不会叠加
 *   - 常见路径下 clone 很小：下拉浮层是 hover 才挂的，没 hover 过就没有那部分节点
 *   - 序列化结果与上次相同就不再 postMessage，避免重复的结构化克隆开销
 *   - 不轮询、不装 MutationObserver、不依赖 store
 * ========================================================================== */
;(function () {
  if (!('serviceWorker' in navigator)) return

  const EVENT = 'common-widget:header-menus-stable'
  const SNAPSHOT_VERSION = 'v1'
  const SELECTOR = '.header-leftside'
  const MAX_BYTES = 256 * 1024
  // 下拉浮层：React state 控制它存不存在（useRenderAfterHoverOrFirst，hover 才首渲且
  // 不回退），CSS 控制它可不可见。SSR 非 SEO 时本来就不渲染这部分，所以剥掉才能让快照
  // 与 SSR 形态一致；也顺带让「什么时候抓」不再受用户鼠标轨迹影响。
  const DROPDOWN_SELECTOR = '.header-menu-subgrid, .header-menu-sublist, .header-menu-subgridsmall'
  // useMenuAim 在 hover 时加的高亮 class，SSR 不会有
  const HOVER_ACTIVE_CLASS = 'header-menu-item-active'

  /* --------------------------------------------------------------------------
   * 右侧（.header-rightside）capture —— 2026-09 新增
   *
   * 跟左侧的关键差异：右侧所有可展开内容（头像下拉、语言货币面板、InMail 面板、
   * PickUpGroup 抽屉）用的都是 `@web-studio/universal-uikit` 的 `Dropdown`/`Drawer`
   * 且一律 `enablePortal={true}`（`ui/Common/DropDownAndDraw/index.tsx`、
   * `ui/Common/DrawerRight/index.tsx`）——展开内容渲染进 portal，**根本不在
   * `.header-rightside` 的 DOM 子树里**，`cloneNode(true)` 天然抓不到。头像下拉的
   * trigger 本身也只是个不含用户数据的通用图标（`MenuGroupAvatarList` 的
   * `avatarEle`，真实头像/昵称/VIP 全在 portal 出去的下拉内容里）。
   *
   * 所以右侧**不需要**左侧那套 DROPDOWN_SELECTOR/HOVER_ACTIVE_CLASS 剥离逻辑——
   * 那几个是既有架构决定的，不是疏漏。但**另有三处内联内容必须归一化**，否则快照字节
   * 逐路由/逐次不同（实测：同一 key 下三条路由抓出 7646/7630/7622 三种字节数，归一化后
   * 四条路由恒为 3633 —— 顺带让每次导航的注入载荷少了一半多）。快照全局只存一份、
   * 全站注入，**只有路径无关才对得住这个存储模型**；否则「后写覆盖先写」会把上一页的
   * 路径痕迹带到下一页：
   *
   * 1. InMail 未读数徽标（`Login/InMail/index.tsx` 的 `.header-inmall-mark`）——
   *    trigger 自身的一部分（不在 portal 里）、持续变化的实时数据。它变化时
   *    `loginElements` 的元素引用**不变**（`<InMaill />` 本身没变，只是内部子树重渲染）
   *    ⇒ 稳定事件不会重抛、过期计数会被冻进快照。剥掉，让组件 hydrate 后用实时数据补回。
   * 2. hover 才可见的 tooltip 气泡（`[role="tooltip"]`，当前是 Download 的二维码）——
   *    uikit 把它**内联**渲染在子树里（不是 portal，这条推翻了「右侧全走 portal」的判断），
   *    且带每次挂载都变的随机 id（`bn-tooltips-<8 位随机>`）。默认不可见，剥掉对首帧
   *    视觉没有影响。连带把指向它的 `aria-describedby` 一起摘掉，免得留下悬空引用。
   * 3. 登录/注册链接的 `return_to=<当前页 URL 的 base64>`（`NoLogin/useReturnToUrl.tsx`
   *    → `utils/getReturnToUrl.ts`）—— 这是快照里**唯一跟当前路径绑定**的东西。不归一化
   *    的话，A 页抓的快照注入到 B 页就带着 A 的 return_to，用户在 hydrate 之前点「Log In」
   *    会在登录后被送回 A 页。SW 侧无法重算这个值（它依赖 Julia 配置的 `returnToList`
   *    正则覆盖 + bizChannel + ref），所以只能在 capture 时把这个参数摘掉：早点击退化为
   *    「登录后落默认页」，比「落到上一页」更可接受，同时让快照变成路径无关。
   *
   * ⚠️ 注入的字节只保证**首帧视觉正确**，不保证活过 hydrate：客户端首帧会带上新的随机
   * tooltip id 与正确的 return_to ⇒ 与注入字节必然不一致。已实测这不影响正确性
   * （hydrate 后 `#toLoginPage` 的 return_to 会变成当前页），也不产生可见闪烁（内容一致）。
   * ------------------------------------------------------------------------ */
  const EVENT_RIGHT = 'common-widget:header-rightside-stable'
  const SELECTOR_RIGHT = '.header-rightside'
  const RIGHT_LIVE_BADGE_SELECTOR = '.header-inmall-mark'
  const RIGHT_HOVER_BUBBLE_SELECTOR = '[role="tooltip"]'
  const RIGHT_PATH_BOUND_PARAM = 'return_to'

  /* --------------------------------------------------------------------------
   * 与 SW 侧共用的口径
   *
   * ⚠️ 下面整段是**生成的**，唯一口径在 `worker/snapshot-scope.js`。要改就改那里，
   * 然后 `cd packages/components && yarn worker:sync-scope`。
   *
   * 2026-08-31 起这里只剩 LANG_SEG_RE —— 路由白名单已整段删除，capture **全站**发生。
   * ------------------------------------------------------------------------ */
  /* >>> CW_SNAPSHOT_SCOPE — generated from worker/snapshot-scope.js, do not edit here >>> */
  // 语言段判据。页面侧 buildKey 与 SW 侧 langFromUrl **共用这一条** —— 两处一旦不一致，
  // 两边算出的 key 里 lang 就会不同，快照永远命中不了。
  const LANG_SEG_RE = /^[a-z]{2}(-[a-z0-9]+)?$/
  /* <<< CW_SNAPSHOT_SCOPE <<< */

  const debug = (window.__COMMON_WIDGET_HEADER_SNAPSHOT_DEBUG__ = { state: 'idle', key: null, bytes: 0, sent: 0 })
  const report = (state, extra) => {
    debug.state = state
    if (extra) debug.reason = extra
    try {
      window.__COMMON_WIDGET_CACHE_STORE__.track('ComponentShow', {
        pageName: 'header_snapshot_' + state,
        elementId: extra || '',
      })
    } catch (e) {
      /* 埋点失败不影响主流程 */
    }
  }

  // 独立诊断入口，别跟左侧的 __COMMON_WIDGET_HEADER_SNAPSHOT_DEBUG__ 共用——两条
  // capture 各自独立触发，共用一个对象会互相覆盖 state/key。
  const debugRight = (window.__COMMON_WIDGET_HEADER_SNAPSHOT_RIGHT_DEBUG__ = {
    state: 'idle',
    key: null,
    bytes: 0,
    sent: 0,
  })
  const reportRight = (state, extra) => {
    debugRight.state = state
    if (extra) debugRight.reason = extra
    try {
      window.__COMMON_WIDGET_CACHE_STORE__.track('ComponentShow', {
        pageName: 'header_snapshot_right_' + state,
        elementId: extra || '',
      })
    } catch (e) {
      /* 埋点失败不影响主流程 */
    }
  }

  const readCookie = name => {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'))
    return m ? decodeURIComponent(m[1]) : ''
  }

  // key 维度只取可观测量。注意：注入侧（SW）必须能在 JS 执行前算出同一个 key，
  // 所以每一维都得能从 cookie / URL / SSR 字节推导出来。theme 目前是从 header 容器的
  // className 读的，注入侧需要改成在 SSR 字节里正则 `-color`（待阶段 3 对齐）。
  const buildKey = () => {
    const container = document.querySelector('.header-container')
    const theme = /(?:^|\s)(\w+)-color(?:\s|$)/.exec((container && container.className) || '')
    const seg = (location.pathname.split('/')[1] || '').toLowerCase()
    return [
      SNAPSHOT_VERSION,
      readCookie('cr00') || 'unlogin',
      // 用生成段里的 LANG_SEG_RE，不要再内联一份 —— SW 侧的 langFromUrl 用的是同一条，
      // 两边一旦不一致，算出的 lang 就不同、快照永远命中不了
      LANG_SEG_RE.test(seg) ? seg : 'na',
      theme ? theme[1] : 'na',
    ].join('|')
  }

  // 归一化：去掉 hover 才产生的结构和 class，让产物只依赖菜单项集合本身
  const serializeMenu = el => {
    const clone = el.cloneNode(true)
    const dropdowns = clone.querySelectorAll(DROPDOWN_SELECTOR)
    for (let i = 0; i < dropdowns.length; i++) {
      dropdowns[i].remove()
    }
    const actives = clone.querySelectorAll('.' + HOVER_ACTIVE_CLASS)
    for (let i = 0; i < actives.length; i++) {
      actives[i].classList.remove(HOVER_ACTIVE_CLASS)
    }
    return clone.outerHTML
  }

  // 归一化三处内联的非确定性内容（实时徽标 / hover 气泡的随机 id / 路径绑定的
  // return_to），依据见上面 EVENT_RIGHT 之前那段长注释。目标是让同一个
  // `v1|cr00|lang|theme` 下**任意路由抓出的字节完全相同**——快照全局只存一份、全站注入，
  // 只有路径无关才对得住这个存储模型。
  const serializeRightside = el => {
    const clone = el.cloneNode(true)

    const drop = selector => {
      const nodes = clone.querySelectorAll(selector)
      for (let i = 0; i < nodes.length; i++) nodes[i].remove()
    }
    drop(RIGHT_LIVE_BADGE_SELECTOR)
    drop(RIGHT_HOVER_BUBBLE_SELECTOR)

    // 气泡剥掉后 aria-describedby 就是悬空引用（且值本身是随机 id）
    const described = clone.querySelectorAll('[aria-describedby]')
    for (let i = 0; i < described.length; i++) {
      described[i].removeAttribute('aria-describedby')
    }

    // return_to 摘掉。用 URL 解析而不是正则替换：这个值是 base64，可能含 `+` / `=`，
    // 正则切 query 容易切错边界。解析失败（相对路径等）就原样留着，不冒险改坏 href。
    const links = clone.querySelectorAll('a[href*="' + RIGHT_PATH_BOUND_PARAM + '="]')
    for (let i = 0; i < links.length; i++) {
      try {
        const u = new URL(links[i].getAttribute('href'), location.href)
        u.searchParams.delete(RIGHT_PATH_BOUND_PARAM)
        links[i].setAttribute('href', u.href)
      } catch (e) {
        /* 解析不了就不动 */
      }
    }

    return clone.outerHTML
  }

  const idle = fn =>
    typeof window.requestIdleCallback === 'function'
      ? window.requestIdleCallback(fn, { timeout: 2000 })
      : setTimeout(fn, 0)

  let lastSent = ''
  let scheduled = false

  // 宿主可以用 registerHeaderLeftHandler 注册一个 left render handler 改左侧菜单内容
  // （Header/index.tsx:213 的 render，是 menus 这个 useMemo 的 dep，所以它产出的节点就在
  // .header-leftside 里、会被一起序列化进快照）。
  //
  // 而快照**全局只存一份**（saveHeaderSnapshot 落盘后把其它 key 全删），key 是
  // `v1|cr00|lang|theme`、**没有路由维度** ⇒ 一旦把某个宿主定制过的菜单存进去，
  // 之后**全站**导航都会被注入那份定制内容。
  //
  // 全站铺开（2026-08-31 删掉路由白名单）之后所有 desktop header 路由都会 capture，
  // 这个坑从「小概率」变成「谁最后访问谁说了算」。
  // 这里选最省的解法：**检测到宿主注册了 handler 就不 capture**，保证存的
  // 永远是未定制的那一份。定制页面自己仍会被注入未定制版，但那与它 SSR 直出的形态一致
  // （handler 是运行时注册的，SSR 本来就没有），定制内容照旧在 hydrate 后出现。
  //
  // 备选是给 key 加一维路由 + 按维度各留一份，但那会让缓存随宿主数量增长、且跨 app 导航
  // 命中率骤降。宿主使用率很低（已确认「大部分没有使用」），不值得。
  const hostLeftRenderRegistered = () => {
    try {
      return !!window.__COMMON_WIDGET_CACHE_STORE__.getCache('headerLeftRender')
    } catch (e) {
      // store 还没就绪 / 取不到，就当没注册（capture 本来就在 menus 稳定之后才跑）
      return false
    }
  }

  const capture = () => {
    scheduled = false

    // ⛔ 这里原先还有一道路由白名单门（`isSnapshotPath(location.pathname)`），
    // 2026-08-31 全站放开时整段删除 ⇒ **任何路由**菜单稳定后都会抓。
    // 于是下面这条宿主早退成了唯一的防污染门，见它自己的注释。
    if (hostLeftRenderRegistered()) return report('skip', 'host-left-render')

    const el = document.querySelector(SELECTOR)
    if (!el) return report('skip', 'menu-not-found')

    const html = serializeMenu(el)
    debug.bytes = html.length

    // 菜单没变就不必再发一遍
    if (html === lastSent) return report('skip', 'unchanged')
    if (html.length > MAX_BYTES) return report('abort', 'too-large:' + html.length)

    // 首次访问时 SW 还没接管本页，postMessage 无接收方，直接跳过（下次访问再抓）
    const sw = navigator.serviceWorker.controller
    if (!sw) return report('skip', 'no-controller')

    const key = buildKey()
    debug.key = key
    sw.postMessage({
      type: 'SAVE_HEADER_SNAPSHOT',
      version: SNAPSHOT_VERSION,
      key: key,
      // 曾经还报一个 `path`，供 SW 侧按同一份白名单再校验一次。白名单删掉之后 SW 不再
      // 读它 ⇒ 协议里也不留死字段（旧 SW 收到不带 path 的消息会拒，属于过渡态，
      // 新 SW 一 activate 就恢复）。
      selector: SELECTOR,
      html: html,
    })
    lastSent = html
    debug.sent++
    report('sent', String(html.length))
  }

  window.addEventListener(EVENT, () => {
    if (scheduled) return
    scheduled = true
    idle(capture)
  })

  // SW 落盘后的回执。带 type，不会被上面那个老的数据同步监听吃掉。
  navigator.serviceWorker.addEventListener('message', event => {
    const data = event.data
    if (!data || data.type !== 'HEADER_SNAPSHOT_RESULT') return
    if (data.ok) {
      debug.stored = data.bytes
      report('stored', String(data.bytes))
    } else {
      // 存不下就把 lastSent 清掉，下次事件重试
      lastSent = ''
      report('store-rejected', data.reason || 'unknown')
    }
  })

  /* --------------------------------------------------------------------------
   * 右侧 capture —— 逻辑与左侧对称，key 复用同一个 buildKey()（v1|cr00|lang|theme），
   * 防污染门也对称：`registerHeaderRightHandler` 已经存在
   * （`src/utils/registerHeaderRender.ts`），宿主定制过右侧就不 capture，理由跟左侧
   * 的 hostLeftRenderRegistered 完全一致（快照全局只存一份、没有路由维度）。
   * ------------------------------------------------------------------------ */
  let lastSentRight = ''
  let scheduledRight = false

  const hostRightRenderRegistered = () => {
    try {
      return !!window.__COMMON_WIDGET_CACHE_STORE__.getCache('headerRightRender')
    } catch (e) {
      return false
    }
  }

  const captureRight = () => {
    scheduledRight = false

    if (hostRightRenderRegistered()) return reportRight('skip', 'host-right-render')

    const el = document.querySelector(SELECTOR_RIGHT)
    if (!el) return reportRight('skip', 'menu-not-found')

    const html = serializeRightside(el)
    debugRight.bytes = html.length

    if (html === lastSentRight) return reportRight('skip', 'unchanged')
    if (html.length > MAX_BYTES) return reportRight('abort', 'too-large:' + html.length)

    const sw = navigator.serviceWorker.controller
    if (!sw) return reportRight('skip', 'no-controller')

    const key = buildKey()
    debugRight.key = key
    sw.postMessage({
      type: 'SAVE_HEADER_SNAPSHOT_RIGHT',
      version: SNAPSHOT_VERSION,
      key: key,
      selector: SELECTOR_RIGHT,
      html: html,
    })
    lastSentRight = html
    debugRight.sent++
    reportRight('sent', String(html.length))

    captureSprite(html)
  }

  window.addEventListener(EVENT_RIGHT, () => {
    if (scheduledRight) return
    scheduledRight = true
    idle(captureRight)
  })

  /* --------------------------------------------------------------------------
   * icon sprite 子集 —— 2026-09 新增
   *
   * 为什么需要：注入的 header 字节里图标是 `<use xlink:href="#xxx">`，靠页面上的 sprite
   * 解析。而 sprite 由 `static/configs/newbase/common-widget-icon@<ver>.js` 提供，那个脚本
   * ①在文档 **99%** 的位置（header 标记在 72.6%）②还要等 `DOMContentLoaded` 才注入
   * ③文件 144KB 且 CDN 只给 `max-age=600`（URL 明明带版本号）⇒ 注入的 header 一定早于
   * sprite 出现，那段窗口里图标是**空的**（实测 QA 真实网络 254ms、本地 Slow-3G 1.6s）。
   *
   * 光把 sprite 缓存起来治不了这个 —— 脚本的执行时机摆在那儿。唯一能让**首帧就有图标**的
   * 办法，是把 header 真正用到的那几个 `<symbol>` 跟快照一起注入。全量 114 个 symbol 里
   * header 只用到个位数（匿名态 2 个），子集只有几 KB，且走 Cache Storage 不过网络。
   *
   * 注入位置在 `<body>` 开始标签之后 —— **必须在 React 根（`#__APP_HEADER`）之外**，
   * 否则又会被 hydrate 当成多余节点抹掉（右侧那次的教训）。
   * ------------------------------------------------------------------------ */
  const SPRITE_ROOT_SELECTOR = 'svg[aria-name="common-widget"]'
  const SNAPSHOT_SPRITE_ID = '__cw_snapshot_sprite__'
  let lastSentSprite = ''

  // 从快照 HTML 里收集 `<use href="#id">` / `<use xlink:href="#id">` 引用到的 symbol id
  const collectSymbolIds = html => {
    const ids = {}
    const re = /(?:xlink:)?href="#([^"]+)"/g
    let m
    while ((m = re.exec(html))) ids[m[1]] = true
    return Object.keys(ids)
  }

  const captureSprite = rightHtml => {
    try {
      const sprite = document.querySelector(SPRITE_ROOT_SELECTOR)
      // sprite 还没注入（icon 脚本要等 DCL）⇒ 这次不抓，保留上一次存的那份
      if (!sprite) return reportRight('sprite-skip', 'sprite-not-ready')

      const ids = collectSymbolIds(rightHtml)
      if (!ids.length) return reportRight('sprite-skip', 'no-icon-ref')

      const parts = []
      for (let i = 0; i < ids.length; i++) {
        // id 来自我们自己序列化出来的 HTML，但仍走 getElementById 而不是拼选择器，
        // 免得 id 里出现选择器元字符时 querySelector 抛错
        const sym = document.getElementById(ids[i])
        if (sym && sym.tagName.toLowerCase() === 'symbol') parts.push(sym.outerHTML)
      }
      if (!parts.length) return reportRight('sprite-skip', 'symbols-not-found')

      // 与 icon 脚本注入的那个 sprite 同形（隐藏、零尺寸），但带自己的 id 便于事后清理
      const html =
        '<svg id="' +
        SNAPSHOT_SPRITE_ID +
        '" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">' +
        parts.join('') +
        '</svg>'

      if (html === lastSentSprite) return
      if (html.length > MAX_BYTES) return reportRight('sprite-skip', 'too-large:' + html.length)

      const sw = navigator.serviceWorker.controller
      if (!sw) return

      sw.postMessage({
        type: 'SAVE_HEADER_SPRITE',
        version: SNAPSHOT_VERSION,
        key: buildKey(),
        html: html,
      })
      lastSentSprite = html
      reportRight('sprite-sent', ids.length + 'symbols/' + html.length + 'B')
    } catch (e) {
      /* sprite 只是锦上添花，抓不到不影响快照本身 */
    }
  }

  // 真 sprite 一旦到位就把注入的子集摘掉：两者 symbol id 相同，留着就是一份重复 id 的死
  // DOM（icon 脚本把全量 sprite 插成 body.firstChild，排在我们前面，引用已经解析到它了）。
  const dropSnapshotSprite = () => {
    try {
      const mine = document.getElementById(SNAPSHOT_SPRITE_ID)
      if (mine && document.querySelector(SPRITE_ROOT_SELECTOR)) mine.remove()
    } catch (e) {
      /* 清理失败无所谓，只是多留一份隐藏 DOM */
    }
  }
  if (document.readyState === 'complete') {
    dropSnapshotSprite()
  } else {
    window.addEventListener('load', dropSnapshotSprite, { once: true })
  }

  navigator.serviceWorker.addEventListener('message', event => {
    const data = event.data
    if (!data || data.type !== 'HEADER_SNAPSHOT_RESULT_RIGHT') return
    if (data.ok) {
      debugRight.stored = data.bytes
      reportRight('stored', String(data.bytes))
    } else {
      lastSentRight = ''
      reportRight('store-rejected', data.reason || 'unknown')
    }
  })
})()
