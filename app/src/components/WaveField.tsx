import { useEffect, useRef } from "react";

/**
 * The hero's wave field: layered sine curves in gold, drawn on a canvas.
 *
 * Hand-rolled rather than a library. Three reasons, in order of how much they
 * mattered: the bundle is already the whole dashboard and a WebGL wrapper
 * would dwarf this file; a canvas 2D context works everywhere without a
 * fallback path; and the motion has to say something specific — these are
 * budget lines, so they breathe rather than crash, and they never touch the
 * ceiling.
 *
 * Behaviour that is deliberate, not incidental:
 *   - respects prefers-reduced-motion by drawing one static frame
 *   - stops entirely when scrolled out of view (IntersectionObserver), so it
 *     costs nothing while a reader is further down the page
 *   - caps devicePixelRatio at 2 — beyond that it is invisible and expensive
 *   - a fixed timestep decoupled from frame rate, so a 120Hz display shows the
 *     same motion as a 60Hz one instead of running twice as fast
 */

interface Layer {
  amplitude: number;
  wavelength: number;
  speed: number;
  y: number;
  width: number;
  alpha: number;
  hue: string;
}

// Gold, cooling into the category colours as the layers recede.
// Positioned in the lower third: this is a horizon the type sits above, not a
// texture behind it. Anything above y=0.62 collides with the sub-paragraph.
const LAYERS: Layer[] = [
  { amplitude: 30, wavelength: 0.0042, speed: 0.22, y: 0.68, width: 1.7, alpha: 0.95, hue: "212, 168, 67" },
  { amplitude: 40, wavelength: 0.0031, speed: -0.16, y: 0.74, width: 1.3, alpha: 0.62, hue: "212, 168, 67" },
  { amplitude: 24, wavelength: 0.0058, speed: 0.31, y: 0.79, width: 1.1, alpha: 0.46, hue: "169, 129, 44" },
  { amplitude: 52, wavelength: 0.0023, speed: -0.11, y: 0.85, width: 1.0, alpha: 0.32, hue: "57, 135, 229" },
  { amplitude: 36, wavelength: 0.0037, speed: 0.19, y: 0.92, width: 1.0, alpha: 0.26, hue: "25, 158, 112" },
];

export function WaveField() {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0;
    let height = 0;
    let raf = 0;
    let t = 0;
    let last = 0;
    let visible = true;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);

      for (const layer of LAYERS) {
        const baseY = height * layer.y;
        ctx.beginPath();
        // 2px steps: at this amplitude the curve is smooth and it halves the
        // path length on wide displays.
        for (let x = 0; x <= width; x += 2) {
          // Two summed sines at incommensurate frequencies, so the crest
          // pattern never visibly repeats.
          const y =
            baseY +
            Math.sin(x * layer.wavelength + t * layer.speed) * layer.amplitude +
            Math.sin(x * layer.wavelength * 0.47 - t * layer.speed * 0.6) *
              layer.amplitude *
              0.35;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        const grad = ctx.createLinearGradient(0, 0, width, 0);
        grad.addColorStop(0, `rgba(${layer.hue}, 0)`);
        grad.addColorStop(0.18, `rgba(${layer.hue}, ${layer.alpha})`);
        grad.addColorStop(0.82, `rgba(${layer.hue}, ${layer.alpha})`);
        grad.addColorStop(1, `rgba(${layer.hue}, 0)`);
        ctx.strokeStyle = grad;
        ctx.lineWidth = layer.width;
        ctx.stroke();
      }
    };

    const frame = (now: number) => {
      if (!visible) {
        raf = 0;
        return;
      }
      // Fixed timestep, clamped: a background tab returns a huge delta and
      // would otherwise jump the phase by seconds on the next frame.
      const dt = last ? Math.min((now - last) / 1000, 0.05) : 0.016;
      last = now;
      t += dt;
      draw();
      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (raf || reduced) return;
      last = 0;
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    resize();
    draw();
    if (!reduced) start();

    const onResize = () => {
      resize();
      draw();
    };
    window.addEventListener("resize", onResize);

    const io = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        if (visible) start();
        else stop();
      },
      { threshold: 0 }
    );
    io.observe(canvas);

    return () => {
      stop();
      io.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return <canvas className="wavefield" ref={ref} aria-hidden="true" />;
}
