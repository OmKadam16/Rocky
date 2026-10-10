import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { AssistantState } from "../types";

type Props = { size?: number; className?: string; state?: AssistantState; onToggle?: () => void };

export default function LiquidSphere({ size = 148, className = "", state = "idle", onToggle }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const raf = useRef<number>(0);
  const stateRef = useRef<AssistantState>(state);
  // onToggle changes identity on every assistant state change. Reading it
  // through a ref keeps it out of the effect deps — otherwise each transition
  // tore down the WebGL context and rebuilt the geometry from scratch.
  const toggleRef = useRef(onToggle);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    toggleRef.current = onToggle;
  }, [onToggle]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.z = 3.9;

    // No MSAA: the sphere is a soft gradient blob with no hard edges to alias,
    // and at 1.5x device pixels the difference is invisible.
    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    const setSize = () => {
      const s = size;
      renderer.setSize(s, s);
      camera.aspect = 1;
      camera.updateProjectionMatrix();
    };
    setSize();

    // detail 64 meant 20 * 65^2 = 84,500 triangles — a quarter of a million
    // vertices, each running simplex noise every frame, for a 220px sphere.
    // detail 20 is 8,820 triangles and looks identical at this size.
    const geometry = new THREE.IcosahedronGeometry(1, 20);

    const noiseGLSL = `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);
  const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));
  vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);
  vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy);
  vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;
  vec3 x2=x0-i2+C.yyy;
  vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;
  vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z);
  vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;
  vec4 y=y_*ns.x+ns.yyyy;
  vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);
  vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;
  vec4 s1=floor(b1)*2.0+1.0;
  vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
  vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);
  vec3 p1=vec3(a0.zw,h.y);
  vec3 p2=vec3(a1.xy,h.z);
  vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
  m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

    const vertexShader = `
  uniform float uTime;
  uniform float uAmplitude;
  uniform float uSpeed;
  varying vec3 vNormal;
  varying float vDisplacement;
  ${noiseGLSL}
  void main() {
    vNormal = normal;
    float n = snoise(position * 2.2 + vec3(0.0, 0.0, uTime * uSpeed));
    float displacement = n * uAmplitude;
    vDisplacement = displacement;
    vec3 newPosition = position + normal * displacement;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(newPosition, 1.0);
  }
`;

    const fragmentShader = `
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  varying vec3 vNormal;
  varying float vDisplacement;
  void main() {
    vec3 viewDir = normalize(cameraPosition - vec3(0.0));
    float fresnel = pow(1.0 - abs(dot(normalize(vNormal), viewDir)), 2.5);
    vec3 base = mix(uColorA, uColorB, vDisplacement * 3.0 + 0.5);
    vec3 color = base + fresnel * 0.6;
    gl_FragColor = vec4(color, 1.0);
  }
`;

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uAmplitude: { value: 0.18 },
        uSpeed: { value: 0.35 },
        uColorA: { value: new THREE.Color(0x1a3d3a) },
        uColorB: { value: new THREE.Color(0x7fd9c4) },
      },
      vertexShader,
      fragmentShader,
    });

    const sphere = new THREE.Mesh(geometry, material);
    scene.add(sphere);

    const MAP: Record<AssistantState, { scale: number; amplitude: number; speed: number; rotSpeed: number }> = {
      idle: { scale: 1.0, amplitude: 0.18, speed: 0.35, rotSpeed: 0.15 },
      listening: { scale: 1.08, amplitude: 0.23, speed: 0.55, rotSpeed: 0.22 },
      thinking: { scale: 1.06, amplitude: 0.14, speed: 0.28, rotSpeed: 0.08 },
      speaking: { scale: 1.1, amplitude: 0.26, speed: 0.72, rotSpeed: 0.28 },
    };

    let current = { ...MAP[stateRef.current] };
    let tweenFrom = { ...current };
    let tweenTarget = { ...MAP[stateRef.current] };
    let tweenStart = 0;
    const TWEEN_DURATION = 0.35;
    const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

    const onClick = () => toggleRef.current?.();
    renderer.domElement.style.cursor = "pointer";
    renderer.domElement.addEventListener("click", onClick);

    const clock = new THREE.Clock();
    let lastState = stateRef.current;
    let running = false;

    const animate = () => {
      raf.current = requestAnimationFrame(animate);
      const t = clock.getElapsedTime();
      if (stateRef.current !== lastState) {
        tweenFrom = { ...current };
        tweenTarget = { ...MAP[stateRef.current] };
        tweenStart = t;
        lastState = stateRef.current;
      }
      const elapsed = t - tweenStart;
      const progress = Math.min(elapsed / TWEEN_DURATION, 1);
      const eased = easeOutCubic(progress);
      current.scale = lerp(tweenFrom.scale, tweenTarget.scale, eased);
      current.amplitude = lerp(tweenFrom.amplitude, tweenTarget.amplitude, eased);
      current.speed = lerp(tweenFrom.speed, tweenTarget.speed, eased);
      current.rotSpeed = lerp(tweenFrom.rotSpeed, tweenTarget.rotSpeed, eased);
      sphere.scale.setScalar(current.scale);
      material.uniforms.uTime.value = t;
      material.uniforms.uAmplitude.value = current.amplitude;
      material.uniforms.uSpeed.value = current.speed;
      sphere.rotation.y = t * current.rotSpeed;
      sphere.rotation.x = Math.sin(t * 0.08) * 0.08;
      renderer.render(scene, camera);
    };

    // Nothing renders while the orb is off screen or the window is in the
    // background — the loop is cancelled, not just skipped.
    const start = () => {
      if (running) return;
      running = true;
      clock.getDelta();
      animate();
    };
    const stop = () => {
      if (!running) return;
      running = false;
      cancelAnimationFrame(raf.current);
    };

    let onScreen = true;
    const sync = () => (onScreen && !document.hidden ? start() : stop());

    const io = new IntersectionObserver((entries) => {
      onScreen = entries[0]!.isIntersecting;
      sync();
    });
    io.observe(container);
    document.addEventListener("visibilitychange", sync);
    sync();

    return () => {
      stop();
      io.disconnect();
      document.removeEventListener("visibilitychange", sync);
      renderer.domElement.removeEventListener("click", onClick);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
    };
  }, [size]);

  return <div ref={containerRef} className={className} style={{ width: size, height: size }} />;
}
