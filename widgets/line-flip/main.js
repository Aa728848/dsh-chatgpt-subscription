/*
 * 线路额度卡的脚本。
 *
 * 数据来自宿主上的 `dsh-chatgpt-subscription:line-card` 数据源（按 60 秒轮询）。一条线路的全部事实
 * ——额度、账号池、当前账号、轮换策略——都在同一个形状里，正反两面读的是同一份 `widget.data`：
 * 翻面不重读数据，它只是把已经拿到的东西换一面摆出来。
 *
 * 三个能力都按线路调用（参数里带 `line`）：刷新额度、切换账号、改轮换策略。成功返回同一份形状时用
 * 它重画，失败只在对应的那一面加一行内联原因——不吞掉，也不把整张卡变成错误页。
 *
 * 翻面用套件的 `t-flip-card`：`[data-t-flip]` 加内层 rotateY，背面 `backface-visibility` 由套件给。
 * 触屏轻点与键盘由运行时切换 `.is-flipped`，桌面靠 `:hover`；两条路径最后都读同一个类名，再写进
 * `widget.setState({ face })`，重载后回到那一面。鼠标点击也切换一次「记住的那一面」——桌面没有悬停
 * 之外的翻面动作，少了这一下，被记住的背面在纯鼠标下就回不到正面。
 *
 * 时间戳一律按毫秒处理，直接交给 `new Date(ms)`。窗口标签优先用数据里的 label，空的时候按
 * 「天 → 小时 → 分钟」逐级推：43200 分钟先命中 30 天，不会落到 720 小时。
 *
 * 组件库缩略画面（placement 为 preview）与没有宿主的场景不调能力，画一份静态样例。
 */
