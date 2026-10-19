import { useMemo, useSyncExternalStore } from "react";
import { pixelAvatar, SPRITE_SIZE } from "../../shared/avatar";
import type { BotAvatar } from "../../shared/bot";
import type { PixelRun } from "../../shared/pixel";

const darkQuery = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

/** Whether the page is in dark mode; avatars tone down their pastel backgrounds. */
export function useDark(): boolean {
  return useSyncExternalStore(
    (notify) => {
      darkQuery?.addEventListener("change", notify);
      return () => darkQuery?.removeEventListener("change", notify);
    },
    () => darkQuery?.matches ?? false,
  );
}

function radiusFor(shape: BotAvatar["shape"] | undefined, size: number): number {
  return shape === "square" ? size * 0.12 : shape === "rounded" ? size * 0.28 : size / 2;
}

/** A generated sprite as SVG: one rect per same-coloured run. */
function PixelSprite({ sprite, size, radius, grid, inset }: { sprite: { background: string; rows: PixelRun[][] }; size: number; radius: number; grid: number; inset: boolean }) {
  const inner = !inset || size <= 24 ? grid : grid / 0.82;
  const offset = (inner - grid) / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${inner} ${inner}`} style={{ borderRadius: radius, flexShrink: 0, display: "block" }} shapeRendering="crispEdges" aria-hidden="true">
      <rect width={inner} height={inner} fill={sprite.background} />
      <g transform={`translate(${offset} ${offset})`}>
        {sprite.rows.map((runs, y) => runs.map((run) => (run.color ? <rect key={`${y}-${run.x}`} x={run.x} y={y} width={run.width} height={1.02} fill={run.color} /> : null)))}
      </g>
    </svg>
  );
}

export function Avatar({ avatar, size }: { avatar: Pick<BotAvatar, "seed"> & Partial<BotAvatar>; size: number }) {
  const dark = useDark();
  const palette = avatar.palette ?? null;
  const sprite = useMemo(() => pixelAvatar(avatar.seed, palette, { dark }), [avatar.seed, palette, dark]);
  const radius = radiusFor(avatar.shape, size);
  if (avatar.imageUrl) return <img src={avatar.imageUrl} width={size} height={size} style={{ borderRadius: radius, objectFit: "cover", flexShrink: 0 }} alt="" />;
  return <PixelSprite sprite={sprite} size={size} radius={radius} grid={SPRITE_SIZE} inset />;
}

/** A group chat's members as overlapping avatars, the first few of them. */
export function AvatarStack({ avatars, size, max = 3 }: { avatars: readonly (Pick<BotAvatar, "seed"> & Partial<BotAvatar>)[]; size: number; max?: number }) {
  const shown = avatars.slice(0, max);
  const overlap = Math.round(size * 0.38);
  return (
    <span className="avatar-stack" style={{ width: shown.length ? size + (shown.length - 1) * (size - overlap) : size, height: size }} aria-hidden="true">
      {shown.map((avatar, index) => (
        <span key={index} className="avatar-stack-item" style={{ left: index * (size - overlap), zIndex: shown.length - index }}>
          <Avatar avatar={avatar} size={size} />
        </span>
      ))}
    </span>
  );
}
