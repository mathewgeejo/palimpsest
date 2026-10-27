// GLSL ES 3.00 (p5.js 2.x WebGL2 context).

export const membraneVert = /* glsl */ `#version 300 es
precision highp float;

in vec3 aPosition;
in vec3 aNormal;
in vec2 aTexCoord;   // x: position across the membrane (0..1), y: absolute history row
in vec4 aVertexColor; // r: treble, g: onset seam, b: centroidV, a: high-mid
in float aLoud;

uniform mat4 uModelViewMatrix;
uniform mat4 uProjectionMatrix;
uniform mat3 uNormalMatrix;

uniform float uHead;     // newest row (fractional)
uniform float uFlex;     // live bass flex, model units

out vec3 vN;
out vec3 vView;
out float vRowsAgo;
out float vRow;
out float vS;
out vec4 vMeta;
out float vLoud;

void main() {
  float rowsAgo = uHead - aTexCoord.y;
  float s = aTexCoord.x;
  vec3 p = aPosition;
  // Only the freshest layers still flex with the current bass; history is fixed.
  float young = exp(-max(rowsAgo, 0.0) / 30.0);
  p += normalize(aNormal) * uFlex * sin(3.14159 * s) * young;

  vec4 mv = uModelViewMatrix * vec4(p, 1.0);
  vView = mv.xyz;
  vN = normalize(uNormalMatrix * aNormal);
  vRowsAgo = rowsAgo;
  vRow = aTexCoord.y;
  vS = s;
  vMeta = aVertexColor;
  vLoud = aLoud;
  gl_Position = uProjectionMatrix * mv;
}
`;

export const membraneFrag = /* glsl */ `#version 300 es
precision highp float;

in vec3 vN;
in vec3 vView;
in float vRowsAgo;
in float vRow;
in float vS;
in vec4 vMeta;
in float vLoud;

uniform float uVisible;   // rows of history shown
uniform float uDetail;    // 0..1
uniform float uQuiet;     // 0..1, rises during quiet passages
uniform float uOnsetGain;
uniform float uGain;
uniform vec2 uFog;        // near, far (view-space depth)

out vec4 fragColor;

const vec3 IVORY  = vec3(0.96, 0.91, 0.81);
const vec3 COPPER = vec3(0.80, 0.48, 0.30);
const vec3 OXIDE  = vec3(0.30, 0.42, 0.38);
const vec3 PETROL = vec3(0.13, 0.44, 0.52);

// Anti-aliased periodic line; fades out when lines get denser than the pixel grid.
float aaLine(float x, float halfWidthPx) {
  float fw = max(fwidth(x), 1e-5);
  float d = abs(fract(x - 0.5) - 0.5) / fw;
  float l = 1.0 - smoothstep(halfWidthPx - 0.5, halfWidthPx + 0.75, d);
  return l * (1.0 - smoothstep(0.18, 0.5, fw));
}

void main() {
  if (vRowsAgo > uVisible || vRowsAgo < -1.0) discard;
  float age = clamp(vRowsAgo / uVisible, 0.0, 1.0);

  vec3 V = normalize(-vView);
  vec3 N = normalize(vN);
  float ndv = abs(dot(N, V));
  float fres = pow(1.0 - ndv, 2.4);

  float treble = vMeta.r;
  float seam = vMeta.g * uOnsetGain;
  float centroidV = vMeta.b;
  float highMid = vMeta.a;

  // Time strata: one contour per few history rows; high-mids emphasise them.
  float rowsPerLine = mix(4.0, 1.25, uDetail);
  float strata = aaLine(vRow / rowsPerLine, 0.5) * (0.45 + 1.2 * highMid) * (0.35 + 0.9 * uDetail);
  // Silk threads running along the growth direction.
  float threads = aaLine(vS * mix(10.0, 26.0, uDetail), 0.3) * 0.035;
  // Treble etching: fine, slightly wavering lines.
  float etchFreq = mix(40.0, 140.0, uDetail);
  float etch = aaLine(vS * etchFreq + sin(vRow * 0.29 + vS * 9.0) * 0.8, 0.3) * treble;
  // Onset seams: a bright crease along the rows where a transient happened.
  float seamLine = seam * (0.35 + 0.65 * aaLine(vRow, 0.9));
  // Copper lips along both sides of the membrane.
  float lip = smoothstep(0.93, 1.0, vS) + 0.6 * smoothstep(0.06, 0.0, vS);

  float leading = exp(-max(vRowsAgo, 0.0) / 4.0);

  float body = 0.035 + 0.30 * fres;
  float lum = body + strata * 0.75 + threads + etch * (0.1 + 0.9 * uDetail) + lip * 0.3 + seamLine * 0.9;
  lum *= 0.30 + 0.70 * vLoud;
  lum += leading * (0.55 + 0.6 * fres) * (0.35 + 0.65 * vLoud);

  // Age: bright recent folds, dim persistent history. Quiet passages lift the history.
  float ageBright = mix(1.0, 0.10, pow(age, 0.5));
  ageBright *= 1.0 + uQuiet * 2.2 * smoothstep(0.03, 0.4, age);
  float tail = smoothstep(1.0, 0.8, age);

  vec3 col = mix(IVORY, COPPER, smoothstep(0.02, 0.35, age));
  col = mix(col, OXIDE * 0.75, smoothstep(0.5, 1.0, age));
  // Spectral centroidV: a slow, restrained warm/cool shift.
  col *= mix(vec3(1.06, 0.97, 0.88), vec3(0.93, 1.0, 1.07), centroidV);
  col = mix(col, IVORY * 1.25, leading);

  // Thin-film interference, kept rare: only at grazing angles.
  float film = 0.5 + 0.5 * cos(6.2831 * (ndv * 1.6 + vS * 0.7 + centroidV * 0.9 + vRow * 0.0015));
  vec3 irid = PETROL * film * fres * (0.25 + 0.75 * highMid) * 0.55;

  float fog = 1.0 - 0.8 * smoothstep(uFog.x, uFog.y, -vView.z);
  vec3 outc = (col * lum + irid) * ageBright * tail * fog * uGain;
  fragColor = vec4(outc, 1.0);
}
`;