;(function () {
  var card = document.querySelector('.line-flip')
  if (!card) return

  var widget = window.widget
  var REFRESH = 'dsh-chatgpt-subscription:line-refresh'
  var SWITCH = 'dsh-chatgpt-subscription:line-account-switch'
  var STRATEGY = 'dsh-chatgpt-subscription:line-account-strategy'

  var NAMES = [
    'refresh', 'frontTitle', 'frontMeta', 'frontPlan', 'frontUpdated', 'frontBlank', 'frontError',
    'windows', 'foot', 'credits', 'resets',
    'backKicker', 'backTitle', 'backMeta', 'backCount', 'backStrategy', 'strategy', 'list',
    'backBlank', 'backBlankText', 'backBlankHint', 'backError'
  ]
  var fields = {}
  for (var index = 0; index < NAMES.length; index += 1) {
    fields[NAMES[index]] = card.querySelector('[data-field="' + NAMES[index] + '"]')
  }

  var shown = null
  var face = 'front'
  var pendingRefresh = null
  var pendingSwitch = null
  var pendingStrategy = null
  var refreshError = ''
  var accountError = ''
  var SAMPLE = null

  function t(key, fallback) {
    var value = widget !== undefined && widget !== null && typeof widget.t === 'function' ? widget.t(key) : key
    return value === key ? fallback : value
  }

  /** 文案模板里的占位符：{n}、{time}、{date}、{a}、{b} 各换一次（全局）。 */
  function fill(template, values) {
    var text = String(template)
    for (var key in values) {
      if (Object.prototype.hasOwnProperty.call(values, key)) {
        text = text.replace(new RegExp('\\{' + key + '\\}', 'g'), String(values[key]))
      }
    }
    return text
  }

  function put(node, value) {
    if (node !== null && node !== undefined) node.textContent = value === null || value === undefined ? '' : String(value)
  }

  function show(node, visible) {
    if (node !== null && node !== undefined) node.hidden = !visible
  }

  /** 数字字段可能是数字也可能是数字字符串；其余一律当作没有。 */
  function numberOrNull(value) {
    if (typeof value === 'number' && isFinite(value)) return value
    if (typeof value === 'string' && value.trim() !== '' && isFinite(Number(value))) return Number(value)
    return null
  }

  function textOrNull(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
  }

  function clock(stamp) {
    var date = new Date(stamp)
    var hours = date.getHours()
    var minutes = date.getMinutes()
    return (hours < 10 ? '0' : '') + hours + ':' + (minutes < 10 ? '0' : '') + minutes
  }

  function dayStamp(stamp) {
    var date = new Date(stamp)
    return date.getMonth() + 1 + '/' + date.getDate()
  }

  /** 一位小数、去掉没意义的 .0：30 天、1.5 小时。 */
  function trimDecimal(value) {
    return String(Math.round(value * 10) / 10)
  }

  function percentText(value) {
    var used = numberOrNull(value)
    if (used === null) return ''
    return trimDecimal(used) + '%'
  }

  /** 这张卡显示哪条线路：props 是第一来源，数据里的 line 兜底。 */
  function lineId() {
    var props = widget !== undefined && widget !== null ? widget.props : null
    var fromProps = props !== null && props !== undefined ? textOrNull(props.line) : null
    if (fromProps !== null) return fromProps
    var fromData = shown !== null && shown !== undefined ? textOrNull(shown.line) : null
    return fromData !== null ? fromData : ''
  }

  /** 标题永远是线路的显示名：先按 props.line 取文案，缺了再退回数据里的 label。 */
  function lineName() {
    var id = lineId()
    if (id !== '') {
      var key = 'line.' + id
      var stated = t(key, '')
      if (stated !== '') return stated
    }
    var label = shown !== null && shown !== undefined ? textOrNull(shown.label) : null
    if (label !== null) return label
    return t('title', '线路额度')
  }

  function quotaOf(data) {
    if (data === null || data === undefined || typeof data !== 'object') return null
    return data.quota !== null && typeof data.quota === 'object' ? data.quota : null
  }

  function windowsOf(data) {
    var quota = quotaOf(data)
    return quota !== null && Array.isArray(quota.windows) ? quota.windows : []
  }

  function accountsOf(data) {
    return data !== null && data !== undefined && Array.isArray(data.accounts) ? data.accounts : []
  }

  /**
   * 一个账号自己那份完整窗口列表。
   *
   * 形状 C 里这是可选字段：没有这个键（这条线路不做按账号读取）与 `[]`（读了，什么都没量到）都不
   * 画窗口行——两种都不补 0% 占位，占位会被读成「用完了」。
   */
  function accountWindowsOf(account) {
    if (account === null || account === undefined || typeof account !== 'object') return []
    return Array.isArray(account.windows) ? account.windows : []
  }

  /** 任何一个账号带着非空窗口：正面就有额度可画，哪怕线路级的 `quota.windows` 是空的。 */
  function hasAccountWindows(data) {
    var accounts = accountsOf(data)
    for (var i = 0; i < accounts.length; i += 1) {
      if (accountWindowsOf(accounts[i]).length > 0) return true
    }
    return false
  }

  /**
   * 正面的分组方案：**≥2 个账号各自带着非空窗口**时才分组，否则返回 null（保持扁平）。
   *
   * 只有一个账号有窗口时分组只会多出一层没有信息量的标题——那一层由规则二挡掉：退回线路级的
   * `quota.windows`。分组时正面只画各账号自己的窗口，线路级那份不再重复一遍。
   */
  function windowGroupsOf(data) {
    var accounts = accountsOf(data)
    var groups = []
    for (var i = 0; i < accounts.length; i += 1) {
      var windows = accountWindowsOf(accounts[i])
      if (windows.length > 0) groups.push({ account: accounts[i], windows: windows })
    }
    return groups.length >= 2 ? groups : null
  }

  /**
   * 窗口标签：优先用数据给的 label；空的时候不足一小时按分钟，整天按天，整点按小时，其余一位小数。
   *
   * 43200 分钟（30 天）先命中天，不会落到「720 小时」。
   */
  function windowText(entry) {
    var item = entry !== null && entry !== undefined && typeof entry === 'object' ? entry : {}
    var stated = textOrNull(item.label)
    if (stated !== null) return stated
    var span = numberOrNull(item.windowMinutes)
    if (span === null || span <= 0) return t('quota', '额度')
    var minutes = Math.round(span)
    if (minutes < 60) return fill(t('minutes', '{n} 分钟'), { n: minutes })
    if (minutes % 1440 === 0) return fill(t('days', '{n} 天'), { n: minutes / 1440 })
    if (minutes % 60 === 0) return fill(t('hours', '{n} 小时'), { n: minutes / 60 })
    return fill(t('hours', '{n} 小时'), { n: trimDecimal(minutes / 60) })
  }

  /** 重置倒计时：到点写「即将重置」，否则按天、小时、分钟给一句人话。 */
  function resetText(stamp, now) {
    var at = numberOrNull(stamp)
    if (at === null) return ''
    var diff = at - now
    if (diff <= 0) return t('resetting', '即将重置')
    var minutes = Math.ceil(diff / 60000)
    if (minutes < 60) return fill(t('resetMinutes', '{n} 分钟后重置'), { n: minutes })
    var hours = Math.floor(minutes / 60)
    var rest = minutes % 60
    if (hours < 24) {
      return rest === 0
        ? fill(t('resetHoursExact', '{a} 小时后重置'), { a: hours })
        : fill(t('resetHours', '{a} 小时 {b} 分后重置'), { a: hours, b: rest })
    }
    var days = Math.floor(hours / 24)
    var left = hours % 24
    return left === 0
      ? fill(t('resetDaysExact', '{a} 天后重置'), { a: days })
      : fill(t('resetDays', '{a} 天 {b} 小时后重置'), { a: days, b: left })
  }

  function creditText(data) {
    var quota = quotaOf(data)
    var credits = quota !== null ? quota.credits : null
    if (credits === null || credits === undefined || typeof credits !== 'object') return ''
    var label = t('credits', '赠额')
    if (credits.unlimited === true) return label + ' ' + t('unlimited', '无限')
    var balance = credits.balance
    if (typeof balance === 'number' && isFinite(balance)) return label + ' ' + String(balance)
    var stated = textOrNull(balance)
    return stated !== null ? label + ' ' + stated : ''
  }

  /**
   * 「只有绝对额度、没有百分比窗口」的线路的主事实：原样用数据里的余额串，不自己补币种。
   *
   * 返回空串表示这条线路没有可显示的额度——那时窗口区让位给空态文案。
   */
  function creditFactText(data) {
    var quota = quotaOf(data)
    var credits = quota !== null ? quota.credits : null
    if (credits === null || credits === undefined || typeof credits !== 'object') return ''
    if (credits.unlimited === true) return t('credits', '赠额') + ' ' + t('unlimited', '无限')
    var balance = credits.balance
    var stated = typeof balance === 'number' && isFinite(balance) ? String(balance) : textOrNull(balance)
    if (stated === null) return ''
    return fill(t('balanceAvailable', '可用余额 {v}'), { v: stated })
  }

  function resetsText(data) {
    var quota = quotaOf(data)
    var reset = quota !== null ? quota.resetCredits : null
    if (reset === null || reset === undefined || typeof reset !== 'object') return ''
    var available = numberOrNull(reset.available)
    if (available === null || available < 0) return ''
    var text = available === 1
      ? t('resetsOne', '1 次可用重置')
      : fill(t('resetsAvailable', '{n} 次可用重置'), { n: Math.round(available) })
    var expiresAt = numberOrNull(reset.expiresAt)
    // 0 是「没有过期时间」的占位值，不画日期。
    if (expiresAt !== null && expiresAt > 0) {
      text += ' · ' + fill(t('resetsExpires', '{date} 到期'), { date: dayStamp(expiresAt) })
    }
    return text
  }

  /**
   * 正面的右上角事实：套餐名 + 这条线路自己的读取时间。
   *
   * 拆成两段返回：窄盒子里「更新于」由 `.w-hide-narrow` 收掉，只留套餐名，不靠省略号硬撑。
   *
   * 分隔点只在两段都在时才出现，并且跟着第二段一起走：Qoder、Command Code 这些线路没有套餐名，
   * 只剩「更新于」时不会多出一个孤零零的前导点；窄盒子里第二段被收掉，也不会留下尾部的点。
   */
  function frontMeta(data) {
    if (data === null || data === undefined || typeof data !== 'object') return { plan: '', rest: '' }
    var plan = textOrNull(data.planLabel)
    var quota = quotaOf(data)
    var fetchedAt = quota !== null ? numberOrNull(quota.fetchedAt) : null
    var updated = fetchedAt !== null && fetchedAt > 0 ? fill(t('updatedAt', '更新于 {time}'), { time: clock(fetchedAt) }) : ''
    var stated = plan !== null ? plan : ''
    return {
      plan: stated,
      rest: updated === '' ? '' : stated === '' ? updated : ' · ' + updated
    }
  }

  function strategyLabel(strategy) {
    if (strategy === 'sequential') return t('strategySequential', '顺序使用')
    if (strategy === 'round-robin') return t('strategyRoundRobin', '轮流使用')
    if (strategy === 'sticky') return t('strategySticky', '固定当前')
    return ''
  }

  /** 背面的右上角事实：账号数 + 当前策略；策略在窄盒子里收掉——下面那排 chip 已经说明了它。 */
  function backMeta(data) {
    var count = accountsOf(data).length
    if (count === 0) return { count: '', rest: '' }
    var label = data !== null && data !== undefined ? strategyLabel(data.strategy) : ''
    return {
      count: count === 1 ? t('metaAccountOne', '1 个账号') : fill(t('metaAccounts', '{n} 个账号'), { n: count }),
      rest: label !== '' ? ' · ' + label : ''
    }
  }

  function displayLabel(account) {
    var stated = textOrNull(account.label)
    if (stated !== null) return stated
    var email = textOrNull(account.email)
    if (email !== null) return email
    return typeof account.id === 'string' ? account.id : ''
  }

  /** 当前账号：先按 activeAccountId 在号池里找，找不到再退回数据里的账号摘要。 */
  function currentAccountOf(data) {
    if (data === null || data === undefined || typeof data !== 'object') return ''
    var activeId = typeof data.activeAccountId === 'string' ? data.activeAccountId : ''
    var accounts = accountsOf(data)
    for (var i = 0; i < accounts.length; i += 1) {
      var account = accounts[i]
      if (account !== null && typeof account === 'object' && activeId !== '' && account.id === activeId) return displayLabel(account)
    }
    var label = textOrNull(data.accountLabel)
    return label !== null ? label : ''
  }

  /** 状态点：登录失效优先于冷却与主账号，颜色只在点上看，读屏文字另给一句。 */
  function toneOf(account, activeId, now) {
    var auth = typeof account.authStatus === 'string' ? account.authStatus : ''
    if (auth === 'expired') return { tone: 'danger', sr: 'srExpired', label: '登录已失效' }
    if (auth === 'invalid') return { tone: 'danger', sr: 'srInvalid', label: '登录无效' }
    if (auth !== '' && auth !== 'ok') return { tone: 'danger', sr: 'srBlocked', label: '登录需要处理' }
    var cooldown = numberOrNull(account.cooldownUntil)
    if (cooldown !== null && cooldown > now) return { tone: 'warn', sr: 'srCooling', label: '冷却中' }
    if (account.primary === true || (activeId !== '' && account.id === activeId)) return { tone: 'brand', sr: 'srPrimary', label: '主账号' }
    return { tone: 'idle', sr: 'srReady', label: '可用' }
  }

  /**
   * 正面的状态：整卡级别的错误优先，其次是没有登录、没有安装，再往后才是额度本身的事实。
   *
   * 没有百分比窗口不等于没有额度：只有绝对额度的线路（command-code、qoder）走 'credits'，
   * 让余额成为正文里那条主事实；'refreshing' 与 'empty' 才交给空态文案。
   */
  function kindOf(data) {
    if (data === null || data === undefined || typeof data !== 'object') return 'loading'
    if (textOrNull(data.error) !== null) return 'error'
    if (data.signedIn === false) return 'signed-out'
    if (data.installed === false) return 'not-installed'
    var quota = quotaOf(data)
    if (quota === null) return 'no-quota'
    if (textOrNull(quota.error) !== null) return 'error'
    // 线路级窗口与「各账号自己的窗口」任一个给了事实，正面就有东西画。
    if (windowsOf(data).length > 0 || hasAccountWindows(data)) return 'ready'
    if (creditFactText(data) !== '') return 'credits'
    if (quota.refreshing === true) return 'refreshing'
    return 'empty'
  }

  function frontBlankOf(data, kind) {
    if (kind === 'loading') return t('loading', '正在读取额度…')
    if (kind === 'signed-out') return t('signedOut', '未登录')
    if (kind === 'not-installed') return t('notInstalled', '这条线路的插件还没装')
    if (kind === 'no-quota') return t('noQuota', '这条线路还没有额度记录，点刷新或去设置页打开一次')
    if (kind === 'refreshing') return t('refreshing', '正在刷新额度…')
    if (kind === 'empty') return t('empty', '这条线路没有额度窗口')
    if (kind === 'error') {
      var quota = quotaOf(data)
      var reason = data !== null && data !== undefined ? textOrNull(data.error) : null
      if (reason === null && quota !== null) reason = textOrNull(quota.error)
      return reason !== null ? reason : t('failed', '读不到额度')
    }
    return ''
  }

  /** 背面的空态：没有账号时说得具体一点，别只留一片空白。 */
  function backBlankOf(data) {
    if (data === null || data === undefined || typeof data !== 'object') {
      return { text: t('loading', '正在读取额度…'), hint: '' }
    }
    if (data.installed === false) return { text: t('notInstalled', '这条线路的插件还没装'), hint: '' }
    if (data.signedIn === false) return { text: t('signedOut', '未登录'), hint: '' }
    var reason = textOrNull(data.error)
    if (reason !== null) return { text: reason, hint: '' }
    return { text: t('emptyAccounts', '账号池是空的'), hint: t('emptyAccountsHint', '添加账号后可以在这里切换') }
  }

  function windowRow(entry, now) {
    var item = entry !== null && entry !== undefined && typeof entry === 'object' ? entry : {}
    var row = document.createElement('div')
    row.className = 'line-flip__win'

    var head = document.createElement('div')
    head.className = 'line-flip__win-head'

    var label = document.createElement('span')
    label.className = 'line-flip__win-label'
    label.textContent = windowText(item)

    var used = document.createElement('span')
    used.className = 'line-flip__win-used'
    var usedText = percentText(item.usedPercent)
    used.textContent = usedText
    if (usedText === '') used.hidden = true

    var reset = document.createElement('span')
    reset.className = 'line-flip__win-reset w-hide-narrow'
    var resetValue = resetText(item.resetsAt, now)
    reset.textContent = resetValue
    if (resetValue === '') reset.hidden = true

    head.appendChild(label)
    head.appendChild(used)
    head.appendChild(reset)

    var meter = document.createElement('span')
    meter.className = 'line-flip__meter'
    meter.setAttribute('aria-hidden', 'true')
    var bar = document.createElement('span')
    bar.className = 'line-flip__fill'
    meter.appendChild(bar)

    var usedValue = numberOrNull(item.usedPercent)
    if (usedValue !== null) {
      meter.style.setProperty('--line-used', Math.max(0, Math.min(100, usedValue)) + '%')
      // 接近满额换成警告色；颜色之外还有百分比数字，不靠颜色单独表达状态。
      if (usedValue >= 90) row.setAttribute('data-high', 'true')
    }

    row.appendChild(head)
    row.appendChild(meter)
    return row
  }

  /**
   * 分组小标题右侧那句弱化的事实：当前/主账号 + 计划名，有什么写什么，挤不下时由 CSS 在窄盒子里收掉。
   *
   * 它不是标题的一部分：标题是「这是谁的额度」，这一句是「这个号现在什么状况」。
   */
  function groupNoteOf(account, data) {
    var activeId = data !== null && data !== undefined && typeof data.activeAccountId === 'string' ? data.activeAccountId : ''
    var parts = []
    if (activeId !== '' && account.id === activeId) parts.push(t('current', '当前'))
    else if (account.primary === true) parts.push(t('srPrimary', '主账号'))
    var plan = textOrNull(account.plan)
    if (plan !== null) parts.push(plan)
    return parts.join(' · ')
  }

  /**
   * 一个账号一组：caption 级的小标题 + 它自己的窗口行（沿用窗口行本身，标签/已用%/倒计时/进度条）。
   *
   * 标题只写一个身份（email，没有就 label），撞名的处理与背面同一套，区分符跟在标题右边；标题行不
   * 参与「行高预算」——它比一行窗口还矮，仍由窗口区自己滚动。
   */
  function windowGroupNode(group, data, plan, now) {
    var account = group.account
    var node = document.createElement('div')
    node.className = 'line-flip__group'
    if (typeof account.id === 'string' && account.id !== '') node.setAttribute('data-account', account.id)

    var head = document.createElement('p')
    head.className = 'line-flip__group-head'

    var titleText = plan !== null && plan !== undefined && plan.name !== '' ? plan.name : displayLabel(account)
    head.setAttribute('aria-label', fill(t('accountQuota', '{name} 的额度'), {
      name: plan !== null && plan !== undefined && plan.tag !== '' ? titleText + ' · ' + plan.tag : titleText
    }))
    var title = document.createElement('span')
    title.className = 'line-flip__group-title'
    title.textContent = titleText
    title.setAttribute('title', titleText)
    head.appendChild(title)

    var tag = plan !== null && plan !== undefined ? plan.tag : ''
    if (tag !== '') {
      var tagNode = document.createElement('span')
      tagNode.className = 'line-flip__group-tag'
      tagNode.textContent = tag
      head.appendChild(tagNode)
    }

    var note = groupNoteOf(account, data)
    if (note !== '') {
      var noteNode = document.createElement('span')
      noteNode.className = 'line-flip__group-note w-hide-narrow'
      noteNode.textContent = note
      head.appendChild(noteNode)
    }

    node.appendChild(head)
    for (var i = 0; i < group.windows.length; i += 1) node.appendChild(windowRow(group.windows[i], now))
    return node
  }

  /**
   * 「只有绝对额度、没有百分比窗口」的主事实行：主句用窗口标题那一档字号与前景色，说明跟在下面一行小字。
   *
   * 复用窗口行的类名：主句按省略号收在盒子宽度里，说明按 288px 的宽度折行，两者都不会横向溢出。
   */
  function creditFactRow(data) {
    var row = document.createElement('div')
    row.className = 'line-flip__win'
    var fact = document.createElement('span')
    fact.className = 'line-flip__win-label'
    fact.textContent = creditFactText(data)
    var hint = document.createElement('span')
    hint.className = 'line-flip__fact'
    hint.textContent = t('creditsOnlyHint', '这条线路按额度计量，没有百分比窗口')
    row.appendChild(fact)
    row.appendChild(hint)
    return row
  }

  /** 该账号自己最近一次快照的主窗口：迷你进度条加百分比，没有快照时不画。 */
  function gaugeOf(account) {
    var used = numberOrNull(account.usedPercent)
    if (used === null) return null
    var wrap = document.createElement('span')
    wrap.className = 'line-flip__gauge'
    wrap.setAttribute('aria-hidden', 'true')
    var meter = document.createElement('span')
    meter.className = 'line-flip__meter line-flip__meter--mini'
    var bar = document.createElement('span')
    bar.className = 'line-flip__fill'
    meter.appendChild(bar)
    meter.style.setProperty('--line-used', Math.max(0, Math.min(100, used)) + '%')
    var pct = document.createElement('span')
    pct.className = 'line-flip__pct'
    var exact = document.createElement('span')
    exact.className = 'line-flip__pct-full'
    exact.textContent = percentText(used)
    var whole = document.createElement('span')
    whole.className = 'line-flip__pct-int'
    whole.textContent = Math.round(Math.max(0, Math.min(100, used))) + '%'
    pct.appendChild(exact)
    pct.appendChild(whole)
    wrap.appendChild(meter)
    wrap.appendChild(pct)
    return wrap
  }

  /**
   * 整行是一个按钮，所以读屏拿到的名字由这里给：动作、别名、邮箱与状态都在一句话里。
   *
   * 只写「切换到 X」会丢掉邮箱与状态，而这两个字段恰恰是同一线路里换号时唯一能区分账号的东西。
   */
  function rowLabel(name, email, statusText) {
    var label = fill(t('switchTo', '切换到 {name}'), { name: name })
    if (email !== null && email !== name) label += ' · ' + email
    if (statusText !== '') label += ' · ' + statusText
    return label
  }

  /** id 的后 4 位：重名又没邮箱时，这是唯一还能把两行分开的东西。 */
  function tailOf(id) {
    var text = typeof id === 'string' ? id : ''
    if (text === '') return ''
    return text.length > 4 ? text.slice(-4) : text
  }

  /**
   * 整卡的「标题方案」：一行一个账号，给出标题、可选的短区分符与副标题。
   *
   * 真实数据里同一个线路的账号常常同名（Qoder 的「For SK · 账号 1」、MiniMax 连着两个「MiniMax Code · cn ·
   * 账号 2」），两行写一样就分不出谁是谁。规则只有一句：**标题撞了才加区分符**，优先用这个账号的邮箱，
   * 邮箱也没有（或者它已经当标题了）就用 id 的后 4 位。用邮箱当区分符时副标题不再重复同一个地址。
   *
   * 区分符之间再撞一次（两个号连邮箱都一样）等于没分，这时退回 id 尾号。
   *
   * 窄盒子放不下「名字 + 区分符」：两半都只会剩几个字，读完谁也不是谁。那里由 CSS 把这一行的标题换成
   * 区分符本身（下面 .line-flip__row[data-tagged] 的规则），名字留在 title 与 aria-label 里备查。
   */
  function collide(plans) {
    var counts = {}
    var i
    for (i = 0; i < plans.length; i += 1) counts[plans[i].name] = (counts[plans[i].name] || 0) + 1
    var tagCounts = {}
    for (i = 0; i < plans.length; i += 1) {
      var plan = plans[i]
      plan.collided = counts[plan.name] > 1
      if (plan.collided) {
        if (plan.email !== null && plan.email !== plan.name) plan.tag = plan.email
        else {
          var tail = tailOf(plan.id)
          plan.tag = tail === '' ? '' : '…' + tail
        }
        if (plan.tag !== '') tagCounts[plan.tag] = (tagCounts[plan.tag] || 0) + 1
      } else if (plan.email !== null && plan.email !== plan.name) {
        plan.subtitle = plan.email
      }
    }
    for (i = 0; i < plans.length; i += 1) {
      var current = plans[i]
      var suffix = tailOf(current.id)
      if (current.tag !== '' && tagCounts[current.tag] > 1 && suffix !== '') current.tag = '…' + suffix
    }
    return plans
  }

  function titlePlanOf(data) {
    var accounts = accountsOf(data)
    var plans = []
    for (var i = 0; i < accounts.length; i += 1) {
      var account = accounts[i] !== null && typeof accounts[i] === 'object' ? accounts[i] : {}
      plans.push({
        name: displayLabel(account),
        email: textOrNull(account.email),
        id: typeof account.id === 'string' ? account.id : '',
        collided: false,
        tag: '',
        subtitle: ''
      })
    }
    return collide(plans)
  }

  /**
   * 正面分组小标题的方案：标题优先用账号的 email，没有 email 才用 label，再没有用 id。
   *
   * 撞名沿用背面那一套（{@link collide}）：先拿邮箱当区分符，邮箱没有或已经当了标题就用 id 后 4
   * 位。不同的只是**比较的范围**——背面比的是整个号池，正面比的是「这一屏真的画了标题的那几组」，
   * 否则一个没被分组显示的账号也会在别人标题后面挂一个区分符。
   */
  function captionPlanOf(groups) {
    var plans = []
    for (var i = 0; i < groups.length; i += 1) {
      var account = groups[i].account
      var email = textOrNull(account.email)
      var label = textOrNull(account.label)
      plans.push({
        name: email !== null ? email : label !== null ? label : typeof account.id === 'string' ? account.id : '',
        email: email,
        id: typeof account.id === 'string' ? account.id : '',
        collided: false,
        tag: '',
        subtitle: ''
      })
    }
    return collide(plans)
  }

  function accountRow(account, data, now, plan) {
    var activeId = data !== null && data !== undefined && typeof data.activeAccountId === 'string' ? data.activeAccountId : ''
    var isActive = activeId !== '' && account.id === activeId
    var busy = pendingSwitch !== null && pendingSwitch === account.id
    var status = toneOf(account, activeId, now)
    var planned = plan !== null && plan !== undefined ? plan : null
    var name = planned !== null ? planned.name : displayLabel(account)
    var tag = planned !== null ? planned.tag : ''
    var subtitle = planned !== null ? planned.subtitle : ''
    var tagged = tag !== '' && (planned === null || planned.collided === true)

    var item = document.createElement('li')
    item.className = 'line-flip__item'

    var row = document.createElement('button')
    row.type = 'button'
    row.className = 'line-flip__row'
    row.setAttribute('data-tone', status.tone)
    if (isActive) {
      row.setAttribute('aria-current', 'true')
      row.disabled = true
    } else {
      // 读屏的名字跟着视觉走：区分符也算进名字里，否则读屏同样分不出同名的两个号。
      row.setAttribute('aria-label', rowLabel(tag !== '' ? name + ' · ' + tag : name, subtitle !== '' ? subtitle : null, t(status.sr, status.label)))
    }
    if (busy) row.setAttribute('data-busy', 'true')

    var dot = document.createElement('span')
    dot.className = 'line-flip__dot'
    dot.setAttribute('aria-hidden', 'true')

    var sr = document.createElement('span')
    sr.className = 'w-sr'
    sr.textContent = t(status.sr, status.label)

    var id = document.createElement('span')
    id.className = 'line-flip__id'

    // 标题与短区分符同一行：区分符不参与省略，名字先让。
    var titleNode = document.createElement('span')
    titleNode.className = 'line-flip__name'
    var labelNode = document.createElement('span')
    labelNode.className = 'line-flip__label'
    labelNode.textContent = name
    titleNode.appendChild(labelNode)
    if (tag !== '') {
      var tagNode = document.createElement('span')
      tagNode.className = 'line-flip__tag'
      tagNode.textContent = tag
      titleNode.appendChild(tagNode)
    }
    id.appendChild(titleNode)

    // 撞名的行在窄盒子里只剩区分符当标题：两个半截的名字摆一起，谁也不认得谁。
    if (tagged) {
      row.setAttribute('data-tagged', 'true')
      var aliasNode = document.createElement('span')
      aliasNode.className = 'line-flip__alias'
      aliasNode.textContent = tag
      aliasNode.setAttribute('title', name)
      id.appendChild(aliasNode)
    }

    // 副标题是邮箱；alias 常常就是邮箱，两行写同一个地址没有意义，而且这一行已经用邮箱当区分符时也不再重复。
    if (subtitle !== '') {
      var emailNode = document.createElement('span')
      emailNode.className = 'line-flip__email w-hide-narrow'
      emailNode.textContent = subtitle
      id.appendChild(emailNode)
    }

    row.appendChild(dot)
    row.appendChild(sr)
    row.appendChild(id)
    var gauge = gaugeOf(account)
    if (gauge !== null) {
      row.appendChild(gauge)
    } else {
      // 这一个号还没有额度快照：不画 0% 的空条（空条会被读成「用完了」），只留一句弱化的小字。
      var unread = document.createElement('span')
      unread.className = 'line-flip__gauge-missing'
      unread.textContent = t('quotaUnread', '额度未读')
      row.appendChild(unread)
    }

    if (isActive || busy) {
      var marker = document.createElement('span')
      marker.className = 'line-flip__marker'
      marker.textContent = busy ? t('switching', '切换中…') : t('current', '当前')
      row.appendChild(marker)
    }

    var used = numberOrNull(account.usedPercent)
    if (used !== null && used >= 90) row.setAttribute('data-high', 'true')

    if (!isActive) {
      row.disabled = busy || pendingSwitch !== null || pendingStrategy !== null
      row.addEventListener('click', function (event) {
        stop(event)
        switchTo(account.id)
      })
      // Enter 与空格交给浏览器按按钮的默认动作走；别冒泡到翻转容器的键盘处理上去换面。
      row.addEventListener('keydown', stopKey)
    }

    item.appendChild(row)
    return item
  }

  function renderStrategy(data) {
    var group = fields.strategy
    if (group === null || group === undefined) return
    var current = data !== null && data !== undefined && typeof data.strategy === 'string' ? data.strategy : ''
    var busy = pendingStrategy !== null || pendingSwitch !== null || data === null || data === undefined
    group.setAttribute('data-busy', pendingStrategy !== null ? 'true' : 'false')
    var chips = group.querySelectorAll('[data-strategy]')
    for (var i = 0; i < chips.length; i += 1) {
      var chip = chips[i]
      chip.setAttribute('aria-pressed', chip.getAttribute('data-strategy') === current ? 'true' : 'false')
      chip.disabled = busy
    }
  }

  function setBusy() {
    var quota = quotaOf(shown)
    var busy = pendingRefresh !== null || (quota !== null && quota.refreshing === true)
    card.setAttribute('data-busy', busy ? 'true' : 'false')
    if (fields.refresh !== null && fields.refresh !== undefined) fields.refresh.disabled = pendingRefresh !== null
  }

  function render() {
    var data = shown
    var kind = kindOf(data)
    card.setAttribute('data-state', kind)

    put(fields.frontTitle, lineName())
    var frontMetaParts = frontMeta(data)
    put(fields.frontPlan, frontMetaParts.plan)
    put(fields.frontUpdated, frontMetaParts.rest)
    show(fields.frontMeta, frontMetaParts.plan !== '' || frontMetaParts.rest !== '')

    var windows = kind === 'ready' ? windowsOf(data) : []
    // 分组要 ≥2 个账号各自带着窗口；不够时 groups 是 null，正面就还是原来那一层扁平的线路窗口。
    var groups = kind === 'ready' ? windowGroupsOf(data) : null
    var now = Date.now()
    var factOnly = kind === 'credits'
    if (fields.windows !== null && fields.windows !== undefined) {
      fields.windows.textContent = ''
      if (groups !== null) {
        var captions = captionPlanOf(groups)
        for (var g = 0; g < groups.length; g += 1) fields.windows.appendChild(windowGroupNode(groups[g], data, captions[g], now))
      } else {
        for (var i = 0; i < windows.length; i += 1) fields.windows.appendChild(windowRow(windows[i], now))
      }
      // 没有百分比窗口但有绝对额度的线路：窗口区的那一格留给「可用余额 …」，正文不再是空白。
      if (factOnly) fields.windows.appendChild(creditFactRow(data))
      show(fields.windows, groups !== null || windows.length > 0 || factOnly)
    }

    var blank = kind === 'ready' || factOnly ? '' : frontBlankOf(data, kind)
    put(fields.frontBlank, blank)
    show(fields.frontBlank, blank !== '')

    // 页脚的赠额对「只有余额」的线路是同一句话的复读：主事实已经写在正文里，页脚只留可用重置。
    var credits = kind === 'ready' ? creditText(data) : ''
    var resets = kind === 'ready' || factOnly ? resetsText(data) : ''
    put(fields.credits, credits)
    show(fields.credits, credits !== '')
    put(fields.resets, resets)
    show(fields.resets, resets !== '')
    show(fields.foot, credits !== '' || resets !== '')

    put(fields.frontError, refreshError)
    show(fields.frontError, refreshError !== '')

    var current = currentAccountOf(data)
    put(fields.backKicker, lineName())
    put(fields.backTitle, current !== '' ? current : t('noAccount', '还没有当前账号'))
    var backMetaParts = backMeta(data)
    put(fields.backCount, backMetaParts.count)
    put(fields.backStrategy, backMetaParts.rest)
    show(fields.backMeta, backMetaParts.count !== '' || backMetaParts.rest !== '')
    renderStrategy(data)

    var accounts = accountsOf(data)
    if (fields.list !== null && fields.list !== undefined) {
      fields.list.textContent = ''
      // 区分符是整卡的事（要跟别的行比），所以先算一遍标题方案，再逐行画。
      var plans = titlePlanOf(data)
      for (var j = 0; j < accounts.length; j += 1) fields.list.appendChild(accountRow(accounts[j], data, now, plans[j]))
      show(fields.list, accounts.length > 0)
    }
    var back = accounts.length === 0 ? backBlankOf(data) : { text: '', hint: '' }
    put(fields.backBlankText, back.text)
    put(fields.backBlankHint, back.hint)
    show(fields.backBlankHint, back.hint !== '')
    show(fields.backBlank, back.text !== '')

    // 刷新按钮在两面上都点得到，所以它的失败也在两面上都写得出来，不会因为在背面就看不见。
    var backError = accountError !== '' ? accountError : refreshError
    put(fields.backError, backError)
    show(fields.backError, backError !== '')

    setBusy()
    applyFace()
  }

  /** 翻面状态：类名是唯一的事实来源，`face` 是它在上一次同步时的影子。 */
  function applyFace() {
    var back = face === 'back'
    card.classList.toggle('is-flipped', back)
    card.setAttribute('aria-pressed', back ? 'true' : 'false')
    card.setAttribute('aria-label', back ? t('flipToFront', '翻回正面看额度') : t('flipToBack', '翻到背面看账号'))
  }

  function persistFace() {
    if (widget === undefined || widget === null || typeof widget.setState !== 'function') return
    widget.setState({ face: face })
  }

  /** 运行时的翻面动作先跑完，再读类名记下来；0 毫秒的等待就是「这一轮事件之后」。 */
  function syncFace() {
    var next = card.classList.contains('is-flipped') ? 'back' : 'front'
    if (next === face) return
    face = next
    applyFace()
    persistFace()
  }

  function restoredFace() {
    var state = widget !== undefined && widget !== null ? widget.state : null
    return state !== null && state !== undefined && typeof state === 'object' && state.face === 'back' ? 'back' : 'front'
  }

  function stop(event) {
    if (event !== null && event !== undefined && typeof event.stopPropagation === 'function') event.stopPropagation()
  }

  function stopKey(event) {
    if (event.key === 'Enter' || event.key === ' ') stop(event)
  }

  /**
   * 轻点翻面交给运行时；鼠标点一下切换「记住的那一面」。
   *
   * 桌面没有悬停之外的翻面动作（运行时对鼠标直接返回），少了这一下，被记住的背面在纯鼠标下就回不到
   * 正面。两种路径最后都在同一个 0 毫秒之后读类名，所以不会与运行时的切换互相抵消。
   */
  function toggleFace(event) {
    if (event.pointerType === 'mouse') card.classList.toggle('is-flipped')
    window.setTimeout(syncFace, 0)
  }

  function flipByKey(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return
    window.setTimeout(syncFace, 0)
  }

  function reasonOf(error, fallback) {
    if (error !== null && error !== undefined && typeof error.message === 'string' && error.message !== '') return error.message
    return fallback
  }

  function canCall() {
    return widget !== undefined && widget !== null && typeof widget.call === 'function'
  }

  /** 三个能力都按线路调用：线路 id 一直在参数里，切换与策略再多带一个字段。 */
  function callLine(capability, extra) {
    var args = { line: lineId() }
    if (extra !== null && extra !== undefined) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) args[key] = extra[key]
      }
    }
    return widget.call(capability, args)
  }

  /** 能力返回同一份形状时用它重画；返回别的东西时留着现有数据，等下一轮数据源刷新。 */
  function looksLikeData(value) {
    if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return false
    return 'quota' in value || 'accounts' in value || 'signedIn' in value || 'strategy' in value
  }

  /** 一次刷新在途时不发第二次；成功与失败都先放开按钮，再画结果。 */
  function refresh() {
    if (pendingRefresh !== null) return
    if (!canCall()) return
    refreshError = ''
    pendingRefresh = callLine(REFRESH, null)
    render()
    pendingRefresh.then(function (next) {
      pendingRefresh = null
      if (looksLikeData(next)) shown = next
      refreshError = ''
      render()
    }, function (error) {
      pendingRefresh = null
      refreshError = reasonOf(error, t('failed', '读不到额度'))
      render()
    })
  }

  function switchTo(accountId) {
    if (pendingSwitch !== null || pendingStrategy !== null) return
    if (!canCall()) return
    accountError = ''
    var call = callLine(SWITCH, { accountId: accountId })
    pendingSwitch = accountId
    render()
    call.then(function (next) {
      pendingSwitch = null
      if (looksLikeData(next)) shown = next
      accountError = ''
      render()
    }, function (error) {
      pendingSwitch = null
      accountError = reasonOf(error, t('accountsFailed', '读不到账号'))
      render()
    })
  }

  function chooseStrategy(strategy) {
    if (pendingStrategy !== null || pendingSwitch !== null) return
    if (!canCall()) return
    if (shown !== null && shown !== undefined && shown.strategy === strategy) return
    accountError = ''
    pendingStrategy = strategy
    render()
    callLine(STRATEGY, { strategy: strategy }).then(function (next) {
      pendingStrategy = null
      if (looksLikeData(next)) shown = next
      accountError = ''
      render()
    }, function (error) {
      pendingStrategy = null
      accountError = reasonOf(error, t('accountsFailed', '读不到账号'))
      render()
    })
  }

  function applyData(next) {
    shown = next !== null && next !== undefined && typeof next === 'object' ? next : null
    render()
  }

  function preview() {
    if (SAMPLE === null) {
      var now = Date.now()
      SAMPLE = {
        line: lineId() === '' ? 'codex' : lineId(),
        label: 'ChatGPT',
        signedIn: true,
        installed: true,
        planLabel: 'plus',
        accountLabel: 'a***@gmail.com',
        accounts: [
          {
            id: 'acc_1',
            label: '主账号',
            email: 'a@example.com',
            primary: true,
            plan: 'plus',
            cooldownUntil: null,
            authStatus: 'ok',
            usedPercent: 34.2,
            resetsAt: now + 7980000
          },
          {
            id: 'acc_2',
            label: '备账号',
            email: 'b@example.com',
            primary: false,
            plan: 'plus',
            cooldownUntil: now + 3600000,
            authStatus: 'ok',
            usedPercent: 63,
            resetsAt: now + 432000000
          }
        ],
        activeAccountId: 'acc_1',
        strategy: 'round-robin',
        quota: {
          windows: [
            { label: '5 小时', usedPercent: 34.2, windowMinutes: 300, resetsAt: now + 7980000 },
            { label: null, usedPercent: 61, windowMinutes: 10080, resetsAt: now + 432000000 }
          ],
          credits: { unlimited: false, balance: '10.00' },
          resetCredits: { available: 1, expiresAt: now + 1728000000 },
          fetchedAt: now,
          refreshing: false,
          error: null
        },
        error: null
      }
    }
    shown = SAMPLE
    render()
  }

  function consider(size) {
    var current = size !== null && size !== undefined ? size : widget !== undefined && widget !== null ? widget.size : null
    if (current !== null && current !== undefined && current.placement === 'preview') preview()
  }

  function restoreFromState(state) {
    var next = state !== null && state !== undefined && typeof state === 'object' && state.face === 'back' ? 'back' : 'front'
    if (next === face) return
    face = next
    applyFace()
  }

  // 静态文案（策略副标题）从 manifest 的 text 里取；没有宿主时留着标记里写的那份。
  var labels = card.querySelectorAll('[data-label]')
  for (var l = 0; l < labels.length; l += 1) {
    var key = labels[l].getAttribute('data-label')
    if (key !== null) labels[l].textContent = t(key, labels[l].textContent)
  }

  if (fields.refresh !== null && fields.refresh !== undefined) {
    fields.refresh.setAttribute('title', t('refresh', '刷新额度'))
    fields.refresh.setAttribute('aria-label', t('refresh', '刷新额度'))
    fields.refresh.addEventListener('click', function (event) {
      stop(event)
      refresh()
    })
    // 空格落在按钮上时浏览器自己会按一次，别让它顺带冒泡成翻面。
    fields.refresh.addEventListener('keydown', stopKey)
  }

  if (fields.strategy !== null && fields.strategy !== undefined) {
    fields.strategy.setAttribute('aria-label', t('rotation', '轮换策略'))
    var chips = fields.strategy.querySelectorAll('[data-strategy]')
    for (var c = 0; c < chips.length; c += 1) {
      var chip = chips[c]
      chip.addEventListener('click', function (event) {
        stop(event)
        var id = this.getAttribute('data-strategy')
        if (id !== null) chooseStrategy(id)
      })
      chip.addEventListener('keydown', stopKey)
    }
  }

  card.addEventListener('click', toggleFace)
  card.addEventListener('keydown', flipByKey)

  face = restoredFace()
  applyFace()

  if (widget !== undefined && widget !== null) {
    if (typeof widget.onData === 'function') widget.onData(applyData)
    if (typeof widget.onSize === 'function') widget.onSize(consider)
    if (typeof widget.onState === 'function') widget.onState(restoreFromState)
    if (typeof widget.onProps === 'function') widget.onProps(function () { render() })
    if (widget.data !== undefined && widget.data !== null) applyData(widget.data)
    else render()
    consider(widget.size)
  } else {
    preview()
  }
})()
