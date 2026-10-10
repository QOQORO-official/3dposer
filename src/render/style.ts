import * as THREE from 'three';

export type RenderStyle = 'manga' | 'toon' | 'clay' | 'blueprint';

function gradientMap(steps: number[]): THREE.DataTexture {
  const data = new Uint8Array(steps.length * 4);
  steps.forEach((v, i) => data.set([v, v, v, 255], i * 4));
  const tex = new THREE.DataTexture(data, steps.length, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export interface StyleMaterials {
  skin: THREE.MeshToonMaterial;
  clay: THREE.MeshStandardMaterial;
}

export function createMaterials(): StyleMaterials {
  const skin = new THREE.MeshToonMaterial({ color: 0xf2f2f2, gradientMap: gradientMap([118, 185, 255]), vertexColors: true });
  const clay = new THREE.MeshStandardMaterial({ color: 0xd9d4cf, roughness: 0.7, metalness: 0, vertexColors: true });
  return { skin, clay };
}

/** Screen-space screentone: maps the toon tones to dot patterns and keeps lines and colored guides. */
export function createHalftoneMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      resolution: { value: new THREE.Vector2(1, 1) },
      cell: { value: 5 },
      angle: { value: THREE.MathUtils.degToRad(45) },
      enabled: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform vec2 resolution;
      uniform float cell;
      uniform float angle;
      uniform float enabled;
      varying vec2 vUv;
      void main() {
        vec4 c = texture2D(tDiffuse, vUv);
        // The render target holds linear color; judge tones perceptually.
        vec3 srgb = pow(max(c.rgb, 0.0), vec3(1.0 / 2.2));
        float l = dot(srgb, vec3(0.299, 0.587, 0.114));
        float sat = max(srgb.r, max(srgb.g, srgb.b)) - min(srgb.r, min(srgb.g, srgb.b));
        // Keep ink lines and colored overlays as they are.
        if (enabled < 0.5 || l < 0.36 || sat > 0.07) {
          // Ink stays solid black so anti-aliased line edges don't break into dots.
          gl_FragColor = vec4(l < 0.36 && sat <= 0.07 && enabled > 0.5 ? vec3(smoothstep(0.0, 0.36, l) * 0.15) : c.rgb, 1.0);
          #include <colorspace_fragment>
          return;
        }
        vec2 p = vUv * resolution;
        float s = sin(angle), co = cos(angle);
        p = mat2(co, -s, s, co) * p;
        vec2 g = fract(p / cell) - 0.5;
        float d = length(g);
        float darkness = clamp((0.95 - l) / 0.75, 0.0, 1.0);
        float radius = sqrt(darkness) * 0.62;
        float aa = 0.75 / cell;
        float ink = darkness < 0.02 ? 0.0 : 1.0 - smoothstep(radius - aa, radius + aa, d);
        // Light tones fade to paper white, darker tones get bigger dots.
        gl_FragColor = vec4(mix(vec3(1.0), vec3(0.0), ink), 1.0);
        #include <colorspace_fragment>
      }
    `,
    depthTest: false,
    depthWrite: false,
  });
}
