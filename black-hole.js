// Procedural, lensed accretion volume. No images, dependencies or network I/O.
const VERTEX = `
attribute vec2 position;
varying vec2 uv;
void main() { uv = position; gl_Position = vec4(position, 0.0, 1.0); }
`
const FRAGMENT = `
precision highp float;
varying vec2 uv;
uniform float phase;
uniform float energy;
uniform float nebula;
uniform float pixelSize;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i=floor(p), f=fract(p); f=f*f*f*(f*(f*6.-15.)+10.);
  return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x),f.y);
}
// Integral of a Gaussian. Integrating the thin disc across each ray segment
// avoids the bright/dark bands caused by point-sampling through its surface.
float erf(float x) {
  float a=abs(x), t=1./(1.+.3275911*a);
  float v=1.-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-.284496736)*t+.254829592)*t*exp(-a*a);
  return sign(x)*v;
}
void main() {
  vec3 eye=vec3(0.,2.55,8.2);
  vec3 forward=normalize(-eye), right=vec3(1.,0.,0.);
  vec3 up=normalize(cross(right,forward));
  vec3 direction=normalize(forward*2.05+right*uv.x*1.65+up*uv.y);
  vec3 p=eye, light=vec3(0.);
  float transmission=1., captured=0., closest=20.;
  for (int i=0;i<144;i++) {
    float distanceToCenter=length(p);
    closest=min(closest,distanceToCenter);
    if(distanceToCenter<1.) { captured=1.; break; }
    if(distanceToCenter>15.) break;
    float stepLength=clamp(distanceToCenter*.05,.035,.3);
    direction=normalize(direction-p*(.66*stepLength/pow(distanceToCenter,3.)));
    vec3 next=p+direction*stepLength;
    // Locate the disc crossing within the segment, rather than letting the
    // sampling lattice stamp a repeating ribbed pattern onto the gas.
    float dy=next.y-p.y;
    float crossing=abs(dy)>.00001 ? clamp(-p.y/dy,0.,1.) : .5;
    vec3 samplePoint=mix(p,next,crossing);
    float r=length(samplePoint.xz);
    float inner=smoothstep(1.28,1.7,r);
    float outer=1.-smoothstep(2.15,mix(3.5,3.9,nebula),r);
    float height=.058+.014*r;
    float column=abs(dy)>.0001
      ? max(0.,.8862269*height*stepLength*(erf(next.y/height)-erf(p.y/height))/dy)
      : exp(-pow((p.y+next.y)*.5/height,2.))*stepLength;
    if(column*inner*outer>.00001) {
      float a=atan(samplePoint.z,samplePoint.x);
      float flow=phase/(.65+r*.26);
      // Anisotropic, advected gas: thin across the orbit, long along it.
      // Low-contrast dust lanes interrupt the filaments without stamped rings.
      vec2 orbit=vec2(cos(a-flow),sin(a-flow));
      vec2 gas=orbit*r*1.8+vec2(r*1.2,0.);
      float broad=noise(gas);
      float shear=orbit.x*2.1+orbit.y*1.6;
      float ribbons=noise(vec2(r*8.5+broad*1.7,shear));
      float threads=noise(vec2(r*18.+broad*2.6,shear*1.7+3.8));
      float micro=noise(vec2(r*35.+ribbons*1.4,shear*2.6+9.2));
      // Suppress subpixel detail at small sizes instead of letting it shimmer.
      float detail=1.-smoothstep(.004,.013,pixelSize);
      float texture=.58+broad*.28+ribbons*.38+(threads-.5)*.24*detail;
      texture+=(micro-.5)*.09*detail*detail;
      float dust=smoothstep(.24,.72,noise(gas*.7+vec2(11.4,8.3)));
      float density=column*inner*outer*texture*mix(.76,1.,dust);
      float heat=exp(-max(0.,r-1.5)*.62);
      vec3 color=mix(vec3(.19,.035,.38),vec3(.57,.12,.95),clamp(heat*1.5,0.,1.));
      color=mix(color,vec3(.95,.49,1.),pow(heat,3.)*.75);
      vec3 velocity=normalize(vec3(-samplePoint.z,0.,samplePoint.x));
      float doppler=clamp(1.+dot(velocity,-direction)*.6,.45,1.65);
      color=mix(color,vec3(.84,.10,.56),max(0.,1.-doppler)*.28);
      vec3 gasColor=mix(vec3(.12,.24,.48),vec3(.48,.40,.76),clamp(heat*1.4,0.,1.));
      gasColor=mix(gasColor,vec3(.79,.83,1.),pow(heat,3.)*.62);
      color=mix(color,gasColor,nebula);
      float opacity=1.-exp(-density*3.1);
      float emission=(.78+heat*1.7)*(.84+ribbons*.24+threads*.1*detail);
      light+=transmission*opacity*color*emission*doppler*(1.+energy*.16);
      transmission*=1.-opacity*.94;
    }
    p=next;
  }
  float photon=exp(-pow((closest-1.018)/max(.008,pixelSize*.8),2.))*.085;
  light+=mix(vec3(.52,.24,.8),vec3(.53,.64,.9),nebula)*photon;
  vec3 mapped=pow(1.-exp(-light*.88),vec3(.94));
  float luminance=max(mapped.r,max(mapped.g,mapped.b));
  float border=1.-smoothstep(.83,1.,max(abs(uv.x),abs(uv.y)));
  float shadow=max(captured,1.-smoothstep(1.,1.+pixelSize*3.,closest));
  // Continuous coverage preserves faint gas without a hard luminance cutoff.
  float gasAlpha=1.-exp(-luminance*9.);
  float alpha=max(shadow,gasAlpha)*border;
  gl_FragColor=vec4(mapped+vec3(.012,.016,.037)*shadow*nebula,alpha);
}
`

