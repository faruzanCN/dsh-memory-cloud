/**
 * Client half of the Memory Nebula bundle.
 *
 * Two additive slot registrations share one tiny observable store:
 *   - `sidebar.footer.action`: a button beside Settings that opens the nebula.
 *   - `shell.overlay`: the full-frame layer that hosts the nebula iframe.
 *
 * The iframe loads a same-origin page served by the Host half. The nebula is
 * dark-only by design, so this half only bridges open/close and Escape — it
 * never forwards the host's light/dark theme. No Harness Client UI package is
 * imported as a module.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-memory-cloud',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useSyncExternalStore } = React

    const NS = 'dsh-memory-cloud'
    const DICTS = {
      en: { title: 'Memory nebula', hint: 'Explore all DSH memories as a 3D nebula' },
      zh: { title: '记忆星云', hint: '以 3D 星云图探索全部 DSH 记忆' },
    }

    // Locale-aware translation for the sidebar button. The nebula iframe page
    // carries its own fixed copy; here we follow the host's active locale.
    let localeApi = null
    function useT() {
      const snap = useSyncExternalStore(
        fn => localeApi ? localeApi.subscribe(fn) : () => {},
        () => localeApi ? localeApi.getSnapshot().revision : 0,
        () => 0,
      )
      void snap
      return key => {
        const active = localeApi ? localeApi.getLocale().active : 'en'
        const dict = DICTS[active] || DICTS.en
        return dict[key] || DICTS.en[key] || key
      }
    }

    // --- shared open/close store -------------------------------------------
    let open = false
    const listeners = new Set()
    const store = {
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
      getSnapshot() { return open },
      getServerSnapshot() { return false },
      set(value) {
        if (value === open) return
        open = value
        for (const fn of listeners) fn()
      },
    }

    // --- nebula glyph ------------------------------------------------------
    function NebulaGlyph(size) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        'aria-hidden': true, style: { display: 'block' },
      },
        h('circle', { cx: 12, cy: 12, r: 3.2, fill: '#ffd591' }),
        h('circle', { cx: 12, cy: 12, r: 6.5, stroke: 'currentColor', strokeWidth: 1, opacity: 0.55 }),
        h('path', { d: 'M3 12c3-5 7-7 12-6', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', opacity: 0.9 }),
        h('path', { d: 'M4 15c4-3 9-3 15-1', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', opacity: 0.8 }),
        h('path', { d: 'M6 8c4-3 8-3 12-1', stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round', opacity: 0.7 }),
        h('circle', { cx: 4, cy: 13, r: 0.9, fill: 'currentColor' }),
        h('circle', { cx: 20, cy: 9, r: 1, fill: 'currentColor' }),
        h('circle', { cx: 18, cy: 18, r: 0.9, fill: 'currentColor' }),
        h('circle', { cx: 8, cy: 5, r: 0.8, fill: 'currentColor' }),
      )
    }

    // --- footer action button ---------------------------------------------
    function NebulaFooterButton(props) {
      const wide = props && props.wide
      const active = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot)
      const t = useT()
      return h('button', {
        type: 'button',
        onClick: () => store.set(!active),
        title: t('hint'),
        'aria-label': t('title'),
        'aria-pressed': active,
        style: {
          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
          padding: '7px 8px', border: 0, borderRadius: 8, cursor: 'pointer',
          background: active ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
          color: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
          font: 'inherit', fontSize: 13, textAlign: 'left',
        },
        onMouseEnter: e => { if (!active) e.currentTarget.style.background = 'var(--dsw-alias-bg-layer-1)' },
        onMouseLeave: e => { if (!active) e.currentTarget.style.background = 'transparent' },
      },
        h('span', { style: { flex: '0 0 auto', display: 'grid', placeItems: 'center', width: 18, height: 18 } }, NebulaGlyph(18)),
        wide ? h('span', { style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, t('title')) : null,
      )
    }

    // --- full-frame overlay ------------------------------------------------
    function NebulaOverlay() {
      const isOpen = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot)

      useEffect(() => {
        if (!isOpen) return undefined
        const onMessage = event => {
          if (event.origin !== location.origin || event.data?.source !== 'dsh-memory-cloud') return
          if (event.data.type === 'close') store.set(false)
        }
        const onKeyDown = event => { if (event.key === 'Escape') store.set(false) }
        window.addEventListener('message', onMessage)
        window.addEventListener('keydown', onKeyDown)
        return () => {
          window.removeEventListener('message', onMessage)
          window.removeEventListener('keydown', onKeyDown)
        }
      }, [isOpen])

      if (!isOpen) return null
      return h('div', {
        style: {
          position: 'fixed', inset: 0, zIndex: 1200, pointerEvents: 'auto',
          // Dark-only surface: never inherit a light host background.
          background: '#070a1c',
        },
        role: 'dialog', 'aria-modal': true, 'aria-label': '记忆星云',
      },
        h('iframe', {
          id: 'dsh-memory-cloud-frame',
          title: '记忆星云 · Memory nebula',
          src: '/memory-cloud/',
          style: { display: 'block', width: '100%', height: '100%', border: 0 },
        }),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        localeApi = ctx.locale
        const disposers = []
        for (const [id, dict] of Object.entries(DICTS)) {
          try { disposers.push(ctx.locale.register(NS, id, dict)) } catch (_) { /* namespace already owned on re-apply */ }
        }
        const label = () => {
          const active = ctx.locale.getLocale().active
          return (DICTS[active] || DICTS.en).title
        }
        disposers.push(ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'dsh-memory-cloud',
          order: 60,
          label,
        }, NebulaFooterButton)))
        disposers.push(ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-memory-cloud',
          order: 100,
          label,
        }, NebulaOverlay)))
        ctx.effect(() => () => {
          for (const dispose of disposers) { try { dispose() } catch (_) {} }
          localeApi = null
        }, 'memory-cloud: ui registrations')
      },
    }
  },
})
