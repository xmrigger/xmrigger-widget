import React from 'react';

/**
 * FuelGauge — SVG semicircle arc gauge (180°→0°, top-center)
 *
 * Color zones: 0-30% green, 30-40% yellow, 40-43% orange, >43% red
 */

const W  = 160;
const H  = 80;
const CX = 80;
const CY = 78;
const R  = 60;
const SW = 10;   // stroke width

function polar(angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: CX + R * Math.cos(rad),
    y: CY - R * Math.sin(rad),
  };
}

// Arc path from angle a1 to a2 (both in 0-180 from right, counter-clockwise)
function arc(a1Deg, a2Deg) {
  if (Math.abs(a1Deg - a2Deg) < 0.01) return '';
  const large = a2Deg - a1Deg > 180 ? 1 : 0;
  const p1 = polar(a1Deg);
  const p2 = polar(a2Deg);
  return `M ${p1.x} ${p1.y} A ${R} ${R} 0 ${large} 0 ${p2.x} ${p2.y}`;
}

// Map percentage (0.0–1.0) to angle (0°=right, 180°=left, sweeping counter-clockwise)
// 0% → 180° (left), 100% → 0° (right)
function pctToAngle(pct) {
  return 180 - (Math.min(Math.max(pct, 0), 1)) * 180;
}

function gaugeColor(pct) {
  if (pct > 0.43) return '#ff2222';
  if (pct > 0.40) return '#ff8800';
  if (pct > 0.30) return '#ffcc00';
  return '#00e676';
}

export default function FuelGauge({ pct, threshold = 0.43 }) {
  const hasPct  = pct != null;
  const safePct = hasPct ? Math.min(Math.max(pct, 0), 1) : 0;
  const color   = hasPct ? gaugeColor(safePct) : '#333';

  // Zone boundaries
  const a0   = 180;  // 0% left
  const a30  = pctToAngle(0.30);
  const a40  = pctToAngle(0.40);
  const a43  = pctToAngle(0.43);
  const a100 = 0;    // right

  // Needle angle
  const needle = hasPct ? pctToAngle(safePct) : 180;

  return (
    <svg
      width={W}
      height={H + 6}
      viewBox={`0 0 ${W} ${H + 6}`}
      style={{ display: 'block' }}
    >
      {/* Background track */}
      <path
        d={arc(0, 180)}
        fill="none"
        stroke="rgba(255,255,255,0.06)"
        strokeWidth={SW}
        strokeLinecap="round"
      />

      {/* Zone: green 0–30% */}
      <path d={arc(a30, a0)} fill="none" stroke="rgba(0,230,118,0.20)" strokeWidth={SW} />
      {/* Zone: yellow 30–40% */}
      <path d={arc(a40, a30)} fill="none" stroke="rgba(255,204,0,0.20)" strokeWidth={SW} />
      {/* Zone: orange 40–43% */}
      <path d={arc(a43, a40)} fill="none" stroke="rgba(255,136,0,0.20)" strokeWidth={SW} />
      {/* Zone: red 43–100% */}
      <path d={arc(a100, a43)} fill="none" stroke="rgba(255,34,34,0.20)" strokeWidth={SW} />

      {/* Threshold tick */}
      {(() => {
        const tp = polar(a43);
        const ti = polar2(a43, R - 14);
        const to = polar2(a43, R + 4);
        return (
          <line
            x1={ti.x} y1={ti.y} x2={to.x} y2={to.y}
            stroke="#ff8800" strokeWidth="1.5" opacity="0.7"
          />
        );
      })()}

      {/* Filled arc from 0% up to current pct */}
      {hasPct && safePct > 0.001 && (
        <path
          d={arc(needle, a0)}
          fill="none"
          stroke={color}
          strokeWidth={SW}
          strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 4px ${color})` }}
        />
      )}

      {/* Needle */}
      {hasPct && (() => {
        const tip  = polar2(needle, R - 4);
        const base = polar2(needle, R - SW - 4);
        return (
          <line
            x1={base.x} y1={base.y} x2={tip.x} y2={tip.y}
            stroke="#fff" strokeWidth="2" strokeLinecap="round"
            opacity="0.9"
          />
        );
      })()}

      {/* Center pivot */}
      <circle cx={CX} cy={CY} r="4" fill="#1a1a22" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
    </svg>
  );
}

// Polar with custom radius
function polar2(angleDeg, r) {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: CX + r * Math.cos(rad),
    y: CY - r * Math.sin(rad),
  };
}
