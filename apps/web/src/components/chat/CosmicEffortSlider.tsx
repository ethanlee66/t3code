import { useGT } from "gt-react";
import {
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { type CosmicBackdropController, mountCosmicBackdrop } from "./CosmicBackdropCanvas";
import {
  type CosmicDepthTier,
  indexFromTrackRatio,
  progressToTrackPercent,
  ratioFromPointerX,
  resolveCosmicDepthProfile,
  stopCenterPercent,
} from "./CosmicEffortSlider.logic";

export interface CosmicEffortOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string | undefined;
  readonly isDefault?: boolean | undefined;
}

const DRAG_THRESHOLD_PX = 5;

export function CosmicEffortSlider(props: {
  label: string;
  options: ReadonlyArray<CosmicEffortOption>;
  selectedId: string;
  disabled?: boolean;
  highlightMaxWhenUnlisted?: boolean;
  lockedNote?: string | undefined;
  onSelect: (id: string) => void;
}) {
  const gt = useGT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<CosmicBackdropController | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const cleanupDragRef = useRef<(() => void) | null>(null);
  const suppressClickRef = useRef(false);
  const suppressClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [drag, setDrag] = useState<{ ratio: number; index: number; scrubbing: boolean } | null>(
    null,
  );

  const clearSuppressClick = () => {
    if (suppressClickTimerRef.current !== null) {
      clearTimeout(suppressClickTimerRef.current);
      suppressClickTimerRef.current = null;
    }
    suppressClickRef.current = false;
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- removes window drag listeners and timers if the slider unmounts mid-drag
  useEffect(
    () => () => {
      cleanupDragRef.current?.();
      if (suppressClickTimerRef.current !== null) {
        clearTimeout(suppressClickTimerRef.current);
        suppressClickTimerRef.current = null;
      }
    },
    [],
  );

  const count = props.options.length;
  const committedIndex = props.options.findIndex((option) => option.id === props.selectedId);
  const displayIndex = drag
    ? drag.index
    : committedIndex >= 0
      ? committedIndex
      : props.highlightMaxWhenUnlisted && count > 0
        ? count - 1
        : 0;
  const displayOption = props.options[displayIndex] ?? props.options[0];
  const fallbackTier: CosmicDepthTier = props.highlightMaxWhenUnlisted ? 4 : 2;
  const profile = resolveCosmicDepthProfile({
    options: props.options,
    activeIndex: drag ? drag.index : committedIndex,
    fallbackTier,
    ...(drag ? { continuousProgress: drag.ratio } : {}),
  });

  const thumbPercent = progressToTrackPercent(profile.progress, count);
  const firstCenter = stopCenterPercent(0, count);

  const beginDragSession = (
    pointerId: number,
    initialClientX: number,
    immediate: boolean,
    captureTarget: HTMLElement | null,
  ) => {
    cleanupDragRef.current?.();
    const trackEl = trackRef.current;
    if (!trackEl || props.disabled || count <= 1) return;

    let active = immediate;
    let scrubbing = false;
    let latestIndex = committedIndex >= 0 ? committedIndex : 0;

    const updateFromClientX = (clientX: number, isScrubbing: boolean) => {
      const ratio = ratioFromPointerX(clientX, trackEl.getBoundingClientRect(), count);
      const index = indexFromTrackRatio(ratio, count);
      latestIndex = index;
      const nextRatio = isScrubbing ? ratio : count <= 1 ? 0.5 : index / (count - 1);
      setDrag({ ratio: nextRatio, index, scrubbing: isScrubbing });
    };

    if (immediate) {
      updateFromClientX(initialClientX, false);
      try {
        captureTarget?.setPointerCapture(pointerId);
      } catch {
        // Synthetic pointer events in tests may omit active pointer capture ids.
      }
    }

    const finish = (commit: boolean) => {
      cleanupDragRef.current?.();
      cleanupDragRef.current = null;
      if (active) {
        if (commit) {
          const picked = props.options[latestIndex];
          if (picked && picked.id !== props.selectedId) {
            props.onSelect(picked.id);
          }
        }
        setDrag(null);
      }
      if (suppressClickRef.current) {
        if (suppressClickTimerRef.current !== null) {
          clearTimeout(suppressClickTimerRef.current);
        }
        suppressClickTimerRef.current = setTimeout(() => {
          suppressClickTimerRef.current = null;
          suppressClickRef.current = false;
        }, 0);
      }
    };

    const handleMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      if (!scrubbing) {
        if (Math.abs(moveEvent.clientX - initialClientX) < DRAG_THRESHOLD_PX) return;
        scrubbing = true;
        active = true;
        if (!immediate) {
          suppressClickRef.current = true;
        }
      }
      updateFromClientX(moveEvent.clientX, true);
    };

    const handleUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      if (scrubbing) {
        updateFromClientX(upEvent.clientX, true);
      }
      finish(true);
    };

    const handleCancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId !== pointerId) return;
      finish(false);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleCancel);

    cleanupDragRef.current = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleCancel);
      try {
        if (captureTarget?.hasPointerCapture(pointerId)) {
          captureTarget.releasePointerCapture(pointerId);
        }
      } catch {
        // Ignore release errors when element already detached.
      }
    };
  };

  const handleSliderKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (props.disabled || count === 0) return;
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      nextIndex = Math.min(count - 1, displayIndex + 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      nextIndex = Math.max(0, displayIndex - 1);
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = count - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    event.stopPropagation();
    const target = props.options[nextIndex];
    if (target) props.onSelect(target.id);
  };

  const thumbFraction = thumbPercent / 100;
  const hasLockedNote = Boolean(props.lockedNote);
  const isScrubbing = Boolean(drag?.scrubbing);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts and disposes the imperative WebGL/Canvas2D cosmic backdrop renderer
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const controller = mountCosmicBackdrop(canvas);
    controllerRef.current = controller;
    return () => {
      controllerRef.current = null;
      controller.destroy();
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes slider tier and drag state to the imperative canvas renderer without React re-renders
  useEffect(() => {
    controllerRef.current?.update({
      tier: profile.tier,
      progress: profile.progress,
      thumbFraction,
      hasLockedNote,
      dragging: isScrubbing,
    });
  }, [profile.tier, profile.progress, thumbFraction, hasLockedNote, isScrubbing]);

  return (
    <div
      className="cosmic-effort-chamber"
      data-cosmic-tier={profile.tier}
      data-dragging={isScrubbing ? "" : undefined}
      data-disabled={props.disabled ? "" : undefined}
      data-has-locked-note={props.lockedNote ? "" : undefined}
    >
      <div data-cosmic-backdrop aria-hidden="true" className="pointer-events-none absolute inset-0">
        <canvas ref={canvasRef} className="block size-full" />
        <div className="cosmic-specular-bezel" />
        <div className="cosmic-iridescent-rim" />
      </div>

      <div className="relative z-10 flex flex-col gap-1.5 px-3 pt-4 pb-2.5">
        {props.lockedNote ? (
          <div className="cosmic-locked-pill mx-auto mb-0.5 max-w-full truncate rounded-full px-2.5 py-0.5 text-center text-2xs text-white/75">
            {props.lockedNote}
          </div>
        ) : null}

        <div
          ref={trackRef}
          role="slider"
          aria-orientation="horizontal"
          aria-label={props.label}
          aria-valuemin={0}
          aria-valuemax={Math.max(count - 1, 0)}
          aria-valuenow={displayIndex}
          aria-valuetext={displayOption?.label ?? ""}
          aria-disabled={props.disabled || undefined}
          tabIndex={-1}
          data-cosmic-slider-track
          onKeyDown={handleSliderKeyDown}
          onPointerDown={(event) => {
            if (event.button !== 0 || props.disabled || count <= 1) return;
            event.preventDefault();
            clearSuppressClick();
            beginDragSession(event.pointerId, event.clientX, true, event.currentTarget);
          }}
          className={cn(
            "group/cosmic-track relative h-7 w-full touch-none",
            props.disabled || count <= 1 ? "cursor-default" : "cursor-ew-resize",
          )}
        >
          {count > 1 ? (
            <div
              className="cosmic-track-rail pointer-events-none absolute top-1/2 -translate-y-1/2"
              style={{
                left: `${firstCenter}%`,
                right: `${firstCenter}%`,
              }}
            >
              <div
                className="cosmic-track-fill h-full overflow-hidden rounded-full"
                style={{ width: `${(profile.progress * 100).toFixed(3)}%` }}
              >
                <div className="cosmic-track-fill-beam h-full" />
              </div>
            </div>
          ) : null}

          {props.options.map((option, index) => {
            const left = stopCenterPercent(index, count);
            const active = index <= displayIndex;
            const current = index === displayIndex;
            return (
              <span
                key={option.id}
                aria-hidden="true"
                style={{ left: `${left}%` }}
                className={cn(
                  "pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-all duration-150",
                  current
                    ? "scale-0 opacity-0"
                    : active
                      ? "cosmic-detent cosmic-detent-active"
                      : "cosmic-detent",
                )}
              />
            );
          })}

          {count > 0 ? (
            <div
              aria-hidden="true"
              style={{ left: `${thumbPercent.toFixed(3)}%` }}
              className="cosmic-slider-thumb pointer-events-none absolute top-1/2 size-7"
            >
              <div className="cosmic-slider-thumb-halo absolute inset-0 rounded-full" />
              <div className="cosmic-slider-thumb-core absolute top-1/2 left-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full group-hover/cosmic-track:scale-110" />
            </div>
          ) : null}
        </div>

        <div
          role="radiogroup"
          aria-label={props.label}
          className="relative grid"
          style={{ gridTemplateColumns: `repeat(${Math.max(count, 1)}, minmax(0, 1fr))` }}
        >
          {count > 0 ? (
            <div
              aria-hidden="true"
              className="cosmic-option-indicator pointer-events-none absolute inset-y-0 left-0 px-0.5"
              style={{
                width: `${(100 / count).toFixed(4)}%`,
                transform: `translate3d(${displayIndex * 100}%, 0, 0)`,
              }}
            >
              <div className="cosmic-option-indicator-pill size-full rounded-lg" />
            </div>
          ) : null}
          {props.options.map((option, index) => {
            const committedSelected = option.id === props.selectedId;
            const visualSelected = drag ? index === drag.index : committedSelected;
            const tabStop = committedIndex >= 0 ? committedSelected : index === 0;
            const rowProps = {
              type: "button" as const,
              role: "radio" as const,
              "aria-checked": committedSelected,
              disabled: props.disabled,
              "data-effort-row": true,
              "data-effort-level": option.label,
              tabIndex: tabStop ? 0 : -1,
              onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
                if (event.button !== 0 || props.disabled || count <= 1) return;
                clearSuppressClick();
                beginDragSession(event.pointerId, event.clientX, false, null);
              },
              onKeyDown: () => {
                clearSuppressClick();
              },
              onClick: () => {
                if (suppressClickRef.current) {
                  clearSuppressClick();
                  return;
                }
                props.onSelect(option.id);
              },
              className: cn(
                "relative z-10 flex h-7 min-w-0 cursor-pointer items-center justify-center rounded-lg text-center tracking-tight outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/75 disabled:cursor-not-allowed disabled:opacity-64",
                count >= 5 ? "px-0.5 text-2xs sm:px-1 sm:text-xs" : "px-1 text-xs",
                visualSelected
                  ? "cosmic-option-selected font-medium text-white"
                  : "cosmic-option-idle",
              ),
            };

            const content = (
              <>
                <span className="truncate">{option.label}</span>
                {option.isDefault ? (
                  <span className="sr-only">
                    {gt("Default", { $context: "marks the default option" })}
                  </span>
                ) : null}
              </>
            );

            if (!option.description) {
              return (
                <button key={option.id} {...rowProps}>
                  {content}
                </button>
              );
            }

            return (
              <Tooltip key={option.id}>
                <TooltipTrigger render={<button {...rowProps} />}>{content}</TooltipTrigger>
                <TooltipPopup side="top" className="max-w-56">
                  {option.description}
                </TooltipPopup>
              </Tooltip>
            );
          })}
        </div>
      </div>
    </div>
  );
}