// A small, highlight-only optical bloom. Work entirely on the GPU: no
// per-frame pixel readback, Canvas blur or loss of the sharp base image.
const COMPOSITE = `
precision highp float;
varying vec2 uv;
uniform sampler2D scene;
uniform vec2 texel;
vec3 highlight(vec2 p) {
  vec4 s=texture2D(scene,p);
  float brightness=max(s.r,max(s.g,s.b));
  return s.rgb*s.a*smoothstep(.32,.82,brightness);
}
void main() {
  vec2 p=uv*.5+.5;
  vec4 base=texture2D(scene,p);
  vec2 d=texel*2.5;
  vec3 glow=highlight(p)*.24;
  glow+=(highlight(p+vec2(d.x,0.))+highlight(p-vec2(d.x,0.))
        +highlight(p+vec2(0.,d.y))+highlight(p-vec2(0.,d.y)))*.1;
  vec2 q=d*.7071;
  glow+=(highlight(p+q)+highlight(p-q)
        +highlight(p+vec2(q.x,-q.y))+highlight(p+vec2(-q.x,q.y)))*.06;
  glow+=(highlight(p+vec2(d.x*2.,0.))+highlight(p-vec2(d.x*2.,0.))
        +highlight(p+vec2(0.,d.y*2.))+highlight(p-vec2(0.,d.y*2.)))*.03;
  glow*=.22;
  float alpha=max(base.a,max(glow.r,max(glow.g,glow.b))*2.);
  gl_FragColor=vec4((base.rgb*base.a+glow)/max(alpha,.0001),alpha);
}
`

function compile(gl, type, source) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(message || 'Black hole shader compilation failed')
  }
  return shader
}

function createProgram(gl, fragmentSource) {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource)
  const program = gl.createProgram()
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.bindAttribLocation(program, 0, 'position')
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Black hole shader link failed')
  return program
}

