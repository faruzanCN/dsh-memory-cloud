/* Memory Nebula — 3D star-field renderer, no external dependencies.
 * Each DSH Session is a nebula cluster; each conversation fragment is a star
 * orbiting its cluster in 3D. Pure Canvas 2D with a hand-rolled perspective
 * projection, painter's-algorithm depth sorting and additive glow. */
(function () {
  'use strict'

  const canvas = document.getElementById('sky')
  const ctx = canvas.getContext('2d', { alpha: false })
  const el = {
    subtitle: document.getElementById('subtitle'),
    search: document.getElementById('search'),
    autorotate: document.getElementById('autorotate'),
    reset: document.getElementById('reset'),
    close: document.getElementById('close'),
    legend: document.getElementById('legend'),
    relationKey: document.getElementById('relation-key'),
    stats: document.getElementById('stats'),
    skinButtons: [...document.querySelectorAll('.skin-btn')],
    tooltip: document.getElementById('tooltip'),
    detail: document.getElementById('detail'),
    detailTitle: document.getElementById('detail-title'),
    detailMeta: document.getElementById('detail-meta'),
    detailFragments: document.getElementById('detail-fragments'),
    detailClose: document.getElementById('detail-close'),
    loading: document.getElementById('loading'),
  }

  // Deterministic hash → PRNG so a Session always lands in the same place.
  function hash(str) {
    let h = 2166136261
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return h >>> 0
  }
  function rng(seed) {
    let s = seed || 1
    return () => {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5
      return ((s >>> 0) % 100000) / 100000
    }
  }

  const PALETTE = [
    [120, 170, 255], [180, 130, 255], [110, 225, 200],
    [255, 160, 110], [255, 130, 190], [140, 210, 255],
    [230, 200, 120], [160, 160, 255], [120, 235, 170], [255, 190, 140],
  ]
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`

  // ---------------------------------------------------------------------------
  // Soft radial sprite cache.
  //
  // A solid ellipse has a hard rim; a per-puff radial gradient is a natural
  // feather but far too slow on Android WebView. Pre-render ONE small radial
  // sprite per colour and reuse it via drawImage: soft NASA-style falloff with
  // no per-frame gradient allocation and no hard edges.
  // ---------------------------------------------------------------------------
  const SPRITE_SIZE = 64
  const spriteCache = new Map()
  function softSprite(color) {
    const key = `${color[0]},${color[1]},${color[2]}`
    let sprite = spriteCache.get(key)
    if (sprite) return sprite
    const cv = document.createElement('canvas')
    cv.width = cv.height = SPRITE_SIZE
    const g = cv.getContext('2d')
    const r = SPRITE_SIZE / 2
    const grad = g.createRadialGradient(r, r, 0, r, r, r)
    // A gentle, multi-stop falloff — no plateau, no rim.
    grad.addColorStop(0, rgba(color, 1))
    grad.addColorStop(0.18, rgba(color, 0.72))
    grad.addColorStop(0.42, rgba(color, 0.32))
    grad.addColorStop(0.68, rgba(color, 0.09))
    grad.addColorStop(0.88, rgba(color, 0.02))
    grad.addColorStop(1, rgba(color, 0))
    g.fillStyle = grad
    g.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE)
    sprite = cv
    spriteCache.set(key, sprite)
    return sprite
  }

  // One shared signal rhythm for BOTH skins: a slow, CONTINUOUS current.
  // Two staggered brightness crests keep charge flowing at every instant —
  // this is not a one-off lightning flash that lights everything then dies.
  // The current is animated at a fixed 30 fps, independent of the display's
  // refresh rate. Driving it from a real clock keeps the speed constant even
  // when rAF fires at 60/120 Hz or stalls for a moment.
  const SIGNAL_FPS = 30
  const FRAME_MS = 1000 / SIGNAL_FPS
  const SIGNAL_CYCLE = 7200
  const WAKE_DECAY = 0.11   // short wake: the wire really goes dark between crests
  const WAKE_CUTOFF = 0.30  // hard black beyond this distance behind a crest
  const CREST_WIDTH = 0.055
  const CRESTS = [0, 0.5]

  /**
   * Brightness at position t from a crest at p. Ahead of the crest (lag < 0)
   * the wire is PURE BLACK — the old wrap-around made every link faintly lit
   * all the time, which is why the currents never seemed to rest.
   */
  function wakeAt(t, p) {
    const lag = p - t
    if (lag < 0 || lag > WAKE_CUTOFF) return 0
    if (lag < CREST_WIDTH) return Math.exp(-((lag / CREST_WIDTH) ** 2) * 0.7)
    return Math.exp(-(lag - CREST_WIDTH) / WAKE_DECAY) * 0.6
  }

  /** Total continuous current level at position t for a link's phase. */
  function currentAt(t, phase) {
    let level = 0
    for (const c of CRESTS) {
      level = Math.max(level, wakeAt(t, (phase + c) % 1))
    }
    // Below this threshold the wire is simply not drawn at all.
    return level < 0.02 ? 0 : Math.min(1, level)
  }

  /**
   * Shared renderer for BOTH skins.
   *
   * Performance (Android WebView): stroking ~56 segments x 3-4 passes meant
   * 6000+ stroke() calls per frame and stuttered badly on mobile Canvas2D,
   * while auto-rotation (one yaw value) stayed smooth. Instead we build ONE
   * path per wire and ONE linear gradient whose stops encode the travelling
   * brightness wave, then reuse that path for three strokes. That is 3 strokes
   * per link regardless of detail, and the gradient interpolates brightness
   * continuously — genuinely silky even when the signal steps at 30 fps.
   */
  function drawSignalWave(pointAt, color, gain, phase, segments, scale) {
    const a = pointAt(0), b = pointAt(1)
    if (Math.abs(b.x - a.x) + Math.abs(b.y - a.y) < 1) return

    // Sample the wave; if the whole link is dark, draw nothing at all.
    const K = 16
    const levels = []
    let peak = 0
    for (let k = 0; k <= K; k += 1) {
      const v = currentAt(k / K, phase) * gain
      levels.push(v)
      if (v > peak) peak = v
    }
    if (peak < 0.02) return

    const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y)
    for (let k = 0; k <= K; k += 1) {
      // Dark stops are fully transparent, not a dim colour, so no permanent
      // hairline survives between currents. Lit stops stay below white.
      grad.addColorStop(k / K, rgba(color, Math.min(0.9, levels[k] * 1.05)))
    }

    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    for (let i = 1; i <= segments; i += 1) {
      const p = pointAt(i / segments)
      ctx.lineTo(p.x, p.y)
    }
    ctx.strokeStyle = grad
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    // Only two passes, both feathered by the gradient itself. A wide opaque
    // stroke with round caps was what produced the hard white outline.
    ctx.globalAlpha = 0.22 * scale
    ctx.lineWidth = 6 * scale
    ctx.stroke()
    ctx.globalAlpha = 1
    ctx.lineWidth = 0.9
    ctx.stroke()
  }

  /** Phase of the continuous current for one link, shared by both skins. */
  function signalPhase(seed) {
    return ((state.time / SIGNAL_CYCLE) + (seed % 1000) / 1000) % 1
  }

  /** Real-time clock quantised to exactly SIGNAL_FPS signal frames/second. */
  function signalClock() {
    return Math.floor((typeof performance !== 'undefined' ? performance.now() : Date.now()) / FRAME_MS) * FRAME_MS
  }

  // Minimal 3D vector helpers, used only to grow dendrite trees in world space.
  const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
  const vscale = (a, k) => [a[0] * k, a[1] * k, a[2] * k]
  const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  function vnorm(a) {
    const l = Math.hypot(a[0], a[1], a[2]) || 1
    return [a[0] / l, a[1] / l, a[2] / l]
  }
  function vperp(dir) {
    const ref = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
    const u = vnorm(vcross(dir, ref))
    return [u, vcross(dir, u)]
  }

  /**
   * Grow one dendrite arbor: a trunk that recursively splits into thinner,
   * shorter branches — the same shape as a tree or a real neuronal dendritic
   * field. Everything is stored as world-space segments so the arbor keeps its
   * 3D structure while the camera rotates.
   */
  function buildDendrites(center, seed, weight) {
    const rand = rng(seed)
    const segments = []
    const tips = []
    // A busier session grows a denser dendritic field (3..7 trunks, 2..3
    // branch levels). This is the neuron skin's "memory count" made visible.
    const trunkCount = 3 + Math.round(weight * 4)
    const maxDepth = weight > 0.55 ? 3 : 2

    function grow(from, dir, length, width, depth) {
      const to = vadd(from, vscale(dir, length))
      segments.push({ a: from, b: to, width, depth })
      if (depth >= maxDepth || length < 6) {
        tips.push({ p: to, depth })
        return
      }
      const [u, v] = vperp(dir)
      const branches = depth === 0 ? 3 : 2
      for (let k = 0; k < branches; k += 1) {
        // Spread children around the parent axis with a clear fork angle.
        const spread = 0.45 + rand() * 0.5
        const around = (k / branches) * Math.PI * 2 + rand() * 1.1
        const side = vadd(vscale(u, Math.cos(around)), vscale(v, Math.sin(around)))
        const childDir = vnorm(vadd(vscale(dir, Math.cos(spread)), vscale(side, Math.sin(spread))))
        grow(to, childDir, length * (0.62 + rand() * 0.13), width * 0.6, depth + 1)
      }
    }

    for (let i = 0; i < trunkCount; i += 1) {
      const theta = (i / trunkCount) * Math.PI * 2 + rand() * 0.6
      const phi = (rand() - 0.5) * 1.5
      const dir = vnorm([Math.cos(theta) * Math.cos(phi), Math.sin(phi), Math.sin(theta) * Math.cos(phi)])
      grow(center, dir, 30 + rand() * 16, 2.3, 0)
    }
    return { segments, tips }
  }

  /**
   * Grow one irregular nebula cloud. There is deliberately NO spherical core
   * and NO orbital ring: a nebula is lumpy gas — a few off-centre condensations
   * joined by wispy filaments, with ragged edges and holes between the lobes.
   * All points are world-space so the cloud keeps its volume while rotating.
   */
  function buildCloud(center, seed, activity, weight) {
    const rand = rng(seed)
    const puffs = []
    const filaments = []
    // More remembered fragments -> more condensations in the cloud.
    const lobes = 2 + Math.round(weight * 4)
    // A dominant stretch axis makes the whole cloud elongated, not round.
    const axis = vnorm([(rand() - 0.5) * 2, (rand() - 0.5) * 1.2, (rand() - 0.5) * 2])
    const [u, v] = vperp(axis)
    const reach = 24 + activity * 12 + weight * 18

    const lobeCenters = []
    for (let l = 0; l < lobes; l += 1) {
      const along = (rand() - 0.35) * reach * 1.5
      const around = rand() * Math.PI * 2
      const off = (0.35 + rand() * 0.65) * reach
      const p = vadd(center, vadd(
        vscale(axis, along),
        vadd(vscale(u, Math.cos(around) * off), vscale(v, Math.sin(around) * off * 0.7)),
      ))
      lobeCenters.push(p)
      // Each condensation is a ragged clump of soft gas puffs, stretched along
      // the cloud axis. Sizes and opacities vary so edges stay fuzzy.
      // Cap per-cloud puffs: hundreds of per-puff radial gradients per frame
      // is exactly what stalls an Android WebView.
      const count = 4 + Math.round(weight * 4) + Math.floor(rand() * 3)
      for (let k = 0; k < count; k += 1) {
        const jitter = [
          (rand() - 0.5) * 26, (rand() - 0.5) * 20, (rand() - 0.5) * 26,
        ]
        // Bias puffs along the axis -> wispy, filamentary clumps.
        const stretch = (rand() - 0.5) * 18
        puffs.push({
          pos: vadd(p, vadd(jitter, vscale(axis, stretch))),
          r: 13 + rand() * 20,
          alpha: 0.04 + rand() * 0.06,
          // Some puffs are cooler/warmer, so the cloud is not one flat colour.
          tint: rand() < 0.28 ? 'cool' : rand() < 0.16 ? 'warm' : 'main',
          squash: 0.25 + rand() * 0.45,
          angle: rand() * Math.PI,
        })
      }
      // A filament runs from the cloud centre out to each condensation, with a
      // kinked mid-point so it reads as gas, not a straight spoke.
      const mid = vadd(vscale(vadd(center, p), 0.5), [
        (rand() - 0.5) * 20, (rand() - 0.5) * 16, (rand() - 0.5) * 20,
      ])
      filaments.push([center.slice(), mid, p.slice()])
    }
    // A few loose filaments drifting off the lobes (ragged outer wisps).
    const wisps = 2 + Math.round(weight * 4)
    for (let f = 0; f < wisps; f += 1) {
      const base = lobeCenters[Math.floor(rand() * lobeCenters.length)]
      const tip = vadd(base, [
        (rand() - 0.5) * 44, (rand() - 0.5) * 30, (rand() - 0.5) * 44,
      ])
      const mid = vadd(vscale(vadd(base, tip), 0.5), [(rand() - 0.5) * 14, (rand() - 0.5) * 12, (rand() - 0.5) * 14])
      filaments.push([base.slice(), mid, tip])
    }
    return { puffs, filaments, lobeCenters, axis }
  }

  let state = {
    clusters: [],       // { session, color, center, cloud, stars, core }
    stars: [],          // flat, for hit-testing / sorting
    workspaces: [],     // { id, label, color, index }
    stats: null,
    query: '',
    dimWorkspace: null,
    autoRotate: true,
    yaw: 0.6,
    pitch: 0.32,
    zoom: 1,
    targetYaw: 0.6,
    targetPitch: 0.32,
    targetZoom: 1,
    skin: 'nebula',
    relations: [],       // { source, target, weight, kind, kinds, shared, a, b }
    dragging: false,
    lastX: 0,
    lastY: 0,
    moved: false,
    hover: null,
    selected: null,
    w: 0, h: 0, dpr: 1,
    time: 0,
    isMobile: false,
    // Two-finger pinch state, kept separate from the single-finger drag.
    pinch: null,      // { startDist, startZoom }
    pointers: new Map(),
  }

  const isTouchDevice = () =>
    typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
      || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)

  /** A phone needs a wider camera so the whole nebula fits its narrow viewport. */
  function cameraDistance() {
    if (!state.isMobile) return 900 / state.zoom
    // The cloud spans roughly ±300 world units. To fit it inside a viewport of
    // `w` pixels we need scale <= (w/2)/300; scale ~= camera/(camera+z), so a
    // larger camera shrinks everything. Derive it from the actual width and
    // keep a floor so a tablet never zooms out too far.
    const usable = Math.max(240, state.w - 24)
    const fit = Math.max(1.6, Math.min(3.4, 1650 / usable))
    return (900 * fit) / state.zoom
  }

  // -------------------------------------------------------------------------
  // Build the model from the aggregate payload
  // -------------------------------------------------------------------------
  function build(data) {
    const workspaces = data.workspaces || []
    const colorOf = new Map()
    workspaces.forEach((ws, i) => colorOf.set(ws.id, PALETTE[i % PALETTE.length]))
    state.workspaces = workspaces.map((ws, i) => ({ ...ws, color: PALETTE[i % PALETTE.length], index: i }))

    const sessions = data.sessions || []
    const golden = Math.PI * (3 - Math.sqrt(5))
    // Normalise each session's actual memory volume against the busiest one.
    // Everything visual (gas density, star count, dendrite complexity, cloud
    // size) is scaled from this, so the picture reflects real memory data.
    const maxFragments = Math.max(1, ...sessions.map(s => (s.fragments || []).length))
    const maxEvents = Math.max(1, ...sessions.map(s => s.counts?.events || 0))
    // Spread cluster centers on a fibonacci sphere so the nebula reads as a
    // galaxy, with radius scaled gently by activity (busier Sessions drift out).
    // On a narrow screen shrink the whole cloud so rotation rarely clips a
    // cluster at the viewport edge.
    const R = state.isMobile ? 205 : 250
    state.clusters = sessions.map((session, i) => {
      const rand = rng(hash(session.id))
      const y = 1 - (i / Math.max(1, sessions.length - 1)) * 2
      const radiusAtY = Math.sqrt(Math.max(0, 1 - y * y))
      const theta = golden * i
      const spread = 0.82 + rand() * 0.42
      const activity = Math.min(1.6, 0.6 + Math.log10(1 + session.counts.events) / 2.2)
      const center = [
        Math.cos(theta) * radiusAtY * R * spread,
        y * R * 0.62,
        Math.sin(theta) * radiusAtY * R * spread,
      ]
      const fragments = session.fragments || []
      const weight = Math.min(1,
        0.6 * (fragments.length / maxFragments) + 0.4 * ((session.counts?.events || 0) / maxEvents))
      const color = colorOf.get(session.workspace) || PALETTE[i % PALETTE.length]
      const cloud = buildCloud(center, hash(session.id) ^ 0x7e31, activity, weight)
      const cluster = {
        session, color, center, cloud, stars: [], weight,
        dendrites: buildDendrites(center, hash(session.id) ^ 0x2c91, weight),
      }

      // Gas puffs themselves are the clickable "nebula" surface; pick the
      // densest condensations as invisible hit anchors, never a glowing ball.
      cloud.lobeCenters.forEach((p, li) => {
        cluster.stars.push({
          kind: 'anchor', cluster, isClusterCore: false, fragment: null,
          pos: p.slice(), size: 1, phase: li, color,
        })
      })
      const anchors = cluster.stars.slice()

      // Young stars embedded *inside* the gas: pick a random condensation and
      // scatter around it, so the stars do not form a ring around a nucleus.
      fragments.forEach((fragment, fi) => {
        const lobe = cloud.lobeCenters[Math.floor(rand() * cloud.lobeCenters.length)] || center
        const spread = 8 + rand() * 20
        const star = {
          kind: 'star', cluster, fragment, isClusterCore: false,
          pos: [
            lobe[0] + (rand() - 0.5) * spread * 2,
            lobe[1] + (rand() - 0.5) * spread * 1.4,
            lobe[2] + (rand() - 0.5) * spread * 2,
          ],
          size: 0.9 + rand() * 1.5 + (fragment.kind === 'user' ? 0.6 : 0),
          phase: rand() * Math.PI * 2,
          color,
        }
        cluster.stars.push(star)
        state.stars.push(star)
      })
      // Bright young stars scale with how much this session actually holds.
      const brightCount = 1 + Math.round(weight * 3)
      for (let s = 0; s < brightCount; s += 1) {
        const lobe = cloud.lobeCenters[Math.floor(rand() * cloud.lobeCenters.length)] || center
        state.stars.push({
          kind: 'bright', cluster, fragment: null, isClusterCore: false,
          pos: [lobe[0] + (rand() - 0.5) * 16, lobe[1] + (rand() - 0.5) * 12, lobe[2] + (rand() - 0.5) * 16],
          size: 1.6 + rand() * 1.1, phase: rand() * Math.PI * 2, color,
        })
      }
      // Fine dust speckles threaded through the gas, offset along filaments.
      const dustPerFilament = 2 + Math.round(weight * 3)
      cloud.filaments.forEach(([a, b, c]) => {
        for (let d = 0; d < dustPerFilament; d += 1) {
          const t = (d + rand()) / dustPerFilament
          const u2 = 1 - t
          const p = [
            u2 * u2 * a[0] + 2 * u2 * t * b[0] + t * t * c[0] + (rand() - 0.5) * 12,
            u2 * u2 * a[1] + 2 * u2 * t * b[1] + t * t * c[1] + (rand() - 0.5) * 9,
            u2 * u2 * a[2] + 2 * u2 * t * b[2] + t * t * c[2] + (rand() - 0.5) * 12,
          ]
          state.stars.push({ kind: 'dust', cluster, fragment: null, isClusterCore: false, pos: p, size: 0.4 + rand() * 0.8, phase: rand() * Math.PI * 2, color })
        }
      })
      anchors.forEach(a => state.stars.push(a))
      // One unobtrusive hit target at the centre for tapping the whole cloud.
      const core = {
        kind: 'core', cluster, isClusterCore: true, fragment: null,
        pos: center.slice(), size: 2.2, phase: rand() * Math.PI * 2, color,
      }
      cluster.core = core
      state.stars.push(core)
      return cluster
    })
    // Resolve relation endpoints to the live cluster objects.
    const byId = new Map(state.clusters.map(c => [c.session.id, c]))
    state.relations = (data.relations || [])
      .map(r => ({ ...r, a: byId.get(r.source), b: byId.get(r.target) }))
      .filter(r => r.a && r.b)
    buildRelationKey(data.relations?.length || 0)

    state.stats = data.stats
    buildLegend()
    buildStats(data.stats)
    el.subtitle.textContent = state.isMobile
      ? `${data.stats.sessions} 个会话 · ${data.stats.fragments} 颗记忆星 · 单指旋转 / 双指缩放`
      : `${data.stats.sessions} 个会话记忆 · ${data.stats.fragments} 颗记忆星 · 拖拽以探索`
    if (state.isMobile) el.search.placeholder = '搜索记忆'
    updateHint()
  }

  const SKIN_KEY = 'dsh-memory-cloud:skin:v1'

  function setSkin(skin) {
    state.skin = skin === 'neuron' ? 'neuron' : 'nebula'
    for (const btn of el.skinButtons) {
      const active = btn.dataset.skin === state.skin
      btn.classList.toggle('active', active)
      btn.setAttribute('aria-pressed', String(active))
    }
    try { window.localStorage.setItem(SKIN_KEY, state.skin) } catch (_) { /* private mode */ }
    updateHint()
  }

  function updateHint() {
    const hint = document.getElementById('hint')
    if (!hint) return
    const neuron = state.skin === 'neuron'
    hint.textContent = state.isMobile
      ? (neuron ? '轻点神经元展开记忆 · 信号沿突触流动' : '单指旋转 · 双指缩放 · 轻点星团展开记忆')
      : (neuron ? '拖拽旋转 · 滚轮缩放 · 点击神经元展开记忆 · 观察信号脉冲' : '拖拽旋转 · 滚轮缩放 · 悬停查看 · 点击星团展开记忆')
  }

  function buildRelationKey(count) {
    if (!el.relationKey) return
    const rows = [
      ['fork', '分支血缘', '#ffd591', true],
      ['topic', '共同话题', '#8aa0ff', false],
      ['workspace', '同工作区', '#7de0c0', false],
    ]
    el.relationKey.innerHTML =
      `<h3>会话关联</h3>` +
      rows.map(([kind, label, color, dashed]) =>
        `<div class="rk-row"><span class="rk-line ${kind}" style="border-top-color:${color};${dashed ? 'border-top-style:dashed' : ''}"></span>${label}</div>`).join('') +
      `<div class="rk-count">${count} 条关联边</div>`
  }

  function buildLegend() {
    el.legend.innerHTML = ''
    for (const ws of state.workspaces) {
      const item = document.createElement('div')
      item.className = 'legend-item'
      item.dataset.workspace = ws.id
      const dot = document.createElement('span')
      dot.className = 'dot'
      dot.style.color = rgba(ws.color, 1)
      dot.style.background = rgba(ws.color, 1)
      const name = document.createElement('span')
      name.className = 'name'
      name.textContent = ws.label
      name.title = ws.label
      const count = document.createElement('span')
      count.className = 'count'
      count.textContent = `${ws.sessions}`
      item.append(dot, name, count)
      item.addEventListener('click', () => {
        state.dimWorkspace = state.dimWorkspace === ws.id ? null : ws.id
        refreshLegendDim()
      })
      el.legend.append(item)
    }
  }
  function refreshLegendDim() {
    for (const item of el.legend.children) {
      item.classList.toggle('dim', state.dimWorkspace != null && item.dataset.workspace !== state.dimWorkspace)
    }
  }

  function buildStats(s) {
    if (!s) return
    const fmt = n => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
    const span = (s.oldest && s.newest)
      ? `${new Date(s.oldest).toLocaleDateString()} — ${new Date(s.newest).toLocaleDateString()}`
      : '—'
    const cells = [
      ['会话星团', fmt(s.sessions)],
      ['记忆星', fmt(s.fragments)],
      ['关联边', fmt(s.relations ?? 0)],
      ['对话轮次', fmt(s.turns)],
      ['用户消息', fmt(s.user)],
      ['助手消息', fmt(s.assistant)],
      ['工具调用', fmt(s.tools)],
      ['时间跨度', span],
    ]
    el.stats.innerHTML = cells.map(([label, value]) =>
      `<div class="stat"><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>`).join('')
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  }

  // -------------------------------------------------------------------------
  // Match / filter
  // -------------------------------------------------------------------------
  function matches(cluster) {
    if (state.dimWorkspace != null && cluster.session.workspace !== state.dimWorkspace) return false
    const q = state.query.trim().toLowerCase()
    if (q === '') return true
    if (cluster.session.title.toLowerCase().includes(q)) return true
    if (cluster.session.workspaceLabel.toLowerCase().includes(q)) return true
    return (cluster.session.fragments || []).some(f => f.text.toLowerCase().includes(q))
  }

  // -------------------------------------------------------------------------
  // 3D projection
  // -------------------------------------------------------------------------
  function project(p) {
    const cy = Math.cos(state.yaw), sy = Math.sin(state.yaw)
    const cp = Math.cos(state.pitch), sp = Math.sin(state.pitch)
    // rotate around Y (yaw)
    let x = p[0] * cy - p[2] * sy
    let z = p[0] * sy + p[2] * cy
    // rotate around X (pitch)
    let y = p[1] * cp - z * sp
    z = p[1] * sp + z * cp
    const camera = cameraDistance()
    const denom = camera + z
    const scale = camera / Math.max(120, denom)
    return {
      x: state.w / 2 + x * scale,
      y: state.h / 2 + y * scale,
      z,
      scale,
    }
  }

  // -------------------------------------------------------------------------
  // Render loop
  // -------------------------------------------------------------------------
  function resize() {
    state.w = window.innerWidth
    state.h = window.innerHeight
    // Android WebViews often report dpr 3. Rendering a full-screen `lighter`
    // composite at 2x costs ~4x the pixels of 1x and is the single biggest
    // cause of jank on mobile. Cap the backing store on small screens.
    const raw = window.devicePixelRatio || 1
    state.dpr = state.w <= 820 ? Math.min(raw, 1.25) : Math.min(2, raw)
    state.isMobile = state.w <= 820 || (state.w <= 980 && isTouchDevice())
    el.search.placeholder = state.isMobile ? '搜索记忆' : '搜索记忆 / 标题 / 工作区'
    canvas.width = Math.floor(state.w * state.dpr)
    canvas.height = Math.floor(state.h * state.dpr)
    canvas.style.width = `${state.w}px`
    canvas.style.height = `${state.h}px`
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0)
    bgGlow = null
  }

  let bgGlow = null
  function drawBackground() {
    ctx.fillStyle = '#070a1c'
    ctx.fillRect(0, 0, state.w, state.h)
    // The central glow is static: build its gradient once per resize instead
    // of allocating a full-screen radial gradient every single frame.
    if (bgGlow === null) {
      bgGlow = ctx.createRadialGradient(state.w / 2, state.h / 2, 0, state.w / 2, state.h / 2, Math.max(state.w, state.h) * 0.6)
      bgGlow.addColorStop(0, 'rgba(40, 50, 110, 0.35)')
      bgGlow.addColorStop(1, 'rgba(7, 10, 28, 0)')
    }
    ctx.fillStyle = bgGlow
    ctx.fillRect(0, 0, state.w, state.h)
    // Distant backdrop stars: ONE path, ONE fill. Per-star fillRect was ~150
    // fill() calls per frame and was a major Android WebView bottleneck.
    const rand = rng(9871)
    ctx.beginPath()
    for (let i = 0; i < 110; i += 1) {
      const x = rand() * state.w, y = rand() * state.h
      ctx.rect(x, y, 1, 1)
    }
    ctx.fillStyle = 'rgba(190,205,255,0.14)'
    ctx.fill()
  }

  // -------------------------------------------------------------------------
  // Skin: nebula (default) — irregular gas clouds joined by electric arcs
  // -------------------------------------------------------------------------

  /** Screen-space jagged arc between two projected points. */
  function arcPoints(pa, pb, seed, jitter, segments) {
    const rand = rng(seed)
    const dx = pb.x - pa.x, dy = pb.y - pa.y
    const len = Math.hypot(dx, dy) || 1
    const nx = -dy / len, ny = dx / len
    const pts = [{ x: pa.x, y: pa.y }]
    for (let i = 1; i < segments; i += 1) {
      const t = i / segments
      // A bow plus a saw-tooth lateral kick: an electric discharge is not a
      // smooth curve, it kinks sharply from side to side.
      const bow = Math.sin(t * Math.PI) * Math.min(22, len * 0.07)
      const kick = (rand() - 0.5) * jitter * (0.4 + Math.sin(t * Math.PI))
      const along = (rand() - 0.5) * jitter * 0.3
      pts.push({
        x: pa.x + dx * t + nx * (bow + kick) + (dx / len) * along,
        y: pa.y + dy * t + ny * (bow + kick) + (dy / len) * along,
      })
    }
    pts.push({ x: pb.x, y: pb.y })
    return pts
  }

  function strokePolyline(pts, color, alpha, width) {
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y)
    ctx.strokeStyle = rgba(color, alpha)
    ctx.lineWidth = width
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.stroke()
  }

  /** Point on a polyline at normalised arc length t. */
  function polylinePoint(pts, t) {
    const f = Math.max(0, Math.min(0.9999, t)) * (pts.length - 1)
    const i = Math.floor(f), u = f - i
    const a = pts[i], b = pts[i + 1] || a
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }
  }

  function drawRelationArcs() {
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    state.relations.forEach(r => {
      if (!r.a || !r.b) return
      const active = matches(r.a) && matches(r.b)
      const pa = project(r.a.center), pb = project(r.b.center)
      const color = r.kind === 'fork' ? [255, 213, 145]
        : r.kind === 'workspace' ? [125, 224, 192] : [140, 180, 255]
      const seed = hash(r.source + r.target)
      const segments = 16
      const pts = arcPoints(pa, pb, seed, 7 + r.weight * 6, segments)

      // On a phone, 29 arcs in a narrow viewport easily drown the gas, so keep
      // only the stronger links clearly visible there.
      const strength = state.isMobile ? Math.max(0, (r.weight - 0.3) * 1.4) : 1
      const gain = (0.35 + r.weight * 0.65) * strength
      if (gain < 0.05) return

      // Between currents the wire is black — no permanent channel glow.
      if (!active) return
      drawSignalWave(t => polylinePoint(pts, t), color, gain, signalPhase(seed), 56, 1)
    })
    ctx.restore()
  }

  /** Irregular gas: soft stretched puffs + wispy filaments, no round core. */
  function drawNebulaClouds() {
    ctx.save()
    // Real nebula gas scatters light; it does not add without bound. Using
    // 'lighter' made overlapping soft sprites saturate to pure white blobs
    // with a hard bright edge. Source-over keeps colours layered and soft.
    ctx.globalCompositeOperation = 'source-over'
    for (const cluster of state.clusters) {
      const visible = matches(cluster)
      const alpha = visible ? 1 : 0.08
      const cloud = cluster.cloud

      // Wispy filaments, all in ONE path (one stroke per cloud).
      ctx.beginPath()
      for (const [a, b, c] of cloud.filaments) {
        const pa = project(a), pb = project(b), pc = project(c)
        ctx.moveTo(pa.x, pa.y)
        ctx.quadraticCurveTo(pb.x, pb.y, pc.x, pc.y)
      }
      ctx.strokeStyle = rgba(cluster.color, 0.055 * alpha)
      ctx.lineWidth = 2
      ctx.lineCap = 'round'
      ctx.stroke()

      const c0 = project(cluster.center)

      // A broad, axis-stretched soft body: pre-rendered sprite, no rim.
      ctx.save()
      ctx.globalAlpha = 0.34 * alpha
      const bodySprite = softSprite(cluster.color)
      const bw = 150 * c0.scale, bh = 78 * c0.scale
      ctx.translate(c0.x, c0.y)
      const ax = project(vadd(cluster.center, vscale(cloud.axis, 40)))
      ctx.rotate(Math.atan2(ax.y - c0.y, ax.x - c0.x))
      ctx.drawImage(bodySprite, -bw / 2, -bh / 2, bw, bh)
      ctx.restore()

      // Every puff is a soft feathered sprite. Overlapping sprites with gentle
      // alpha build up a continuous, edge-less gas — like a real nebula photo.
      ctx.globalAlpha = alpha
      for (const puff of cloud.puffs) {
        const p = project(puff.pos)
        const tint = puff.tint === 'cool' ? [110, 160, 255]
          : puff.tint === 'warm' ? [255, 150, 120] : cluster.color
        const w = Math.max(6, puff.r * p.scale * 3.4)
        const h = w * puff.squash
        ctx.save()
        ctx.globalAlpha = (0.075 + puff.alpha * 1.1) * alpha
        ctx.translate(p.x, p.y)
        ctx.rotate(puff.angle)
        ctx.drawImage(softSprite(tint), -w / 2, -h / 2, w, h)
        ctx.restore()
      }
      ctx.globalAlpha = 1
    }
    ctx.restore()
  }

  /** Young stars embedded in the gas; the click target draws no ball at all. */
  function drawNebulaStars(projected) {
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    // Batch by colour: one path for dust, one for soft glows, one for cores.
    // A per-star radial gradient was ~2000 fill() calls/frame and is the main
    // reason the Android WebView stuttered while auto-rotation stayed smooth.
    const byColor = new Map()
    const keyOf = c => `${c[0]},${c[1]},${c[2]}`
    for (const item of projected) {
      const star = item.star
      if (star.kind === 'core' || star.kind === 'anchor' || !item.visible) continue
      const k = keyOf(star.color)
      if (!byColor.has(k)) byColor.set(k, { color: star.color, dust: [], glow: [], core: [] })
      byColor.get(k)[star.kind === 'dust' ? 'dust' : 'glow'].push(item)
    }
    // Soft sprites instead of solid discs: no hard rim on any star.
    const sprite = softSprite([255, 255, 255])
    for (const group of byColor.values()) {
      const colored = softSprite(group.color)
      ctx.globalAlpha = 0.22
      for (const { star, pr } of group.dust) {
        const twinkle = 0.78 + Math.sin(state.time * 0.002 + star.phase) * 0.22
        const d = Math.max(3, star.size * pr.scale * twinkle * 5)
        ctx.drawImage(colored, pr.x - d / 2, pr.y - d / 2, d, d)
      }
      for (const { star, pr } of group.glow) {
        const twinkle = 0.78 + Math.sin(state.time * 0.002 + star.phase) * 0.22
        const r = Math.max(0.5, star.size * pr.scale * twinkle)
        const d = Math.max(4, r * (star.kind === 'bright' ? 9 : 5))
        ctx.globalAlpha = 0.30
        ctx.drawImage(colored, pr.x - d / 2, pr.y - d / 2, d, d)
        ctx.globalAlpha = 0.34
        const c = Math.max(2, r * 2.2)
        ctx.drawImage(sprite, pr.x - c / 2, pr.y - c / 2, c, c)
      }
    }
    ctx.globalAlpha = 1
    // Selection / hover halo (one stroke, negligible cost).
    for (const { star, pr, visible } of projected) {
      if (!visible || (star !== state.hover && star.cluster !== state.selected)) continue
      const r = Math.max(6, star.size * pr.scale + 6)
      ctx.beginPath()
      ctx.arc(pr.x, pr.y, r, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(255,255,255,0.8)'
      ctx.lineWidth = 1
      ctx.stroke()
    }
    ctx.restore()
  }

  // -------------------------------------------------------------------------
  // Skin: neuron — each Session becomes a soma; relations become axons with
  // travelling signal pulses; fragments become short dendritic twigs.
  // -------------------------------------------------------------------------
  function linkGeometry(r) {
    const pa = project(r.a.center), pb = project(r.b.center)
    const dx = pb.x - pa.x, dy = pb.y - pa.y
    const len = Math.hypot(dx, dy) || 1
    const bow = Math.min(38, len * 0.13)
    return {
      pa, pb,
      cx: (pa.x + pb.x) / 2 - (dy / len) * bow,
      cy: (pa.y + pb.y) / 2 + (dx / len) * bow,
    }
  }

  function quadPoint(g, t) {
    const u = 1 - t
    return {
      x: u * u * g.pa.x + 2 * u * t * g.cx + t * t * g.pb.x,
      y: u * u * g.pa.y + 2 * u * t * g.cy + t * t * g.pb.y,
    }
  }

  function drawNeuronSkin() {
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'

    // Axons use the exact same signal wave as the nebula skin. No permanent
    // sheath: between currents the wire is genuinely absent, not dimly drawn.
    for (const r of state.relations) {
      if (!r.a || !r.b) continue
      const active = matches(r.a) && matches(r.b)
      if (!active) continue
      const g = linkGeometry(r)
      const color = r.kind === 'fork' ? [255, 213, 145] : [110, 170, 255]
      const seed = hash(r.source + r.target)
      const gain = (0.35 + r.weight * 0.65) * (state.isMobile ? Math.max(0, (r.weight - 0.3) * 1.4) : 1)
      if (gain < 0.05) continue
      drawSignalWave(t => quadPoint(g, t), color, gain, signalPhase(seed), 48, 0.85)
    }

    // Dendritic arbors: ONE path per depth across ALL neurons (4 strokes total
    // instead of ~60). Colours are keyed per cluster, so group by depth+colour.
    const dendriteGroups = new Map()
    for (const cluster of state.clusters) {
      if (!matches(cluster) || !cluster.dendrites) continue
      for (const seg of cluster.dendrites.segments) {
        const key = `${seg.depth}:${cluster.color[0]},${cluster.color[1]},${cluster.color[2]}`
        if (!dendriteGroups.has(key)) dendriteGroups.set(key, { depth: seg.depth, color: cluster.color, segs: [] })
        dendriteGroups.get(key).segs.push(seg)
      }
    }
    for (const g of dendriteGroups.values()) {
      ctx.beginPath()
      let scale = 1
      for (const seg of g.segs) {
        const a = project(seg.a), b = project(seg.b)
        scale = a.scale
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
      }
      ctx.strokeStyle = rgba(g.color, 0.26 * (1 - g.depth * 0.22))
      ctx.lineWidth = Math.max(0.35, (2.3 * Math.pow(0.6, g.depth)) * scale * 0.5)
      ctx.lineCap = 'round'
      ctx.stroke()
    }
    // All synaptic boutons in a single fill path, grouped by colour.
    const boutonGroups = new Map()
    for (const cluster of state.clusters) {
      if (!matches(cluster) || !cluster.dendrites) continue
      const key = `${cluster.color[0]},${cluster.color[1]},${cluster.color[2]}`
      if (!boutonGroups.has(key)) boutonGroups.set(key, { color: cluster.color, tips: [] })
      boutonGroups.get(key).tips.push(...cluster.dendrites.tips)
    }
    for (const g of boutonGroups.values()) {
      ctx.beginPath()
      for (const tip of g.tips) {
        const p = project(tip.p)
        const rad = Math.max(0.8, 1.6 * p.scale)
        ctx.moveTo(p.x + rad, p.y)
        ctx.arc(p.x, p.y, rad, 0, Math.PI * 2)
      }
      ctx.fillStyle = rgba(g.color, 0.34)
      ctx.fill()
    }

    // Somas: entirely soft sprites — no stroked ring, no hard membrane edge.
    const whiteSprite = softSprite([255, 255, 255])
    for (const cluster of state.clusters) {
      if (!matches(cluster)) continue
      const p = project(cluster.center)
      const pulse = 0.9 + Math.sin(state.time * 0.0016 + hash(cluster.session.id) % 7) * 0.1
      const R = (7 + Math.min(6, Math.log10(1 + cluster.session.counts.events) * 3)) * p.scale * pulse
      const halo = softSprite(cluster.color)
      const hd = R * 6
      ctx.globalAlpha = 0.55
      ctx.drawImage(halo, p.x - hd / 2, p.y - hd / 2, hd, hd)
      const bd = R * 2.6
      ctx.globalAlpha = 0.5
      ctx.drawImage(halo, p.x - bd / 2, p.y - bd / 2, bd, bd)
      const nd = Math.max(3, R * 1.1)
      ctx.globalAlpha = 0.6
      ctx.drawImage(whiteSprite, p.x - nd / 2, p.y - nd / 2, nd, nd)
      ctx.globalAlpha = 1
    }

    ctx.restore()
  }

  let lastFrame = 0
  function render() {
    // Cap the WHOLE scene at 30 fps. On an Android WebView a full-screen
    // `lighter` composite is expensive; a steady 30 fps reads far smoother
    // than a 60 fps loop that keeps dropping frames. The signal clock is the
    // same 30 Hz tick, so light and motion stay perfectly in step.
    const now = signalClock()
    if (now === lastFrame) {
      requestAnimationFrame(render)
      return
    }
    lastFrame = now
    state.time = now
    if (state.autoRotate && !state.dragging) state.targetYaw += 0.0032
    // 0.22 keeps the same perceived easing at 30 fps as 0.12 did at 60 fps.
    state.yaw += (state.targetYaw - state.yaw) * 0.22
    state.pitch += (state.targetPitch - state.pitch) * 0.22
    state.zoom += (state.targetZoom - state.zoom) * 0.22

    drawBackground()

    // Project everything, then paint back-to-front.
    const projected = []
    for (const star of state.stars) {
      const visible = matches(star.cluster)
      const pr = project(star.pos)
      if (pr.x < -60 || pr.x > state.w + 60 || pr.y < -60 || pr.y > state.h + 60) continue
      projected.push({ star, pr, visible })
    }
    projected.sort((a, b) => b.pr.z - a.pr.z)

    if (state.skin === 'neuron') {
      drawNeuronSkin()
    } else {
      drawNebulaClouds()
      drawRelationArcs()
      drawNebulaStars(projected)
    }

    // Cluster labels: on a narrow screen draw fewer of them to avoid clutter.
    if (state.zoom > 0.75) {
      ctx.save()
      ctx.font = state.isMobile ? '10px Inter, system-ui, sans-serif' : '11px Inter, system-ui, sans-serif'
      ctx.textBaseline = 'middle'
      let drawn = 0
      for (const cluster of state.clusters) {
        if (!matches(cluster)) continue
        if (state.isMobile && drawn >= 8) break
        const pr = project(cluster.center)
        if (pr.scale < (state.isMobile ? 0.30 : 0.55)) continue
        drawn += 1
        const label = cluster.session.title.length > (state.isMobile ? 14 : 22)
          ? `${cluster.session.title.slice(0, state.isMobile ? 14 : 22)}…`
          : cluster.session.title
        // Sit the label just below the cloud instead of on top of the gas.
        const ly = pr.y + 30 * pr.scale + 8
        ctx.globalAlpha = 0.8
        ctx.lineWidth = 3
        ctx.strokeStyle = 'rgba(7,10,28,0.92)'
        ctx.strokeText(label, pr.x + 6, ly)
        ctx.fillStyle = '#d6deff'
        ctx.fillText(label, pr.x + 6, ly)
      }
      ctx.restore()
    }

    requestAnimationFrame(render)
  }

  // -------------------------------------------------------------------------
  // Hit testing & interaction
  // -------------------------------------------------------------------------
  function hitTest(x, y) {
    let best = null
    let bestDist = state.isMobile ? 40 : 24
    // A whole gas cloud should be tappable, not just its brightest star.
    // Anchors sit at the condensations; give them a cloud-sized hit radius.
    const touchPad = state.isMobile ? 18 : 6
    for (const star of state.stars) {
      if (!matches(star.cluster)) continue
      const pr = project(star.pos)
      const d = Math.hypot(pr.x - x, pr.y - y)
      const isCloudTarget = star.kind === 'anchor' || star.kind === 'core'
      const radius = isCloudTarget
        ? Math.max(state.isMobile ? 30 : 24, 30 * pr.scale)
        : Math.max(state.isMobile ? 20 : 8, star.size * pr.scale + touchPad)
      if (d < radius && d < bestDist) {
        bestDist = d
        best = star
      }
    }
    return best
  }

  function showTooltip(star, x, y) {
    if (star == null) { el.tooltip.hidden = true; return }
    const s = star.cluster.session
    let title, sub, text
    if (star.isClusterCore || star.kind === 'anchor') {
      title = s.title
      sub = `${s.workspaceLabel} · ${s.counts.user} 用户消息 · ${s.fragments.length} 记忆星`
      text = '点击展开这段会话的全部记忆碎片'
    } else {
      title = s.title
      sub = star.fragment.kind === 'user' ? '用户记忆' : '助手记忆'
      text = star.fragment.text
    }
    el.tooltip.innerHTML = `<div class="tt-title">${escapeHtml(title)}</div><div class="tt-sub">${escapeHtml(sub)}</div><div class="tt-text">${escapeHtml(text)}</div>`
    el.tooltip.hidden = false
    const tw = el.tooltip.offsetWidth, th = el.tooltip.offsetHeight
    // On touch screens a finger sits below/right of the contact point, so float
    // the bubble above it; desktop keeps the classic lower-right placement.
    const left = Math.max(8, Math.min(state.w - tw - 8, x + (state.isMobile ? -tw / 2 : 14)))
    const top = state.isMobile
      ? Math.max(8, y - th - 18)
      : Math.max(8, Math.min(state.h - th - 12, y + 14))
    el.tooltip.style.left = `${left}px`
    el.tooltip.style.top = `${top}px`
  }

  function openDetail(cluster) {
    const s = cluster.session
    state.selected = cluster
    el.detailTitle.textContent = s.title
    const date = s.createdAt ? new Date(s.createdAt).toLocaleString() : '—'
    el.detailMeta.innerHTML = [
      `📁 ${escapeHtml(s.workspaceLabel)}`,
      `💬 ${s.counts.user} / ${s.counts.assistant} 条对话`,
      `🛠 ${s.counts.tools} 次工具调用`,
      `🕒 ${escapeHtml(date)}`,
    ].map(t => `<span>${t}</span>`).join('')
    el.detailFragments.innerHTML = (s.fragments || []).map(f =>
      `<div class="frag ${f.kind}"><span class="who">${f.kind === 'user' ? '你' : '助手'}${f.time ? ' · ' + escapeHtml(new Date(f.time).toLocaleString()) : ''}</span>${escapeHtml(f.text)}</div>`).join('')
      || '<div class="frag"><span class="who">—</span>这段会话没有可显示的文本记忆。</div>'
    el.detail.hidden = false
  }
  function closeDetail() {
    state.selected = null
    el.detail.hidden = true
  }

  function stopAutoRotate() {
    state.autoRotate = false
    el.autorotate.classList.remove('active')
    el.autorotate.setAttribute('aria-pressed', 'false')
  }

  function pointerDist() {
    const pts = [...state.pointers.values()]
    if (pts.length < 2) return 0
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
  }

  canvas.addEventListener('pointerdown', e => {
    state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    try { canvas.setPointerCapture(e.pointerId) } catch (_) {}
    el.tooltip.hidden = true
    if (state.pointers.size === 2) {
      // Second finger down: begin a pinch, cancelling any single-finger drag.
      state.pinch = { startDist: pointerDist(), startZoom: state.targetZoom }
      state.dragging = false
      state.moved = true // a pinch must never be read as a tap
      canvas.classList.remove('dragging')
      return
    }
    if (state.pointers.size > 2) return
    state.dragging = true
    state.moved = false
    state.lastX = e.clientX
    state.lastY = e.clientY
    canvas.classList.add('dragging')
  })

  canvas.addEventListener('pointermove', e => {
    const prev = state.pointers.get(e.pointerId)
    if (prev === undefined) {
      // Mouse hover (no button): show the tooltip.
      if (!state.dragging && e.pointerType === 'mouse') {
        const star = hitTest(e.clientX, e.clientY)
        state.hover = star
        showTooltip(star, e.clientX, e.clientY)
        canvas.style.cursor = star ? 'pointer' : 'grab'
      }
      return
    }
    state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (state.pinch !== null && state.pointers.size >= 2) {
      const dist = pointerDist()
      if (state.pinch.startDist > 0 && dist > 0) {
        state.targetZoom = Math.max(0.35, Math.min(3.2, state.pinch.startZoom * (dist / state.pinch.startDist)))
        stopAutoRotate()
      }
      return
    }

    if (state.dragging) {
      const dx = e.clientX - state.lastX
      const dy = e.clientY - state.lastY
      state.lastX = e.clientX
      state.lastY = e.clientY
      if (Math.abs(dx) + Math.abs(dy) > 2) state.moved = true
      // A slightly slower rotation feels better under a finger than a mouse.
      const speed = state.isMobile ? 0.0042 : 0.005
      state.targetYaw += dx * speed
      state.targetPitch = Math.max(-1.3, Math.min(1.3, state.targetPitch + dy * speed))
      if (state.moved) stopAutoRotate()
      el.tooltip.hidden = true
    }
  })

  function endPointer(e, cancelled) {
    const wasSingle = state.pointers.size === 1
    const wasDragging = state.dragging
    state.pointers.delete(e.pointerId)
    try { canvas.releasePointerCapture(e.pointerId) } catch (_) {}

    if (state.pointers.size < 2) state.pinch = null
    if (state.pointers.size === 0) {
      state.dragging = false
      canvas.classList.remove('dragging')
    } else if (state.pointers.size === 1) {
      // One finger remains after a pinch: resume rotation from its position.
      const remaining = [...state.pointers.values()][0]
      state.dragging = true
      state.moved = true
      state.lastX = remaining.x
      state.lastY = remaining.y
    }

    // A tap opens the cluster; only for a clean single-pointer, unmoved release.
    if (!cancelled && wasSingle && wasDragging && !state.moved && e.pointerType !== 'mouse') {
      const star = hitTest(e.clientX, e.clientY)
      if (star && (star.isClusterCore || star.kind === 'anchor' || star.fragment)) {
        el.tooltip.hidden = true
        openDetail(star.cluster)
      }
    }
    // Mouse click (desktop) is handled here too, since pointerup fires for it.
    if (!cancelled && wasSingle && wasDragging && !state.moved && e.pointerType === 'mouse') {
      const star = hitTest(e.clientX, e.clientY)
      if (star && (star.isClusterCore || star.kind === 'anchor' || star.fragment)) {
        el.tooltip.hidden = true
        openDetail(star.cluster)
      }
    }
  }
  canvas.addEventListener('pointerup', e => endPointer(e, false))
  canvas.addEventListener('pointercancel', e => endPointer(e, true))
  canvas.addEventListener('pointerleave', () => { el.tooltip.hidden = true; state.hover = null })
  canvas.addEventListener('wheel', e => {
    e.preventDefault()
    state.targetZoom = Math.max(0.35, Math.min(3.2, state.targetZoom * (e.deltaY > 0 ? 0.9 : 1.1)))
  }, { passive: false })
  // Block the browser's own pinch-zoom / pull-to-refresh over the canvas.
  canvas.addEventListener('gesturestart', e => e.preventDefault())
  canvas.addEventListener('gesturechange', e => e.preventDefault())

  el.search.addEventListener('input', () => { state.query = el.search.value })
  for (const btn of el.skinButtons) {
    btn.addEventListener('click', () => setSkin(btn.dataset.skin))
  }
  el.autorotate.addEventListener('click', () => {
    state.autoRotate = !state.autoRotate
    el.autorotate.classList.toggle('active', state.autoRotate)
    el.autorotate.setAttribute('aria-pressed', String(state.autoRotate))
  })
  el.reset.addEventListener('click', () => {
    state.targetYaw = 0.6; state.targetPitch = 0.32; state.targetZoom = 1
  })
  el.detailClose.addEventListener('click', closeDetail)
  // Inside the Harness the ✕ asks the host overlay to close; opened directly
  // in a browser tab there is no host to dismiss, so hide the control there.
  const embedded = window.parent !== window
  if (!embedded) el.close.hidden = true
  el.close.addEventListener('click', () => {
    try {
      if (embedded) window.parent.postMessage({ source: 'dsh-memory-cloud', type: 'close' }, location.origin)
    } catch (_) {}
  })
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!el.detail.hidden) closeDetail()
      else if (window.parent !== window) window.parent.postMessage({ source: 'dsh-memory-cloud', type: 'close' }, location.origin)
    }
  })
  // The nebula is dark-only by design; no theme messages are exchanged.
  window.addEventListener('resize', resize)
  window.addEventListener('orientationchange', () => window.setTimeout(resize, 250))

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  resize()
  let savedSkin = 'nebula'
  try { savedSkin = window.localStorage.getItem(SKIN_KEY) || 'nebula' } catch (_) { /* private mode */ }
  setSkin(savedSkin)
  requestAnimationFrame(render)
  fetch('/memory-cloud/api/memories', { headers: { accept: 'application/json' } })
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
    .then(data => { build(data); el.loading.hidden = true })
    .catch(err => {
      el.loading.innerHTML = `<span>无法读取记忆数据：${escapeHtml(err.message)}</span>`
    })
})()
