// Shared SVG chart-drawing helpers used by index.html's three chart renderers
// (drawCombinedChart, renderOverviewChart, renderChart) — extracted because all three
// duplicated an identical SVG element builder and identical x/y pixel-scale math.
// See test/chart-dom.test.mjs for xScale/yScale/niceMax coverage.

export function createSvgElement(tag, attrs) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

// Maps a label index (0..count-1) to a pixel x position across the plot area. A
// single-label series has nothing to interpolate between, so it's centered instead.
export function xScale(count, plotWidth, marginLeft) {
  return (i) =>
    marginLeft +
    (count === 1 ? plotWidth / 2 : (i / (count - 1)) * plotWidth);
}

// Maps a value (0..max) to a pixel y position, inverted so larger values plot higher.
export function yScale(max, plotHeight, marginTop) {
  return (v) => marginTop + plotHeight - (v / max) * plotHeight;
}

// Rounds a raw max value up to a "nice" number for the axis ceiling — headroom (+15%)
// then rounded up to the nearest power-of-10 step, so gridlines land on round numbers
// instead of the exact (typically ugly) data max.
export function niceMax(rawMax) {
  const power = 10 ** Math.floor(Math.log10(rawMax || 1));
  return Math.ceil((rawMax * 1.15) / power) * power || 1;
}
