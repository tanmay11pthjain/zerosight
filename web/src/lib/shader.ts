// Full-screen background shader: slow molten ember smoke in the logo's colours,
// with a soft glow that follows the pointer. Renders at reduced resolution,
// pauses when the tab is hidden, and draws a single still frame for reduced motion.
const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
const FRAG = `
precision mediump float;
uniform vec2 r;
uniform float t;
uniform vec2 m;
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);
  return mix(mix(h(i),h(i+vec2(1.,0.)),u.x),mix(h(i+vec2(0.,1.)),h(i+vec2(1.,1.)),u.x),u.y);}
float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*n(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}return v;}
void main(){
  vec2 uv=gl_FragCoord.xy/r;
  vec2 p=(gl_FragCoord.xy-.5*r)/r.y;
  float tt=t*.035;
  vec2 q=vec2(fbm(p*1.5+tt),fbm(p*1.5-tt+5.2));
  vec2 w=vec2(fbm(p*1.3+2.*q+vec2(1.7,9.2)+tt*1.3),fbm(p*1.3+2.*q+vec2(8.3,2.8)-tt));
  float f=fbm(p*1.1+2.4*w);
  vec3 col=vec3(.027,.02,.016);
  float glow=smoothstep(.42,1.,f);
  col+=vec3(1.,.42,.075)*glow*glow*.55;
  col+=vec3(.91,.69,.43)*pow(smoothstep(.62,1.,f),3.)*.3;
  float d=length(p-m);
  col+=vec3(1.,.45,.1)*.09*exp(-d*d*5.);
  col*=1.-.6*length(uv-vec2(.5,.45));
  gl_FragColor=vec4(col,1.);
}`;

export function mountShader(): () => void {
  const canvas = document.createElement('canvas');
  canvas.className = 'bg-shader';
  canvas.setAttribute('aria-hidden', 'true');
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' });
  if (!gl) return () => undefined;

  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  };
  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return () => undefined;
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return () => undefined;
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const uR = gl.getUniformLocation(prog, 'r');
  const uT = gl.getUniformLocation(prog, 't');
  const uM = gl.getUniformLocation(prog, 'm');
  document.body.prepend(canvas);

  const scale = Math.min(1, (window.devicePixelRatio || 1) * 0.5);
  const resize = () => {
    canvas.width = Math.max(1, Math.round(innerWidth * scale));
    canvas.height = Math.max(1, Math.round(innerHeight * scale));
    gl.viewport(0, 0, canvas.width, canvas.height);
  };
  resize();
  window.addEventListener('resize', resize);

  let mx = 0,
    my = 0.1,
    tx = 0,
    ty = 0.1;
  const onMove = (e: PointerEvent) => {
    tx = (e.clientX - innerWidth / 2) / innerHeight;
    ty = (innerHeight / 2 - e.clientY) / innerHeight;
  };
  window.addEventListener('pointermove', onMove, { passive: true });

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const start = performance.now();
  let raf = 0;
  const draw = (now: number) => {
    mx += (tx - mx) * 0.05;
    my += (ty - my) * 0.05;
    gl.uniform2f(uR, canvas.width, canvas.height);
    gl.uniform1f(uT, reduced ? 20 : (now - start) / 1000);
    gl.uniform2f(uM, mx, my);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!reduced && !document.hidden) raf = requestAnimationFrame(draw);
  };
  const onVis = () => {
    cancelAnimationFrame(raf);
    if (!document.hidden) raf = requestAnimationFrame(draw);
  };
  document.addEventListener('visibilitychange', onVis);
  raf = requestAnimationFrame(draw);

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', resize);
    window.removeEventListener('pointermove', onMove);
    document.removeEventListener('visibilitychange', onVis);
    canvas.remove();
  };
}