export const postVert = /* glsl */ `#version 300 es
precision highp float;
in vec3 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition.xy + 0.5;
  gl_Position = vec4(aPosition.xy * 2.0, 0.0, 1.0);
}
`;

export const postFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
uniform vec2 uRes;       // output resolution in px
uniform float uGlow;     // 0 disables
uniform int uGlowTaps;   // 0, 6, 12
uniform float uExposure;
uniform float uGrain;
uniform float uSeed;
uniform float uFlipY;
out vec4 fragColor;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec2 uv = vec2(vUv.x, mix(vUv.y, 1.0 - vUv.y, uFlipY));
  vec3 scene = texture(uScene, uv).rgb;

  vec3 glow = vec3(0.0);
  if (uGlowTaps > 0) {
    float total = 0.0;
    for (int i = 0; i < 12; i++) {
      if (i >= uGlowTaps) break;
      float a = float(i) * 2.39996 + 0.5;
      float r = (i % 2 == 0) ? 7.0 : 18.0;
      vec2 o = vec2(cos(a), sin(a)) * r / uRes;
      glow += texture(uScene, uv + o).rgb;
      total += 1.0;
    }
    glow /= max(total, 1.0);
  }

  vec3 c = scene + glow * uGlow;
  vec3 tm = 1.0 - exp(-c * uExposure);

  // Charcoal ground with a faint warm atmosphere and vignette.
  vec2 q = vUv - vec2(0.52, 0.5);
  q.x *= uRes.x / uRes.y;
  float d = length(q);
  vec3 bg = vec3(0.040, 0.040, 0.044) + vec3(0.020, 0.016, 0.012) * (1.0 - smoothstep(0.0, 0.9, d));
  bg *= 1.0 - 0.45 * smoothstep(0.5, 1.25, d);

  vec3 outc = bg + tm * (1.0 - bg);
  outc += (hash(gl_FragCoord.xy + uSeed) - 0.5) * uGrain;
  fragColor = vec4(outc, 1.0);
}
`;
