/**
 * The Phoebe night sky: a deterministic star field on a fixed canvas, shared by the landing page and the app.
 * Twinkles unless the viewer prefers reduced motion. Returns a cleanup function.
 */
export function mountStars(canvas: HTMLCanvasElement, opts: { brightness?: number; density?: number } = {}) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  const brightness = opts.brightness ?? 1;
  const density = opts.density ?? 1;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  type Star = { x: number; y: number; r: number; a: number; tw: number; ph: number; hue: number };
  let list: Star[] = [];
  let w = 0;
  let h = 0;
  let raf = 0;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  // deterministic so a resize doesn't reshuffle the sky
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  const build = () => {
    w = innerWidth;
    h = innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed = 7;
    const n = Math.round(((w * h) / 4200) * density);
    list = Array.from({ length: n }, () => ({
      x: rnd() * w,
      y: rnd() * h,
      r: rnd() < 0.92 ? 0.4 + rnd() * 0.7 : 1.1 + rnd() * 0.8,
      a: (0.25 + rnd() * 0.6) * brightness,
      tw: 0.4 + rnd() * 1.6,
      ph: rnd() * Math.PI * 2,
      hue: rnd(),
    }));
  };
  const draw = (t: number) => {
    ctx.clearRect(0, 0, w, h);
    for (const s of list) {
      const a = reduceMotion ? s.a : s.a * (0.65 + 0.35 * Math.sin(t * 0.001 * s.tw + s.ph));
      ctx.fillStyle = s.hue < 0.75 ? `rgba(230,234,248,${a})` : s.hue < 0.9 ? `rgba(190,180,255,${a})` : `rgba(160,205,255,${a})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!reduceMotion) raf = requestAnimationFrame(draw);
  };
  const onResize = () => {
    build();
    if (reduceMotion) draw(0);
  };
  build();
  addEventListener("resize", onResize);
  raf = requestAnimationFrame(draw);
  return () => {
    cancelAnimationFrame(raf);
    removeEventListener("resize", onResize);
  };
}