export class BlackHoleRenderer {
  constructor() {
    this.canvas = document.createElement('canvas')
    this.gl = null
    this.lastFrame = -Infinity
    this.size = 0
    this.mode = 'canvas'
    try {
      const gl = this.canvas.getContext('webgl', {
        alpha: true, premultipliedAlpha: false, antialias: false,
        depth: false, stencil: false, preserveDrawingBuffer: true,
      })
      if (!gl) return
      const debug = gl.getExtension('WEBGL_debug_renderer_info')
      const device = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
      this.software = /SwiftShader|Basic Render|software|llvmpipe/i.test(device)
      const program = createProgram(gl, FRAGMENT)
      this.program = program
      this.postProgram = createProgram(gl, COMPOSITE)
      this.sceneUniform = gl.getUniformLocation(this.postProgram, 'scene')
      this.texelUniform = gl.getUniformLocation(this.postProgram, 'texel')
      this.sceneTexture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, this.sceneTexture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      this.sceneFramebuffer = gl.createFramebuffer()
      gl.useProgram(program)
      const vertices = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, vertices)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW)
      const position = gl.getAttribLocation(program, 'position')
      gl.enableVertexAttribArray(position)
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
      this.phaseUniform = gl.getUniformLocation(program, 'phase')
      this.energyUniform = gl.getUniformLocation(program, 'energy')
      this.nebulaUniform = gl.getUniformLocation(program, 'nebula')
      this.pixelSizeUniform = gl.getUniformLocation(program, 'pixelSize')
      this.gl = gl
      this.mode = 'webgl'
      this.canvas.addEventListener('webglcontextlost', event => {
        event.preventDefault()
        this.gl = null
        this.mode = 'canvas'
      })
    } catch {
      // Canvas fallback retains the same layering on devices without WebGL.
      this.gl = null
    }
  }

  draw(ctx, radius, phase, energy, mobile, now, skin = 'neuron') {
    const nebula = skin === 'nebula'
    if (nebula) this.drawAtmosphere(ctx, radius, phase, energy)
    if (!this.gl || this.gl.isContextLost()) {
      this.mode = 'canvas'
      this.drawFallback(ctx, radius, phase, energy, nebula)
      return
    }
    const gl = this.gl
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1)
    const resolution = this.software ? 512 : Math.min(mobile ? 512 : 768, Math.max(384, Math.ceil(radius * 6.2 * dpr * 1.25 / 64) * 64))
    const changed = this.size !== resolution || this.skin !== skin
    this.skin = skin
    if (changed) {
      this.size = resolution
      this.canvas.width = Math.round(resolution * 1.65)
      this.canvas.height = resolution
      gl.viewport(0, 0, this.canvas.width, this.canvas.height)
      gl.bindTexture(gl.TEXTURE_2D, this.sceneTexture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.canvas.width, this.canvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFramebuffer)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.sceneTexture, 0)
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        this.gl = null
        this.mode = 'canvas'
        this.drawFallback(ctx, radius, phase, energy, nebula)
        return
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    }
    // The field remains on Canvas2D. Only this small offscreen volume is
    // ray-marched, at most 30fps; its texture is reused between those frames.
    if (changed || (!this.software && now - this.lastFrame >= 1000 / 30) || (this.software && !this.baked)) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFramebuffer)
      gl.useProgram(this.program)
      gl.uniform1f(this.phaseUniform, phase)
      gl.uniform1f(this.energyUniform, energy)
      gl.uniform1f(this.nebulaUniform, nebula ? 1 : 0)
      gl.uniform1f(this.pixelSizeUniform, 2 / resolution)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.useProgram(this.postProgram)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.sceneTexture)
      gl.uniform1i(this.sceneUniform, 0)
      gl.uniform2f(this.texelUniform, 1 / this.canvas.width, 1 / this.canvas.height)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      this.lastFrame = now
      if (this.software) {
        this.baked = document.createElement('canvas')
        this.baked.width = this.canvas.width
        this.baked.height = this.canvas.height
        this.baked.getContext('2d').drawImage(this.canvas, 0, 0)
      }
    }
    const image = this.software ? this.baked : this.canvas
    const height = radius * 6.2
    const width = height * 1.65
    ctx.save()
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.rotate(-0.28)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    ctx.drawImage(image, -width / 2, -height / 2, width, height)
    if (this.software) this.drawFlow(ctx, radius, phase, energy, nebula)
    ctx.restore()
  }

  // A sparse, feathered envelope shares the surrounding clouds' source-over
  // scattering. Cached puffs avoid per-frame gradients or full-canvas filters.
  drawAtmosphere(ctx, radius, phase, energy) {
    if (!this.atmosphere) {
      this.atmosphere = [[105, 147, 220], [151, 120, 211], [109, 169, 190]].map(color => {
        const sprite = document.createElement('canvas')
        sprite.width = sprite.height = 128
        const g = sprite.getContext('2d')
        const gradient = g.createRadialGradient(64, 64, 0, 64, 64, 64)
        gradient.addColorStop(0, `rgba(${color},.48)`)
        gradient.addColorStop(.28, `rgba(${color},.24)`)
        gradient.addColorStop(.62, `rgba(${color},.065)`)
        gradient.addColorStop(1, `rgba(${color},0)`)
        g.fillStyle = gradient
        g.fillRect(0, 0, 128, 128)
        return sprite
      })
    }
    ctx.save()
    ctx.rotate(-.28)
    ctx.globalCompositeOperation = 'source-over'
    for (let i = 0; i < 24; i++) {
      const a = i * 2.39996
      const r = radius * (1.8 + (i % 5) * .48)
      const drift = Math.sin(phase * .16 + a) * radius * .12
      const x = Math.cos(a) * r, y = Math.sin(a) * r * .46 + drift
      const width = radius * (2.1 + (i % 4) * .42)
      const height = width * (.48 + (i % 3) * .12)
      ctx.globalAlpha = (.12 + energy * .045) * (.8 + .2 * Math.sin(a + phase * .2))
      ctx.drawImage(this.atmosphere[i % 3], x - width / 2, y - height / 2, width, height)
    }
    ctx.restore()
  }

  drawFlow(ctx, radius, phase, energy, nebula = false) {
    this.flowSprites ??= new Map()
    if (!this.flowSprites.has(nebula)) {
      const sprite = document.createElement('canvas')
      sprite.width = sprite.height = 64
      const g = sprite.getContext('2d')
      const glow = g.createRadialGradient(32,32,0,32,32,32)
      glow.addColorStop(0,nebula ? 'rgba(205,217,255,.65)' : 'rgba(237,159,255,.8)')
      glow.addColorStop(.3,nebula ? 'rgba(123,151,226,.25)' : 'rgba(184,79,244,.3)')
      glow.addColorStop(1,'rgba(128,40,214,0)')
      g.fillStyle = glow; g.fillRect(0,0,64,64)
      this.flowSprites.set(nebula, sprite)
    }
    const flowSprite = this.flowSprites.get(nebula)
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    for (let i = 0; i < 72; i++) {
      const a = i * 2.39996 + phase * (1.2 - (i % 6) * .07)
      const r = radius * (1.7 + (i % 7) * .16)
      const x = Math.cos(a) * r, y = Math.sin(a) * r * .27 + radius * .17
      if (Math.sin(a) < 0 && x*x+y*y < radius*radius*1.8) continue
      ctx.save()
      ctx.translate(x,y)
      ctx.rotate(Math.atan2(Math.cos(a)*.27,-Math.sin(a)))
      ctx.globalAlpha = (.09 + energy*.06) * (.55+.45*Math.sin(a+i*.3)**2)
      const w = radius * .95, h = radius * .17
      ctx.drawImage(flowSprite,-w/2,-h/2,w,h)
      ctx.restore()
    }
    ctx.restore()
  }

  // Smooth optical-density texture for devices without WebGL. Build once per
  // palette, then composite at high quality; no stacked ellipse outlines.
  drawFallback(ctx, radius, phase, energy, nebula = false) {
    this.fallbackTextures ??= new Map()
    if (!this.fallbackTextures.has(nebula)) {
      const texture = document.createElement('canvas')
      texture.width = 845
      texture.height = 512
      const cool = nebula ? [.22, .32, .57] : [.4, .1, .67]
      const hot = nebula ? [.79, .83, 1] : [.93, .55, 1]
      const g = texture.getContext('2d')
      const image = g.createImageData(texture.width, texture.height)
      const smooth = (a, b, value) => {
        const t = Math.max(0, Math.min(1, (value - a) / (b - a)))
        return t * t * (3 - 2 * t)
      }
      for (let py = 0; py < texture.height; py++) {
        for (let px = 0; px < texture.width; px++) {
          const x = (px + .5 - texture.width / 2) / texture.height * 6.2
          const y = (py + .5 - texture.height / 2) / texture.height * 6.2
          const distance = Math.hypot(x, y)
          const discRadius = Math.hypot(x, (y - .12) / .27)
          const azimuth = Math.atan2((y - .12) / .27, x)
          const grain = 1 + .06 * Math.sin(azimuth * 3 + discRadius * 2) + .025 * Math.sin(azimuth * 7 - discRadius * 5)
          const disc = smooth(1.15, 1.65, discRadius) * (1 - smooth(2.05, 3.5, discRadius)) * grain
          const shadow = 1 - smooth(.985, 1.025, distance)
          const foreground = smooth(-.06, .12, y)
          const lens = Math.exp(-(((Math.hypot(x, y * 1.04) - 1.2) / .16) ** 2)) * (1 - smooth(-.08, .2, y))
          const halo = Math.exp(-(((distance - 1.27) / .38) ** 2)) * .075
          const light = disc * (1 - shadow * (1 - foreground)) * .85 + lens * .65 + halo
          const doppler = .9 + .22 * Math.tanh(x)
          const heat = smooth(3.5, 1.3, discRadius)
          const alpha = Math.max(shadow, 1 - Math.exp(-light * 5))
          const offset = (py * texture.width + px) * 4
          for (let channel = 0; channel < 3; channel++) {
            const color = cool[channel] * (1 - heat * .65) + hot[channel] * heat * .65
            image.data[offset + channel] = Math.round(255 * (1 - Math.exp(-light * color * doppler * 1.7)))
          }
          image.data[offset + 3] = Math.round(255 * alpha)
        }
      }
      g.putImageData(image, 0, 0)
      this.fallbackTextures.set(nebula, texture)
    }
    const texture = this.fallbackTextures.get(nebula)
    const height = radius * 6.2, width = height * 1.65
    ctx.save()
    ctx.rotate(-.28)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.globalCompositeOperation = 'source-over'
    ctx.drawImage(texture, -width / 2, -height / 2, width, height)
    this.drawFlow(ctx, radius, phase, energy, nebula)
    ctx.restore()
  }
}
