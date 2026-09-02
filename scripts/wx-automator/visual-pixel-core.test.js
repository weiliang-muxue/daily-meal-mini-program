'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { PNG } = require('pngjs')
const {
  analyzeStepperGlyphs,
  assertStepperButtonGeometry,
  perceptualDistance,
} = require('./visual-pixel-core')

const VIEWPORT = { windowWidth: 96, windowHeight: 48 }
const BOXES = [
  { left: 0, top: 0, width: 48, height: 48 },
  { left: 48, top: 0, width: 48, height: 48 },
]

function fill(png, left, top, right, bottom, color) {
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const index = (png.width * y + x) << 2
      png.data[index] = color[0]
      png.data[index + 1] = color[1]
      png.data[index + 2] = color[2]
      png.data[index + 3] = 255
    }
  }
}

function stepperPng(background, minus, plus, options = {}) {
  const png = new PNG({ width: 96, height: 48 })
  fill(png, 0, 0, 96, 48, background)
  fill(png, 15, 22, 33, 26, minus)
  fill(png, 63, 22, 81, 26, plus)
  if (options.plusVertical !== false) fill(png, 70, 15, 74, 33, plus)
  return png
}

function solidPlusPng(background, minus, plus) {
  const png = stepperPng(background, minus, background, { plusVertical: false })
  fill(png, 68, 20, 77, 29, plus)
  return png
}

test('stepper geometry requires both dimensions near 48px and inside the viewport', () => {
  assert.deepEqual(assertStepperButtonGeometry(BOXES, VIEWPORT, 'GEOMETRY'), BOXES)
  assert.doesNotThrow(() => assertStepperButtonGeometry([
    { left: 0, top: 0, width: 47, height: 49 },
    { left: 47, top: 0, width: 49, height: 47 },
  ], VIEWPORT, 'GEOMETRY'))
  assert.throws(() => assertStepperButtonGeometry([
    { left: 0, top: 0, width: 48, height: 50 }, BOXES[1],
  ], VIEWPORT, 'GEOMETRY'), /stable touch target/)
  assert.throws(() => assertStepperButtonGeometry([
    BOXES[0], { left: 48, top: -2, width: 48, height: 48 },
  ], VIEWPORT, 'GEOMETRY'), /stable touch target/)
})

test('perceptual glyph gate accepts enabled minus and pale disabled plus in light mode', () => {
  const evidence = analyzeStepperGlyphs(
    stepperPng([237, 240, 237], [23, 107, 70], [213, 217, 214]),
    BOXES,
    VIEWPORT,
    'LIGHT_GLYPHS',
  )
  assert.equal(evidence[0].symbol, 'minus')
  assert.equal(evidence[1].symbol, 'plus')
  assert(evidence[1].maximumDistance > evidence[1].threshold)
  assert(evidence[1].verticalSpan >= 7)
})

test('perceptual glyph gate accepts disabled rendering on a dark button', () => {
  const evidence = analyzeStepperGlyphs(
    stepperPng([39, 49, 43], [104, 116, 109], [104, 116, 109]),
    BOXES,
    VIEWPORT,
    'DARK_GLYPHS',
  )
  assert.equal(evidence.length, 2)
  assert(perceptualDistance([39, 49, 43], [104, 116, 109]) > evidence[1].threshold)
})

test('glyph gate rejects an invisible plus and a plus missing its vertical stroke', () => {
  assert.throws(() => analyzeStepperGlyphs(
    stepperPng([237, 240, 237], [23, 107, 70], [237, 240, 237]),
    BOXES,
    VIEWPORT,
    'INVISIBLE_PLUS',
  ), /visible centered plus glyph/)
  assert.throws(() => analyzeStepperGlyphs(
    stepperPng([237, 240, 237], [23, 107, 70], [213, 217, 214], { plusVertical: false }),
    BOXES,
    VIEWPORT,
    'BROKEN_PLUS',
  ), /visible centered plus glyph/)
})

test('glyph gate rejects a centered solid square masquerading as a plus', () => {
  assert.throws(() => analyzeStepperGlyphs(
    solidPlusPng([237, 240, 237], [23, 107, 70], [213, 217, 214]),
    BOXES,
    VIEWPORT,
    'SOLID_PLUS',
  ), /visible centered plus glyph/)
})
