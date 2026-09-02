'use strict'

const fs = require('node:fs')
const { PNG } = require('pngjs')

const MIN_BUTTON_SIZE = 47
const MAX_BUTTON_SIZE = 49

function fail(message, stage) {
  const error = new Error(message)
  error.stage = stage
  throw error
}

function finiteBox(value) {
  return value && ['left', 'top', 'width', 'height'].every((key) => Number.isFinite(Number(value[key])))
}

function assertStepperButtonGeometry(boxes, viewport, stage) {
  const viewportWidth = Number(viewport && viewport.windowWidth)
  const viewportHeight = Number(viewport && viewport.windowHeight)
  if (!Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight)
    || !Array.isArray(boxes) || boxes.length !== 2 || boxes.some((box) => !finiteBox(box))) {
    fail('planner duration button geometry is invalid', stage)
  }
  return boxes.map((box, buttonIndex) => {
    const normalized = Object.fromEntries(
      ['left', 'top', 'width', 'height'].map((key) => [key, Number(box[key])]),
    )
    if (normalized.width < MIN_BUTTON_SIZE || normalized.width > MAX_BUTTON_SIZE
      || normalized.height < MIN_BUTTON_SIZE || normalized.height > MAX_BUTTON_SIZE
      || normalized.left < -1 || normalized.top < -1
      || normalized.left + normalized.width > viewportWidth + 1
      || normalized.top + normalized.height > viewportHeight + 1) {
      fail(`planner duration button ${buttonIndex} is outside its stable touch target`, stage)
    }
    return normalized
  })
}

function srgbChannel(value) {
  const channel = Math.max(0, Math.min(255, Number(value))) / 255
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

function oklab(rgb) {
  const red = srgbChannel(rgb[0])
  const green = srgbChannel(rgb[1])
  const blue = srgbChannel(rgb[2])
  const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue)
  const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue)
  const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function perceptualDistance(left, right) {
  const first = oklab(left)
  const second = oklab(right)
  return Math.sqrt(first.reduce((sum, value, index) => sum + (value - second[index]) ** 2, 0))
}

function quantile(values, fraction) {
  if (!values.length) return 0
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.floor((ordered.length - 1) * fraction)))]
}

function medianColor(colors) {
  return [0, 1, 2].map((channel) => quantile(colors.map((color) => color[channel]), 0.5))
}

function pixel(png, x, y) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return null
  const index = (png.width * y + x) << 2
  if (png.data[index + 3] < 192) return null
  return [png.data[index], png.data[index + 1], png.data[index + 2]]
}

function screenshotTransform(png, viewport, stage) {
  const viewportWidth = Number(viewport && viewport.windowWidth)
  const viewportHeight = Number(viewport && viewport.windowHeight)
  const scale = png.width / viewportWidth
  const offsetY = png.height - viewportHeight * scale
  if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(offsetY)
    || offsetY < -1 || offsetY > png.height * 0.35) {
    fail('planner duration glyph evidence scale is invalid', stage)
  }
  return { scaleX: scale, scaleY: scale, offsetY: Math.max(0, offsetY) }
}

function collectFractionalRegion(png, box, transform, region) {
  const { scaleX, scaleY, offsetY } = transform
  const left = Math.max(0, Math.floor((box.left + box.width * region[0]) * scaleX))
  const right = Math.min(png.width, Math.ceil((box.left + box.width * region[1]) * scaleX))
  const top = Math.max(0, Math.floor(offsetY + (box.top + box.height * region[2]) * scaleY))
  const bottom = Math.min(png.height, Math.ceil(offsetY + (box.top + box.height * region[3]) * scaleY))
  const colors = []
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const color = pixel(png, x, y)
      if (color) colors.push(color)
    }
  }
  return colors
}

function pointBounds(points) {
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  }
}

function glyphAxisEvidence(points, center, axis) {
  const selected = points.filter((point) => Math.abs(point[axis === 'x' ? 'y' : 'x'] - center[axis === 'x' ? 1 : 0]) <= 5)
  const values = selected.map((point) => point[axis])
  if (!values.length) return { bins: 0, span: 0, before: false, after: false }
  const bins = new Set(values.map((value) => Math.floor(value)))
  const minimum = Math.min(...values)
  const maximum = Math.max(...values)
  const midpoint = axis === 'x' ? center[0] : center[1]
  return {
    bins: bins.size,
    span: maximum - minimum,
    // DevTools screenshots can map a centered CSS glyph half a layout pixel off
    // the reported element box after native-title-bar and DPR conversion.
    before: minimum <= midpoint - 2.5,
    after: maximum >= midpoint + 2.5,
  }
}

