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
    livePanel: document.getElementById('live-panel'),
    liveFeed: document.getElementById('live-feed'),
    liveWrites: document.getElementById('live-writes'),
    liveReads: document.getElementById('live-reads'),
    liveRate: document.getElementById('live-rate'),
    liveToggle: document.getElementById('live-toggle'),
    legendToggle: document.getElementById('legend-toggle'),
    legendContent: document.getElementById('legend-content'),
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

  /** Even sampling keeps both the oldest and newest entries when capped. */
  function sampleEvenly(items, cap) {
    if (items.length <= cap) return items
    if (cap <= 0) return []
    const out = []
    for (let i = 0; i < cap; i += 1) {
      const index = Math.round((i * (items.length - 1)) / Math.max(1, cap - 1))
      out.push(items[index])
    }
    return out
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
  // Phase advances with the real wall clock (continuous, no quantisation), so
  // the flow is as smooth as the display allows.
  const SIGNAL_CYCLE = 7200
  // A wider crest plus a longer wake reads as flowing liquid rather than a
  // single bright bead; the gradient is sampled finely enough that the peak
  // moves sub-stop instead of snapping from sample to sample.
  const WAKE_DECAY = 0.18
  const WAKE_CUTOFF = 0.34
  const CREST_WIDTH = 0.085
  const CRESTS = [0, 0.5]

  /**
   * Brightness at position t from a crest at p. Ahead of the crest (lag < 0)
   * the wire is PURE BLACK — the old wrap-around made every link faintly lit
   * all the time, which is why the currents never seemed to rest.
   */
  /**
   * Brightness at position t from a crest at p. Ahead of the crest (lag < 0)
   * the wire is PURE BLACK. Behind it the brightness decays as one continuous
   * curve: a gaussian leading edge that hands over to an exponential wake with
   * no step at the seam, and a soft window that fades it to zero before the
   * cutoff. Hard discontinuities here show up as a visible hard line at the end
   * of every lit band, which reads as stuttering rather than flow.
   */
  const EDGE_VALUE = Math.exp(-0.7)
  const CUT_START = WAKE_CUTOFF * 0.62
  function wakeAt(t, p) {
    const lag = p - t
    if (lag < 0) return 0
    if (lag >= WAKE_CUTOFF) return 0
    const base = lag < CREST_WIDTH
      ? Math.exp(-((lag / CREST_WIDTH) ** 2) * 0.7)
      : EDGE_VALUE * Math.exp(-(lag - CREST_WIDTH) / WAKE_DECAY)
    if (lag <= CUT_START) return base
    // Smoothstep the tail out so the band dissolves instead of being clipped.
    const u = (lag - CUT_START) / (WAKE_CUTOFF - CUT_START)
    const fade = 1 - u * u * (3 - 2 * u)
    return base * fade
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
   * Shared renderer for BOTH skins. `intensity` separates the two kinds of
   * current: static relation links are drawn at half brightness (a quiet
   * background web), while a link carrying live memory traffic is drawn at
   * full brightness so the eye can tell which flow is happening right now.
   *
   * Performance (Android WebView): stroking ~56 segments x 3-4 passes meant
   * 6000+ stroke() calls per frame and stuttered badly on mobile Canvas2D,
   * while auto-rotation (one yaw value) stayed smooth. Instead we build ONE
   * path per wire and ONE linear gradient whose stops encode the travelling
   * brightness wave, then reuse that path for three strokes. That is 3 strokes
   * per link regardless of detail, and the gradient interpolates brightness
   * continuously — genuinely silky even when the signal steps at 30 fps.
   */
  function drawSignalWave(pointAt, color, gain, phase, segments, scale, intensity = 1) {
    const a = pointAt(0), b = pointAt(1)
    if (Math.abs(b.x - a.x) + Math.abs(b.y - a.y) < 1) return

    // Sample the wave; if the whole link is dark, draw nothing at all.
    // The number of stops follows the on-screen length: a long link rendered
    // with only 16 stops made the crest jump from stop to stop (the visible
    // "stuttering"), so sample roughly one stop per ~6 px instead.
    const screenLen = Math.hypot(b.x - a.x, b.y - a.y)
    const pxPerStop = state.quality < 1 ? 12 : 6
    const K = Math.max(12, Math.min(96, Math.round(screenLen / pxPerStop)))
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
      grad.addColorStop(k / K, rgba(color, Math.min(0.9, levels[k] * 1.05) * intensity))
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
    ctx.globalAlpha = 0.22 * scale * intensity
    ctx.lineWidth = 6 * scale
    ctx.stroke()
    ctx.globalAlpha = 1
    ctx.lineWidth = 0.9
    ctx.stroke()
  }

  /**
   * Continuous wall clock in milliseconds. An earlier version floored this to
   * 30 Hz, which made the crest advance in visible steps; the phase must be a
   * float that changes every animation frame.
   */
  function signalClock() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now()
  }

  // ---------------------------------------------------------------------------
  // Level of detail
  //
  // Zoom is the drill-down control. Each band reveals strictly more memory:
  //   0  overview        clusters as gas, titles only
  //   1  cluster         titles + counts, relations readable
  //   2  fragment digest sampled fragment text, one cluster in focus
  //   3  full text       complete untruncated fragments (fetched on demand)
  // ---------------------------------------------------------------------------
  const ZOOM_MIN = 0.35
  const ZOOM_MAX = 9
  const LOD_STEPS = [1.5, 2.8, 5]
  function clampZoom(z) {
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z))
  }
  function lodFor(zoom) {
    let lod = 0
    for (const step of LOD_STEPS) if (zoom >= step) lod += 1
    return lod
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
  function buildDendrites(center, seed, weight, scale = 1) {
    const rand = rng(seed)
    const segments = []
    const tips = []
    // Dendritic complexity is the neuron skin's memory count made visible.
    // weight already comes from the FULL committed fragment count, so a
    // 560-memory session grows a much denser tree than a 3-memory one.
    const trunkCount = 2 + Math.round(weight * 9)      // 2 .. 11 trunks
    const maxDepth = weight > 0.72 ? 4 : weight > 0.5 ? 3 : 2
    const branchesAt = depth => (depth === 0 ? (weight > 0.6 ? 3 : 2) : 2)

    function grow(from, dir, length, width, depth) {
      const to = vadd(from, vscale(dir, length))
      segments.push({ a: from, b: to, width, depth })
      if (depth >= maxDepth || length < 5) {
        tips.push({ p: to, depth })
        return
      }
      const [u, v] = vperp(dir)
      const branches = branchesAt(depth)
      for (let k = 0; k < branches; k += 1) {
        // Spread children around the parent axis with a clear fork angle.
        const spread = 0.45 + rand() * 0.5
        const around = (k / branches) * Math.PI * 2 + rand() * 1.1
        const side = vadd(vscale(u, Math.cos(around)), vscale(v, Math.sin(around)))
        const childDir = vnorm(vadd(vscale(dir, Math.cos(spread)), vscale(side, Math.sin(spread))))
        grow(to, childDir, length * (0.62 + rand() * 0.13), width * 0.6, depth + 1)
      }
    }

    const baseLength = (28 + rand() * 14) * scale
    for (let i = 0; i < trunkCount; i += 1) {
      const theta = (i / trunkCount) * Math.PI * 2 + rand() * 0.6
      const phi = (rand() - 0.5) * 1.5
      const dir = vnorm([Math.cos(theta) * Math.cos(phi), Math.sin(phi), Math.sin(theta) * Math.cos(phi)])
      grow(center, dir, baseLength * (0.8 + rand() * 0.4), 2.3 * scale, 0)
    }
    return { segments, tips }
  }

  /** Visual radius multiplier from memory weight: ~0.45x .. 1.85x. */
  function clusterScale(weight) {
    return 0.45 + weight * 1.4
  }

  /**
   * Grow one irregular nebula cloud. There is deliberately NO spherical core
   * and NO orbital ring: a nebula is lumpy gas — a few off-centre condensations
   * joined by wispy filaments, with ragged edges and holes between the lobes.
   * All points are world-space so the cloud keeps its volume while rotating.
   */
  function buildCloud(center, seed, activity, weight, scale = 1) {
    const rand = rng(seed)
    const puffs = []
    const filaments = []
    // More remembered fragments -> more condensations in the cloud.
    const lobes = 2 + Math.round(weight * 4)
    // A dominant stretch axis makes the whole cloud elongated, not round.
    const axis = vnorm([(rand() - 0.5) * 2, (rand() - 0.5) * 1.2, (rand() - 0.5) * 2])
    const [u, v] = vperp(axis)
    const reach = (26 + activity * 12 + weight * 22) * scale

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
          (rand() - 0.5) * 26 * scale, (rand() - 0.5) * 20 * scale, (rand() - 0.5) * 26 * scale,
        ]
        // Bias puffs along the axis -> wispy, filamentary clumps.
        const stretch = (rand() - 0.5) * 18 * scale
        puffs.push({
          pos: vadd(p, vadd(jitter, vscale(axis, stretch))),
          r: (13 + rand() * 20) * scale,
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
    bridges: [],         // faint interstellar haze between neighbouring clouds
    // --- level of detail (zoom drives how much memory is revealed) ---
    lod: 0,              // 0 全景 · 1 星团 · 2 碎片摘要 · 3 碎片全文
    focus: null,         // cluster being drilled into
    focusDepth: 0,       // 0..1 eased blend of the focus translation
    detailCache: new Map(), // sessionId -> full fragments (lazy)
    detailPending: new Set(),
    dragging: false,
    lastX: 0,
    lastY: 0,
    moved: false,
    hover: null,
    selected: null,
    w: 0, h: 0, dpr: 1,
    time: 0,
    quality: 1,      // 1 = full crest sampling; 0.5 under sustained load
    fieldRadius: 250, // grows with session count to keep visual density constant
    // --- live memory activity ---
    live: {
      connected: false,
      writes: 0,
      reads: 0,
      pulses: [],     // expanding rings on the target cloud
      newborns: [],   // fresh stars that fade into the cloud
      times: [],      // timestamps for the events/minute readout
      lastBurst: 0,
      liveClusters: new Map(), // sessions not on disk yet -> ephemeral nebula
    },
    isMobile: false,
    // Two-finger pinch state, kept separate from the single-finger drag.
    pinch: null,      // { startDist, startZoom }
    pointers: new Map(),
  }

  const isTouchDevice = () =>
    typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
      || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)

  /**
   * Camera rig distance. Zoom is NOT applied here — `project()` multiplies by
   * zoom as pure magnification. The rig tracks the field radius so a large
   * history stays fully framed instead of collapsing into a bright centre.
   */
  function cameraDistance() {
    // 900 is the baseline for a ~250-unit field; scale with the actual field
    // radius so the on-screen density stays constant as sessions accumulate.
    const base = 900 * (state.fieldRadius / 250)
    if (!state.isMobile) return base
    // On a narrow screen push back further so the wider field still fits.
    const usable = Math.max(240, state.w - 24)
    const fit = Math.max(1.6, Math.min(3.4, 1650 / usable))
    return base * fit
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
    // `session.fragments` is only the SAMPLED digest (max maxFragments), so it
    // cannot describe how big a memory really is. Use the committed totals.
    const fullCount = s => Math.max(1, s.counts?.fragments || (s.fragments || []).length || 1)
    const maxMemories = Math.max(1, ...sessions.map(fullCount))
    const maxEvents = Math.max(1, ...sessions.map(s => s.counts?.events || 0))
    // A log-scale weight keeps one huge session from dwarfing everything else
    // while still making a 560-memory cloud clearly larger than a 3-memory one.
    // ratio is 0..1 across the population; keep the floor low so small
    // memories really are small (the earlier 0.35 floor flattened the range).
    const memoryWeight = s => {
      const raw = fullCount(s)
      const ratio = Math.log(raw) / Math.log(maxMemories)
      return Math.max(0.06, Math.min(1, 0.10 + 0.90 * ratio))
    }
    // The field must grow with the population. A fixed radius made 141
    // sessions occupy the same volume as 15, so every label and star piled
    // into the centre. Area grows linearly with N (radius ~ sqrt(N)), which
    // keeps the number of clusters per unit area — the visual density — flat.
    const N = Math.max(1, sessions.length)
    const fieldRadius = 250 * Math.sqrt(N / 15)
    state.fieldRadius = fieldRadius

    // Global star budget. Each cluster contributes a capped number of visible
    // stars, so a big history never becomes an undifferentiated glitter blob.
    const STAR_BUDGET = 900
    const perClusterStars = Math.max(3, Math.floor(STAR_BUDGET / N))

    // Spread cluster centers on a fibonacci sphere so the nebula reads as a
    // galaxy, with radius scaled gently by activity (busier Sessions drift out).
    const R = fieldRadius * (state.isMobile ? 0.82 : 1)
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
      const weight = memoryWeight(session)
      const scale = clusterScale(weight)
      const color = colorOf.get(session.workspace) || PALETTE[i % PALETTE.length]
      const cloud = buildCloud(center, hash(session.id) ^ 0x7e31, activity, weight, scale)
      const cluster = {
        session, color, center, cloud, stars: [], weight, scale,
        dendrites: buildDendrites(center, hash(session.id) ^ 0x2c91, weight, scale),
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
      // Sample evenly into the per-cluster budget so the whole field keeps a
      // consistent star density regardless of how much history exists.
      const shownFragments = sampleEvenly(fragments, perClusterStars)
      shownFragments.forEach(fragment => {
        const lobe = cloud.lobeCenters[Math.floor(rand() * cloud.lobeCenters.length)] || center
        const spread = (8 + rand() * 20) * cluster.scale
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
      // Bright young stars scale with how much this session actually holds,
      // but never exceed the budget for tiny populations.
      const brightCount = Math.min(perClusterStars, 1 + Math.round(weight * 3))
      for (let s = 0; s < brightCount; s += 1) {
        const lobe = cloud.lobeCenters[Math.floor(rand() * cloud.lobeCenters.length)] || center
        state.stars.push({
          kind: 'bright', cluster, fragment: null, isClusterCore: false,
          pos: [lobe[0] + (rand() - 0.5) * 16, lobe[1] + (rand() - 0.5) * 12, lobe[2] + (rand() - 0.5) * 16],
          size: 1.6 + rand() * 1.1, phase: rand() * Math.PI * 2, color,
        })
      }
      // Fine dust speckles threaded through the gas, offset along filaments.
      const dustPerFilament = Math.max(0, Math.min(3, Math.floor(perClusterStars / 3)))
      cloud.filaments.forEach(([a, b, c]) => {
        for (let d = 0; d < dustPerFilament; d += 1) {
          const t = (d + rand()) / dustPerFilament
          const u2 = 1 - t
          const p = [
            u2 * u2 * a[0] + 2 * u2 * t * b[0] + t * t * c[0] + (rand() - 0.5) * 12 * cluster.scale,
            u2 * u2 * a[1] + 2 * u2 * t * b[1] + t * t * c[1] + (rand() - 0.5) * 9 * cluster.scale,
            u2 * u2 * a[2] + 2 * u2 * t * b[2] + t * t * c[2] + (rand() - 0.5) * 12 * cluster.scale,
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
    state.bridges = buildBridges()

    state.stats = data.stats
    buildLegend()
    buildStats(data.stats)
    el.subtitle.textContent = state.isMobile
      ? `${data.stats.sessions} 个会话 · ${data.stats.fragments} 颗记忆星 · 单指旋转 / 双指缩放`
      : `${data.stats.sessions} 个会话记忆 · ${data.stats.fragments} 颗记忆星 · 拖拽以探索`
    if (state.isMobile) el.search.placeholder = '搜索记忆'
    updateHint()
    connectLive()
  }

  // -------------------------------------------------------------------------
  // Live memory activity
  //
  // `session/event` is the post-commit append feed, so each SSE item is a
  // memory that was JUST written (or a memory being read back as context).
  // A brand-new session has no cluster on disk yet, so we grow a small
  // ephemeral cloud for it and retire it once the log appears on the next
  // snapshot. This makes an active conversation visibly bloom.
  // -------------------------------------------------------------------------

  function escapeLive(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  }

  function connectLive() {
    if (typeof EventSource === 'undefined') return
    let source
    try { source = new EventSource('/memory-cloud/api/live') } catch { return }
    source.onopen = () => {
      state.live.connected = true
      el.livePanel.dataset.connected = 'true'
    }
    source.onerror = () => {
      state.live.connected = false
      el.livePanel.dataset.connected = 'false'
    }
    source.onmessage = event => {
      let item
      try { item = JSON.parse(event.data) } catch { return }
      if (!item || !item.sessionId) return
      onLiveItem(item)
    }
  }

  function clusterForLive(item) {
    let cluster = state.clusters.find(c => c.session.id === item.sessionId)
    if (cluster) return cluster
    // Not yet on disk: create a temporary nebula at a free spot.
    let ephemeral = state.live.liveClusters.get(item.sessionId)
    if (!ephemeral) {
      const idx = state.live.liveClusters.size
      const rand = rng(hash(item.sessionId) ^ 0x51ab)
      const angle = idx * 2.399 + rand()
      const radius = 150 + rand() * 90
      const center = [Math.cos(angle) * radius, (rand() - 0.5) * 170, Math.sin(angle) * radius]
      const cloud = buildCloud(center, hash(item.sessionId) ^ 0x77, 0.8, 0.25)
      ephemeral = {
        session: {
          id: item.sessionId,
          title: item.sessionTitle || '正在进行的对话',
          counts: { events: 0, user: 0, assistant: 0, tools: 0, turns: 0, fragments: 0 },
          fragments: [], topics: [],
        },
        color: PALETTE[(idx + 3) % PALETTE.length],
        center, cloud, stars: [], ephemeral: true,
        dendrites: buildDendrites(center, hash(item.sessionId) ^ 0x2c91, 0.35),
        core: null, weight: 0.25, scale: 0.85,
        lobeCenters: cloud.lobeCenters,
      }
      // Reuse the normal hit-test core so tapping the new cloud works.
      const core = {
        kind: 'core', cluster: ephemeral, isClusterCore: true, fragment: null,
        pos: center.slice(), size: 2.2, phase: 0, color: ephemeral.color,
      }
      ephemeral.core = core
      state.stars.push(core)
      state.live.liveClusters.set(item.sessionId, ephemeral)
      state.clusters.push(ephemeral)

      // Give the newborn cloud a temporary link to its nearest durable
      // neighbour: the live memory flow needs a wire to travel along. It is
      // removed together with the ephemeral cluster on the next snapshot.
      let nearest = null, bestD = Infinity
      for (const c of state.clusters) {
        if (c === ephemeral || c.ephemeral) continue
        const d = Math.hypot(
          c.center[0] - center[0], c.center[1] - center[1], c.center[2] - center[2],
        )
        if (d < bestD) { bestD = d; nearest = c }
      }
      if (nearest) {
        state.relations.push({
          source: item.sessionId, target: nearest.session.id,
          weight: 0.85, kind: 'live', kinds: ['live'], shared: [],
          a: ephemeral, b: nearest,
        })
      }
    }
    if (item.sessionTitle && ephemeral.session.title === '正在进行的对话') {
      ephemeral.session.title = item.sessionTitle
    }
    return ephemeral
  }

  function onLiveItem(item) {
    const now = performance.now()
    const cluster = clusterForLive(item)
    cluster.lastLiveAt = now
    const isWrite = item.kind === 'write'
    if (isWrite) state.live.writes += 1
    else state.live.reads += 1
    state.live.times.push(now)
    if (state.live.times.length > 120) state.live.times.shift()

    // Expanding ring on the target cloud: write rings ripple outward, read
    // rings ripple inward (memory being consulted / pulled back).
    state.live.pulses.push({
      cluster, born: now, kind: isWrite ? 'write' : 'read',
      color: isWrite ? [150, 215, 255] : [235, 195, 130],
    })
    if (state.live.pulses.length > 26) state.live.pulses.shift()

    if (isWrite) {
      const lobe = cluster.cloud.lobeCenters[
        Math.floor(Math.random() * cluster.cloud.lobeCenters.length)] || cluster.center
      state.live.newborns.push({
        cluster, born: now,
        pos: [lobe[0] + (Math.random() - 0.5) * 16, lobe[1] + (Math.random() - 0.5) * 12, lobe[2] + (Math.random() - 0.5) * 16],
        color: cluster.color,
        phase: Math.random() * Math.PI * 2,
      })
      if (state.live.newborns.length > 60) state.live.newborns.shift()
      cluster.session.counts.fragments += 1
    }

    state.live.lastBurst = now
    el.livePanel.dataset.active = 'true'
    el.liveWrites.textContent = String(state.live.writes)
    el.liveReads.textContent = String(state.live.reads)
    appendLiveRow(item, cluster)
    updateLiveRate(now)
  }

  function appendLiveRow(item, cluster) {
    if (el.liveFeed.querySelector('.live-empty')) el.liveFeed.innerHTML = ''
    const row = document.createElement('div')
    row.className = `live-row ${item.kind}`
    const label = item.kind === 'write' ? '写入' : '读取'
    const body = item.text || item.tool || item.type || ''
    const title = cluster.session.title || '会话'
    row.innerHTML = `<span class="live-tag">${label}</span><span class="live-text" title="${escapeLive(body)}"><b>${escapeLive(title.slice(0, 14))}</b> ${escapeLive(body.slice(0, 60))}</span>`
    el.liveFeed.prepend(row)
    while (el.liveFeed.children.length > 14) el.liveFeed.lastChild.remove()
  }

  function updateLiveRate(now) {
    const recent = state.live.times.filter(t => now - t < 60000)
    el.liveRate.textContent = String(recent.length)
  }

  /** Draw the live rings and newborn stars on top of the scene. */
  function drawLiveEffects() {
    const now = performance.now()
    const L = state.live
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'

    // A soft, lingering aura on any cloud touched in the last few seconds:
    // the ring is brief, but the cluster itself keeps a "hot" edge so an
    // active conversation is visible even between events.
    for (const cluster of state.clusters) {
      const last = cluster.lastLiveAt || 0
      const heat = Math.max(0, 1 - (now - last) / 3200)
      if (heat <= 0) continue
      const pr = project(cluster.center)
      const sprite = softSprite(cluster.color)
      const d = 130 * pr.scale * (0.8 + heat * 0.5)
      ctx.globalAlpha = heat * 0.16
      ctx.drawImage(sprite, pr.x - d / 2, pr.y - d / 2, d, d)
    }
    ctx.globalAlpha = 1

    for (let i = L.pulses.length - 1; i >= 0; i -= 1) {
      const p = L.pulses[i]
      const age = (now - p.born) / 1400
      if (age >= 1) { L.pulses.splice(i, 1); continue }
      const pr = project(p.cluster.center)
      const baseR = 8 * pr.scale
      const grow = p.kind === 'write' ? age : 1 - age
      const r = Math.max(2, baseR + grow * 40 * pr.scale)
      ctx.beginPath()
      ctx.arc(pr.x, pr.y, r, 0, Math.PI * 2)
      ctx.strokeStyle = rgba(p.color, (1 - age) * 0.5)
      ctx.lineWidth = 1.2
      ctx.stroke()
    }
    for (let i = L.newborns.length - 1; i >= 0; i -= 1) {
      const s = L.newborns[i]
      const age = (now - s.born) / 6000
      if (age >= 1) { L.newborns.splice(i, 1); continue }
      const pr = project(s.pos)
      const twinkle = 0.75 + Math.sin(now * 0.004 + s.phase) * 0.25
      const r = Math.max(0.8, (1.4 + (1 - age) * 1.6) * pr.scale * twinkle)
      const sprite = softSprite([255, 255, 255])
      const d = r * 7
      ctx.globalAlpha = (1 - age) * 0.85
      ctx.drawImage(sprite, pr.x - d / 2, pr.y - d / 2, d, d)
      ctx.globalAlpha = 1
      ctx.beginPath()
      ctx.arc(pr.x, pr.y, r, 0, Math.PI * 2)
      ctx.fillStyle = '#ffffff'
      ctx.fill()
    }
    ctx.restore()
    // Idle the activity dot shortly after the last event.
    if (now - L.lastBurst > 1200) el.livePanel.dataset.active = 'false'
  }

  /** Fold an on-disk snapshot back in: drop ephemeral clouds now on disk. */
  function refreshFromSnapshot() {
    fetch('/memory-cloud/api/memories', { headers: { accept: 'application/json' } })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(data => {
        const ids = new Set((data.sessions || []).map(s => s.id))
        for (const [id, cluster] of state.live.liveClusters) {
          if (!ids.has(id)) continue
          state.live.liveClusters.delete(id)
          const ci = state.clusters.indexOf(cluster)
          if (ci >= 0) state.clusters.splice(ci, 1)
          // Remove its core from the flat hit-test list.
          const si = state.stars.indexOf(cluster.core)
          if (si >= 0) state.stars.splice(si, 1)
          // Drop the temporary live-only link that pointed at this cloud.
          state.relations = state.relations.filter(r => r.a !== cluster && r.b !== cluster)
        }
        if (state.stats) {
          state.stats.sessions = data.stats.sessions
          state.stats.fragments = data.stats.fragments
          buildStats(state.stats)
          el.subtitle.textContent = state.isMobile
            ? `${data.stats.sessions} 个会话 · ${data.stats.fragments} 颗记忆星 · 单指旋转 / 双指缩放`
            : `${data.stats.sessions} 个会话记忆 · ${data.stats.fragments} 颗记忆星 · 拖拽以探索`
        }
      })
      .catch(() => { /* transient; next tick retries */ })
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
      ? (neuron ? '双指放大可看到更多记忆 · 轻点神经元展开' : '双指放大可看到更多记忆 · 轻点星团展开')
      : (neuron ? '滚轮放大逐层展开记忆 · 双击神经元钻入全文' : '滚轮放大逐层展开记忆 · 双击星团钻入全文')
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
      `<div class="rk-row rk-flow"><span class="rk-line flow"></span>实时记忆流（亮）</div>` +
      `<div class="rk-row rk-flow"><span class="rk-line dim"></span>关系流（半亮）</div>` +
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
    if (cluster.session.workspaceLabel && cluster.session.workspaceLabel.toLowerCase().includes(q)) return true
    return (cluster.session.fragments || []).some(f => f.text.toLowerCase().includes(q))
  }

  // -------------------------------------------------------------------------
  // 3D projection
  // -------------------------------------------------------------------------
  function project(p) {
    const cy = Math.cos(state.yaw), sy = Math.sin(state.yaw)
    const cp = Math.cos(state.pitch), sp = Math.sin(state.pitch)
    // Drilling in translates the focused cluster toward the origin, so zooming
    // actually flies INTO that nebula instead of just scaling a fixed rig.
    const fd = state.focusDepth
    const ox = state.focus && fd > 0 ? state.focus.center[0] * fd : 0
    const oy = state.focus && fd > 0 ? state.focus.center[1] * fd : 0
    const oz = state.focus && fd > 0 ? state.focus.center[2] * fd : 0
    const dx = p[0] - ox, dy0 = p[1] - oy, dz = p[2] - oz
    // rotate around Y (yaw)
    let x = dx * cy - dz * sy
    let z = dx * sy + dz * cy
    // rotate around X (pitch)
    let y = dy0 * cp - z * sp
    z = dy0 * sp + z * cp
    const camera = cameraDistance()
    const denom = camera + z
    // Perspective falloff times the zoom multiplier: zoom is pure magnification,
    // so it can climb far enough to read individual memories.
    const scale = (camera / Math.max(120, denom)) * state.zoom
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

  /**
   * Screen-space arc between two projected points.
   *
   * The offset from the chord must be a SMOOTH function of t. The earlier
   * version added an independent random kick per segment, which produced a
   * saw-tooth polyline; a brightness band spanning a couple of those segments
   * changed direction abruptly as it advanced, so the light looked like pixels
   * hopping along the wire instead of fluid travelling through it. Two gentle
   * harmonics (one bow plus one slow S-curve) keep every point at parameter t
   * projecting onto the chord at exactly t, so the travelling gradient stays
   * aligned with the drawn line.
   */
  /**
   * Screen-space path between two clusters, shaped like a neural axon / air
   * discharge rather than a smooth bow. The offset from the chord is a sum of
   * a few low-amplitude harmonics: gentle enough that the gradient stays
   * aligned with the drawn line (every point at parameter t still projects
   * onto the chord at t), but irregular enough to read as an organic spark.
   * Short side branches are returned separately as decorative offshoots.
   */
  function arcPoints(pa, pb, seed, segments) {
    const dx = pb.x - pa.x, dy = pb.y - pa.y
    const len = Math.hypot(dx, dy) || 1
    const nx = -dy / len, ny = dx / len
    const rand = rng(seed)
    const sign = rand() < 0.5 ? -1 : 1
    const bowAmp = Math.min(20, len * 0.075) * sign
    // Two incommensurate harmonics produce a wandering, lightning-like trace.
    const k1 = 1.7 + rand() * 1.1
    const k2 = 4.3 + rand() * 2.4
    const a1 = Math.min(14, len * 0.045)
    const a2 = Math.min(7, len * 0.022)
    const p1 = rand() * Math.PI * 2
    const p2 = rand() * Math.PI * 2
    const pts = [{ x: pa.x, y: pa.y }]
    for (let i = 1; i < segments; i += 1) {
      const t = i / segments
      const env = Math.sin(t * Math.PI) // pin both ends to the clusters
      const off = env * (
        bowAmp +
        a1 * Math.sin(t * Math.PI * 2 * k1 + p1) +
        a2 * Math.sin(t * Math.PI * 2 * k2 + p2)
      )
      pts.push({ x: pa.x + dx * t + nx * off, y: pa.y + dy * t + ny * off })
    }
    pts.push({ x: pb.x, y: pb.y })
    return pts
  }

  /** Short side branches off a path, for a neural/branching-discharge look. */
  function arcBranches(pts, seed) {
    const rand = rng(seed ^ 0x3c17)
    const out = []
    const count = 2 + Math.floor(rand() * 3)
    for (let b = 0; b < count; b += 1) {
      const i = 6 + Math.floor(rand() * Math.max(1, pts.length - 12))
      const p = pts[i] || pts[0]
      const prev = pts[i - 1] || p
      const next = pts[i + 1] || p
      const tx = next.x - prev.x, ty = next.y - prev.y
      const tl = Math.hypot(tx, ty) || 1
      const perpX = -ty / tl, perpY = tx / tl
      const side = rand() < 0.5 ? -1 : 1
      const reach = 6 + rand() * 16
      const mid = { x: p.x + perpX * reach * side * 0.55, y: p.y + perpY * reach * side * 0.55 }
      const tip = {
        x: p.x + perpX * reach * side + tx / tl * reach * 0.4,
        y: p.y + perpY * reach * side + ty / tl * reach * 0.4,
      }
      out.push([p, mid, tip])
    }
    return out
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

  // Static relation web: half brightness. These are the enduring structural
  // links between memory clusters, not something happening right now.
  const RELATION_INTENSITY = 0.5
  // A link touching a cluster with recent live activity carries the real-time
  // memory flow, drawn at full brightness over the dim relation web.
  const LIVE_INTENSITY = 1
  const LIVE_WINDOW = 2600
  // Relation traffic is deliberately SLOW: it is ambient background structure,
  // not an event. Live traffic keeps the original pace so an actual memory
  // write/read still reads as "now".
  const RELATION_CYCLE_FACTOR = 3.4
  const LIVE_CYCLE_FACTOR = 0.45

  /** Phase for one link. Slower for the ambient relation web. */
  function linkPhase(seed, factor) {
    return ((state.time / (SIGNAL_CYCLE * factor)) + (seed % 1000) / 1000) % 1
  }

  function drawRelationArcs() {
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    const now = performance.now()
    state.relations.forEach(r => {
      if (!r.a || !r.b) return
      const active = matches(r.a) && matches(r.b)
      const pa = project(r.a.center), pb = project(r.b.center)
      const color = r.kind === 'fork' ? [255, 213, 145]
        : r.kind === 'workspace' ? [125, 224, 192] : [140, 180, 255]
      const seed = hash(r.source + r.target)
      // 56 samples: the arc reads as a continuous curve rather than a chain of
      // visible segments once a lit band crosses it.
      const segments = 56
      const pts = arcPoints(pa, pb, seed, segments)

      // On a phone, 29 arcs in a narrow viewport easily drown the gas, so keep
      // only the stronger links clearly visible there.
      const strength = state.isMobile ? Math.max(0, (r.weight - 0.3) * 1.4) : 1
      const gain = (0.35 + r.weight * 0.65) * strength
      if (gain < 0.05) return

      // Between currents the wire is black — no permanent channel glow.
      if (!active) return

      // Slow ambient flow along the relation.
      drawSignalWave(t => polylinePoint(pts, t), color, gain,
        linkPhase(seed, RELATION_CYCLE_FACTOR), segments, 1, RELATION_INTENSITY)

      // Short side branches make the link read as a neural axon / discharge.
      // They are decorative: drawn faintly so they never compete with the flow.
      if (!state.isMobile) {
        const branches = arcBranches(pts, seed)
        const branchAlpha = 0.16 * gain * RELATION_INTENSITY
        for (const br of branches) {
          ctx.beginPath()
          ctx.moveTo(br[0].x, br[0].y)
          ctx.quadraticCurveTo(br[1].x, br[1].y, br[2].x, br[2].y)
          ctx.strokeStyle = rgba(color, branchAlpha)
          ctx.lineWidth = 0.7
          ctx.lineCap = 'round'
          ctx.stroke()
        }
      }

      // Live overlay: if either endpoint was touched by a real memory event
      // just now, re-draw the SAME curve at full brightness with the original
      // fast phase so realtime flow is visibly quicker than the ambient web.
      const heat = Math.max(
        1 - (now - (r.a.lastLiveAt || 0)) / LIVE_WINDOW,
        1 - (now - (r.b.lastLiveAt || 0)) / LIVE_WINDOW,
      )
      if (heat > 0) {
        drawSignalWave(t => polylinePoint(pts, t), color, gain,
          linkPhase(seed, LIVE_CYCLE_FACTOR), segments, 1, LIVE_INTENSITY * heat)
      }
    })
    ctx.restore()
  }

  /**
   * Interstellar medium between clusters.
   *
   * Without this, each nebula reads as an isolated floating island. We lay a
   * few very large, very faint gas blobs along each relation (and between
   * spatially close clouds), so neighbouring clusters dissolve into one
   * another and the whole field shares one continuous haze. Draw these FIRST,
   * underneath everything, at a fraction of the cloud alpha.
   */
  function buildBridges() {
    const bridges = []
    const seen = new Set()
    const consider = (a, b, strength) => {
      const key = a.session.id < b.session.id
        ? `${a.session.id}|${b.session.id}` : `${b.session.id}|${a.session.id}`
      if (seen.has(key)) return
      seen.add(key)
      const dist = Math.hypot(
        a.center[0] - b.center[0], a.center[1] - b.center[1], a.center[2] - b.center[2],
      )
      const rand = rng(hash(key))
      const n = 3 + Math.round(strength * 3)
      for (let k = 0; k < n; k += 1) {
        const t = 0.2 + (k / Math.max(1, n - 1)) * 0.6
        const base = [
          a.center[0] + (b.center[0] - a.center[0]) * t,
          a.center[1] + (b.center[1] - a.center[1]) * t,
          a.center[2] + (b.center[2] - a.center[2]) * t,
        ]
        const drift = (rand() - 0.5) * dist * 0.18 * strength
        bridges.push({
          pos: [base[0] + drift, base[1] + (rand() - 0.5) * 26, base[2] - drift],
          size: (60 + rand() * 70) * (0.6 + strength * 0.6),
          color: k % 2 === 0 ? a.color : b.color,
          alpha: 0.014 + rand() * 0.018,
        })
      }
    }
    for (const r of state.relations) if (r.a && r.b) consider(r.a, r.b, Math.max(0.3, r.weight))
    // Spatially close clusters get a wisp even without a computed relation.
    for (let i = 0; i < state.clusters.length; i += 1) {
      for (let j = i + 1; j < state.clusters.length; j += 1) {
        const a = state.clusters[i], b = state.clusters[j]
        const d = Math.hypot(a.center[0]-b.center[0], a.center[1]-b.center[1], a.center[2]-b.center[2])
        if (d < 190) consider(a, b, 0.35)
      }
    }
    return bridges
  }

  function drawBridges(bridges) {
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    const fog = Math.max(0.3, Math.min(1, 30 / Math.max(30, state.clusters.length)))
    for (const b of bridges) {
      const p = project(b.pos)
      const d = b.size * p.scale
      ctx.globalAlpha = b.alpha * fog
      ctx.drawImage(softSprite(b.color), p.x - d / 2, p.y - d / 2, d, d)
    }
    ctx.globalAlpha = 1
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
      // Its size follows the session's real memory volume.
      const sizeScale = cluster.scale || 1
      // With many clusters the gases overlap; scale opacity down so the field
      // stays a nebula instead of an opaque patchwork quilt.
      const fog = Math.max(0.42, Math.min(1, 24 / Math.max(24, state.clusters.length)))
      ctx.save()
      ctx.globalAlpha = 0.34 * alpha * fog
      const bodySprite = softSprite(cluster.color)
      const bw = 150 * c0.scale * sizeScale, bh = 78 * c0.scale * sizeScale
      ctx.translate(c0.x, c0.y)
      const ax = project(vadd(cluster.center, vscale(cloud.axis, 40 * sizeScale)))
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
        ctx.globalAlpha = (0.075 + puff.alpha * 1.1) * alpha * fog
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
    const now = performance.now()

    // Axons use the exact same signal wave as the nebula skin: the ambient
    // relation flow is slow, the realtime overlay on active clusters keeps the
    // original fast pace.
    for (const r of state.relations) {
      if (!r.a || !r.b) continue
      const active = matches(r.a) && matches(r.b)
      if (!active) continue
      const g = linkGeometry(r)
      const color = r.kind === 'fork' ? [255, 213, 145] : [110, 170, 255]
      const seed = hash(r.source + r.target)
      const gain = (0.35 + r.weight * 0.65) * (state.isMobile ? Math.max(0, (r.weight - 0.3) * 1.4) : 1)
      if (gain < 0.05) continue
      drawSignalWave(t => quadPoint(g, t), color, gain,
        linkPhase(seed, RELATION_CYCLE_FACTOR), 48, 0.85, RELATION_INTENSITY)

      // Axon collaterals: short side twigs, same idea as the nebula branches.
      if (!state.isMobile) {
        const pt = quadPoint(g, 0.5)
        const rand = rng(seed ^ 0x51)
        for (let b = 0; b < 2; b += 1) {
          const ang = rand() * Math.PI * 2
          const reach = 8 + rand() * 14
          ctx.beginPath()
          ctx.moveTo(pt.x, pt.y)
          ctx.quadraticCurveTo(
            pt.x + Math.cos(ang) * reach * 0.6, pt.y + Math.sin(ang) * reach * 0.6,
            pt.x + Math.cos(ang + 0.5) * reach, pt.y + Math.sin(ang + 0.5) * reach,
          )
          ctx.strokeStyle = rgba(color, 0.14 * gain * RELATION_INTENSITY)
          ctx.lineWidth = 0.7
          ctx.lineCap = 'round'
          ctx.stroke()
        }
      }

      const heat = Math.max(
        1 - (now - (r.a.lastLiveAt || 0)) / LIVE_WINDOW,
        1 - (now - (r.b.lastLiveAt || 0)) / LIVE_WINDOW,
      )
      if (heat > 0) {
        drawSignalWave(t => quadPoint(g, t), color, gain,
          linkPhase(seed, LIVE_CYCLE_FACTOR), 48, 0.85, LIVE_INTENSITY * heat)
      }
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
      ctx.strokeStyle = rgba(g.color, 0.26 * Math.pow(0.82, g.depth))
      ctx.lineWidth = Math.max(0.35, (2.3 * Math.pow(0.68, g.depth)) * scale * 0.5)
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
      const R = (7 + Math.min(6, Math.log10(1 + cluster.session.counts.events) * 3)) * p.scale * pulse * (cluster.scale || 1)
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

  // -------------------------------------------------------------------------
  // Level-of-detail helpers
  // -------------------------------------------------------------------------

  /** The cluster nearest the viewport centre — the one a deep zoom is about. */
  function clusterAtCenter() {
    let best = null, bestD = Infinity
    for (const cluster of state.clusters) {
      if (!matches(cluster)) continue
      const pr = project(cluster.center)
      const d = Math.hypot(pr.x - state.w / 2, pr.y - state.h / 2)
      if (d < bestD) { bestD = d; best = cluster }
    }
    return best
  }

  /** Full, untruncated fragments for one cluster (lazy, cached). */
  function requestDetail(cluster) {
    const id = cluster.session.id
    if (state.detailCache.has(id) || state.detailPending.has(id)) return
    state.detailPending.add(id)
    fetch(`/memory-cloud/api/session/${encodeURIComponent(id)}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(detail => {
        const bySeq = new Map((detail.fragments || []).map(f => [f.seq, f]))
        state.detailCache.set(id, bySeq)
        cluster.hasFullDetail = true
      })
      .catch(() => { /* keep the sampled digest on failure */ })
      .finally(() => state.detailPending.delete(id))
  }

  /** Text for one fragment at the current detail level. */
  function fragmentText(fragment, cluster, lod) {
    const full = state.detailCache.get(cluster.session.id)
    const source = (lod >= 3 && full && full.get(fragment.seq)) || fragment
    const text = source.text || ''
    const cap = lod >= 3 ? 320 : 90
    return text.length > cap ? `${text.slice(0, cap).trimEnd()}…` : text
  }

  /** Fragment captions over their own stars — the actual remembered words. */
  function drawFragmentCaptions(lod) {
    const cluster = state.focus
    if (!cluster || state.focusDepth < 0.35) return
    ctx.save()
    ctx.textBaseline = 'top'
    const fontSize = lod >= 3 ? 11.5 : 10.5
    ctx.font = `${fontSize}px Inter, "PingFang SC", system-ui, sans-serif`
    const maxW = Math.min(state.isMobile ? 150 : 230, state.w * 0.42)
    const limit = state.isMobile ? 8 : 14

    // Collect candidates first, then place them greedily with collision
    // rejection: overlapping captions were an unreadable pile of text.
    const candidates = []
    for (const star of cluster.stars) {
      if (star.kind !== 'star' || !star.fragment) continue
      const pr = project(star.pos)
      if (pr.x < -60 || pr.x > state.w + 60 || pr.y < -30 || pr.y > state.h + 30) continue
      if (pr.scale < 0.5) continue
      const text = fragmentText(star.fragment, cluster, lod)
      if (text === '') continue
      candidates.push({ pr, text, isUser: star.fragment.kind === 'user' })
    }
    // Prefer the most central/most readable ones, then place top-to-bottom.
    candidates.sort((a, b) => a.pr.y - b.pr.y)
    const placed = []
    let drawn = 0
    for (const cand of candidates) {
      if (drawn >= limit) break
      const lines = wrapText(cand.text, maxW, ctx)
      const lineH = fontSize + 2.5
      const w = Math.max(...lines.map(l => ctx.measureText(l).width))
      const x = cand.pr.x + 7
      const y = cand.pr.y + 6
      const rect = { x: x - 2, y: y - 1, w: w + 4, h: lines.length * lineH + 2 }
      if (rect.x < 4 || rect.x + rect.w > state.w - 4) continue
      if (rect.y < 4 || rect.y + rect.h > state.h - 4) continue
      if (placed.some(r => overlaps(r, rect))) continue
      placed.push(rect)
      drawn += 1

      for (let i = 0; i < lines.length; i += 1) {
        const ly = y + i * lineH
        ctx.globalAlpha = 0.94
        ctx.lineWidth = 3
        ctx.strokeStyle = 'rgba(6,9,22,0.96)'
        ctx.strokeText(lines[i], x, ly)
        ctx.fillStyle = cand.isUser ? '#bfe6ff' : '#dcd0ff'
        ctx.fillText(lines[i], x, ly)
      }
      // A hairline tying the caption to its star.
      ctx.globalAlpha = 0.3
      ctx.beginPath()
      ctx.moveTo(cand.pr.x, cand.pr.y)
      ctx.lineTo(x - 2, y + 3)
      ctx.strokeStyle = cand.isUser ? 'rgba(150,210,255,0.8)' : 'rgba(200,170,255,0.8)'
      ctx.lineWidth = 0.7
      ctx.stroke()
    }
    ctx.restore()
  }

  function overlaps(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  }

  /** Greedy wrap by measured width, capped at 3 lines. */
  function wrapText(text, maxW, context) {
    const lines = []
    let line = ''
    for (const ch of text) {
      const next = line + ch
      if (context.measureText(next).width > maxW && line !== '') {
        lines.push(line)
        line = ch
        if (lines.length >= 3) { lines[2] = `${lines[2].slice(0, -1)}…`; return lines }
      } else {
        line = next
      }
    }
    if (line !== '') lines.push(line)
    return lines
  }

  const LOD_LABELS = ['全景', '星团', '记忆摘要', '记忆全文']
  function updateLodBadge() {
    const badge = document.getElementById('lod-badge')
    if (!badge) return
    badge.textContent = LOD_LABELS[state.lod] || LOD_LABELS[0]
    badge.dataset.lod = String(state.lod)
    const title = state.focus ? state.focus.session.title : ''
    badge.title = title ? `${LOD_LABELS[state.lod]} · ${title}` : LOD_LABELS[state.lod]
  }

  let lastFrame = 0
  const frameGaps = []
  function render() {
    // Render at the display's own rate: a fixed 30 fps gate made the flowing
    // current visibly step on a 60/120 Hz screen.
    const now = signalClock()
    const dtMs = lastFrame === 0 ? 16 : Math.min(64, now - lastFrame)
    lastFrame = now
    state.time = now
    const dt = dtMs / 1000
    // Frame-rate independent easing: same perceived response at 60 or 120 Hz.
    const ease = 1 - Math.exp(-dt * 7.5)
    if (state.autoRotate && !state.dragging) state.targetYaw += 0.096 * dt
    state.yaw += (state.targetYaw - state.yaw) * ease
    state.pitch += (state.targetPitch - state.pitch) * ease
    state.zoom += (state.targetZoom - state.zoom) * ease

    // Level of detail is a pure function of the eased zoom, so the bands feel
    // continuous rather than snapping at the moment you stop scrolling.
    // Level of detail follows the user's INTENDED zoom, not the eased value:
    // easing approaches its target asymptotically, so testing state.zoom made
    // the band boundary unreachable in practice (2.759 vs a 2.8 threshold).
    const lod = lodFor(state.targetZoom)
    if (lod !== state.lod) { state.lod = lod; updateLodBadge() }

    // From band 2 on, one cluster becomes the subject of the close-up.
    if (lod >= 2) {
      if (state.focus === null) state.focus = clusterAtCenter()
    } else {
      state.focus = null
    }
    const wantFocus = lod >= 2 && state.focus !== null ? 1 : 0
    state.focusDepth += (wantFocus - state.focusDepth) * 0.12
    if (state.focus && lod >= 3) requestDetail(state.focus)

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
      drawBridges(state.bridges)
      drawNebulaClouds()
      drawRelationArcs()
      drawNebulaStars(projected)
    }
    drawLiveEffects()

    // Captions only make sense once a cluster fills the view.
    if (lod >= 2) drawFragmentCaptions(lod)

    // Cluster labels. Higher bands show more: title, then counts, then the
    // dominant topics, so zooming literally reveals more of the memory.
    //
    // With a large history, drawing every title turns the centre into an
    // unreadable pile. Labels are therefore: (1) capped by a screen-area
    // budget, (2) prioritised by memory size and depth, (3) placed with
    // rectangle collision rejection, and (4) reduced to the title only once
    // the population is large — the detail rows come back when you zoom in.
    if (state.zoom > 0.75) {
      ctx.save()
      const baseSize = state.isMobile ? 10 : 11
      ctx.textBaseline = 'middle'
      const N = state.clusters.length
      const crowded = N > 30
      // ~1 label per 9000 px² of viewport, clamped to a sane range.
      const areaBudget = Math.max(6, Math.min(26, Math.round((state.w * state.h) / 9000)))
      const maxLabels = lod >= 2 ? 1 : areaBudget
      // Panel / toolbar margins that labels must stay clear of.
      const safeTop = 62, safeBottom = state.h - (state.isMobile ? 92 : 74)
      const safeLeft = state.isMobile ? 8 : 18
      const safeRight = state.w - (state.isMobile ? 8 : 18)

      const placed = []
      // Prioritise larger memories and nearer clusters, then place greedily.
      const candidates = state.clusters
        .filter(c => matches(c))
        .filter(c => !(lod >= 2 && c !== state.focus))
        .map(c => ({ c, pr: project(c.center) }))
        .filter(({ pr }) => pr.x > -40 && pr.x < state.w + 40 && pr.y > -40 && pr.y < state.h + 40)
        .sort((a, b) => (b.c.weight - a.c.weight) || (a.pr.z - b.pr.z))

      for (const { c, pr } of candidates) {
        if (placed.length >= maxLabels) break
        const trunc = lod >= 2 ? 40 : (crowded ? 12 : state.isMobile ? 14 : 22)
        const title = c.session.title
        const label = title.length > trunc ? `${title.slice(0, trunc)}…` : title
        const size = lod >= 2 ? baseSize + 3 : baseSize
        ctx.font = `${lod >= 2 ? 600 : 400} ${size}px Inter, "PingFang SC", system-ui, sans-serif`
        const x = pr.x + 6
        const ly = pr.y + Math.min(120, 30 * pr.scale) + 8
        const w = ctx.measureText(label).width
        const rows = (!crowded && lod >= 1) || lod >= 2 ? 2 : 1
        const h = size + rows * (baseSize + 3)
        const rect = { x: x - 3, y: ly - size / 2 - 3, w: w + 6, h: h + 6 }
        if (rect.x < safeLeft || rect.x + rect.w > safeRight) continue
        if (rect.y < safeTop || rect.y + rect.h > safeBottom) continue
        if (placed.some(r => overlaps(r, rect))) continue
        placed.push(rect)

        ctx.globalAlpha = 0.88
        ctx.lineWidth = 3
        ctx.strokeStyle = 'rgba(7,10,28,0.92)'
        ctx.strokeText(label, x, ly)
        ctx.fillStyle = '#d6deff'
        ctx.fillText(label, x, ly)

        // Counts / topics are suppressed in a crowded field; zoom in (or a
        // small history) brings them back.
        const showMeta = lod >= 1 && !crowded
        if (showMeta) {
          const cc = c.session.counts
          const meta = `${cc.fragments} 条记忆 · ${cc.user}/${cc.assistant} 对话 · ${cc.tools} 工具`
          ctx.font = `400 ${baseSize - 1}px Inter, system-ui, sans-serif`
          ctx.globalAlpha = 0.7
          ctx.strokeText(meta, x, ly + size + 4)
          ctx.fillStyle = '#9db0e6'
          ctx.fillText(meta, x, ly + size + 4)
        }
        if (lod >= 2 && (c.session.topics || []).length > 0) {
          const words = c.session.topics.slice(0, 6).map(t => t.word).join(' · ')
          ctx.font = `400 ${baseSize - 1}px Inter, system-ui, sans-serif`
          ctx.globalAlpha = 0.6
          ctx.strokeText(words, x, ly + size * 2 + 8)
          ctx.fillStyle = '#8fa6d8'
          ctx.fillText(words, x, ly + size * 2 + 8)
        }
        if (lod >= 3) {
          const status = c.hasFullDetail ? '已载入完整记忆' : '正在载入完整记忆…'
          ctx.font = `400 ${baseSize - 1}px Inter, system-ui, sans-serif`
          ctx.globalAlpha = 0.55
          ctx.fillStyle = c.hasFullDetail ? '#8fd6b4' : '#d8c98a'
          ctx.fillText(status, x, ly + size * 3 + 12)
        }
      }
      ctx.restore()
    }

    // Adaptive frame gate: stay uncapped while the device keeps up, and fall
    // back to 30 fps only after a sustained streak of expensive frames (an
    // Android WebView under load). It recovers on its own when frames get
    // cheap again, so a slow start never permanently caps the animation.
    // Adaptive quality ONLY — never the frame rate.
    //
    // An earlier version dropped the whole scene to 30 fps when frames got
    // expensive, then recovered as soon as they got cheap again. That feedback
    // loop oscillates between 60 and 30 fps, which reads as far worse
    // stuttering than staying at one rate. Frame pacing is now left to the
    // browser; the only adaptation is how finely the crest is sampled, decided
    // from the real frame interval with wide hysteresis so it cannot flap.
    frameGaps.push(dtMs)
    if (frameGaps.length > 30) frameGaps.shift()
    if (frameGaps.length === 30) {
      const sorted = [...frameGaps].sort((a, b) => a - b)
      const p50 = sorted[15]
      if (p50 > 22 && state.quality > 0.5) state.quality = 0.5
      else if (p50 < 15 && state.quality < 1) state.quality = 1
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
      // Capped: at deep zoom an uncapped cloud radius would swallow the whole
      // viewport and make nothing else selectable.
      const radius = isCloudTarget
        ? Math.min(state.isMobile ? 60 : 48, Math.max(state.isMobile ? 30 : 24, 30 * pr.scale))
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
    state.focus = cluster
    // Opening a memory is a decision to look at THAT one; at a shallow zoom we
    // also drift toward its band so the close-up is ready when the user zooms.
    if (state.zoom < LOD_STEPS[0]) state.targetZoom = LOD_STEPS[0] + 0.4
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
        state.targetZoom = clampZoom(state.pinch.startZoom * (dist / state.pinch.startDist))
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
    state.targetZoom = clampZoom(state.targetZoom * (e.deltaY > 0 ? 0.88 : 1.14))
  }, { passive: false })
  // Block the browser's own pinch-zoom / pull-to-refresh over the canvas.
  canvas.addEventListener('gesturestart', e => e.preventDefault())
  canvas.addEventListener('gesturechange', e => e.preventDefault())

  // Double-click / double-tap a cluster to fly all the way in and read it.
  canvas.addEventListener('dblclick', e => {
    const star = hitTest(e.clientX, e.clientY)
    if (!star) return
    state.focus = star.cluster
    stopAutoRotate()
    state.targetZoom = ZOOM_MAX * 0.72
    if (state.zoom >= LOD_STEPS[2]) requestDetail(star.cluster)
  })

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
    state.focus = null
  })
  el.detailClose.addEventListener('click', closeDetail)
  // Close button is always visible so users can always find and click it.
  el.close.addEventListener('click', () => {
    try {
      if (window.parent !== window) {
        window.parent.postMessage({ source: 'dsh-memory-cloud', type: 'close' }, location.origin)
      } else {
        window.close()
      }
    } catch (_) {}
  })
  // The toolbar is flat and always visible; only the legend box is collapsible.
  el.legendToggle.addEventListener('click', () => {
    const collapsed = el.legendContent.hidden
    el.legendContent.hidden = !collapsed
    el.legendToggle.textContent = collapsed ? '−' : '+'
    el.legendToggle.setAttribute('aria-expanded', String(collapsed))
  })

  window.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return
    // Close the innermost layer first; never close the whole page while a
    // panel is still open.
    if (!el.detail.hidden) { closeDetail(); return }
    if (!el.legendContent.hidden && window.innerWidth <= 820) {
      el.legendContent.hidden = true
      el.legendToggle.textContent = '+'
      el.legendToggle.setAttribute('aria-expanded', 'false')
      return
    }
    if (window.parent !== window) window.parent.postMessage({ source: 'dsh-memory-cloud', type: 'close' }, location.origin)
  })
  el.liveToggle.addEventListener('click', () => {
    const collapsed = el.livePanel.classList.toggle('collapsed')
    el.liveToggle.textContent = collapsed ? '+' : '−'
    el.liveToggle.setAttribute('aria-pressed', String(!collapsed))
  })
  el.liveFeed.innerHTML = '<div class="live-empty">等待对话记忆写入…</div>'
  el.livePanel.dataset.connected = 'false'
  // The nebula is dark-only by design; no theme messages are exchanged.
  window.addEventListener('resize', resize)
  window.addEventListener('orientationchange', () => window.setTimeout(resize, 250))
  // Periodically reconcile ephemeral live clouds with the on-disk snapshot.
  window.setInterval(refreshFromSnapshot, 15000)

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
