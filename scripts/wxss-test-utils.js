'use strict'

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

function splitTopLevel(value, separator) {
  const parts = []
  let start = 0
  let depth = 0
  let quote = ''

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (quote) {
      if (character === quote && value[index - 1] !== '\\') quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '(' || character === '[') depth += 1
    if (character === ')' || character === ']') depth -= 1
    if (character === separator && depth === 0) {
      parts.push(value.slice(start, index))
      start = index + 1
    }
  }
  parts.push(value.slice(start))
  return parts
}

function findOpeningBrace(source, start, end) {
  let quote = ''
  for (let index = start; index < end; index += 1) {
    const character = source[index]
    if (quote) {
      if (character === quote && source[index - 1] !== '\\') quote = ''
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '{') return index
  }
  return -1
}

function findClosingBrace(source, opening, end) {
  let depth = 1
  let quote = ''
  for (let index = opening + 1; index < end; index += 1) {
    const character = source[index]
    if (quote) {
      if (character === quote && source[index - 1] !== '\\') quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '{') depth += 1
    if (character === '}') depth -= 1
    if (depth === 0) return index
  }
  throw new Error(`Unclosed WXSS block at offset ${opening}`)
}

function parseDeclarations(body) {
  return splitTopLevel(body, ';').map((entry, index) => {
    const colon = entry.indexOf(':')
    if (colon < 1) return null
    const property = entry.slice(0, colon).trim().toLowerCase()
    let value = entry.slice(colon + 1).trim()
    const important = /\s*!important\s*$/i.test(value)
    if (important) value = value.replace(/\s*!important\s*$/i, '').trim()
    return { property, value, important, declarationOrder: index }
  }).filter(Boolean)
}

function normalizeSelector(selector) {
  return selector.trim().replace(/\s+/g, ' ')
}

function normalizeMedia(media) {
  return media.trim().replace(/\s+/g, ' ')
}

function parseWxss(input) {
  const source = stripComments(input)
  const rules = []
  let sourceOrder = 0

  function parseRange(start, end, media) {
    let cursor = start
    while (cursor < end) {
      while (cursor < end && /\s|;/.test(source[cursor])) cursor += 1
      if (cursor >= end) break
      const opening = findOpeningBrace(source, cursor, end)
      if (opening < 0) break
      const prelude = source.slice(cursor, opening).trim()
      const closing = findClosingBrace(source, opening, end)
      const bodyStart = opening + 1

      if (/^@media\b/i.test(prelude)) {
        const query = normalizeMedia(prelude.replace(/^@media\s*/i, ''))
        parseRange(bodyStart, closing, [...media, query])
      } else if (!prelude.startsWith('@')) {
        const selectors = splitTopLevel(prelude, ',').map(normalizeSelector).filter(Boolean)
        const declarations = parseDeclarations(source.slice(bodyStart, closing))
        if (selectors.length && declarations.length) {
          rules.push({ selectors, declarations, media: [...media], sourceOrder })
          sourceOrder += 1
        }
      }
      cursor = closing + 1
    }
  }

  parseRange(0, source.length, [])
  return rules
}

function mediaQueryMatches(query, viewport) {
  return splitTopLevel(query, ',').some((clauseValue) => {
    const clause = clauseValue.trim()
    const conditions = [...clause.matchAll(/\(([^()]*)\)/g)].map((match) => match[1].trim())
    const residue = clause.replace(/\([^()]*\)/g, '').replace(/\band\b/gi, '').replace(/\b(?:all|screen)\b/gi, '').trim()
    if (residue) throw new Error(`Unsupported media query syntax: ${query}`)
    return conditions.every((condition) => {
      const separator = condition.indexOf(':')
      if (separator < 1) throw new Error(`Unsupported media condition: ${condition}`)
      const feature = condition.slice(0, separator).trim().toLowerCase()
      const value = condition.slice(separator + 1).trim().toLowerCase()
      if (feature === 'orientation') {
        const orientation = viewport.orientation || (viewport.width > viewport.height ? 'landscape' : 'portrait')
        return orientation === value
      }
      if (feature === 'prefers-color-scheme') return (viewport.colorScheme || 'light') === value
      if (feature === 'prefers-reduced-motion') return (viewport.reducedMotion || 'no-preference') === value
      const length = value.match(/^(\d+(?:\.\d+)?)px$/)
      if (!length) throw new Error(`Unsupported media length: ${condition}`)
      const threshold = Number(length[1])
      if (feature === 'min-width') return viewport.width >= threshold
      if (feature === 'max-width') return viewport.width <= threshold
      if (feature === 'min-height') return viewport.height >= threshold
      if (feature === 'max-height') return viewport.height <= threshold
      throw new Error(`Unsupported media feature: ${feature}`)
    })
  })
}