function analyzeStepperGlyphs(png, boxes, viewport, stage) {
  if (!png || !Number.isFinite(png.width) || !Number.isFinite(png.height) || !png.data) {
    fail('planner duration glyph PNG is invalid', stage)
  }
  const normalizedBoxes = assertStepperButtonGeometry(boxes, viewport, stage)
  const transform = screenshotTransform(png, viewport, stage)
  const { scaleX, scaleY, offsetY } = transform
  const symbols = ['minus', 'plus']
  const backgroundRegions = [
    [0.14, 0.30, 0.14, 0.30], [0.70, 0.86, 0.14, 0.30],
    [0.14, 0.30, 0.70, 0.86], [0.70, 0.86, 0.70, 0.86],
  ]

  return normalizedBoxes.map((box, buttonIndex) => {
    const backgroundSamples = backgroundRegions.flatMap((region) => (
      collectFractionalRegion(png, box, transform, region)
    ))
    if (backgroundSamples.length < 16) fail(`planner duration button ${buttonIndex} has no stable background sample`, stage)
    const background = medianColor(backgroundSamples)
    const backgroundNoise = quantile(
      backgroundSamples.map((color) => perceptualDistance(color, background)),
      0.95,
    )
    // OKLab distance is theme-independent. Keep the floor low enough for the
    // native disabled opacity while staying above local background noise.
    const threshold = Math.max(0.012, backgroundNoise + 0.008)
    const left = Math.max(0, Math.floor((box.left + box.width * 0.18) * scaleX))
    const right = Math.min(png.width, Math.ceil((box.left + box.width * 0.82) * scaleX))
    const top = Math.max(0, Math.floor(offsetY + (box.top + box.height * 0.18) * scaleY))
    const bottom = Math.min(png.height, Math.ceil(offsetY + (box.top + box.height * 0.82) * scaleY))
    const points = []
    let maximumDistance = 0
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const color = pixel(png, x, y)
        if (!color) continue
        const distance = perceptualDistance(color, background)
        maximumDistance = Math.max(maximumDistance, distance)
        if (distance >= threshold) {
          points.push({
            x: (x + 0.5) / scaleX - box.left,
            y: (y + 0.5 - offsetY) / scaleY - box.top,
          })
        }
      }
    }

    const symbol = symbols[buttonIndex]
    const minimumArea = symbol === 'plus' ? 8 : 5
    const normalizedArea = points.length / (scaleX * scaleY)
    const center = [box.width / 2, box.height / 2]
    const horizontal = glyphAxisEvidence(points, center, 'x')
    const vertical = glyphAxisEvidence(points, center, 'y')
    const crossesCenter = points.some((point) => (
      Math.abs(point.x - center[0]) <= 3 && Math.abs(point.y - center[1]) <= 3
    ))
    const horizontalVisible = horizontal.bins >= 7 && horizontal.span >= 7
      && horizontal.before && horizontal.after
    const verticalVisible = vertical.bins >= 7 && vertical.span >= 7
      && vertical.before && vertical.after
    const bounds = points.length ? pointBounds(points) : { width: 0, height: 0 }
    const minusShape = symbol !== 'minus'
      || (bounds.height <= 6 && bounds.height <= Math.max(2, bounds.width * 0.45))
    const offAxisPixels = points.filter((point) => (
      Math.abs(point.x - center[0]) > 3 && Math.abs(point.y - center[1]) > 3
    )).length
    const offAxisRatio = points.length ? offAxisPixels / points.length : 1
    const boundsArea = Math.max(1, (bounds.width + 1) * (bounds.height + 1))
    const fillRatio = normalizedArea / boundsArea
    const plusShape = symbol !== 'plus' || (offAxisRatio <= 0.18 && fillRatio <= 0.72)
    if (normalizedArea < minimumArea || maximumDistance < threshold + 0.006
      || !crossesCenter || !horizontalVisible || (symbol === 'plus' && !verticalVisible)
      || !minusShape || !plusShape) {
      fail(`planner duration button ${buttonIndex} has no visible centered ${symbol} glyph`, stage)
    }
    return {
      buttonIndex,
      symbol,
      foregroundPixels: points.length,
      normalizedArea,
      threshold,
      maximumDistance,
      horizontalSpan: horizontal.span,
      verticalSpan: vertical.span,
      offAxisRatio,
      fillRatio,
    }
  })
}

function assertPngStepperGlyphs(targetPath, boxes, viewport, stage) {
  return analyzeStepperGlyphs(PNG.sync.read(fs.readFileSync(targetPath)), boxes, viewport, stage)
}

module.exports = {
  analyzeStepperGlyphs,
  assertPngStepperGlyphs,
  assertStepperButtonGeometry,
  perceptualDistance,
}
