import type { SampledOutput } from "../../core/sheet/sampling";
import type { UnitSpec } from "../../core/sheet/units";
import { inUnit, sig } from "./weightFormat";

/** Empirical frequencies, conditional on valid trials; never suggest a fitted density. */
export function SampledDistribution({
  output,
  unit,
}: {
  readonly output: SampledOutput;
  readonly unit: UnitSpec | null;
}) {
  const distribution = output.distribution;
  if (!distribution) return null;
  const bins = distribution.histogram;
  const maxCount = Math.max(...bins.map((bin) => bin.count), 1);
  const min = bins[0].low;
  const max = bins[bins.length - 1].high;
  const scale = Math.max(Math.abs(min), Math.abs(max), 1);
  const range = max / scale - min / scale;
  const x = (value: number) =>
    range ? 24 + (552 * (value / scale - min / scale)) / range : 300;
  const nominal = "value" in output.nominal ? output.nominal.value : null;
  const mark = (value: number, color: string, key: string) =>
    Number.isFinite(value) && value >= min && value <= max ? (
      <line
        key={key}
        x1={x(value)}
        x2={x(value)}
        y1={10}
        y2={132}
        stroke={color}
        strokeWidth={2}
      />
    ) : null;
  const interval = distribution.quantiles;
  const describe = (value: number) => sig(inUnit(value, unit?.factor ?? 1));
  const suffix = unit?.label ? ` ${unit.label}` : "";
  return (
    <figure className="wsampled-distribution">
      <figcaption>
        Sampled distribution · {output.validTrials.toLocaleString()} valid
        trials{unit?.label ? ` · values in ${unit.label}` : ""}
      </figcaption>
      <svg
        viewBox="0 0 600 160"
        role="img"
        aria-label={`Histogram of ${output.validTrials} valid values from ${describe(min)} to ${describe(max)}${suffix}. Median ${describe(interval.p50)}, 95% interval ${describe(interval.p025)} to ${describe(interval.p975)}${nominal === null ? "" : `, nominal ${describe(nominal)}`}.`}
      >
        {bins.map((bin, index) => {
          const width = 552 / bins.length;
          const height = (bin.count / maxCount) * 112;
          return (
            <rect
              key={index}
              x={24 + index * width + 1}
              y={132 - height}
              width={Math.max(1, width - 2)}
              height={height}
              className="wsampled-bar"
            >
              <title>{`${describe(bin.low)} – ${describe(bin.high)}: ${bin.count} trials`}</title>
            </rect>
          );
        })}
        {min !== max && (
          <>
            <rect
              x={x(interval.p025)}
              y={127}
              width={Math.max(1, x(interval.p975) - x(interval.p025))}
              height={5}
              className="wsampled-interval"
            />
            {mark(interval.p50, "var(--ink)", "median")}
            {nominal !== null && mark(nominal, "var(--accent)", "nominal")}
          </>
        )}
        <text x={24} y={153}>
          {describe(min)}
        </text>
        <text x={576} y={153} textAnchor="end">
          {describe(max)}
        </text>
      </svg>
      <p>
        Bars: valid trials · line: median · band: 95% sampled interval · accent
        line: nominal (if in range).
      </p>
    </figure>
  );
}