function selectorSpecificity(selector) {
  const ids = (selector.match(/#[\w-]+/g) || []).length
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length
  const elements = (selector.replace(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|::?[\w-]+/g, ' ')
    .match(/(?:^|[\s>+~])(?:[a-zA-Z][\w-]*|\*)/g) || []).filter((token) => !token.includes('*')).length
  return (ids * 100) + (classes * 10) + elements
}

function ruleApplies(rule, viewport) {
  return rule.media.every((query) => mediaQueryMatches(query, viewport))
}

function computedStyle(rules, selectors, viewport) {
  const requested = new Set((Array.isArray(selectors) ? selectors : [selectors]).map(normalizeSelector))
  const winners = new Map()

  for (const rule of rules) {
    if (!ruleApplies(rule, viewport)) continue
    for (const selector of rule.selectors) {
      if (!requested.has(selector)) continue
      const specificity = selectorSpecificity(selector)
      for (const declaration of rule.declarations) {
        const candidate = {
          ...declaration,
          specificity,
          sourceOrder: rule.sourceOrder,
        }
        const current = winners.get(declaration.property)
        const wins = !current
          || Number(candidate.important) > Number(current.important)
          || (candidate.important === current.important && candidate.specificity > current.specificity)
          || (candidate.important === current.important && candidate.specificity === current.specificity
            && (candidate.sourceOrder > current.sourceOrder
              || (candidate.sourceOrder === current.sourceOrder
                && candidate.declarationOrder >= current.declarationOrder)))
        if (wins) winners.set(declaration.property, candidate)
      }
    }
  }

  return Object.fromEntries([...winners].map(([property, declaration]) => [property, declaration.value]))
}

function rulesForSelector(rules, selector, options = {}) {
  const normalizedSelector = normalizeSelector(selector)
  const normalizedMedia = options.media === undefined ? null : normalizeMedia(options.media)
  return rules.filter((rule) => {
    if (!rule.selectors.includes(normalizedSelector)) return false
    if (options.unconditional && rule.media.length) return false
    if (normalizedMedia !== null && !rule.media.includes(normalizedMedia)) return false
    return true
  })
}

function declarationValues(rules, selector, property, options = {}) {
  return rulesForSelector(rules, selector, options).flatMap((rule) => rule.declarations
    .filter((declaration) => declaration.property === property.toLowerCase())
    .map((declaration) => declaration.value))
}

function lengthToPx(input, viewportWidth, options = {}) {
  if (input === undefined || input === null) return 0
  const percentBase = options.percentBase === undefined ? viewportWidth : options.percentBase
  const safeArea = options.safeArea || {}
  let value = String(input).trim()
  if (value === '0') return 0
  if (/^calc\(.+\)$/.test(value)) value = value.slice(5, -1)
  value = value.replace(/(?:env|constant)\(safe-area-inset-(left|right|top|bottom)\)/g,
    (_, inset) => `${Number(safeArea[inset] || 0)}px`)
  const compact = value.replace(/\s+/g, '')
  const terms = compact.match(/[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:rpx|px|%|vw)/g)
  if (!terms || terms.join('') !== compact.replace(/^\+/, '')) {
    throw new Error(`Unsupported CSS length: ${input}`)
  }
  return terms.reduce((total, term) => {
    const match = term.match(/^([+-]?\d+(?:\.\d+)?)(rpx|px|%|vw)$/)
    const numeric = Number(match[1])
    if (match[2] === 'rpx') return total + (numeric * viewportWidth / 750)
    if (match[2] === '%') return total + (numeric * percentBase / 100)
    if (match[2] === 'vw') return total + (numeric * viewportWidth / 100)
    return total + numeric
  }, 0)
}

function shorthandSide(value, side) {
  const tokens = splitTopLevel(String(value).trim(), ' ').map((token) => token.trim()).filter(Boolean)
  if (tokens.length === 1) return tokens[0]
  if (tokens.length === 2) return side === 'top' || side === 'bottom' ? tokens[0] : tokens[1]
  if (tokens.length === 3) return side === 'top' ? tokens[0] : side === 'bottom' ? tokens[2] : tokens[1]
  return { top: tokens[0], right: tokens[1], bottom: tokens[2], left: tokens[3] }[side]
}

function boxSidePx(style, box, side, viewportWidth, options = {}) {
  const value = style[`${box}-${side}`] === undefined ? shorthandSide(style[box] || '0', side) : style[`${box}-${side}`]
  return lengthToPx(value, viewportWidth, options)
}

function borderSidePx(style, side, viewportWidth, options = {}) {
  const value = style[`border-${side}-width`] || style['border-width'] || style[`border-${side}`] || style.border || '0'
  return lengthToPx(String(value).trim().split(/\s+/)[0], viewportWidth, options)
}

function gridRepeatCount(value) {
  const match = String(value || '').match(/repeat\(\s*(\d+)\s*,/)
  return match ? Number(match[1]) : null
}

module.exports = {
  boxSidePx,
  borderSidePx,
  computedStyle,
  declarationValues,
  gridRepeatCount,
  lengthToPx,
  mediaQueryMatches,
  normalizeMedia,
  parseWxss,
  rulesForSelector,
}
